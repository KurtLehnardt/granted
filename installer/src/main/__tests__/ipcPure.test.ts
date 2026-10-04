import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  escapeForAppleScript,
  mergeRegistryPath,
  newInstallStatusPath,
  parseInstallStatusJson,
  parseVersionFromOutput,
  psSingleQuoted,
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
