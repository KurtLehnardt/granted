/**
 * Integration: the REAL scaffold/scripts/macos/open-granted.sh — Granted in
 * its own window (Chrome/Edge app mode) or in a browser tab — plus the two
 * granted-tray.sh subcommands that go through it. The macOS counterpart of
 * tray.integration.test.ts's "open-granted.ps1" block, and written the same
 * way: a stand-in browser that only records how it was started, a stand-in
 * `open` that only records what it was asked to open, and a settings file per
 * test, so a test never launches a real browser, never opens a real tab and
 * never touches the real ~/Library/Application Support/Granted.
 *
 * Which browsers the machine running this has installed makes no difference:
 * GRANTED_APP_BROWSER_DIRS replaces the folders the script looks in
 * (/Applications and ~/Applications) with throwaway ones holding stand-in
 * .app bundles, and GRANTED_APP_BROWSER_MDFIND replaces (or disables) the
 * Spotlight lookup — so "Chrome is installed", "only Edge is installed" and
 * "neither is installed" are all set up, not waited for.
 *
 * Not macOS-only, unlike the launchctl half of macTray.integration.test.ts:
 * nothing here needs launchd, Spotlight or a real browser, so these run
 * wherever bash and node do — which is what gives them CI coverage today, on
 * the Linux installer job, before the macos-latest job exists. Windows is
 * skipped (no POSIX bash to run the script with).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseOpenGrantedOutput, parseOpenInSetting, withOpenInSetting } from "../ipcPure";
import { macScriptPath, saveOpenIn } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the scripts live in scaffold/.
const MACOS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "macos");
const OPEN_SCRIPT = join(MACOS_SCRIPTS, "open-granted.sh");
const TRAY_SCRIPT = join(MACOS_SCRIPTS, "granted-tray.sh");
const URL = "http://localhost:3979/?a=1&b=2";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(100);
    last = fn();
  }
  return last;
}

interface Sandbox {
  /** The settings file the script reads and writes (never the real one). */
  settings: string;
  /** The stand-in `open`, for a test that has to pass it on itself. */
  openCmd: string;
  /** Run open-granted.sh and return its stdout. */
  run: (args: string[], extra?: Record<string, string>) => Promise<string>;
  /** Run granted-tray.sh (which is what the menu-bar helper calls) and return its stdout. */
  tray: (args: string[], extra?: Record<string, string>) => Promise<string>;
  /** What the stand-in app-mode browser was started with, one line per launch. */
  launched: () => string[];
  /** What the stand-in `open` was asked to open. */
  opened: () => string[];
  /** Deletes the bundle, so that browser reads as "not installed". */
  removeBrowser: (which: "chrome" | "edge") => Promise<void>;
}

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * A throwaway /Applications holding stand-in Chrome and Edge bundles (shell
 * scripts that append their arguments to a log), a stand-in `open`, a
 * stand-in mdfind that finds nothing, and a settings file of its own — so
 * every test can run alone, in any order.
 */
async function sandbox(options: { browsers?: Array<"chrome" | "edge"> } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "granted-open-it-"));
  roots.push(root);
  const apps = join(root, "Applications");
  const launchLog = join(root, "launched.log");
  const openLog = join(root, "opened.log");
  const bundles: Record<"chrome" | "edge", string> = {
    chrome: join(apps, "Google Chrome.app"),
    edge: join(apps, "Microsoft Edge.app"),
  };
  for (const which of options.browsers ?? ["chrome", "edge"]) {
    const macOS = join(bundles[which], "Contents", "MacOS");
    await mkdir(macOS, { recursive: true });
    const binary = join(macOS, which === "chrome" ? "Google Chrome" : "Microsoft Edge");
    await writeFile(binary, `#!/bin/sh\nprintf '${which} %s\\n' "$@" >> ${JSON.stringify(launchLog)}\n`, { mode: 0o755 });
  }
  // An /Applications that exists but has nothing in it, so the search really
  // walks more than one folder.
  await mkdir(join(root, "Applications-empty"), { recursive: true });
  const openStandIn = join(root, "fake-open.sh");
  await writeFile(openStandIn, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openLog)}\n`, { mode: 0o755 });
  const settings = join(root, "Granted", "settings.json");
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    GRANTED_SETTINGS_PATH: settings,
    GRANTED_APP_BROWSER_DIRS: `${apps}:${join(root, "Applications-empty")}`,
    GRANTED_APP_BROWSER_MDFIND: "none",
    GRANTED_OPEN_CMD: openStandIn,
    // Never a real app-mode browser, and never the real settings file: the
    // overrides above are what makes that true, so a test that needs the real
    // default must say so itself.
    ...extra,
  });
  const lines = (path: string): string[] =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  return {
    settings,
    openCmd: openStandIn,
    run: async (args, extra = {}) => (await execFileAsync("/bin/bash", [OPEN_SCRIPT, ...args], { env: env(extra) })).stdout,
    tray: async (args, extra = {}) =>
      (await execFileAsync("/bin/bash", [TRAY_SCRIPT, ...args, "--port", "3979"], { env: env({ GRANTED_LOG_DIR: join(root, "logs"), ...extra }) })).stdout,
    launched: () => lines(launchLog),
    opened: () => lines(openLog),
    removeBrowser: async (which) => rm(bundles[which], { recursive: true, force: true }),
  };
}

/** The stand-in browser is started detached: wait a while to be sure it was NOT. */
async function notLaunched(s: Sandbox): Promise<void> {
  await sleep(1500);
  assert.deepEqual(s.launched(), []);
}

describe(
  "open-granted.sh: Granted in its own window (Chrome/Edge app mode) or a browser tab",
  { skip: (process.platform === "win32" || !existsSync(OPEN_SCRIPT)) && "needs a POSIX bash, run from installer/" },
  () => {
    test("the installer looks for the script exactly where the repo keeps it", () => {
      // A literal, not join()-derived: re-deriving the expectation with the
      // same join that built it cannot catch the path being wrong (the same
      // mistake appUpdate/install.ts's settingsPath comment records).
      assert.equal(macScriptPath("/granted/scaffold", "open-granted.sh"), "/granted/scaffold/scripts/macos/open-granted.sh");
      assert.ok(existsSync(TRAY_SCRIPT), "and the tray script that calls it is there too");
    });

    // --- which browser, and whether there is one ---------------------------

    test("Chrome is preferred, then Edge, then nothing — whatever is actually installed on this machine", async () => {
      const both = await sandbox();
      assert.match(await both.run(["--find-browser"]), /Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/m);
      await both.removeBrowser("chrome");
      assert.match(await both.run(["--find-browser"]), /Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge$/m);
      await both.removeBrowser("edge");
      assert.equal((await both.run(["--find-browser"])).trim(), "", "neither installed: no app-mode browser");
    });

    test("a browser in the per-user ~/Applications counts too (a Chrome installed without admin rights)", async () => {
      const s = await sandbox({ browsers: [] });
      const home = await mkdtemp(join(tmpdir(), "granted-user-apps-"));
      roots.push(home);
      const userApps = join(home, "Applications");
      const macOS = join(userApps, "Google Chrome.app", "Contents", "MacOS");
      await mkdir(macOS, { recursive: true });
      await writeFile(join(macOS, "Google Chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      assert.equal((await s.run(["--find-browser"])).trim(), "", "not in the folders it was told to search");
      assert.match(await s.run(["--find-browser"], { GRANTED_APP_BROWSER_DIRS: `/nowhere:${userApps}` }), /Google Chrome$/m);
    });

    test("a browser somewhere else entirely is found through Spotlight, and a Spotlight that answers nothing is not an error", async () => {
      const s = await sandbox({ browsers: [] });
      const elsewhere = await mkdtemp(join(tmpdir(), "granted-elsewhere-"));
      roots.push(elsewhere);
      const bundle = join(elsewhere, "Google Chrome.app");
      await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(bundle, "Contents", "MacOS", "Google Chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // A stand-in mdfind: it answers for Chrome's bundle id and nothing else,
      // the way a real Spotlight with only Chrome indexed would.
      const mdfind = join(elsewhere, "fake-mdfind.sh");
      await writeFile(
        mdfind,
        `#!/bin/sh\ncase "$*" in *com.google.Chrome*) printf '%s' ${JSON.stringify(bundle)} ;; esac\n`,
        { mode: 0o755 },
      );
      assert.match(await s.run(["--find-browser"], { GRANTED_APP_BROWSER_MDFIND: mdfind }), /Google Chrome$/m);
      const silent = join(elsewhere, "silent-mdfind.sh");
      await writeFile(silent, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      assert.equal((await s.run(["--find-browser"], { GRANTED_APP_BROWSER_MDFIND: silent })).trim(), "");
      assert.equal((await s.run(["--find-browser"], { GRANTED_APP_BROWSER_MDFIND: "/nonexistent/mdfind" })).trim(), "");
    });

    // --- opening ----------------------------------------------------------

    test('by default it opens an app window: --app="<url>", and says so', async () => {
      const s = await sandbox();
      const out = await s.run(["--url", URL, "--no-browser-fallback"]);
      assert.equal(parseOpenGrantedOutput(out), "window");
      const reported = JSON.parse(out.trim()) as { browser: string | null };
      assert.match(reported.browser ?? "", /Google Chrome$/, "and which browser it used");
      assert.deepEqual(await until(() => s.launched(), (l) => l.length > 0), [`chrome --app=${URL}`]);
      assert.deepEqual(s.opened(), [], "and no browser tab on top of it");
    });

    test("with no Chrome or Edge it opens a browser tab instead (Safari, on a stock Mac)", async () => {
      const s = await sandbox({ browsers: [] });
      const out = await s.run(["--url", URL]);
      assert.equal(parseOpenGrantedOutput(out), "browser");
      assert.equal((JSON.parse(out.trim()) as { browser: string | null }).browser, null);
      assert.deepEqual(s.opened(), [URL]);
      await notLaunched(s);
    });

    test("with no Chrome or Edge and --no-browser-fallback it opens nothing, and leaves that to the caller", async () => {
      const s = await sandbox({ browsers: [] });
      assert.equal(parseOpenGrantedOutput(await s.run(["--url", URL, "--no-browser-fallback"])), "none");
      assert.deepEqual(s.opened(), []);
      await notLaunched(s);
    });

    test("GRANTED_APP_BROWSER=none is how a test says 'no app-mode browser', whatever is installed", async () => {
      const s = await sandbox();
      assert.equal(parseOpenGrantedOutput(await s.run(["--url", URL, "--no-browser-fallback"], { GRANTED_APP_BROWSER: "none" })), "none");
      await notLaunched(s);
    });

    test("a browser that can't be run falls back to a tab rather than reporting a window", async () => {
      const s = await sandbox();
      const out = await s.run(["--url", URL], { GRANTED_APP_BROWSER: join(MACOS_SCRIPTS, "no-such-browser") });
      assert.equal(parseOpenGrantedOutput(out), "browser");
      assert.deepEqual(s.opened(), [URL]);
      await notLaunched(s);
    });

    // --- the preference ---------------------------------------------------

    test("a 'browser' preference is saved where the installer reads it, and then no app window is opened", async () => {
      const s = await sandbox();
      await s.run(["--set-open-in", "browser"]);
      assert.equal(parseOpenInSetting(readFileSync(s.settings, "utf8")), "browser", "the installer's parser reads what the script wrote");
      assert.match(await s.run(["--get-open-in"]), /"openIn":"browser"/);
      const out = await s.run(["--url", URL]);
      assert.equal(parseOpenGrantedOutput(out), "browser");
      assert.deepEqual(s.opened(), [URL], "a tab, even though Chrome is right there");
      await notLaunched(s);
      await s.run(["--set-open-in", "window"]);
      assert.match(await s.run(["--get-open-in"]), /"openIn":"window"/);
      assert.equal(parseOpenGrantedOutput(await s.run(["--url", URL, "--no-browser-fallback"])), "window");
    });

    test("a preference the installer saved is what the script follows, and the other way round", async () => {
      const s = await sandbox();
      assert.equal((await saveOpenIn(s.settings, "browser")).ok, true);
      assert.match(await s.run(["--get-open-in"]), /"openIn":"browser"/);
      await s.run(["--set-open-in", "window"]);
      assert.equal(parseOpenInSetting(readFileSync(s.settings, "utf8")), "window");
      // Byte for byte what the installer itself would have written.
      assert.equal(readFileSync(s.settings, "utf8"), withOpenInSetting('{"openIn":"browser"}', "window"));
    });

    test("the script reads a hand-edited file exactly as the installer does", async () => {
      const s = await sandbox();
      await mkdir(dirname(s.settings), { recursive: true });
      for (const text of ['{"openIn":["browser"]}', '{"OpenIn":"browser"}', '{"openIn":"Browser"}', "[]", "not json at all", ""]) {
        await writeFile(s.settings, text);
        assert.equal(parseOpenInSetting(text), "window", text);
        assert.match(await s.run(["--get-open-in"]), /"openIn":"window"/, text);
      }
      // A BOM, which a file hand-edited on Windows can carry: the installer
      // strips it, so the script has to as well.
      await writeFile(s.settings, "\uFEFF" + '{"openIn":"browser"}');
      assert.equal(parseOpenInSetting(readFileSync(s.settings, "utf8")), "browser");
      assert.match(await s.run(["--get-open-in"]), /"openIn":"browser"/);
    });

    test("--set-open-in keeps every other setting, nested ones included", async () => {
      const s = await sandbox();
      await mkdir(dirname(s.settings), { recursive: true });
      await writeFile(s.settings, JSON.stringify({ autoUpdate: true, lastAutoCheck: 1234, a: { b: { c: { d: 1 } } } }));
      await s.run(["--set-open-in", "browser"]);
      assert.deepEqual(JSON.parse(readFileSync(s.settings, "utf8")), {
        autoUpdate: true,
        lastAutoCheck: 1234,
        a: { b: { c: { d: 1 } } },
        openIn: "browser",
      });
    });

    test("--set-open-in refuses anything but window or browser, and writes nothing", async () => {
      const s = await sandbox();
      await assert.rejects(() => s.run(["--set-open-in", "sideways"]), /must be window or browser/);
      assert.equal(existsSync(s.settings), false);
    });

    // --- the URL ----------------------------------------------------------

    test("anything but a whole http(s) URL is refused, and nothing is launched or opened", async () => {
      const s = await sandbox();
      for (const url of [
        "/Applications/Calculator.app",
        "file:///etc/passwd",
        "http://localhost:3000/ --evil",
        'http://localhost:3000/"x',
        "http://localhost:3000/$(touch /tmp/granted-open-granted-test-pwned)",
        "http://localhost:3000/`id`",
        "localhost:3000",
      ]) {
        await assert.rejects(() => s.run(["--url", url]), /must be an http\(s\) URL/, url);
      }
      await assert.rejects(() => s.run(["--url", ""]), /usage: open-granted\.sh/, "and an empty one says how to call it");
      await assert.rejects(() => s.run(["--sideways"]), /unknown option --sideways/);
      await notLaunched(s);
      assert.deepEqual(s.opened(), []);
      assert.equal(existsSync("/tmp/granted-open-granted-test-pwned"), false, "nothing was ever handed to a shell");
    });

    test("an https URL, and a URL whose query a shell would have mangled, both open as one argument", async () => {
      const s = await sandbox();
      const tricky = "https://localhost:3979/?q=a&b=%20c;d|e";
      assert.equal(parseOpenGrantedOutput(await s.run(["--url", tricky, "--no-browser-fallback"])), "window");
      assert.deepEqual(await until(() => s.launched(), (l) => l.length > 0), [`chrome --app=${tricky}`]);
    });

    // --- granted-tray.sh, which is what the menu-bar helper calls ---------

    describe("granted-tray.sh goes through it, so the menu and the installer agree", () => {
      test("`open` opens an app window when that's the preference, and a tab when it isn't", async () => {
        const s = await sandbox();
        await s.tray(["open"]);
        assert.deepEqual(await until(() => s.launched(), (l) => l.length > 0), ["chrome --app=http://localhost:3979"]);
        assert.deepEqual(s.opened(), []);
        await s.tray(["set-open-in", "--mode", "browser"]);
        await s.tray(["open"]);
        assert.deepEqual(s.opened(), ["http://localhost:3979"]);
        assert.equal(s.launched().length, 1, "still only the one app window");
      });

      test("`open-in` and `set-open-in` are the installer's own setting, in the installer's own file", async () => {
        const s = await sandbox();
        assert.match(await s.tray(["open-in"]), /"openIn":"window"/);
        await s.tray(["set-open-in", "--mode", "browser"]);
        assert.equal(parseOpenInSetting(readFileSync(s.settings, "utf8")), "browser");
        assert.match(await s.tray(["open-in"]), /"openIn":"browser"/);
        assert.equal((await saveOpenIn(s.settings, "window")).ok, true);
        assert.match(await s.tray(["open-in"]), /"openIn":"window"/, "a change the installer made is seen at once");
      });

      test("`set-open-in` refuses a mode that isn't window or browser", async () => {
        const s = await sandbox();
        await assert.rejects(() => s.tray(["set-open-in", "--mode", "sideways"]), /--mode window or --mode browser/);
        await assert.rejects(() => s.tray(["set-open-in"]), /--mode window or --mode browser/);
        assert.equal(existsSync(s.settings), false);
      });

      test("an install too old to have open-granted.sh still opens Granted — in a tab — and says saving failed", async () => {
        const s = await sandbox();
        // The real tray script, alone in a scripts/macos with no
        // open-granted.sh beside it: an install made before this landed.
        const root = await mkdtemp(join(tmpdir(), "granted-old-install-"));
        roots.push(root);
        const scripts = join(root, "granted", "scaffold", "scripts", "macos");
        await mkdir(scripts, { recursive: true });
        const oldTray = join(scripts, "granted-tray.sh");
        await writeFile(oldTray, readFileSync(TRAY_SCRIPT, "utf8"), { mode: 0o755 });
        const tray = (args: string[]): Promise<{ stdout: string }> =>
          execFileAsync("/bin/bash", [oldTray, ...args, "--port", "3979"], {
            env: {
              ...process.env,
              GRANTED_SETTINGS_PATH: s.settings,
              GRANTED_LOG_DIR: join(root, "logs"),
              GRANTED_OPEN_CMD: s.openCmd,
            },
          });
        // Granted still opens, in a tab.
        await tray(["open"]);
        assert.deepEqual(s.opened(), ["http://localhost:3979"]);
        assert.deepEqual(s.launched(), [], "no app window: there is nothing here that knows how to open one");
        // Reading the preference falls back to the default rather than failing…
        assert.match((await tray(["open-in"])).stdout, /"openIn":"window"/);
        // …and saving fails, which is what makes the menu put its tick back.
        await assert.rejects(() => tray(["set-open-in", "--mode", "browser"]), /no .*open-granted\.sh in this install/);
      });
    });
  },
);
