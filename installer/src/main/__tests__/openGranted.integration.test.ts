/**
 * Integration tests for "Open Granted": the real file system (a temp
 * install folder), a real HTTP server, and — on Windows — a real
 * powershell.exe running the exact script buildTaskScript generates.
 * No Electron, no network beyond 127.0.0.1.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildTaskScript, TASK_WINDOW_CLOSED_MESSAGE } from "../ipcPure";
import {
  getSetupState,
  isProcessAlive,
  isStatusWindowAlive,
  macScriptPath,
  probeGranted,
  readStatusFile,
  readTaskStatus,
  saveApiKeys,
  saveOpenIn,
  waitForGrantedToStart,
  windowsScriptPath,
} from "../openGranted";

const execFileAsync = promisify(execFile);

// scaffold/.env.example as shipped.
const ENV_EXAMPLE = [
  "OPENAI_API_KEY=sk-...",
  "ANTHROPIC_API_KEY=sk-ant-...",
  "EXA_API_KEY=",
  "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true",
  "",
].join("\n");

// What setup-local.mjs writes to .env.local (before its re-embed step)...
const LOCAL_ENV = "LLM_PROVIDER=ollama\nEMBEDDINGS_BASE_URL=http://localhost:11434/v1\nEMBEDDINGS_MODEL=nomic-embed-text\n";
// ...and what 3-embed.mjs --target=local writes last, once the re-embed succeeded.
const LOCAL_META = JSON.stringify({ count: 3, embeddingModel: "nomic-embed-text", dims: 768 });

const GRANTED_HTML = "<html><head><title>Granted — federal funding intelligence for everyone</title></head></html>";

/** A fresh fake install: <tmp>/granted/scaffold with package.json + .env.example. */
async function makeInstall(): Promise<{ root: string; installDir: string; scaffoldDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "granted-it-"));
  const installDir = join(root, "granted");
  const scaffoldDir = join(installDir, "scaffold");
  await mkdir(scaffoldDir, { recursive: true });
  await writeFile(join(scaffoldDir, "package.json"), "{}");
  await writeFile(join(scaffoldDir, ".env.example"), ENV_EXAMPLE);
  return { root, installDir, scaffoldDir };
}

// Never the real %LOCALAPPDATA%\Granted\settings.json.
const settingsDir = mkdtempSync(join(tmpdir(), "granted-settings-it-"));
const SETTINGS = join(settingsDir, "Granted", "settings.json");
const setupState = (installDir: string): ReturnType<typeof getSetupState> => getSetupState(installDir, SETTINGS);
after(() => rmSync(settingsDir, { recursive: true, force: true }));

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise((resolveServe) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServe({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function serveHtml(body: string): Promise<{ server: Server; url: string }> {
  return serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(body);
  });
}

describe("getSetupState / saveApiKeys against a real install folder", () => {
  let install: Awaited<ReturnType<typeof makeInstall>>;
  before(async () => {
    install = await makeInstall();
  });
  after(async () => {
    await rm(install.root, { recursive: true, force: true });
  });

  test("a fresh install reads as installed but not configured", async () => {
    assert.deepEqual(await setupState(install.installDir), {
      installDir: install.installDir,
      platform: process.platform,
      installed: true,
      openaiKeySet: false,
      anthropicKeySet: false,
      hostedKeysSet: false,
      localConfigured: false,
      settingsProviderSet: false,
      trayAvailable: false,
      shortcutsAvailable: false,
      appWindowAvailable: false,
      openIn: "window",
    });
  });

  // Deliberately in THIS describe, which runs on every platform, rather than
  // beside the rest of the open-granted.sh tests in
  // macOpenGranted.integration.test.ts: that whole describe is skipped on
  // win32 (it needs a POSIX bash), and windows-latest is the one runner where
  // a macOS path built with the ambient `join` comes out with backslashes —
  // so an assertion living there could never run where it matters. The same
  // CI failure grantedSettingsPath's comment records.
  test("each platform's script path is spelled with that platform's separators, on whatever runner this is", () => {
    // Literal expectations, never re-derived with the join that built them:
    // re-deriving a path with the same call cannot catch the path being wrong.
    assert.equal(macScriptPath("/granted/scaffold", "open-granted.sh"), "/granted/scaffold/scripts/macos/open-granted.sh");
    assert.equal(macScriptPath("/granted/scaffold", "granted-tray.sh"), "/granted/scaffold/scripts/macos/granted-tray.sh");
    assert.equal(
      windowsScriptPath("C:\\granted\\scaffold", "open-granted.ps1"),
      "C:\\granted\\scaffold\\scripts\\windows\\open-granted.ps1",
    );
    assert.equal(
      windowsScriptPath("C:\\granted\\scaffold", "granted-tray.ps1"),
      "C:\\granted\\scaffold\\scripts\\windows\\granted-tray.ps1",
    );
    assert.ok(!macScriptPath("/granted/scaffold", "granted-tray.sh").includes("\\"), "the macOS path is POSIX on every runner");
    assert.ok(
      !windowsScriptPath("C:\\granted\\scaffold", "granted-tray.ps1").includes("/"),
      "the Windows path is win32 on every runner",
    );
  });

  test("an install that has the Windows tray, shortcut and open-in-a-window scripts says so on win32 only — these files are tracked in the repo and present on every platform's clone, but the capability stays Windows-only regardless", async () => {
    await mkdir(join(install.scaffoldDir, "scripts", "windows"), { recursive: true });
    await writeFile(join(install.scaffoldDir, "scripts", "windows", "granted-tray.ps1"), "");
    await writeFile(join(install.scaffoldDir, "scripts", "windows", "shortcuts.ps1"), "");
    await writeFile(join(install.scaffoldDir, "scripts", "windows", "open-granted.ps1"), "");
    const state = await setupState(install.installDir);
    // REGRESSION (review): a bare existsSync with no platform guard here
    // wrongly reads true on macOS too, since these files land on every
    // clone — these flags must track process.platform, not just the files.
    const expected = process.platform === "win32";
    assert.equal(state.trayAvailable, expected);
    assert.equal(state.shortcutsAvailable, expected);
    assert.equal(state.appWindowAvailable, expected);
  });

  test("an install that has scripts/macos/granted-tray.sh and open-granted.sh can run in the background and in its own window on darwin only (same rule, each platform its own scripts)", async () => {
    await mkdir(join(install.scaffoldDir, "scripts", "macos"), { recursive: true });
    await writeFile(join(install.scaffoldDir, "scripts", "macos", "granted-tray.sh"), "");
    await writeFile(join(install.scaffoldDir, "scripts", "macos", "open-granted.sh"), "");
    const state = await setupState(install.installDir);
    // On Windows the .ps1 files written by the test above are still there, so
    // both stay true there; what this pins down is that the .sh files alone
    // make them true on macOS, and on neither platform does the other's file
    // count.
    const eitherPlatform = process.platform === "win32" || process.platform === "darwin";
    assert.equal(state.trayAvailable, eitherPlatform);
    assert.equal(state.appWindowAvailable, eitherPlatform);
    // Shortcuts remain Windows-only: scripts/macos has no counterpart yet.
    assert.equal(state.shortcutsAvailable, process.platform === "win32");
  });

  test("on macOS, its own window needs open-granted.sh specifically — the tray script alone isn't it", async () => {
    const dir = join(install.root, "mac-tray-only", "scaffold");
    await mkdir(join(dir, "scripts", "macos"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "scripts", "macos", "granted-tray.sh"), "");
    const state = await getSetupState(join(install.root, "mac-tray-only"), SETTINGS);
    assert.equal(state.trayAvailable, process.platform === "darwin");
    assert.equal(state.appWindowAvailable, false);
  });

  test("saveOpenIn creates the settings file, round-trips through getSetupState, and keeps other settings", async () => {
    assert.equal((await saveOpenIn(SETTINGS, "browser")).ok, true);
    assert.equal((await setupState(install.installDir)).openIn, "browser");
    // Something else the file might hold (a future setting) survives a change.
    await writeFile(SETTINGS, JSON.stringify({ openIn: "browser", other: 1 }));
    assert.equal((await saveOpenIn(SETTINGS, "window")).ok, true);
    assert.deepEqual(JSON.parse(await readFile(SETTINGS, "utf8")), { openIn: "window", other: 1 });
    assert.equal((await setupState(install.installDir)).openIn, "window");
  });

  test("a folder that was never cloned reads as not installed", async () => {
    const state = await setupState(join(install.root, "nowhere"));
    assert.equal(state.installed, false);
  });

  test("a Claude key alone is enough: it is saved, and setup state reads as ready (search needs no key)", async () => {
    const other = await makeInstall();
    try {
      const result = await saveApiKeys(other.scaffoldDir, { openaiApiKey: "", anthropicApiKey: "sk-ant-only-claude-000000", exaApiKey: "" });
      assert.deepEqual(result, { ok: true, message: "Saved your keys to .env.local." });
      const env = await readFile(join(other.scaffoldDir, ".env.local"), "utf8");
      assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-only-claude-000000$/m);
      assert.match(env, /^OPENAI_API_KEY=sk-\.\.\.$/m, "the OpenAI placeholder is left as-is");
      const state = await setupState(other.installDir);
      assert.equal(state.hostedKeysSet, true);
      assert.equal(state.openaiKeySet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("an empty form is rejected, says one scoring key (or local models) is needed, and writes nothing", async () => {
    const result = await saveApiKeys(install.scaffoldDir, { openaiApiKey: "", anthropicApiKey: "", exaApiKey: "" });
    assert.equal(result.ok, false);
    assert.equal(result.suggestLocal, true);
    assert.match(result.message, /needs one API key to score/);
    assert.match(result.message, /Search itself runs on this computer and needs no key/);
    assert.match(result.message, /use local models instead/);
    assert.equal(existsSync(join(install.scaffoldDir, ".env.local")), false);
  });

  test("a provider saved in Settings (Gemini, say) counts as configured, with no keys in .env.local", async () => {
    const other = await makeInstall();
    try {
      await mkdir(join(other.scaffoldDir, "data", "local"), { recursive: true });
      await writeFile(
        join(other.scaffoldDir, "data", "local", "llm-config.json"),
        JSON.stringify({ provider: "cloud", cloud: { providerId: "gemini", keySource: { type: "env", name: "GEMINI_API_KEY" } } }),
      );
      const state = await setupState(other.installDir);
      assert.equal(state.settingsProviderSet, true);
      assert.equal(state.hostedKeysSet, false);
      assert.equal((await setupState(install.installDir)).settingsProviderSet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("an OpenAI key alone is enough (it can do the scoring)", async () => {
    const other = await makeInstall();
    try {
      const result = await saveApiKeys(other.scaffoldDir, { openaiApiKey: "sk-only-openai-0000000000", anthropicApiKey: "", exaApiKey: "" });
      assert.equal(result.ok, true);
      const env = await readFile(join(other.scaffoldDir, ".env.local"), "utf8");
      assert.match(env, /^OPENAI_API_KEY=sk-only-openai-0000000000$/m);
      assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-\.\.\.$/m, "the Claude placeholder is left as-is");
      const state = await setupState(other.installDir);
      assert.equal(state.hostedKeysSet, true);
      assert.equal(state.anthropicKeySet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("a complete form creates .env.local from .env.example, and setup state then reads as configured", async () => {
    const result = await saveApiKeys(install.scaffoldDir, {
      openaiApiKey: "sk-test-openai-0000000000",
      anthropicApiKey: "sk-ant-test-key-000000000",
      exaApiKey: "",
    });
    assert.deepEqual(result, { ok: true, message: "Saved your keys to .env.local." });
    const env = await readFile(join(install.scaffoldDir, ".env.local"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=sk-test-openai-0000000000$/m);
    assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-test-key-000000000$/m);
    assert.match(env, /^NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true$/m, "the rest of .env.example is carried over");
    const state = await setupState(install.installDir);
    assert.equal(state.hostedKeysSet, true);
    assert.equal(state.openaiKeySet && state.anthropicKeySet, true);
  });

  test("saving again: blank fields keep the existing keys, a typed key replaces its old value", async () => {
    const result = await saveApiKeys(install.scaffoldDir, { openaiApiKey: "", anthropicApiKey: "sk-ant-new-key-0000000000", exaApiKey: "exa-new" });
    assert.equal(result.ok, true);
    const env = await readFile(join(install.scaffoldDir, ".env.local"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=sk-test-openai-0000000000$/m);
    assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-new-key-0000000000$/m);
    assert.match(env, /^EXA_API_KEY=exa-new$/m);
  });

  test("today's setup:local (no EMBEDDINGS_BASE_URL) counts as configured straight away", async () => {
    const other = await makeInstall();
    try {
      await writeFile(join(other.scaffoldDir, ".env.local"), "LLM_PROVIDER=ollama\nLOCAL_LLM_MODEL=gemma4:latest\n");
      const state = await setupState(other.installDir);
      assert.equal(state.localConfigured, true);
      assert.equal(state.hostedKeysSet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("an older local setup (EMBEDDINGS_BASE_URL set) only counts as configured once its corpus re-embed finished", async () => {
    const other = await makeInstall();
    try {
      await writeFile(join(other.scaffoldDir, ".env.local"), LOCAL_ENV);
      // setup:local failed during the re-embed: env written, no local corpus.
      assert.equal((await setupState(other.installDir)).localConfigured, false);

      await mkdir(join(other.scaffoldDir, "data", "local"), { recursive: true });
      await writeFile(join(other.scaffoldDir, "data", "local", "corpus-meta.json"), LOCAL_META);
      const state = await setupState(other.installDir);
      assert.equal(state.localConfigured, true);
      assert.equal(state.hostedKeysSet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("REGRESSION (review): a key the app would refuse (a truncated paste) is rejected by name and nothing is written", async () => {
    const other = await makeInstall();
    try {
      const result = await saveApiKeys(other.scaffoldDir, { openaiApiKey: "sk-proj-abc", anthropicApiKey: "", exaApiKey: "" });
      assert.equal(result.ok, false);
      assert.match(result.message, /That OpenAI key doesn't look right/);
      assert.equal(existsSync(join(other.scaffoldDir, ".env.local")), false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("REGRESSION (review): a half-finished setup:local isn't treated as ready for hosted mode, even with an OpenAI key", async () => {
    const other = await makeInstall();
    try {
      await writeFile(join(other.scaffoldDir, ".env.local"), `OPENAI_API_KEY=sk-only-openai-0000000000\n${LOCAL_ENV}`);
      const state = await setupState(other.installDir);
      assert.equal(state.openaiKeySet, true);
      assert.equal(state.hostedKeysSet, false, "LLM_PROVIDER=ollama: offer the choice again");
      assert.equal(state.localConfigured, false, "and no finished local re-embed either");
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("a scaffold folder that has gone missing reports a clear error instead of throwing", async () => {
    const result = await saveApiKeys(join(install.root, "deleted", "scaffold"), {
      openaiApiKey: "sk-a-key-0000000000000000",
      anthropicApiKey: "sk-ant-b-key-0000000000000",
      exaApiKey: "",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Couldn't write/);
  });
});

describe("probeGranted / waitForGrantedToStart against a real HTTP server", () => {
  test("recognises Granted's page", async () => {
    const { server, url } = await serveHtml(GRANTED_HTML);
    try {
      assert.equal(await probeGranted(url, 5000), "granted");
    } finally {
      server.close();
    }
  });

  test("tells some other app on the port apart from Granted", async () => {
    const { server, url } = await serveHtml("<title>Some other dev server</title>");
    try {
      assert.equal(await probeGranted(url, 5000), "other");
    } finally {
      server.close();
    }
  });

  test("a server that accepts but doesn't answer in time is 'busy', not 'down' (so no second server is started)", async () => {
    const pending: import("node:http").ServerResponse[] = [];
    const { server, url } = await serve((_req, res) => void pending.push(res));
    try {
      assert.equal(await probeGranted(url, 500), "busy");
    } finally {
      for (const res of pending) res.end();
      server.close();
    }
  });

  test("reports 'down' when nothing is listening", async () => {
    const { server, url } = await serveHtml("");
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(await probeGranted(url, 2000), "down");
  });

  test("waits for a server that only starts listening after a while", async () => {
    // Reserve a free port, release it, then bring Granted up on it ~1.5s later.
    const { server: reserve, url } = await serveHtml("");
    const { port } = reserve.address() as AddressInfo;
    await new Promise<void>((r) => reserve.close(() => r()));
    let late: Server | undefined;
    const timer = setTimeout(() => {
      late = createServer((_q, res) => res.end(GRANTED_HTML)).listen(port, "127.0.0.1");
    }, 1500);
    try {
      const outcome = await waitForGrantedToStart({
        probe: () => probeGranted(url, 2000),
        readStatus: async () => ({ state: "running", message: null }),
        timeoutMs: 15_000,
        intervalMs: 250,
      });
      assert.deepEqual(outcome, { ok: true });
    } finally {
      clearTimeout(timer);
      late?.close();
    }
  });
});

describe("isProcessAlive", () => {
  test("is true for this process and false for one that has exited", async () => {
    assert.equal(isProcessAlive(process.pid), true);
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => child.once("exit", r));
    assert.equal(isProcessAlive(child.pid!), false);
  });
});

describe("buildTaskScript run by a real powershell.exe", { skip: process.platform !== "win32" && "Windows only" }, () => {
  let dir: string;
  before(async () => {
    // A $ and a ' in the path: both must be taken literally by the script.
    dir = await mkdtemp(join(tmpdir(), "granted it's $weird-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeTask(command: string): Promise<{ statusPath: string; scriptPath: string }> {
    const id = Math.random().toString(36).slice(2);
    const statusPath = join(dir, `status-${id}.json`);
    const scriptPath = join(dir, `task-${id}.ps1`);
    await writeFile(
      scriptPath,
      buildTaskScript({ title: "Granted test", cwd: dir, statusPath, command, failureMessage: "It didn't work." }),
      "utf8",
    );
    return { statusPath, scriptPath };
  }

  const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

  async function runTask(command: string): Promise<{ status: Awaited<ReturnType<typeof readStatusFile>>; stdout: string }> {
    const { statusPath, scriptPath } = await writeTask(command);
    const { stdout } = await execFileAsync("powershell.exe", [...PS_ARGS, scriptPath], { windowsHide: true, timeout: 60_000 });
    return { status: await readStatusFile(statusPath), stdout };
  }

  test("a command that exits 0 reports done (with the window's pid), and runs in the requested folder", async () => {
    const { status } = await runTask('cmd.exe /c "cd > where.txt"');
    assert.equal(status?.state, "done");
    assert.equal(status?.message, null);
    assert.ok(Number.isInteger(status?.pid) && status!.pid! > 0, "pid recorded");
    const where = (await readFile(join(dir, "where.txt"), "utf8")).trim();
    // Through realpathSync.native: %TEMP% can be an 8.3 short path (e.g.
    // C:\Users\RUNNER~1\... on GitHub's Windows runners) while `cd` reports
    // the long form — same folder, different spelling.
    assert.equal(realpathSync.native(where).toLowerCase(), realpathSync.native(dir).toLowerCase());
  });

  test("a command that exits non-zero reports error with the failure message, and says so in the window", async () => {
    const { status, stdout } = await runTask("cmd.exe /c exit 3");
    assert.equal(status?.state, "error");
    assert.equal(status?.message, "It didn't work.");
    assert.match(stdout, /\[x\] It didn't work\./);
  });

  test("closing the window mid-command reads as an error, not as still running", async () => {
    // A command that runs until killed, standing in for a long setup:local.
    const { statusPath, scriptPath } = await writeTask("ping.exe -n 120 127.0.0.1 | Out-Null");
    const window = spawn("powershell.exe", [...PS_ARGS, scriptPath], { windowsHide: true, stdio: "ignore" });
    try {
      let running = null;
      for (let i = 0; i < 100 && running?.state !== "running"; i++) {
        await new Promise((r) => setTimeout(r, 200));
        running = await readTaskStatus(statusPath);
      }
      assert.equal(running?.state, "running", "the window reported running");
      assert.equal(running?.pid, window.pid, "with its own pid");

      // "The user closes the window": PowerShell dies without writing done/error.
      await execFileAsync("taskkill.exe", ["/PID", String(window.pid), "/T", "/F"]);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal((await readStatusFile(statusPath))?.state, "running", "the file itself still says running");
      assert.deepEqual(await readTaskStatus(statusPath), {
        state: "error",
        message: TASK_WINDOW_CLOSED_MESSAGE,
        pid: window.pid,
        closed: true,
      });
    } finally {
      window.kill();
    }
  });

  test("PID reuse can't fake a live window: a released lock means closed, even if that pid now belongs to a running process", async () => {
    // Simulates Windows handing the closed window's PID to an unrelated
    // process: the recorded pid is alive (it's this test runner), but the
    // window's lock file exists and nobody holds it.
    const statusPath = join(dir, "reused-pid-status.json");
    await writeFile(statusPath, JSON.stringify({ state: "running", message: null, pid: process.pid }));
    await writeFile(`${statusPath}.lock`, "");
    assert.equal(isProcessAlive(process.pid), true, "the pid itself is alive");
    assert.equal(isStatusWindowAlive(statusPath, process.pid), false, "but the window is not");
    assert.equal((await readTaskStatus(statusPath))?.closed, true);
  });

  test("while a real window holds its lock it reads as alive", async () => {
    const { statusPath, scriptPath } = await writeTask("ping.exe -n 120 127.0.0.1 | Out-Null");
    const window = spawn("powershell.exe", [...PS_ARGS, scriptPath], { windowsHide: true, stdio: "ignore" });
    try {
      let status = null;
      for (let i = 0; i < 100 && status?.state !== "running"; i++) {
        await new Promise((r) => setTimeout(r, 200));
        status = await readTaskStatus(statusPath);
      }
      assert.equal(status?.state, "running");
      assert.equal(existsSync(`${statusPath}.lock`), true, "the window created its lock");
      assert.equal(isStatusWindowAlive(statusPath, window.pid!), true);
    } finally {
      await execFileAsync("taskkill.exe", ["/PID", String(window.pid), "/T", "/F"]).catch(() => {});
    }
  });
});
