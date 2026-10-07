import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendErrorEntry,
  clearErrorLog,
  errorLogDir,
  logFileName,
  readErrorEntries,
  type ErrorLogEntry,
} from "../store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "granted-errorlog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (i: number, extra: Partial<ErrorLogEntry> = {}): ErrorLogEntry => ({
  id: "E-AAAAAA",
  time: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  version: "0.2.3",
  platform: "test",
  area: "search",
  message: `error number ${i}`,
  source: "server",
  ...extra,
});

// The per-platform expectations below are literal strings, never rebuilt with
// the ambient `join`. Rebuilding them makes the assertion tautological: the
// test picks up the very same platform-dependent separator the code under test
// did, so a macOS path joined with Windows separators (or the reverse) still
// "passes" on every runner. That exact bug in the installer's own
// grantedSettingsPath only surfaced on the windows-latest CI runner, where its
// test did assert a literal.
describe("where the log lives", () => {
  test("GRANTED_LOG_DIR wins, then logs/ next to GRANTED_SETTINGS_PATH", () => {
    assert.equal(errorLogDir({ GRANTED_LOG_DIR: "/x/logs", GRANTED_SETTINGS_PATH: "/y/settings.json" }), "/x/logs");
    assert.equal(errorLogDir({ GRANTED_SETTINGS_PATH: join("y", "settings.json") }), join("y", "logs"));
  });
  test("Windows: %LOCALAPPDATA%\\Granted\\logs (next to the tray's server log)", () => {
    assert.equal(errorLogDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }), "C:\\Users\\a\\AppData\\Local\\Granted\\logs");
  });
  // Also next to the server log on macOS: scripts/macos/granted-tray.sh writes
  // server-<port>.log into exactly this folder, the platform's own per-user
  // log location.
  test("macOS: ~/Library/Logs/Granted; elsewhere ~/.granted/logs", () => {
    assert.equal(errorLogDir({}, "darwin", "/Users/a"), "/Users/a/Library/Logs/Granted");
    assert.equal(errorLogDir({}, "linux", "/home/a"), "/home/a/.granted/logs");
    assert.equal(errorLogDir({ GRANTED_LOG_DIR: "/x/logs" }, "darwin", "/Users/a"), "/x/logs");
    // Nothing above may depend on the OS this test runs under.
    assert.ok(!errorLogDir({}, "darwin", "/Users/a").includes("\\"), "the macOS path is POSIX on every runner");
    assert.ok(!errorLogDir({ LOCALAPPDATA: "C:\\L" }).includes("/"), "the Windows path is win32 on every runner");
  });
  test("under node:test with no override: a temp folder, never the real log", () => {
    assert.ok(errorLogDir({ NODE_TEST_CONTEXT: "child-v8" }).startsWith(tmpdir()));
  });
  test("file names", () => {
    assert.equal(logFileName(0), "errors.jsonl");
    assert.equal(logFileName(2), "errors.2.jsonl");
  });
});

describe("appending and reading", () => {
  test("one JSON line per entry, read back oldest first", () => {
    assert.equal(appendErrorEntry(entry(1), { dir }), true);
    assert.ok(appendErrorEntry(entry(2, { stack: "at x", status: 500, path: "/api/match", key: "k" }), { dir }));
    const lines = readFileSync(join(dir, "errors.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const read = readErrorEntries({ dir });
    assert.deepEqual(read.map((e) => e.message), ["error number 1", "error number 2"]);
    assert.equal(read[1].status, 500);
    assert.equal(read[1].path, "/api/match");
  });

  test("torn or hand-edited lines are skipped, not fatal", () => {
    appendErrorEntry(entry(1), { dir });
    writeFileSync(join(dir, "errors.jsonl"), `${readFileSync(join(dir, "errors.jsonl"), "utf8")}{"broken\nnot json\n{"no":"message"}\n`);
    appendErrorEntry(entry(2), { dir });
    assert.deepEqual(readErrorEntries({ dir }).map((e) => e.message), ["error number 1", "error number 2"]);
  });

  test("no log yet reads as empty", () => {
    assert.deepEqual(readErrorEntries({ dir: join(dir, "nothing-here") }), []);
  });
});

describe("rotation", () => {
  test("rotates at the size limit and keeps 3 files, dropping the oldest", () => {
    const maxBytes = 2000;
    for (let i = 0; i < 100; i++) appendErrorEntry(entry(i, { message: `error number ${i} ${"x".repeat(150)}` }), { dir, maxBytes });
    for (const f of ["errors.jsonl", "errors.1.jsonl", "errors.2.jsonl"]) {
      assert.ok(existsSync(join(dir, f)), f);
      assert.ok(statSync(join(dir, f)).size <= maxBytes, `${f} is ${statSync(join(dir, f)).size} bytes`);
    }
    assert.equal(existsSync(join(dir, "errors.3.jsonl")), false);
    const read = readErrorEntries({ dir });
    // Newest kept, in order, with no gaps between them; the oldest are gone.
    assert.match(read[read.length - 1].message, /^error number 99 /);
    assert.doesNotMatch(read[0].message, /^error number 0 /);
    const nums = read.map((e) => Number(/error number (\d+)/.exec(e.message)![1]));
    nums.forEach((n, i) => i > 0 && assert.equal(n, nums[i - 1] + 1));
  });

  test("the default limit is ~1 MB", () => {
    const big = "y".repeat(10_000);
    for (let i = 0; i < 110; i++) appendErrorEntry(entry(i, { message: big }), { dir });
    assert.ok(existsSync(join(dir, "errors.1.jsonl")), "rotated once past 1 MB");
    assert.ok(statSync(join(dir, "errors.jsonl")).size < 1_000_000);
  });
});

describe("never throws", () => {
  test("a log folder that can't be created: append returns false", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    assert.doesNotThrow(() => assert.equal(appendErrorEntry(entry(1), { dir: join(file, "logs") }), false));
  });
  test("an entry that can't be serialized: append returns false", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(appendErrorEntry({ ...entry(1), message: circular as unknown as string }, { dir }), false);
  });
  test("reading or clearing a log folder that is a file", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    assert.deepEqual(readErrorEntries({ dir: file }), []);
    assert.doesNotThrow(() => clearErrorLog({ dir: file }));
  });
});

test("clear removes every log file", () => {
  for (let i = 0; i < 40; i++) appendErrorEntry(entry(i, { message: "z".repeat(200) }), { dir, maxBytes: 1000 });
  assert.ok(existsSync(join(dir, "errors.1.jsonl")));
  assert.equal(clearErrorLog({ dir }), true);
  assert.deepEqual(readErrorEntries({ dir }), []);
});
