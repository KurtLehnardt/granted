/**
 * Integration: the REAL install-macos.sh installing a specific release
 * (GRANTED_REF) from local stand-in repos (GRANTED_REPO_URL), so it runs
 * offline and fast — the macOS mirror of installRef.integration.test.ts.
 * Covers a fresh pinned install, updating an install this script made, and
 * everything an update must NOT do: switch a folder with local changes or
 * one it didn't make, go backwards, break on a re-tagged release. Also
 * covers stop_granted_in, which install-windows.ps1's Stop-GrantedIn has no
 * exact mac counterpart test for (there is no tray on macOS to stop; this
 * instead spawns a stand-in whose command line, like a real `npm run dev`,
 * mentions this install's own path). Git and Node must already be installed
 * (they are wherever this runs), so nothing is downloaded — but the real
 * Ollama check still runs (a no-op if it's already installed, as it is on
 * every machine this was verified on; same acceptance as
 * installRef.integration.test.ts's real VC-runtime check on Windows).
 * macOS only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readStatusFile } from "../openGranted";

const execFileAsync = promisify(execFile);
// `npm test` runs from installer/; the script lives at the repo root.
const REPO_ROOT = resolve(process.cwd(), "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "install-macos.sh");
const PORT = 3978;
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe(
  "install-macos.sh with GRANTED_REF (a pinned release)",
  { skip: (process.platform !== "darwin" || !existsSync(INSTALL_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let root: string;
    const started: ChildProcess[] = [];
    let seq = 0;

    /** Commits scaffold at `version` (a runnable fake: `npm run dev` serves Granted's page on $PORT), optionally tagging it. */
    function commitVersion(source: string, version: string, tag: string | null, extraFile?: string): void {
      const scaffold = join(source, "scaffold");
      writeFileSync(join(scaffold, "package.json"), JSON.stringify({ name: "granted", version, private: true, scripts: { dev: "node server.js" } }, null, 2));
      writeFileSync(
        join(scaffold, "package-lock.json"),
        JSON.stringify({ name: "granted", version, lockfileVersion: 3, requires: true, packages: { "": { name: "granted", version } } }, null, 2),
      );
      writeFileSync(join(scaffold, "server.js"), `require("node:http").createServer((q, r) => r.end(${JSON.stringify(GRANTED_HTML)})).listen(Number(process.env.PORT), "127.0.0.1");`);
      if (extraFile) writeFileSync(join(scaffold, extraFile), extraFile);
      git(source, "add", "-A");
      git(source, "commit", "-q", "-m", `version ${version}`);
      if (tag) git(source, "tag", "-f", "-a", tag, "-m", tag); // annotated, as real releases are
    }

    /** A stand-in for the GitHub repo: v0.1.0, v0.2.0, then main moved on to 0.3.0-dev. */
    function makeSource(): string {
      const source = join(root, `source-${seq++}`);
      mkdirSync(join(source, "scaffold"), { recursive: true });
      git(source, "init", "-q", "-b", "main");
      commitVersion(source, "0.1.0", "v0.1.0");
      commitVersion(source, "0.2.0", "v0.2.0");
      commitVersion(source, "0.3.0-dev", null);
      return source;
    }

    /** Runs the real script in `home`; returns its status and console output. */
    async function runInstall(home: string, source: string, ref: string | null, extra: Record<string, string> = {}): Promise<{ state: string | null; message: string | null; output: string }> {
      const status = join(root, `status-${seq++}.json`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRANTED_REPO_URL: source,
        GRANTED_INSTALL_DIR: "granted",
        GRANTED_STATUS_FILE: status,
        GRANTED_PORT: String(PORT),
        npm_config_audit: "false",
        npm_config_fund: "false",
        ...extra,
      };
      if (ref) env["GRANTED_REF"] = ref;
      else delete env["GRANTED_REF"];
      let output = "";
      try {
        const r = await execFileAsync("bash", [INSTALL_SCRIPT], { cwd: home, env, timeout: 180_000 });
        output = r.stdout + r.stderr;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = (e.stdout ?? "") + (e.stderr ?? "");
      }
      const s = await readStatusFile(status);
      return { state: s?.state ?? null, message: s?.message ?? null, output };
    }

    const versionIn = (home: string): string => (JSON.parse(readFileSync(join(home, "granted", "scaffold", "package.json"), "utf8")) as { version: string }).version;
    const freshHome = (): string => {
      const d = join(root, `home-${seq++}`);
      mkdirSync(d, { recursive: true });
      return d;
    };

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "granted-installref-mac-it-"));
    });

    after(async () => {
      for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
      await rm(root, { recursive: true, force: true }).catch(() => {});
    });

    test("a fresh install of v0.1.0 gets exactly v0.1.0 (not v0.2.0 or main), marked as installer-made; v0.2.0 then updates it", async () => {
      const source = makeSource();
      const home = freshHome();
      const r = await runInstall(home, source, "v0.1.0");
      assert.equal(r.state, "done", r.output);
      assert.equal(versionIn(home), "0.1.0");
      assert.equal(git(join(home, "granted"), "describe", "--tags", "--exact-match"), "v0.1.0");
      assert.ok(existsSync(join(home, "granted", ".git", "granted-installer")), "marked as made by the installer");
      assert.match(r.output, /carry on in the Granted installer/, "run by the installer app: no terminal next steps");
      assert.doesNotMatch(r.output, /npm run setup/);

      const update = await runInstall(home, source, "v0.2.0");
      assert.equal(update.state, "done", update.output);
      assert.equal(versionIn(home), "0.2.0");
      assert.match(update.output, /now at v0\.2\.0/);

      // Local changes: never switched over them.
      writeFileSync(join(home, "granted", "scaffold", "package.json"), readFileSync(join(home, "granted", "scaffold", "package.json"), "utf8") + "\n");
      git(source, "tag", "-f", "v0.2.1", "v0.2.0");
      const kept = await runInstall(home, source, "v0.2.1");
      assert.equal(kept.state, "done", kept.output);
      assert.match(kept.output, /has local changes/);
      assert.equal(versionIn(home), "0.2.0", "not switched while dirty");
    });

    test("REGRESSION: never backwards — an install already containing the release, or with newer code, is left alone (GRANTED_ALLOW_DOWNGRADE overrides)", async () => {
      const source = makeSource();
      // Installed from main (the README one-liner): 0.3.0-dev, already past v0.2.0.
      const fromMain = freshHome();
      assert.equal((await runInstall(fromMain, source, null)).state, "done");
      assert.equal(versionIn(fromMain), "0.3.0-dev");
      const r1 = await runInstall(fromMain, source, "v0.2.0");
      assert.equal(r1.state, "done", r1.output);
      assert.match(r1.output, /already includes Granted v0\.2\.0/);
      assert.equal(versionIn(fromMain), "0.3.0-dev", "not moved back to v0.2.0");

      // At v0.2.0, an older release NOT in its history (a patch on an old
      // line): refused by version... unless explicitly allowed.
      const at020 = freshHome();
      await runInstall(at020, source, "v0.2.0");
      git(source, "checkout", "-q", "-b", "maint-0.1", "v0.1.0");
      commitVersion(source, "0.1.5", "v0.1.5", "patch.txt");
      git(source, "checkout", "-q", "main");
      const refused = await runInstall(at020, source, "v0.1.5");
      assert.equal(refused.state, "done", refused.output);
      assert.match(refused.output, /already has a newer Granted \(0\.2\.0\)/);
      assert.equal(versionIn(at020), "0.2.0");
      const allowed = await runInstall(at020, source, "v0.1.5", { GRANTED_ALLOW_DOWNGRADE: "1" });
      assert.equal(allowed.state, "done", allowed.output);
      assert.equal(versionIn(at020), "0.1.5");
    });

    test("a folder the installer didn't make (someone's own checkout) is never switched to another release", async () => {
      const source = makeSource();
      const home = freshHome();
      git(home, "clone", "-q", "--branch", "v0.1.0", source, "granted");
      const r = await runInstall(home, source, "v0.2.0");
      assert.equal(r.state, "done", r.output);
      assert.match(r.output, /wasn't installed by this installer/);
      assert.equal(versionIn(home), "0.1.0");
    });

    test("REGRESSION: a release re-tagged on GitHub (moved to a fix) neither breaks updates nor installs the stale copy", async () => {
      const source = makeSource();
      const home = freshHome();
      await runInstall(home, source, "v0.1.0"); // the clone now has v0.1.0 AND v0.2.0 locally
      git(source, "checkout", "-q", "-b", "fixes2", "v0.2.0");
      commitVersion(source, "0.2.0", "v0.2.0", "fix-020.txt");
      git(source, "checkout", "-q", "main");
      const r = await runInstall(home, source, "v0.2.0");
      assert.equal(r.state, "done", r.output);
      assert.equal(versionIn(home), "0.2.0");
      assert.ok(existsSync(join(home, "granted", "scaffold", "fix-020.txt")), "the re-tagged v0.2.0, not the stale local copy");
    });

    test("REGRESSION: updating stops a running Granted first, so npm ci never runs under it (no tray on macOS — matched by command line, like a plain `npm run dev` would be)", async () => {
      const source = makeSource();
      const home = freshHome();
      await runInstall(home, source, "v0.1.0");
      // realpathSync, not a plain join: stop_granted_in resolves $dir via
      // `cd && pwd -P` (symlink-safe, so it can't be fooled by one path
      // into the same directory mismatching another) — on macOS os.tmpdir()
      // itself is one (/var -> /private/var), so the stand-in below must be
      // spawned with the SAME resolved path bash will compare against, or
      // this test would be asserting something that was never true for the
      // real (always-absolute, already-resolved) scaffoldDir() path.
      const full = realpathSync(join(home, "granted"));
      // Stands in for a running `npm run dev`: a node process whose command
      // line mentions this install's own path, the same way
      // install-windows.ps1's Stop-GrantedIn matches by command line.
      const fake = spawn(process.execPath, ["-e", "setInterval(function(){}, 1000)", join(full, "scaffold", "fake-dev-marker")], { stdio: "ignore" });
      started.push(fake);
      await sleep(500);
      assert.equal(fake.exitCode, null, "the stand-in is running");

      const r = await runInstall(home, source, "v0.2.0");
      assert.equal(r.state, "done", r.output);
      assert.match(r.output, /stopped the Granted that was running/);
      assert.ok(r.output.indexOf("stopped the Granted") < r.output.indexOf("Installing npm dependencies"), "stopped before npm ci");
      // A signal-terminated child reports exitCode: null (NOT a numeric
      // code) with the signal in signalCode instead — exitCode alone would
      // never go non-null here even though it's genuinely gone.
      const deadline = Date.now() + 5000;
      while (fake.exitCode === null && fake.signalCode === null && Date.now() < deadline) await sleep(100);
      assert.ok(fake.exitCode !== null || fake.signalCode !== null, "the stand-in was stopped");
      assert.equal(versionIn(home), "0.2.0");
    });

    test("a GRANTED_REF that isn't a release tag is refused before anything is done", async () => {
      const home = freshHome();
      const r = await runInstall(home, makeSource(), "main; rm -rf /tmp/should-never-run");
      assert.equal(r.state, "error");
      assert.match(r.message ?? "", /must be a release tag/);
      assert.equal(existsSync(join(home, "granted")), false);
    });

    test("REGRESSION: a release that can't be checked out leaves no half-made folder behind, so a re-run works", async () => {
      const source = makeSource();
      const home = freshHome();
      const r = await runInstall(home, source, "v0.9.9"); // no such release
      assert.equal(r.state, "error");
      assert.match(r.message ?? "", /Couldn't check out Granted v0\.9\.9/);
      assert.equal(existsSync(join(home, "granted")), false, "the clone it just made is gone");
      const retry = await runInstall(home, source, "v0.1.0");
      assert.equal(retry.state, "done", retry.output);
      assert.equal(versionIn(home), "0.1.0");
    });
  },
);
