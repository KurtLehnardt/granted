/**
 * Integration: the REAL scaffold/scripts/macos/update.sh — Settings → About
 * Granted → "Update to vX.Y.Z" — run against throwaway installs that the REAL
 * install-macos.sh made from local stand-in git repos with annotated release
 * tags, so everything runs offline and nothing is downloaded. The macOS
 * counterpart of the update.ps1 half of installRef.integration.test.ts, and it
 * covers the same four things that file does: a successful update that stops
 * the running Granted and starts it again on the same port, an update that
 * fails half-way and puts the previous version back (and starts the version it
 * put back), a declined update that never stops anything, and an updater that
 * outlives the server which started it (the app's real startUpdater, with its
 * parent killed). It also covers the one hazard macOS has and Windows does
 * not: update.sh being rewritten in place while it runs, which is what it
 * hands over to a copy of itself to survive.
 *
 * Nothing here touches anything real, by the same means every other macOS
 * integration test in this family uses: a throwaway LaunchAgent label
 * (GRANTED_LAUNCH_LABEL) whose plist lives in a temp folder, temp settings and
 * log folders, a temp TMPDIR, no menu-bar helper, a stand-in for `open`, and a
 * port no real Granted uses. The user's own install, LaunchAgents, settings and
 * logs are never reachable from here.
 *
 * The file-shape checks run anywhere; everything that runs the script is macOS
 * only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { probeGranted, readStatusFile } from "../openGranted";

const execFileAsync = promisify(execFile);
// `npm test` runs from installer/; the scripts live in scaffold/ and the
// install script at the repo root.
const REPO_ROOT = resolve(process.cwd(), "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "install-macos.sh");
const MACOS_SCRIPTS = join(REPO_ROOT, "scaffold", "scripts", "macos");
const UPDATE_SCRIPT = join(MACOS_SCRIPTS, "update.sh");
const APP_INSTALL_TS = join(REPO_ROOT, "scaffold", "lib", "appUpdate", "install.ts");
// Not 3973 (macUninstall), 3975 (macLauncher), 3977 (macTray), 3978
// (installRefMac) or 3979 (installRef): a real Granted, or another test's fake
// one, must never be mistaken for this one's.
const PORT = 3971;
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(500);
    last = await fn();
  }
  return last;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

// --- file-shape checks (any platform) --------------------------------------

test(
  "update.sh decides every refusal before it stops anything, and puts the previous version back when the install fails",
  { skip: !existsSync(UPDATE_SCRIPT) && "run from installer/" },
  () => {
    const script = readFileSync(UPDATE_SCRIPT, "utf8");
    // The code only, with the comments stripped: the header explains at length
    // what this script does and why, and those sentences must not be mistaken
    // for the thing itself.
    //
    // Every regex below that matches this text tolerates CRLF (`\r?\n`), the
    // convention macTray.integration.test.ts records: nothing in this repo
    // forces LF on checkout, so on the Windows runner — where this test is NOT
    // skipped, because it reads a file rather than running it — every line ends
    // with a carriage return. A bare `\n` here passes locally and fails there.
    const code = script
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    // Both refusals that must be decided BEFORE Granted is stopped: the
    // installer's marker and a dirty working tree. Each is checked above the
    // line that stops the server, which is the whole property.
    const marker = code.indexOf('if [ ! -f "$MARKER" ]; then');
    const dirty = code.indexOf('git -C "$INSTALL_DIR" status --porcelain');
    const stop = code.indexOf('"$TRAY_SCRIPT" stop --port "$PORT"');
    const install = code.indexOf('/bin/bash "$INSTALL_SCRIPT"');
    assert.ok(marker > 0, "the installer's marker is checked");
    assert.ok(dirty > 0, "local changes are checked");
    assert.ok(stop > 0, "Granted is stopped");
    assert.ok(marker < stop && dirty < stop, "both refusals are decided before anything is stopped");
    assert.ok(stop < install, "and Granted is stopped before the install step runs");
    assert.match(code, /MARKER="\$INSTALL_DIR\/\.git\/granted-installer"/);

    // Stopping and starting Granted are granted-tray.sh's business, never
    // reimplemented here (no launchctl of its own).
    assert.match(code, /"\$TRAY_SCRIPT" start --port "\$PORT"/);
    assert.ok(!code.includes("launchctl"), "the LaunchAgent is granted-tray.sh's business");

    // The rollback: back to the head this run started from, and only called
    // "put back" once the restore's own npm ci succeeded.
    assert.match(code, /PREV_HEAD="\$\(git -C "\$INSTALL_DIR" rev-parse HEAD/);
    assert.match(code, /checkout --quiet "\$PREV_HEAD"/);
    assert.match(code, /RESTORED=" Granted v\$FROM was put back\."/);
    const restore = code.indexOf('"$NPM_BIN" ci --no-audit --no-fund');
    assert.ok(restore > 0 && restore < code.indexOf('RESTORED=" Granted'), "npm ci runs before it claims the version is back");

    // The status file is the one the app already reads, in the folder the
    // settings file is in — not a new protocol and not a new location.
    assert.match(code, /STATUS_FILE="\$SUPPORT_DIR\/update-status\.json"/);
    assert.match(code, /GRANTED_SETTINGS_PATH:-\$HOME\/Library\/Application Support\/Granted\/settings\.json/);
    assert.match(code, /"state":"%s","from":%s,"to":%s,"message":%s,"at":"%s"/);

    // It runs from a copy of itself, outside the folder it is about to switch
    // over (see the header), and that copy is removed again.
    assert.match(code, /exec \/bin\/bash "\$SELF_COPY" "\$@"/);
    assert.match(code, /GRANTED_UPDATE_REEXEC/);
    assert.match(code, /rm -f -- "\$GRANTED_UPDATE_SELF_COPY"/);

    // The release tag is matched with bash's own `=~`, never a `printf | grep
    // -q` pipeline: `grep -q` exits on its first match, which can SIGPIPE the
    // printf feeding it, and under `set -o pipefail` that becomes the
    // pipeline's status — a good tag rejected at random.
    assert.match(code, /\[\[ ! "\$REF" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/);
    assert.ok(!/grep -qE '\^v\[0-9\]/.test(code), "no grep -q pipeline for the tag check");

    // A failing install is handled here, not reported by the ERR trap as an
    // internal failure: the left-hand side of a `||` is the one place that trap
    // is documented to skip, and `set +e` would not have skipped it.
    assert.match(code, /\|\| INSTALL_CODE=\$\?/);
    assert.ok(!/^set \+e$/m.test(code), "no set +e: it does not stop the ERR trap");
    // A failure anywhere has to reach that trap at all: bash does not run it
    // inside a shell function without errtrace.
    assert.match(code, /^set -o errtrace$/m);
    assert.match(code, /^trap 'on_error "\$LINENO" "\$BASH_COMMAND"' ERR$/m);
    // An update that is already under way must not be hung up on.
    assert.match(code, /^trap '' HUP$/m);
  },
);

test(
  "the app starts update.sh the way it starts the uninstaller: detached, out of the install, output in a file",
  { skip: !existsSync(APP_INSTALL_TS) && "run from installer/" },
  () => {
    const source = readFileSync(APP_INSTALL_TS, "utf8");
    // The script it runs is the one installInfo() reported, passed in — not a
    // path rebuilt here (REGRESSION (review): startMacUpdater used to rebuild
    // it with its own path.posix.join and leave installInfo().script unused, so
    // the two could drift apart silently).
    assert.match(source, /startDetached\("\/bin\/bash", \[script, "--ref", ref, "--port", String\(port\)\]/);
    assert.ok(!/path\.posix\.join\(dir, "scripts", "macos", "update\.sh"\)/.test(source), "the updater's path is not worked out twice");
    // Both of the things an install does to itself go through the one helper,
    // so neither can drift away from the other, and both are given the script
    // their own *Info() reported.
    assert.match(source, /startDetached\("\/bin\/bash", uninstallArgs\(script, choice\)/);
    assert.match(source, /cwd: "\/",\r?\n\s*detached: true,/);
    // darwin is a first-class answer from installInfo now, not "not Windows",
    // and one table says both where each platform's updater is and how it is
    // started — so nothing can be offered an update and then handed another
    // platform's updater (REGRESSION (review): `platform === "darwin" ? mac :
    // windows` made Windows the implicit answer for every other platform).
    assert.match(source, /darwin: \{ script: \["scripts", "macos", "update\.sh"\], start: startMacUpdater \}/);
    assert.match(source, /if \(!updater\) return Promise\.reject\(/);
    assert.ok(!/platform === "darwin" \? start/.test(source), "no ternary that defaults every other platform to Windows");
    assert.ok(!source.includes('"not-windows"'), "the reason is about having an updater, not about Windows");
  },
);

// --- the real thing (macOS) ------------------------------------------------

interface Box {
  /** The temp root everything for this box lives under. */
  root: string;
  /** The folder the install was made in (the install is $home/granted). */
  home: string;
  installDir: string;
  scaffold: string;
  source: string;
  updateScript: string;
  trayScript: string;
  label: string;
  supportDir: string;
  logDir: string;
  tmp: string;
  env: Record<string, string>;
  agentLoaded: () => boolean;
}

describe(
  "update.sh, run for real against throwaway installs",
  { skip: (process.platform !== "darwin" || !existsSync(UPDATE_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let root: string;
    const boxes: Box[] = [];
    const started: ChildProcess[] = [];
    let seq = 0;

    /** Commits scaffold at `version` (a runnable fake: `npm run dev` serves Granted's page on $PORT), optionally tagging it. */
    function commitVersion(source: string, version: string, tag: string | null, extra: Record<string, string> = {}): void {
      const scaffold = join(source, "scaffold");
      writeFileSync(join(scaffold, "package.json"), JSON.stringify({ name: "granted", version, private: true, scripts: { dev: "node server.js" } }, null, 2));
      writeFileSync(
        join(scaffold, "package-lock.json"),
        JSON.stringify({ name: "granted", version, lockfileVersion: 3, requires: true, packages: { "": { name: "granted", version } } }, null, 2),
      );
      writeFileSync(
        join(scaffold, "server.js"),
        `require("node:http").createServer((q, r) => r.end(${JSON.stringify(GRANTED_HTML)})).listen(Number(process.env.PORT), "127.0.0.1");`,
      );
      for (const [name, contents] of Object.entries(extra)) {
        mkdirSync(join(scaffold, name, ".."), { recursive: true });
        writeFileSync(join(scaffold, name), contents);
      }
      git(source, "add", "-A");
      git(source, "commit", "-q", "-m", `version ${version}`);
      if (tag) git(source, "tag", "-f", "-a", tag, "-m", tag); // annotated, as real releases are
    }

    /**
     * A stand-in for the GitHub repo, carrying the REAL macOS scripts (so the
     * install made from it has the real update.sh and granted-tray.sh in it):
     * v0.1.0, v0.2.0, then main moved on to 0.3.0-dev.
     */
    function makeSource(): string {
      const source = join(root, `source-${seq++}`);
      mkdirSync(join(source, "scaffold", "scripts", "macos"), { recursive: true });
      for (const f of readdirSync(MACOS_SCRIPTS).filter((f) => f.endsWith(".sh"))) {
        writeFileSync(join(source, "scaffold", "scripts", "macos", f), readFileSync(join(MACOS_SCRIPTS, f), "utf8"));
      }
      git(source, "init", "-q", "-b", "main");
      commitVersion(source, "0.1.0", "v0.1.0");
      commitVersion(source, "0.2.0", "v0.2.0");
      commitVersion(source, "0.3.0-dev", null);
      return source;
    }

    /** A throwaway install of `ref`, really made by install-macos.sh, with its own label, settings, logs and TMPDIR. */
    async function makeBox(options: { ref?: string | null; source?: string } = {}): Promise<Box> {
      // realpath: mkdtemp hands back /var/folders/…, a symlink to
      // /private/var/folders/…, and the scripts resolve their own location
      // with `pwd -P` — so what they report is the resolved path.
      const base = realpathSync(await mkdtemp(join(root, "box-")));
      const home = join(base, "home");
      const supportDir = join(base, "Application Support", "Granted");
      const logDir = join(base, "Logs", "Granted");
      const launchAgentsDir = join(base, "LaunchAgents");
      const tmp = join(base, "tmp");
      for (const d of [home, supportDir, logDir, launchAgentsDir, tmp]) mkdirSync(d, { recursive: true });
      // A stand-in for `open`, so nothing a test opens reaches a real browser.
      const openCmd = join(base, "fake-open.sh");
      await writeFile(openCmd, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(join(base, "opened.log"))}\n`, { mode: 0o755 });
      const label = `com.granted.test.${randomUUID()}`;
      const source = options.source ?? makeSource();
      const env: Record<string, string> = {
        GRANTED_REPO_URL: source,
        GRANTED_INSTALL_DIR: "granted",
        GRANTED_LAUNCH_LABEL: label,
        GRANTED_LAUNCH_AGENTS_DIR: launchAgentsDir,
        GRANTED_LOG_DIR: logDir,
        GRANTED_SETTINGS_PATH: join(supportDir, "settings.json"),
        GRANTED_MENUBAR_HELPER: "none",
        GRANTED_APP_BROWSER: "none",
        GRANTED_OPEN_CMD: openCmd,
        // Every temporary file either script makes lands in here, so a test can
        // assert that they were all cleaned up again.
        TMPDIR: tmp,
        npm_config_audit: "false",
        npm_config_fund: "false",
      };
      const installDir = join(home, "granted");
      const uid = process.getuid?.() ?? 0;
      const box: Box = {
        root: base,
        home,
        installDir,
        scaffold: join(installDir, "scaffold"),
        source,
        updateScript: join(installDir, "scaffold", "scripts", "macos", "update.sh"),
        trayScript: join(installDir, "scaffold", "scripts", "macos", "granted-tray.sh"),
        label,
        supportDir,
        logDir,
        tmp,
        env,
        agentLoaded: () => {
          try {
            execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" });
            return true;
          } catch {
            return false;
          }
        },
      };
      boxes.push(box);
      if (options.ref !== null) {
        const r = await runInstall(box, options.ref ?? "v0.1.0");
        assert.equal(r.state, "done", r.output);
      }
      return box;
    }

    /** Runs the real install-macos.sh in the box's home; returns its status and console output. */
    async function runInstall(box: Box, ref: string | null, extra: Record<string, string> = {}): Promise<{ state: string | null; message: string | null; output: string }> {
      const status = join(box.root, `install-status-${seq++}.json`);
      const env: NodeJS.ProcessEnv = { ...process.env, ...box.env, GRANTED_STATUS_FILE: status, GRANTED_PORT: String(PORT), ...extra };
      if (ref) env["GRANTED_REF"] = ref;
      else delete env["GRANTED_REF"];
      let output = "";
      try {
        const r = await execFileAsync("bash", [INSTALL_SCRIPT], { cwd: box.home, env, timeout: 240_000 });
        output = r.stdout + r.stderr;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = (e.stdout ?? "") + (e.stderr ?? "");
      }
      const s = await readStatusFile(status);
      return { state: s?.state ?? null, message: s?.message ?? null, output };
    }

    /**
     * Runs the INSTALLED copy's own update.sh — what Settings → Update starts —
     * and returns the update-status.json it wrote. GRANTED_INSTALL_SCRIPT points
     * it at this repo's install-macos.sh instead of downloading the release's,
     * which is the same override update.ps1's tests use.
     */
    async function update(
      box: Box,
      ref: string,
      args: string[] = [],
      extraEnv: Record<string, string> = {},
    ): Promise<{ status: Record<string, unknown>; output: string }> {
      let output = "";
      try {
        const r = await execFileAsync("/bin/bash", [box.updateScript, "--ref", ref, "--port", String(PORT), ...args], {
          cwd: box.home,
          env: { ...process.env, ...box.env, GRANTED_INSTALL_SCRIPT: INSTALL_SCRIPT, ...extraEnv },
          timeout: 300_000,
        });
        output = r.stdout + r.stderr;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = (e.stdout ?? "") + (e.stderr ?? "");
      }
      let status: Record<string, unknown> = {};
      try {
        status = JSON.parse(readFileSync(join(box.supportDir, "update-status.json"), "utf8")) as Record<string, unknown>;
      } catch {
        /* nothing written */
      }
      return { status, output };
    }

    const versionIn = (box: Box): string =>
      (JSON.parse(readFileSync(join(box.scaffold, "package.json"), "utf8")) as { version: string }).version;

    /** Starts Granted in the background from the box's own install, as the installer does, and waits for it. */
    async function startGranted(box: Box): Promise<void> {
      await execFileAsync("/bin/bash", [box.trayScript, "start", "--port", String(PORT)], {
        env: { ...process.env, ...box.env },
        timeout: 180_000,
      });
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted", "Granted is running");
    }

    const stopGranted = async (box: Box): Promise<void> => {
      await execFileAsync("/bin/bash", [box.trayScript, "stop", "--port", String(PORT)], {
        env: { ...process.env, ...box.env },
        timeout: 120_000,
      }).catch(() => {});
      await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 1000), (p) => p === "down", 30_000);
    };

    before(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "granted-mac-update-it-")));
    });

    after(async () => {
      for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // Whatever any test left running or registered on the machine running the
      // tests: stopped and booted out, through the script and directly.
      for (const b of boxes) {
        try {
          if (existsSync(b.trayScript)) {
            execFileSync("/bin/bash", [b.trayScript, "stop", "--port", String(PORT)], { stdio: "ignore", env: { ...process.env, ...b.env } });
          }
        } catch {
          /* nothing was running */
        }
        try {
          execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${b.label}`], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    });

    test("stops the running Granted, moves the install to the release, and starts Granted again on the same port", async () => {
      const box = await makeBox();
      await startGranted(box);
      assert.ok(box.agentLoaded(), "the throwaway LaunchAgent is loaded");
      try {
        const { status, output } = await update(box, "v0.2.0");
        assert.equal(status["state"], "done", `${JSON.stringify(status)}\n${output}`);
        assert.equal(status["from"], "0.1.0");
        assert.equal(status["to"], "v0.2.0");
        assert.equal(status["message"] ?? null, null);
        assert.equal(versionIn(box), "0.2.0");
        assert.equal(git(box.installDir, "describe", "--tags", "--exact-match"), "v0.2.0");
        // Started again, in the background, on the same port — and really
        // under launchd again, not just answering.
        assert.equal(
          await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"),
          "granted",
          "Granted is back on the same port",
        );
        assert.ok(box.agentLoaded(), "and back under its LaunchAgent");
        // Really stopped and started again, not merely still answering: the
        // server log this run wrote was rotated aside, which granted-tray.sh
        // only does when it is starting a server that was not there.
        assert.ok(existsSync(join(box.logDir, `server-${PORT}.log.previous`)), "the server that was running really was stopped and started again");
        // The install's own output was kept, and the status timestamp is
        // something the page can compare against (ISO 8601, with milliseconds).
        assert.match(readFileSync(join(box.logDir, "update.log"), "utf8"), /now at v0\.2\.0/, "the install's own output was kept");
        assert.match(String(status["at"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        // Everything it made outside the install was cleaned up again: the copy
        // of itself, the downloaded install script, the install's status file.
        const left = readdirSync(box.tmp).filter((f) => f.startsWith("granted-update"));
        assert.deepEqual(left, [], `temporary files left behind: ${left.join(", ")}`);
      } finally {
        await stopGranted(box);
      }
    });

    test("REGRESSION: the release it installs may ship a different update.sh — the update still finishes", async () => {
      // update.sh lives in the folder it is switching over, so the file it was
      // read from is replaced partway through its own run. It copies itself out
      // first for exactly this reason (see its header); here the release really
      // does replace it, with something that is not the updater at all.
      const source = makeSource();
      git(source, "checkout", "-q", "-b", "newer-updater", "v0.2.0");
      commitVersion(source, "0.2.2", "v0.2.2", { "scripts/macos/update.sh": "#!/bin/sh\necho 'a completely different updater'\n" });
      git(source, "checkout", "-q", "main");
      const box = await makeBox({ source });
      const { status, output } = await update(box, "v0.2.2", ["--no-restart"]);
      assert.equal(status["state"], "done", `${JSON.stringify(status)}\n${output}`);
      assert.equal(versionIn(box), "0.2.2");
      assert.match(readFileSync(box.updateScript, "utf8"), /a completely different updater/, "the new release's script is what is installed now");
    });

    test("REGRESSION: update.sh is REWRITTEN IN PLACE while it runs — the copy it handed over to finishes the update anyway", async () => {
      // The hazard the self-copy exists for (see update.sh's header), and the
      // only test that actually exercises it. The "ships a different update.sh"
      // test above does NOT: `git checkout` unlinks the old file and creates a
      // new one, so a running bash goes on reading the old inode and passes
      // with or without the self-copy. A rewrite IN PLACE keeps the inode, and
      // that really does break a running bash — measured again on the machine
      // this was written on: the shell reads the NEW bytes at its OLD offset,
      // having already run half the script, and then runs whatever it finds
      // there (exit 127, mid-line, in that measurement).
      //
      // So: hold the install step open at a known moment, rewrite the installed
      // update.sh in place while the update is in flight (same inode,
      // asserted), then let it finish and require the update to have completed
      // correctly. A stand-in install script rather than the real
      // install-macos.sh because that handshake is the whole point — the
      // rewrite has to land mid-run, and the real script reaches no moment a
      // test can wait on.
      const box = await makeBox();
      const ready = join(box.root, "install-started");
      const go = join(box.root, "install-may-finish");
      const standIn = join(box.root, "slow-install.sh");
      await writeFile(
        standIn,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          `printf 'started\\n' > ${JSON.stringify(ready)}`,
          `while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.1; done`,
          // What install-macos.sh's update path does, reduced to the one step
          // this test is about: move the install to the release it was asked
          // for, and report "done" in its own status file.
          `git -C ${JSON.stringify(box.installDir)} -c advice.detachedHead=false checkout --quiet "refs/tags/$GRANTED_REF"`,
          `printf 'now at %s\\n' "$GRANTED_REF"`,
          `printf '{"state":"done","message":""}' > "$GRANTED_STATUS_FILE"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // Longer than update.sh itself (~21KB), so a bash that resumed reading at
      // its old offset lands inside this rather than at EOF, and junk from the
      // first line on, so wherever it landed it would run something that is not
      // the updater (and, with `set -e`, stop there).
      const rewritten =
        [
          "#!/bin/bash",
          "echo 'a completely different updater'",
          ...Array.from({ length: 1200 }, (_, i) => `a completely different updater, line ${i} "`),
        ].join("\n") + "\n";

      const running = update(box, "v0.2.0", ["--no-restart"], { GRANTED_INSTALL_SCRIPT: standIn });
      await until(async () => existsSync(ready), (there) => there, 120_000);
      assert.ok(existsSync(ready), "the install step is running");
      // It really is running from a copy of itself outside the install: that
      // copy is in the temporary folder at this very moment.
      const copies = readdirSync(box.tmp).filter((f) => f.startsWith("granted-update."));
      assert.equal(copies.length, 1, `the copy it handed over to: ${readdirSync(box.tmp).join(", ") || "(nothing in TMPDIR)"}`);
      // Truncate and rewrite, which keeps the inode — `cat newcontent >
      // update.sh`, not git's unlink-and-recreate.
      const inode = statSync(box.updateScript).ino;
      writeFileSync(box.updateScript, rewritten);
      assert.equal(statSync(box.updateScript).ino, inode, "rewritten in place: the same file, different bytes");
      await writeFile(go, "");

      const { status, output } = await running;
      assert.equal(status["state"], "done", `${JSON.stringify(status)}\n${output}`);
      assert.equal(status["to"], "v0.2.0");
      assert.equal(versionIn(box), "0.2.0");
      // Nothing of the rewritten file ran, and bash never tripped over it.
      assert.doesNotMatch(output, /a completely different updater|unexpected EOF|syntax error|command not found/);
      // It really was the installed script that was rewritten under it.
      assert.match(readFileSync(box.updateScript, "utf8"), /a completely different updater/);
      // And the copy it ran from removed itself afterwards, as every other run does.
      assert.deepEqual(readdirSync(box.tmp).filter((f) => f.startsWith("granted-update")), []);
    });

    test("REGRESSION: a failed update puts the previous version back, and says so", async () => {
      const source = makeSource();
      // v0.2.1: a release whose npm ci fails (lockfile out of sync with
      // package.json), the same way installRef.integration.test.ts makes one.
      git(source, "checkout", "-q", "-b", "broken", "v0.2.0");
      writeFileSync(
        join(source, "scaffold", "package.json"),
        JSON.stringify({ name: "granted", version: "0.2.1", private: true, scripts: { dev: "node server.js" }, dependencies: { "left-pad": "1.3.0" } }, null, 2),
      );
      git(source, "add", "-A");
      git(source, "commit", "-q", "-m", "broken 0.2.1");
      git(source, "tag", "-a", "v0.2.1", "-m", "v0.2.1");
      git(source, "checkout", "-q", "main");

      const box = await makeBox({ source });
      // NOT --no-restart: the whole point of the rollback is that Granted comes
      // back up by itself, so it can say what happened. Nothing in this test
      // starts it — only the updater does.
      const { status, output } = await update(box, "v0.2.1");
      try {
        assert.equal(status["state"], "error", `${JSON.stringify(status)}\n${output}`);
        assert.match(String(status["message"]), /The update to v0\.2\.1 didn't finish: .*Granted v0\.1\.0 was put back\. Details are in /);
        // The install is the previous release again, whole: the tag it was on,
        // its version, and a working tree with nothing left over.
        assert.equal(versionIn(box), "0.1.0");
        assert.equal(git(box.installDir, "describe", "--tags", "--exact-match"), "v0.1.0");
        assert.equal(git(box.installDir, "status", "--porcelain"), "", "nothing left modified");
        // And the version that was put back really is running again, on the
        // same port and under its own LaunchAgent — which is the only way the
        // page can be told any of the above.
        assert.equal(
          await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"),
          "granted",
          "the updater started the restored Granted again by itself",
        );
        assert.ok(box.agentLoaded(), "and under its LaunchAgent");
      } finally {
        await stopGranted(box);
      }
    });

    test("REGRESSION: a declined update stops nothing — a running Granted keeps running", async () => {
      const box = await makeBox();
      // Work in the folder that isn't on GitHub: install-macos.sh would refuse
      // to switch over it, and update.sh must decide that BEFORE stopping
      // anything.
      writeFileSync(join(box.scaffold, "server.js"), `${readFileSync(join(box.scaffold, "server.js"), "utf8")}\n// my change\n`);
      await startGranted(box);
      try {
        const { status, output } = await update(box, "v0.2.0");
        assert.equal(status["state"], "error", `${JSON.stringify(status)}\n${output}`);
        assert.match(String(status["message"]), /Granted wasn't updated to v0\.2\.0: it has local changes in /);
        assert.equal(versionIn(box), "0.1.0", "not switched while dirty");
        assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "granted", "the running Granted wasn't stopped");
        assert.ok(box.agentLoaded(), "and its LaunchAgent is still loaded");
        // Nothing was installed either, so there is no install log at all.
        assert.equal(existsSync(join(box.logDir, "update.log")), false, "the install step never ran");
      } finally {
        await stopGranted(box);
      }
    });

    test("a folder the installer didn't make is never switched to another release, and nothing is stopped for it", async () => {
      const box = await makeBox();
      await rm(join(box.installDir, ".git", "granted-installer"), { force: true });
      await startGranted(box);
      try {
        const { status } = await update(box, "v0.2.0");
        assert.equal(status["state"], "error", JSON.stringify(status));
        assert.match(String(status["message"]), /Granted wasn't updated to v0\.2\.0: this folder wasn't installed by the Granted installer\./);
        assert.equal(versionIn(box), "0.1.0");
        assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "granted", "someone's own checkout keeps running");
      } finally {
        await stopGranted(box);
      }
    });

    test("an install script that declines after the fact (never backwards) is reported in its own words", async () => {
      const source = makeSource();
      const box = await makeBox({ ref: "v0.2.0", source });
      // An older release that is NOT in this install's history: install-macos.sh
      // refuses it by version, and update.sh reads the reason out of its log.
      git(source, "checkout", "-q", "-b", "maint-0.1", "v0.1.0");
      commitVersion(source, "0.1.5", "v0.1.5", { "patch.txt": "patch" });
      git(source, "checkout", "-q", "main");
      const { status, output } = await update(box, "v0.1.5", ["--no-restart"]);
      assert.equal(status["state"], "error", `${JSON.stringify(status)}\n${output}`);
      assert.match(String(status["message"]), /Granted wasn't updated to v0\.1\.5: Not changing .* it already has a newer Granted \(0\.2\.0\)\./);
      // The reason is quoted with the console colour codes taken off.
      assert.ok(!String(status["message"]).includes("\u001b"), "no console colour codes in what the page shows");
      assert.equal(versionIn(box), "0.2.0", "not moved back");
    });

    test("a --ref that isn't a release tag is refused before anything is done", async () => {
      const box = await makeBox();
      for (const bad of ["main", "v1.2", "v0.2.0; rm -rf /tmp/should-never-run"]) {
        const { status } = await update(box, bad, ["--no-restart"]);
        assert.equal(status["state"], "error", JSON.stringify(status));
        assert.match(String(status["message"]), /--ref must be a release tag like v1\.2\.3/);
        assert.equal(versionIn(box), "0.1.0");
      }
      // An option given no value, and a port that isn't one: exit 64, as every
      // other script in this family answers bad input.
      for (const args of [["--ref"], ["--ref", "v0.2.0", "--port"], ["--ref", "v0.2.0", "--port", "abc"]]) {
        const r = await execFileAsync("/bin/bash", [box.updateScript, ...args], {
          env: { ...process.env, ...box.env },
          timeout: 60_000,
        }).then(
          () => ({ code: 0, stderr: "" }),
          (err: { code?: number; stderr?: string }) => ({ code: err.code ?? -1, stderr: err.stderr ?? "" }),
        );
        assert.equal(r.code, 64, `${args.join(" ")}: ${r.stderr}`);
      }
    });

    test("REGRESSION: the app's real startUpdater launches update.sh, which outlives the server that started it", async () => {
      // A stand-in update.sh that records how it was started, waits, then
      // records that it finished — after its "server" has been killed.
      const dir = join(root, `launch-${seq++}`, "scaffold");
      mkdirSync(join(dir, "scripts", "macos"), { recursive: true });
      const startedFile = join(dir, "started.txt");
      const finishedFile = join(dir, "finished.txt");
      writeFileSync(
        join(dir, "scripts", "macos", "update.sh"),
        [
          "#!/bin/bash",
          `printf '%s\\n' "$*" > ${JSON.stringify(startedFile)}`,
          "sleep 6",
          `printf 'done\\n' > ${JSON.stringify(finishedFile)}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // The "server": a node process calling the app's real startUpdater
      // (scaffold/lib/appUpdate/install.ts), detached so that killing its whole
      // process group is what the update really does to it.
      const serverScript = join(dir, "server.mts");
      writeFileSync(
        serverScript,
        [
          `import { startUpdater } from ${JSON.stringify(pathToFileURL(APP_INSTALL_TS).href)};`,
          `await startUpdater("v9.9.9", 3456, ${JSON.stringify(join(dir, "scripts", "macos", "update.sh"))}, { platform: "darwin", logPath: ${JSON.stringify(join(dir, "start.log"))} });`,
          'console.log("launched");',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      const server = spawn(process.execPath, ["--import", "tsx", serverScript], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "inherit"],
      });
      started.push(server);
      let out = "";
      server.stdout?.on("data", (b: Buffer) => (out += b.toString()));
      const startedWith = await until(
        async () => (existsSync(startedFile) ? readFileSync(startedFile, "utf8") : ""),
        (text) => text.endsWith("\n"),
        60_000,
      );
      assert.match(startedWith, /--ref v9\.9\.9 --port 3456/, "update.sh was actually started");
      // The update stops the server — on macOS that is launchd killing its
      // whole job, so the whole process group goes. The updater must survive it.
      process.kill(-(server.pid as number), "SIGKILL");
      await until(async () => existsSync(finishedFile), (there) => there, 30_000);
      assert.ok(existsSync(finishedFile), "update.sh ran to the end after its server was killed");
      assert.match(out, /launched/);
    });
  },
);
