/**
 * Integration tests for "Open Granted": the real file system (a temp
 * install folder), a real HTTP server, and — on Windows — a real
 * powershell.exe running the exact script buildTaskScript generates.
 * No Electron, no network beyond 127.0.0.1.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildTaskScript } from "../ipcPure";
import { getSetupState, probeGranted, readStatusFile, saveApiKeys, waitForGrantedToStart } from "../openGranted";

const execFileAsync = promisify(execFile);

// scaffold/.env.example as shipped.
const ENV_EXAMPLE = [
  "OPENAI_API_KEY=sk-...",
  "ANTHROPIC_API_KEY=sk-ant-...",
  "EXA_API_KEY=",
  "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true",
  "",
].join("\n");

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

function serve(body: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolveServe) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServe({ server, url: `http://127.0.0.1:${port}/` });
    });
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
    assert.deepEqual(await getSetupState(install.installDir), {
      installDir: install.installDir,
      installed: true,
      hostedKeysSet: false,
      localConfigured: false,
    });
  });

  test("a folder that was never cloned reads as not installed", async () => {
    const state = await getSetupState(join(install.root, "nowhere"));
    assert.equal(state.installed, false);
  });

  test("a rejected form (missing a required key) writes nothing at all", async () => {
    const result = await saveApiKeys(install.scaffoldDir, { openaiApiKey: "sk-only-openai", anthropicApiKey: "", exaApiKey: "" });
    assert.equal(result.ok, false);
    assert.match(result.message, /Anthropic API key/);
    assert.equal(existsSync(join(install.scaffoldDir, ".env.local")), false);
  });

  test("a complete form creates .env.local from .env.example, and setup state then reads as configured", async () => {
    const result = await saveApiKeys(install.scaffoldDir, {
      openaiApiKey: "sk-test-openai",
      anthropicApiKey: "sk-ant-test",
      exaApiKey: "",
    });
    assert.deepEqual(result, { ok: true, message: "Saved your keys to .env.local." });
    const env = await readFile(join(install.scaffoldDir, ".env.local"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=sk-test-openai$/m);
    assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-test$/m);
    assert.match(env, /^NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true$/m, "the rest of .env.example is carried over");
    assert.equal((await getSetupState(install.installDir)).hostedKeysSet, true);
  });

  test("saving again never overwrites keys already in .env.local", async () => {
    const result = await saveApiKeys(install.scaffoldDir, {
      openaiApiKey: "sk-different",
      anthropicApiKey: "sk-ant-different",
      exaApiKey: "exa-new",
    });
    assert.equal(result.ok, true);
    const env = await readFile(join(install.scaffoldDir, ".env.local"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=sk-test-openai$/m);
    assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-test$/m);
    assert.match(env, /^EXA_API_KEY=exa-new$/m, "a blank optional key is still filled in");
  });

  test("an .env.local written by `npm run setup:local` reads as locally configured", async () => {
    const other = await makeInstall();
    try {
      await writeFile(
        join(other.scaffoldDir, ".env.local"),
        "LLM_PROVIDER=ollama\nEMBEDDINGS_BASE_URL=http://localhost:11434/v1\n",
      );
      const state = await getSetupState(other.installDir);
      assert.equal(state.localConfigured, true);
      assert.equal(state.hostedKeysSet, false);
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test("a scaffold folder that has gone missing reports a clear error instead of throwing", async () => {
    const result = await saveApiKeys(join(install.root, "deleted", "scaffold"), {
      openaiApiKey: "sk-a",
      anthropicApiKey: "sk-ant-b",
      exaApiKey: "",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Couldn't write/);
  });
});

describe("probeGranted / waitForGrantedToStart against a real HTTP server", () => {
  test("recognises Granted's page", async () => {
    const { server, url } = await serve(GRANTED_HTML);
    try {
      assert.equal(await probeGranted(url, 5000), "granted");
    } finally {
      server.close();
    }
  });

  test("tells some other app on the port apart from Granted", async () => {
    const { server, url } = await serve("<title>Some other dev server</title>");
    try {
      assert.equal(await probeGranted(url, 5000), "other");
    } finally {
      server.close();
    }
  });

  test("reports 'down' when nothing is listening", async () => {
    const { server, url } = await serve("");
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(await probeGranted(url, 2000), "down");
  });

  test("waits for a server that only starts listening after a while", async () => {
    // Reserve a free port, release it, then bring Granted up on it ~1.5s later.
    const { server: reserve, url } = await serve("");
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

describe("buildTaskScript run by a real powershell.exe", { skip: process.platform !== "win32" && "Windows only" }, () => {
  let dir: string;
  before(async () => {
    // A $ and a ' in the path: both must be taken literally by the script.
    dir = await mkdtemp(join(tmpdir(), "granted it's $weird-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runTask(command: string): Promise<{ status: Awaited<ReturnType<typeof readStatusFile>>; stdout: string }> {
    const statusPath = join(dir, `status-${Math.random().toString(36).slice(2)}.json`);
    const scriptPath = join(dir, `task-${Math.random().toString(36).slice(2)}.ps1`);
    await writeFile(
      scriptPath,
      buildTaskScript({ title: "Granted test", cwd: dir, statusPath, command, failureMessage: "It didn't work." }),
      "utf8",
    );
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, timeout: 60_000 },
    );
    return { status: await readStatusFile(statusPath), stdout };
  }

  test("a command that exits 0 reports done, and runs in the requested folder", async () => {
    const { status } = await runTask("cmd.exe /c \"cd > where.txt\"");
    assert.deepEqual(status, { state: "done", message: null });
    const where = (await readFile(join(dir, "where.txt"), "utf8")).trim();
    assert.equal(where.toLowerCase(), dir.toLowerCase());
  });

  test("a command that exits non-zero reports error with the failure message, and says so in the window", async () => {
    const { status, stdout } = await runTask("cmd.exe /c exit 3");
    assert.deepEqual(status, { state: "error", message: "It didn't work." });
    assert.match(stdout, /\[x\] It didn't work\./);
  });
});
