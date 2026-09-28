import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveKeySource, resetKeySourceCache } from "../keySource";

const TMP_DIR = path.join(os.tmpdir(), `granted-keysource-test-${process.pid}`);
fs.mkdirSync(TMP_DIR, { recursive: true });

function writeTemp(name: string, content: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

afterEach(() => {
  resetKeySourceCache();
});

describe("resolveKeySource — inline", () => {
  test("returns the key as-is", () => {
    assert.deepEqual(resolveKeySource({ type: "inline", key: "sk-abc123" }), { key: "sk-abc123" });
  });
  test("empty inline key -> error", () => {
    assert.equal(resolveKeySource({ type: "inline", key: "" }).key, undefined);
  });
});

describe("resolveKeySource — env", () => {
  const VAR = "GRANTED_KEYSOURCE_TEST_VAR";
  afterEach(() => delete process.env[VAR]);

  test("reads process.env at use time", () => {
    process.env[VAR] = "sk-fromenv123";
    assert.deepEqual(resolveKeySource({ type: "env", name: VAR }), { key: "sk-fromenv123" });
  });

  test("unset variable -> \"Variable X isn't set.\"", () => {
    delete process.env[VAR];
    const r = resolveKeySource({ type: "env", name: VAR });
    assert.equal(r.key, undefined);
    assert.equal(r.error, `Variable ${VAR} isn't set.`);
  });

  test("invalid variable name -> rejected before ever touching process.env", () => {
    const r = resolveKeySource({ type: "env", name: "not a valid name!" });
    assert.equal(r.key, undefined);
    assert.match(r.error!, /isn't a valid environment variable name/);
  });
});

describe("resolveKeySource — file", () => {
  test("relative path is rejected", () => {
    const r = resolveKeySource({ type: "file", path: "relative/path.key" });
    assert.equal(r.key, undefined);
    assert.match(r.error!, /Couldn't read/);
  });

  test("missing file -> \"Couldn't read <path>\"", () => {
    const missing = path.join(TMP_DIR, "does-not-exist.key");
    const r = resolveKeySource({ type: "file", path: missing });
    assert.equal(r.error, `Couldn't read ${missing}`);
  });

  test("single-line file: trimmed content is the key", () => {
    const p = writeTemp("single.key", "  sk-singleline123  \n");
    assert.deepEqual(resolveKeySource({ type: "file", path: p }), { key: "sk-singleline123" });
  });

  test("multi-line file: the first line passing the format check wins", () => {
    const p = writeTemp("multi.key", "# a comment that fails the check\nsk-therealkey000\nsk-anotherline000\n");
    const isValid = (k: string) => k.startsWith("sk-");
    const r = resolveKeySource({ type: "file", path: p }, isValid);
    assert.equal(r.key, "sk-therealkey000");
  });

  test("multi-line file: no line passes the check -> falls back to the first non-empty line", () => {
    const p = writeTemp("multi-none-valid.key", "nope\nstill-nope\n");
    const isValid = (k: string) => k.startsWith("sk-");
    const r = resolveKeySource({ type: "file", path: p }, isValid);
    assert.equal(r.key, "nope");
  });

  test("oversized file (>8KB) -> rejected", () => {
    const p = writeTemp("huge.key", "a".repeat(9 * 1024));
    const r = resolveKeySource({ type: "file", path: p });
    assert.match(r.error!, /Couldn't read/);
  });

  test("mtime-cached: repeated reads of an unchanged file agree; a change is picked up", () => {
    const p = writeTemp("cached.key", "sk-original000\n");
    const first = resolveKeySource({ type: "file", path: p });
    const second = resolveKeySource({ type: "file", path: p });
    assert.deepEqual(first, second);

    fs.writeFileSync(p, "sk-updated000\n", "utf8");
    const stat = fs.statSync(p);
    fs.utimesSync(p, stat.atime, new Date(stat.mtimeMs + 5000));
    const third = resolveKeySource({ type: "file", path: p });
    assert.equal(third.key, "sk-updated000");
  });
});
