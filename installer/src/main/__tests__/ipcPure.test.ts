import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyApiKeys,
  buildTaskScript,
  decideStatusPoll,
  envIsLocalConfigured,
  escapeForAppleScript,
  grantedPort,
  isRealKey,
  looksLikeGranted,
  mergeRegistryPath,
  newInstallStatusPath,
  parseInstallStatusJson,
  parseStatusFile,
  parseVersionFromOutput,
  psSingleQuoted,
  resolveTaskStatus,
  shouldReattach,
  STATUS_LOCK_LINE,
  statusLockPath,
  TASK_WINDOW_CLOSED_MESSAGE,
  upsertEnv,
} from "../ipcPure";

describe("parseVersionFromOutput", () => {
  test("git --version's real shape", () => {
    assert.deepEqual(parseVersionFromOutput("git version 2.56.0.windows.1\n"), {
      version: "2.56.0",
      major: 2,
    });
  });

  test("node --version's real shape (leading v, no trailing text)", () => {
    assert.deepEqual(parseVersionFromOutput("v22.23.3\n"), { version: "22.23.3", major: 22 });
  });

  test("output with no x.y.z-shaped version at all returns the trimmed raw text, major null", () => {
    assert.deepEqual(parseVersionFromOutput("some unexpected banner\n"), {
      version: "some unexpected banner",
      major: null,
    });
  });

  test("empty output returns version: null (not an empty string), major: null", () => {
    assert.deepEqual(parseVersionFromOutput(""), { version: null, major: null });
    assert.deepEqual(parseVersionFromOutput("   \n"), { version: null, major: null });
  });
});

describe("mergeRegistryPath", () => {
  test("returns null (no-op signal) when the registry read came back empty", () => {
    assert.equal(mergeRegistryPath("C:\\existing", ""), null);
    assert.equal(mergeRegistryPath("C:\\existing", ";"), null);
    assert.equal(mergeRegistryPath("C:\\existing", "   "), null);
  });

  test("merges Machine+User registry entries onto the original PATH, deduped", () => {
    const merged = mergeRegistryPath(
      "C:\\Windows\\system32;C:\\Windows",
      "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs;",
    );
    // Case-insensitive dedupe: "C:\Windows\System32" (registry) collapses
    // with "C:\Windows\system32" (original) into one entry.
    assert.deepEqual(merged?.split(";"), [
      "C:\\Windows\\system32",
      "C:\\Windows",
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\nodejs",
    ]);
  });

  test("trailing/leading semicolons and a null-registry-key empty string never produce an empty PATH segment", () => {
    // A trailing ';' on a registry value, and PowerShell concatenating a
    // missing key as an empty string, are both routine on real Windows.
    const merged = mergeRegistryPath("C:\\existing", "C:\\Windows\\System32;;C:\\Git\\cmd;");
    assert.ok(merged);
    assert.ok(!merged.split(";").some((segment) => segment.length === 0), `segments: ${merged}`);
  });

  test(
    "REGRESSION (real bug, found on an actual Windows VM): repeated calls are idempotent, never growing PATH",
    () => {
      // The original (buggy) implementation appended the full registry PATH
      // onto whatever process.env.PATH already was, every single call. A
      // real validation pass measured +270 chars per failed prereq check,
      // saturating Windows's 32,767-char env-var limit after ~16-120
      // checks. This test simulates exactly that usage pattern (call
      // mergeRegistryPath, apply the result, call again, repeat) and
      // asserts the length stabilizes after the first call.
      const original = "C:\\Windows\\system32;C:\\Windows";
      const registryStdout = "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs;";
      let path = original;
      const lengths: number[] = [];
      for (let i = 0; i < 200; i++) {
        const merged = mergeRegistryPath(original, registryStdout);
        if (merged !== null) path = merged;
        lengths.push(path.length);
      }
      assert.equal(lengths[0], lengths[1], "length must stabilize after the first call");
      assert.equal(lengths[0], lengths[199], "length must never grow across 200 repeated calls");
    },
  );
});

describe("parseInstallStatusJson", () => {
  test("plain JSON (as pwsh's Set-Content writes it, no BOM)", () => {
    assert.deepEqual(parseInstallStatusJson('{"state":"running","message":null}'), {
      state: "running",
      message: null,
    });
  });

  test(
    "REGRESSION (real bug, found on an actual Windows VM): a leading UTF-8 BOM (as Windows PowerShell 5.1's Set-Content -Encoding utf8 writes it) is stripped, not rejected",
    () => {
      const bom = String.fromCharCode(0xfeff);
      const withBom = bom + '{"state":"done","message":null}';
      assert.deepEqual(parseInstallStatusJson(withBom), { state: "done", message: null });
    },
  );

  test("an error state carries its message through", () => {
    assert.deepEqual(parseInstallStatusJson('{"state":"error","message":"git clone failed."}'), {
      state: "error",
      message: "git clone failed.",
    });
  });

  test("malformed JSON returns null, never throws", () => {
    assert.equal(parseInstallStatusJson("not json at all"), null);
    assert.equal(parseInstallStatusJson(""), null);
    assert.equal(parseInstallStatusJson("{"), null);
  });

  test("valid JSON with an unexpected/missing state returns null (treated as \"no status yet\")", () => {
    assert.equal(parseInstallStatusJson('{"state":"finished"}'), null);
    assert.equal(parseInstallStatusJson("{}"), null);
    assert.equal(parseInstallStatusJson('{"message":"no state field at all"}'), null);
  });
});

describe("escapeForAppleScript", () => {
  test("escapes backslashes and double quotes, leaves everything else alone", () => {
    assert.equal(escapeForAppleScript('say "hi"'), 'say \\"hi\\"');
    assert.equal(escapeForAppleScript("C:\\path\\to\\thing"), "C:\\\\path\\\\to\\\\thing");
  });

  test("the real one-liner round-trips: wrapping it in an AppleScript string and unescaping gives back the original", () => {
    const command = 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh)"';
    const escaped = escapeForAppleScript(command);
    const unescaped = escaped.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    assert.equal(unescaped, command);
  });
});

describe("psSingleQuoted", () => {
  test("wraps in single quotes, doubling any embedded single quote (PowerShell's escape rule)", () => {
    assert.equal(psSingleQuoted("C:\\Users\\test\\temp.json"), "'C:\\Users\\test\\temp.json'");
    assert.equal(psSingleQuoted("O'Brien"), "'O''Brien'");
  });

  test("does NOT expand $ or backtick (the reason single-quoting was chosen over double-quoting)", () => {
    const withDollar = psSingleQuoted("C:\\Users\\$weird\\temp.json");
    // A double-quoted PowerShell string would expand $weird as a variable
    // reference; single-quoted, the literal text must survive untouched.
    assert.equal(withDollar, "'C:\\Users\\$weird\\temp.json'");
    const withBacktick = psSingleQuoted("C:\\Users\\weird`ntemp.json");
    assert.equal(withBacktick, "'C:\\Users\\weird`ntemp.json'");
  });
});

describe("newInstallStatusPath", () => {
  test("produces a unique, well-shaped path each call (so a prior attempt's late write can never collide with a later one's poll)", () => {
    const a = newInstallStatusPath();
    const b = newInstallStatusPath();
    assert.notEqual(a, b);
    for (const p of [a, b]) {
      assert.match(p, /granted-install-status-[0-9a-f-]{36}\.json$/i);
    }
  });
});

// scaffold/.env.example's real shape (the placeholders are what a fresh copy holds).
const ENV_EXAMPLE = [
  "# comment",
  "OPENAI_API_KEY=sk-...",
  "ANTHROPIC_API_KEY=sk-ant-...",
  "EXA_API_KEY=",
  "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true",
  "",
].join("\n");

describe("applyApiKeys", () => {
  test("fills .env.example's placeholders and leaves the rest of the file alone", () => {
    const r = applyApiKeys(ENV_EXAMPLE, { OPENAI_API_KEY: "sk-real", ANTHROPIC_API_KEY: "sk-ant-real", EXA_API_KEY: "" });
    assert.match(r.text, /^OPENAI_API_KEY=sk-real$/m);
    assert.match(r.text, /^ANTHROPIC_API_KEY=sk-ant-real$/m);
    assert.match(r.text, /^EXA_API_KEY=$/m);
    assert.match(r.text, /^# comment$/m);
    assert.deepEqual(r.missing, []);
  });

  test("a blank field keeps the key already set", () => {
    const existing = ENV_EXAMPLE.replace("OPENAI_API_KEY=sk-...", "OPENAI_API_KEY=sk-keep-me");
    const r = applyApiKeys(existing, { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant-x", EXA_API_KEY: "" });
    assert.match(r.text, /^OPENAI_API_KEY=sk-keep-me$/m);
    assert.deepEqual(r.missing, []);
  });

  test("a key the user typed replaces the one already set (never silently dropped)", () => {
    const existing = ENV_EXAMPLE.replace("OPENAI_API_KEY=sk-...", "OPENAI_API_KEY=sk-stale");
    const r = applyApiKeys(existing, { OPENAI_API_KEY: "sk-new", ANTHROPIC_API_KEY: "sk-ant-x", EXA_API_KEY: "" });
    assert.match(r.text, /^OPENAI_API_KEY=sk-new$/m);
    assert.doesNotMatch(r.text, /sk-stale/);
  });

  test("reports required keys still missing, and trims pasted whitespace", () => {
    const r = applyApiKeys(ENV_EXAMPLE, { OPENAI_API_KEY: "  sk-real \n", ANTHROPIC_API_KEY: "   ", EXA_API_KEY: "" });
    assert.match(r.text, /^OPENAI_API_KEY=sk-real$/m);
    assert.deepEqual(r.missing, ["ANTHROPIC_API_KEY"]);
  });

  test("a key containing $ is written literally (String.replace's $-patterns must not apply)", () => {
    const r = applyApiKeys(ENV_EXAMPLE, { OPENAI_API_KEY: "sk-a$&b$1", ANTHROPIC_API_KEY: "sk-ant-x", EXA_API_KEY: "" });
    assert.match(r.text, /^OPENAI_API_KEY=sk-a\$&b\$1$/m);
  });
});

describe("upsertEnv", () => {
  test("appends a key that isn't present", () => {
    assert.equal(upsertEnv("A=1\n", "B", "2"), "A=1\nB=2\n");
  });
});

describe("isRealKey", () => {
  test(".env.example's placeholders and blanks don't count as set", () => {
    assert.equal(isRealKey(""), false);
    assert.equal(isRealKey("sk-..."), false);
    assert.equal(isRealKey("sk-ant-..."), false);
    assert.equal(isRealKey("sk-real"), true);
  });
});

describe("envIsLocalConfigured", () => {
  // What setup-local.mjs writes (step 6) — BEFORE the corpus re-embed (step 7).
  const LOCAL_ENV =
    "LLM_PROVIDER=ollama\nEMBEDDINGS_BASE_URL=http://localhost:11434/v1\nEMBEDDINGS_MODEL=nomic-embed-text\n";
  // What 3-embed.mjs --target=local writes last, on success.
  const LOCAL_META = JSON.stringify({ count: 4698, embeddingModel: "nomic-embed-text", dims: 768 });

  test("needs the env lines AND a finished local re-embed with the same model", () => {
    assert.equal(envIsLocalConfigured(LOCAL_ENV, LOCAL_META), true);
    assert.equal(envIsLocalConfigured(LOCAL_ENV, "﻿" + LOCAL_META), true, "BOM tolerated");
  });

  test("a setup:local that failed during the re-embed (env written, no local corpus) does NOT count", () => {
    assert.equal(envIsLocalConfigured(LOCAL_ENV, null), false);
  });

  test("a local corpus embedded with a different model (dims mismatch) does NOT count", () => {
    assert.equal(
      envIsLocalConfigured(LOCAL_ENV, JSON.stringify({ embeddingModel: "text-embedding-3-small", dims: 512 })),
      false,
    );
  });

  test("hosted env, or junk corpus metadata, does not count", () => {
    assert.equal(envIsLocalConfigured(ENV_EXAMPLE, LOCAL_META), false);
    assert.equal(envIsLocalConfigured(LOCAL_ENV, "not json"), false);
  });
});

describe("parseStatusFile / resolveTaskStatus", () => {
  test("keeps buildTaskScript's pid alongside install-windows.ps1's fields", () => {
    assert.deepEqual(parseStatusFile('{"state":"running","message":null,"pid":4242}'), {
      state: "running",
      message: null,
      pid: 4242,
    });
    assert.deepEqual(parseStatusFile('﻿{"state":"done"}'), { state: "done", message: null });
    assert.equal(parseStatusFile("garbage"), null);
  });

  test("a running status whose window process is gone means the window was closed", () => {
    const running = { state: "running" as const, message: null, pid: 4242 };
    assert.deepEqual(resolveTaskStatus(running, () => true), running);
    assert.deepEqual(resolveTaskStatus(running, () => false), {
      state: "error",
      message: TASK_WINDOW_CLOSED_MESSAGE,
      pid: 4242,
      closed: true,
    });
  });

  test("finished statuses, statuses without a pid (install-windows.ps1's) and null pass through", () => {
    const done = { state: "done" as const, message: null, pid: 1 };
    assert.deepEqual(resolveTaskStatus(done, () => false), done);
    const noPid = { state: "running" as const, message: null };
    assert.deepEqual(resolveTaskStatus(noPid, () => false), noPid);
    assert.equal(resolveTaskStatus(null, () => false), null);
  });
});

describe("buildTaskScript", () => {
  const script = buildTaskScript({
    title: "Granted",
    cwd: "C:\\Users\\O'Brien\\granted\\scaffold",
    statusPath: "C:\\Temp\\$x\\s.json",
    command: "npm.cmd run dev",
    failureMessage: "It didn't work.",
  });

  test("single-quotes every interpolated path/message (no $ or backtick expansion; ' doubled)", () => {
    assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\O''Brien\\granted\\scaffold'/);
    assert.match(script, /\$StatusPath = 'C:\\Temp\\\$x\\s\.json'/);
    assert.match(script, /Write-Status "error" 'It didn''t work\.'/);
  });

  test("records the window's own pid in every status write (closed-window detection)", () => {
    assert.match(script, /@\{ state = \$state; message = \$message; pid = \$PID \}/);
  });

  test("takes the window's exclusive status lock right after $StatusPath is set, before anything runs", () => {
    const lock = script.indexOf(STATUS_LOCK_LINE);
    assert.ok(lock > script.indexOf("$StatusPath = "), "after $StatusPath");
    assert.ok(lock < script.indexOf('Write-Status "running"'), "before the first status write");
    assert.equal(statusLockPath("C:\\t\\s.json"), "C:\\t\\s.json.lock");
  });

  test("reports running before the command and done/error from its exit code after", () => {
    const running = script.indexOf('Write-Status "running"');
    const command = script.indexOf("npm.cmd run dev");
    const exitCheck = script.indexOf("if ($LASTEXITCODE -eq 0)");
    assert.ok(running > -1 && running < command && command < exitCheck);
  });

  test("uses CRLF line endings", () => {
    assert.ok(script.includes("\r\n"));
    assert.ok(!/[^\r]\n/.test(script));
  });
});

describe("decideStatusPoll", () => {
  const OPTS = {
    startedTimeoutMs: 10_000,
    overallTimeoutMs: 600_000,
    notStartedMessage: "not started",
    timedOutMessage: "timed out",
  };
  const INSTALL = { ...OPTS, waitWhileAlive: true, closedMessage: "install window closed" };
  const MINUTE = 60_000;
  const RUNNING = { state: "running" as const, message: null, pid: 4242 };

  test("finishes with done/error as soon as the file says so", () => {
    assert.deepEqual(
      decideStatusPoll({ ...OPTS, status: { state: "done", message: null, pid: 5 }, elapsedMs: 1000, sawRunning: true }),
      { finish: { state: "done", message: null } },
    );
    assert.deepEqual(
      decideStatusPoll({ ...OPTS, status: { state: "error", message: "boom" }, elapsedMs: 1000, sawRunning: true }),
      { finish: { state: "error", message: "boom" } },
    );
  });

  test("keeps waiting (null) while running and inside every limit", () => {
    assert.equal(decideStatusPoll({ ...INSTALL, status: RUNNING, elapsedMs: 9 * MINUTE, sawRunning: true }), null);
  });

  test("REGRESSION (real Windows 11 run): an install window alive past 10 minutes at a UAC prompt is NOT given up on", () => {
    // The old fixed 10-minute limit fired here, re-enabled the button, and a
    // second click started a concurrent install. Now: a "still waiting"
    // notice (so a genuinely stuck window isn't silent either), never a finish.
    for (const minutes of [11, 30, 120]) {
      assert.deepEqual(
        decideStatusPoll({ ...INSTALL, status: RUNNING, elapsedMs: minutes * MINUTE, sawRunning: true }),
        { stillWaiting: true },
        `still waiting at ${minutes} min`,
      );
    }
  });

  test("tasks without waitWhileAlive keep their hard limit even with a live pid", () => {
    assert.deepEqual(decideStatusPoll({ ...OPTS, status: RUNNING, elapsedMs: 11 * MINUTE, sawRunning: true }), {
      finish: { state: "error", message: "timed out" },
    });
  });

  test("a status with no pid (an older install-windows.ps1) can't be checked, so it keeps the 10-minute limit", () => {
    assert.deepEqual(
      decideStatusPoll({ ...INSTALL, status: { state: "running", message: null }, elapsedMs: 11 * MINUTE, sawRunning: true }),
      { finish: { state: "error", message: "timed out" } },
    );
  });

  test("never reporting running within startedTimeoutMs is reported as not started", () => {
    assert.equal(decideStatusPoll({ ...OPTS, status: null, elapsedMs: 5000, sawRunning: false }), null);
    assert.deepEqual(decideStatusPoll({ ...OPTS, status: null, elapsedMs: 11_000, sawRunning: false }), {
      finish: { state: "error", message: "not started" },
    });
  });

  test("a window closed mid-run finishes immediately, worded by the caller's closedMessage", () => {
    const closed = resolveTaskStatus(RUNNING, () => false);
    assert.deepEqual(decideStatusPoll({ ...INSTALL, status: closed, elapsedMs: 2000, sawRunning: true }), {
      finish: { state: "error", message: "install window closed" },
    });
    // Without a closedMessage, the generic text.
    assert.deepEqual(decideStatusPoll({ ...OPTS, status: closed, elapsedMs: 2000, sawRunning: true }), {
      finish: { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE },
    });
  });

  test("closedMessage only replaces a real closed-window error, not a script's own error text", () => {
    assert.deepEqual(
      decideStatusPoll({ ...INSTALL, status: { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE }, elapsedMs: 2000, sawRunning: true }),
      { finish: { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE } },
    );
  });
});

describe("shouldReattach", () => {
  const RECENT = { recentLaunchMs: 60_000, acceptDone: true };

  test("re-attaches to a previous attempt that's still running (has a pid to keep checking)", () => {
    assert.equal(shouldReattach({ state: "running", message: null, pid: 7 }, { ...RECENT, launchedMsAgo: 900_000 }), true);
  });

  test("never re-attaches to a pid-less 'running' file — it can't tell a closed window from a live one", () => {
    assert.equal(shouldReattach({ state: "running", message: null }, { ...RECENT, launchedMsAgo: 5_000 }), false);
  });

  test("a slow start (nothing reported yet) re-attaches only if it was launched moments ago", () => {
    assert.equal(shouldReattach(null, { ...RECENT, launchedMsAgo: 15_000 }), true, "AV-slow start: don't race it");
    assert.equal(shouldReattach(null, { ...RECENT, launchedMsAgo: 120_000 }), false, "it never started: launch anew");
  });

  test("a finished 'done' attempt re-attaches (report the success) only where that makes sense", () => {
    const done = { state: "done" as const, message: null, pid: 7 };
    assert.equal(shouldReattach(done, { ...RECENT, launchedMsAgo: 900_000 }), true);
    assert.equal(shouldReattach(done, { ...RECENT, acceptDone: false, launchedMsAgo: 900_000 }), false);
  });

  test("an error (including a closed window) never re-attaches — the retry should start fresh", () => {
    assert.equal(shouldReattach({ state: "error", message: "x", closed: true }, { ...RECENT, launchedMsAgo: 1_000 }), false);
  });
});

describe("buildTaskScript env", () => {
  test("sets each variable single-quoted, before the command runs", () => {
    const script = buildTaskScript({
      title: "t",
      cwd: "C:\\x",
      statusPath: "C:\\s.json",
      command: "npm.cmd run dev",
      failureMessage: "f",
      env: { PORT: "3000", ODD: "it's $x" },
    });
    assert.match(script, /^\$env:PORT = '3000'$/m);
    assert.match(script, /^\$env:ODD = 'it''s \$x'$/m);
    assert.ok(script.indexOf("$env:PORT") < script.indexOf("npm.cmd run dev"));
  });

  test("refuses a variable name that isn't a plain identifier (it's interpolated unquoted)", () => {
    assert.throws(() =>
      buildTaskScript({ title: "t", cwd: "c", statusPath: "s", command: "c", failureMessage: "f", env: { "X; rm": "1" } }),
    );
  });
});

describe("grantedPort", () => {
  test("defaults to 3000 (Next's default, what the README documents)", () => {
    assert.equal(grantedPort(undefined), 3000);
    assert.equal(grantedPort(""), 3000);
  });

  test("honours a valid GRANTED_PORT and ignores junk", () => {
    assert.equal(grantedPort("3987"), 3987);
    assert.equal(grantedPort("abc"), 3000);
    assert.equal(grantedPort("70000"), 3000);
    assert.equal(grantedPort("-1"), 3000);
  });
});

describe("looksLikeGranted", () => {
  test("matches Granted's own <title>, not some other app on port 3000", () => {
    assert.equal(looksLikeGranted("<title>Granted — federal funding intelligence for everyone</title>"), true);
    assert.equal(looksLikeGranted("<title>My other dev server</title>"), false);
  });
});
