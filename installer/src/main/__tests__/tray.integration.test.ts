/**
 * Integration: the REAL scaffold/scripts/windows/granted-tray.ps1 and
 * shortcuts.ps1, run by a real powershell.exe against a fake Granted
 * install whose `npm run dev` is a tiny Node server — so this proves the
 * hidden background server, status reporting, single instance, -Stop, the
 * failure paths and the .lnk files, without a real Next.js build.
 * Windows only (on CI: the installer-windows job).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  parseOpenGrantedOutput,
  parseOpenInSetting,
  parseShortcutsOutput,
  startProcessCommand,
  STATUS_LOCK_LINE,
  trayLaunchCommand,
} from "../ipcPure";
import { probeGranted, readTaskStatus, saveOpenIn } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the scripts live in scaffold/.
const WINDOWS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "windows");
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";

// Each test case uses its own port so a slow teardown can't leak into the next.
let nextPort = 3961;
const takePort = (): number => nextPort++;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(250);
    last = await fn();
  }
  return last;
}

test("the tray script takes the same exclusive status lock as install-windows.ps1 and the task scripts", { skip: !existsSync(WINDOWS_SCRIPTS) && "run from installer/" }, () => {
  const tray = readFileSync(join(WINDOWS_SCRIPTS, "granted-tray.ps1"), "utf8");
  assert.ok(tray.includes(STATUS_LOCK_LINE), "granted-tray.ps1 must contain STATUS_LOCK_LINE verbatim");
});

describe("granted-tray.ps1 and shortcuts.ps1, run for real", { skip: (process.platform !== "win32" || !existsSync(WINDOWS_SCRIPTS)) && "Windows only, run from installer/" }, () => {
  let root: string;
  let scaffold: string;
  let trayScript: string;
  const started: ChildProcess[] = [];

  /** A fake install: package.json whose `dev` runs fake-dev.js, plus the real scripts/windows/*. */
  async function makeScaffold(name: string, devScript: string): Promise<string> {
    const dir = join(root, name, "scaffold");
    mkdirSync(join(dir, "scripts", "windows"), { recursive: true });
    for (const f of readdirSync(WINDOWS_SCRIPTS)) copyFileSync(join(WINDOWS_SCRIPTS, f), join(dir, "scripts", "windows", f));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fake", private: true, scripts: { dev: "node fake-dev.js" } }));
    await writeFile(join(dir, "fake-dev.js"), devScript);
    return dir;
  }

  // Logs one "REQ" line per request, so a test can tell whether the tray keeps probing.
  const FAKE_SERVER = `require("node:http").createServer((q, r) => { console.log("REQ " + q.url); r.end(${JSON.stringify(GRANTED_HTML)}); }).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fake Granted up on " + process.env.PORT));`;
  // A dev server that never starts listening (stuck compiling, say).
  const NEVER_LISTENS = `console.log("starting forever"); setInterval(() => {}, 1000);`;

  const logPath = (port: number): string => join(process.env["LOCALAPPDATA"]!, "Granted", "logs", `server-${port}.log`);
  const portOwner = async (port: number): Promise<number | null> => {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
      { windowsHide: true },
    );
    const n = Number(stdout.trim());
    return n > 0 ? n : null;
  };

  function startTray(dir: string, port: number, extra: string[] = [], env?: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn("powershell.exe", [...PS, join(dir, "scripts", "windows", "granted-tray.ps1"), "-NoTray", "-Port", String(port), ...extra], {
      windowsHide: true,
      stdio: "ignore",
      ...(env && { env }),
    });
    started.push(child);
    return child;
  }

  async function signalTray(dir: string, port: number, signal: "-Stop" | "-Restart"): Promise<number> {
    try {
      await execFileAsync("powershell.exe", [...PS, join(dir, "scripts", "windows", "granted-tray.ps1"), signal, "-Port", String(port)], { windowsHide: true });
      return 0;
    } catch (err) {
      return (err as { code?: number }).code ?? -1;
    }
  }
  const stopTray = (dir: string, port: number): Promise<number> => signalTray(dir, port, "-Stop");

  const exited = (child: ChildProcess): Promise<number | null> =>
    child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((r) => child.once("exit", (code) => r(code)));

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-tray-it-"));
    scaffold = await makeScaffold("main", FAKE_SERVER);
    trayScript = join(scaffold, "scripts", "windows", "granted-tray.ps1");
  });

  after(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("starts the server hidden, reports running with its pid + lock, answers, and -Stop shuts everything down", async () => {
    const port = takePort();
    const statusPath = join(root, "status-main.json");
    const tray = startTray(scaffold, port, ["-StatusPath", statusPath]);

    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted"), "granted");
    const status = await readTaskStatus(statusPath);
    assert.equal(status?.state, "running");
    assert.equal(status?.pid, tray.pid, "the tray's own pid");
    assert.ok(existsSync(`${statusPath}.lock`), "and its lock");

    const log = readFileSync(logPath(port), "utf8");
    assert.match(log, new RegExp(`fake Granted up on ${port}`), "server output goes to the log, not a console");

    // REGRESSION (review): once Granted has answered, the tray stops making
    // HTTP requests — no GET / every 2 s re-rendering the page and filling the log.
    const requests = (): number => (readFileSync(logPath(port), "utf8").match(/^REQ /gm) ?? []).length;
    await sleep(1500);
    const settled = requests();
    await sleep(6000);
    assert.equal(requests(), settled, "no further probe requests while running");

    assert.equal(await stopTray(scaffold, port), 0);
    assert.equal(await exited(tray), 0);
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 1000), (p) => p === "down"), "down", "the server tree is gone too");
    assert.equal((await readTaskStatus(statusPath))?.closed, true, "a tray that has exited reads as closed");
  });

  test("-Stop with nothing running for that port exits 1", async () => {
    assert.equal(await stopTray(scaffold, takePort()), 1);
  });

  test("-Restart starts a fresh server (waiting for the old one to let go of the port) and rotates the log", async () => {
    const port = takePort();
    const statusPath = join(root, "status-restart.json");
    const tray = startTray(scaffold, port, ["-StatusPath", statusPath]);
    await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted");
    const firstOwner = await portOwner(port);
    assert.ok(firstOwner);

    assert.equal(await signalTray(scaffold, port, "-Restart"), 0);
    const secondOwner = await until(() => portOwner(port), (o) => o !== null && o !== firstOwner, 30_000);
    assert.ok(secondOwner && secondOwner !== firstOwner, "a new server process holds the port");
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted"), "granted");
    assert.ok(existsSync(`${logPath(port)}.previous`), "the previous run's log was kept");
    assert.equal((await readTaskStatus(statusPath))?.state, "running");

    assert.equal(await stopTray(scaffold, port), 0);
    assert.equal(await exited(tray), 0);
  });

  test("REGRESSION (review): -Stop still exits cleanly when the server already died (taskkill errors must not abort the quit)", async () => {
    const port = takePort();
    const tray = startTray(scaffold, port);
    await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted");
    const owner = await portOwner(port);
    await execFileAsync("taskkill.exe", ["/PID", String(owner), "/F"]); // the node server only; its cmd/npm parents linger and exit
    assert.equal(await stopTray(scaffold, port), 0);
    assert.equal(await exited(tray), 0, "the tray quit despite taskkill having nothing (or less) to kill");
  });

  test("REGRESSION (review): a second launch while the first tray's Granted isn't answering reports it instead of leaving silently", async () => {
    const port = takePort();
    const stuck = await makeScaffold("stuck", NEVER_LISTENS);
    // A log left by an earlier run on this port already says "starting forever":
    // the wait below would pass at once and the second tray would race the first.
    await rm(logPath(port), { force: true });
    const first = startTray(stuck, port);
    await until(async () => existsSync(logPath(port)) && readFileSync(logPath(port), "utf8").includes("starting forever"), (v) => v);
    const statusPath = join(root, "status-second.json");
    const second = startTray(stuck, port, ["-StatusPath", statusPath, "-AlreadyRunningWaitSeconds", "3"]);
    assert.equal(await exited(second), 3);
    const status = await readTaskStatus(statusPath);
    assert.equal(status?.state, "error");
    assert.match(status?.message ?? "", /already running in the background.*isn't answering/);
    assert.equal(await stopTray(stuck, port), 0);
    await exited(first);
  });

  test("REGRESSION (review): a 'busy' port (a Granted still compiling) is waited for, not reported as another program", async () => {
    const port = takePort();
    // Accepts at once but answers the first request only after 12 s (longer
    // than the tray's 10 s first probe), like `next dev` compiling its first page.
    let first = true;
    const slow: Server = await new Promise((r) => {
      const s = createServer((_q, res) => {
        const delay = first ? 12_000 : 0;
        first = false;
        setTimeout(() => res.end(GRANTED_HTML), delay);
      });
      s.listen(port, "127.0.0.1", () => r(s));
    });
    try {
      const statusPath = join(root, "status-busy.json");
      const tray = startTray(scaffold, port, ["-StatusPath", statusPath]);
      assert.equal(await exited(tray), 0, "it waited, then found Granted already running");
      assert.equal(existsSync(statusPath), false, "no 'another program' error written");
    } finally {
      slow.close();
    }
  });

  test("a second launch for the same port doesn't start a second server", async () => {
    const port = takePort();
    const first = startTray(scaffold, port);
    await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted");
    const second = startTray(scaffold, port);
    assert.equal(await exited(second), 0, "the second instance just leaves");
    assert.equal(first.exitCode, null, "the first keeps running");
    assert.equal(await stopTray(scaffold, port), 0);
    await exited(first);
  });

  test("a server that dies before answering is reported with the log's last error", async () => {
    const port = takePort();
    const broken = await makeScaffold("broken", `console.error("Error: Cannot find module 'next'"); process.exit(1);`);
    const statusPath = join(root, "status-broken.json");
    const tray = startTray(broken, port, ["-StatusPath", statusPath]);
    const status = await until(() => readTaskStatus(statusPath), (s) => s?.state === "error");
    assert.equal(status?.state, "error");
    assert.match(status?.message ?? "", /stopped before it finished starting/);
    assert.match(status?.message ?? "", /Cannot find module 'next'/);
    assert.equal(await stopTray(broken, port), 0);
    await exited(tray);
  });

  test("another program on the port: reports it and exits 2 without starting anything", async () => {
    const port = takePort();
    const other: Server = await new Promise((r) => {
      const s = createServer((_q, res) => res.end("<title>Some other dev server</title>"));
      s.listen(port, "127.0.0.1", () => r(s));
    });
    try {
      const statusPath = join(root, "status-other.json");
      const tray = startTray(scaffold, port, ["-StatusPath", statusPath]);
      assert.equal(await exited(tray), 2);
      const status = await readTaskStatus(statusPath);
      assert.equal(status?.state, "error");
      assert.match(status?.message ?? "", new RegExp(`already using port ${port}`));
    } finally {
      other.close();
    }
  });

  test("Granted already running on the port (started some other way): leaves it alone and exits 0", async () => {
    const port = takePort();
    const existing: Server = await new Promise((r) => {
      const s = createServer((_q, res) => res.end(GRANTED_HTML));
      s.listen(port, "127.0.0.1", () => r(s));
    });
    try {
      const tray = startTray(scaffold, port);
      assert.equal(await exited(tray), 0);
      assert.equal(await probeGranted(`http://127.0.0.1:${port}/`, 2000), "granted", "still the original server");
    } finally {
      existing.close();
    }
  });

  test("the real tray (icon mode), launched exactly as the installer launches it, serves Granted and quits on -Stop", async () => {
    const port = takePort();
    const statusPath = join(root, "status-ui.json");
    const { file, args } = trayLaunchCommand({
      systemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
      trayScript,
      port,
      statusPath,
    });
    // Exactly ipc.ts's launchTray: PowerShell Start-Process (see startProcessCommand).
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", startProcessCommand(file, args)], {
      cwd: scaffold,
      windowsHide: true,
    });
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted", 60_000), "granted");
    assert.equal((await readTaskStatus(statusPath))?.state, "running");
    assert.equal(await stopTray(scaffold, port), 0);
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 1000), (p) => p === "down"), "down");
    assert.equal((await until(() => readTaskStatus(statusPath), (s) => s?.closed === true))?.closed, true, "the tray exited");
  });

  test("shortcuts.ps1 creates Granted.lnk where asked, launching the tray hidden with -OpenBrowser", async () => {
    const desk = join(root, "Desktop");
    const start = join(root, "Programs");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [...PS, join(scaffold, "scripts", "windows", "shortcuts.ps1"), "-Desktop", "-StartMenu", "-DesktopDir", desk, "-StartMenuDir", start],
      { windowsHide: true },
    );
    assert.deepEqual(parseShortcutsOutput(stdout), [join(desk, "Granted.lnk"), join(start, "Granted.lnk")]);

    // Read the .lnk back through the same COM object Explorer uses.
    const read = `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${join(desk, "Granted.lnk").replace(/'/g, "''")}'); @{ t = $l.TargetPath; a = $l.Arguments; w = $l.WorkingDirectory; i = $l.IconLocation } | ConvertTo-Json -Compress`;
    const { stdout: lnkJson } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", read], { windowsHide: true });
    const lnk = JSON.parse(lnkJson) as { t: string; a: string; w: string; i: string };
    assert.match(lnk.t, /\\System32\\conhost\.exe$/i);
    assert.match(lnk.a, /^--headless ".*\\powershell\.exe" -NoProfile -STA -ExecutionPolicy Bypass -File ".*granted-tray\.ps1" -OpenBrowser$/);
    // Through realpathSync.native: %TEMP% can be an 8.3 short path (C:\Users\RUNNER~1\... on
    // GitHub's Windows runners) while the shortcut stores the long form — same folder.
    assert.equal(realpathSync.native(lnk.w).toLowerCase(), realpathSync.native(scaffold).toLowerCase());
    assert.match(lnk.i, /granted\.ico,0$/);
  });

  describe("open-granted.ps1: Granted in its own window (Edge/Chrome app mode) or a browser tab", () => {
    // A stand-in browser that records how it was started — never a real Edge
    // window, never a real browser tab — and, per test, a settings file and
    // log of its own (so tests can run alone or in any order).
    let openScript: string;
    let seq = 0;
    interface Sandbox {
      settings: string;
      browserLog: string;
      env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
      run: (args: string[], extra?: Record<string, string>) => Promise<string>;
      browserCalls: () => string[];
    }
    async function sandbox(): Promise<Sandbox> {
      const dir = join(root, `open-${seq++}`);
      mkdirSync(dir, { recursive: true });
      const browserLog = join(dir, "browser.log");
      const fakeBrowser = join(dir, "fake-browser.cmd");
      // Plain %*: the script passes --app="<url>", whose quotes keep a URL's & away from cmd.
      await writeFile(fakeBrowser, `@echo %*>>"${browserLog}"\r\n`);
      const settings = join(dir, "Granted", "settings.json");
      const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
        ...process.env,
        GRANTED_SETTINGS_PATH: settings,
        GRANTED_APP_BROWSER: fakeBrowser,
        ...extra,
      });
      return {
        settings,
        browserLog,
        env,
        run: async (args, extra = {}) =>
          (await execFileAsync("powershell.exe", [...PS, openScript, ...args], { windowsHide: true, env: env(extra) })).stdout,
        browserCalls: () =>
          existsSync(browserLog)
            ? readFileSync(browserLog, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
            : [],
      };
    }
    /** The stand-in browser is started asynchronously: wait a while to be sure it was NOT. */
    async function notLaunched(s: Sandbox): Promise<void> {
      await sleep(3000);
      assert.deepEqual(s.browserCalls(), []);
    }

    before(() => {
      openScript = join(scaffold, "scripts", "windows", "open-granted.ps1");
    });

    test("by default it opens an app window: --app=\"<url>\", and says so", async () => {
      const s = await sandbox();
      const out = await s.run(["-Url", "http://localhost:3901/?a=1&b=2", "-NoBrowserFallback"]);
      assert.equal(parseOpenGrantedOutput(out), "window");
      assert.deepEqual(await until(async () => s.browserCalls(), (c) => c.length > 0, 10_000), ['--app="http://localhost:3901/?a=1&b=2"']);
    });

    test("a 'browser' preference is saved where the installer reads it, and then no app window is opened", async () => {
      const s = await sandbox();
      await s.run(["-SetOpenIn", "browser"]);
      assert.equal(parseOpenInSetting(readFileSync(s.settings, "utf8")), "browser", "the installer's parser reads what the script wrote");
      assert.match(await s.run(["-GetOpenIn"]), /"openIn":"browser"/);
      assert.equal(parseOpenGrantedOutput(await s.run(["-Url", "http://localhost:3901", "-NoBrowserFallback"])), "none");
      await notLaunched(s);
    });

    test("a preference the installer saved is what the script follows", async () => {
      const s = await sandbox();
      assert.equal((await saveOpenIn(s.settings, "browser")).ok, true);
      assert.match(await s.run(["-GetOpenIn"]), /"openIn":"browser"/);
    });

    test("REGRESSION (review): the script reads a hand-edited file exactly as the installer does", async () => {
      const s = await sandbox();
      mkdirSync(dirname(s.settings), { recursive: true });
      for (const text of ['{"openIn":["browser"]}', '{"OpenIn":"browser"}', '{"openIn":"Browser"}']) {
        await writeFile(s.settings, text);
        assert.equal(parseOpenInSetting(text), "window", text);
        assert.match(await s.run(["-GetOpenIn"]), /"openIn":"window"/, text);
      }
    });

    test("REGRESSION (review): -SetOpenIn keeps nested settings intact", async () => {
      const s = await sandbox();
      mkdirSync(dirname(s.settings), { recursive: true });
      await writeFile(s.settings, JSON.stringify({ a: { b: { c: { d: 1 } } } }));
      await s.run(["-SetOpenIn", "browser"]);
      assert.deepEqual(JSON.parse(readFileSync(s.settings, "utf8")), { a: { b: { c: { d: 1 } } }, openIn: "browser" });
    });

    test("with no Edge or Chrome it leaves opening to the caller", async () => {
      const s = await sandbox();
      assert.equal(parseOpenGrantedOutput(await s.run(["-Url", "http://localhost:3901", "-NoBrowserFallback"], { GRANTED_APP_BROWSER: "none" })), "none");
    });

    test("REGRESSION (review): anything but a whole http(s) URL is refused, and nothing is launched", async () => {
      const s = await sandbox();
      for (const url of ["C:\\Windows\\System32\\calc.exe", "file:///C:/Windows", "http://localhost:3000/ --evil", 'http://localhost:3000/"x', "localhost:3000"]) {
        await assert.rejects(s.run(["-Url", url, "-NoBrowserFallback"]), url);
      }
      await notLaunched(s);
    });

    test("the tray opens Granted through it (here: Granted already running, a shortcut's -OpenBrowser launch)", async () => {
      const s = await sandbox();
      const port = takePort();
      const existing: Server = await new Promise((r) => {
        const srv = createServer((_q, res) => res.end(GRANTED_HTML));
        srv.listen(port, "127.0.0.1", () => r(srv));
      });
      try {
        const tray = startTray(scaffold, port, ["-OpenBrowser"], s.env());
        assert.equal(await exited(tray), 0);
        assert.deepEqual(await until(async () => s.browserCalls(), (c) => c.length > 0, 10_000), [`--app="http://localhost:${port}"`]);
      } finally {
        existing.close();
      }
    });
  });

  test("shortcuts.ps1 only creates what's asked for, and -Port is carried into the shortcut", async () => {
    const desk = join(root, "Desktop2");
    const start = join(root, "Programs2");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [...PS, join(scaffold, "scripts", "windows", "shortcuts.ps1"), "-StartMenu", "-Port", "3987", "-DesktopDir", desk, "-StartMenuDir", start],
      { windowsHide: true },
    );
    assert.deepEqual(parseShortcutsOutput(stdout), [join(start, "Granted.lnk")]);
    assert.equal(existsSync(join(desk, "Granted.lnk")), false);
    const read = `(New-Object -ComObject WScript.Shell).CreateShortcut('${join(start, "Granted.lnk").replace(/'/g, "''")}').Arguments`;
    const { stdout: lnkArgs } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", read], { windowsHide: true });
    assert.match(lnkArgs.trim(), / -OpenBrowser -Port 3987$/);
  });
});
