import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cleanArea, envFileSecrets, logError, messageOf, serverSanitizeContext, shortStack } from "../server";
import { isErrorId } from "../errorId";
import { readErrorEntries } from "../store";

let dir: string;
const saved = process.env["GRANTED_LOG_DIR"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "granted-logerror-"));
  process.env["GRANTED_LOG_DIR"] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env["GRANTED_LOG_DIR"];
  else process.env["GRANTED_LOG_DIR"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("logError", () => {
  test("writes a sanitized entry and returns its correlation id", () => {
    const err = new Error(`provider said: key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA invalid for jane@example.com in ${join(homedir(), "granted")}`);
    const id = logError("search", err, { status: 500, path: "/api/match" });
    assert.ok(isErrorId(id), id);
    const [e] = readErrorEntries();
    assert.equal(e.id, id);
    assert.equal(e.area, "search");
    assert.equal(e.source, "server");
    assert.equal(e.status, 500);
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.ok(e.platform.startsWith(process.platform));
    assert.ok(!Number.isNaN(Date.parse(e.time)));
    assert.match(e.message, /\[redacted-key\]/);
    assert.match(e.message, /\[email\]/);
    assert.doesNotMatch(e.message, /sk-ant-api03|jane@example|AAAAAAAAAAAA/);
    assert.ok(!e.message.includes(homedir()), "home folder removed");
    assert.match(e.stack ?? "", /^at /);
    assert.ok((e.stack ?? "").split("\n").length <= 8);
    // and nothing secret anywhere in the raw file
    const raw = readFileSync(join(dir, "errors.jsonl"), "utf8");
    assert.doesNotMatch(raw, /sk-ant-api03|jane@example\.com/);
  });

  test("reuses a valid id given to it (the one the page already shows), never an invalid one", () => {
    assert.equal(logError("page", "x", { id: "E-ABCDEF" }), "E-ABCDEF");
    const other = logError("page", "x", { id: "<script>" });
    assert.notEqual(other, "<script>");
    assert.ok(isErrorId(other));
  });

  test("once: the same failure isn't logged twice", () => {
    const a = logError("app-update", "update failed", { once: "update-status:v1:2026" });
    const b = logError("app-update", "update failed", { once: "update-status:v1:2026" });
    assert.equal(a, b);
    assert.equal(readErrorEntries().length, 1);
  });

  test("extra secrets passed in are scrubbed too", () => {
    logError("llm-provider", "bad key: weird-provider-key-12", { secrets: ["weird-provider-key-12"] });
    assert.equal(readErrorEntries()[0].message, "bad key: [redacted]");
  });

  test("never throws, whatever it's given, even when the log can't be written", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    process.env["GRANTED_LOG_DIR"] = join(file, "logs");
    const weird: unknown[] = [undefined, null, 42, Symbol("s"), { toString() { throw new Error("nope"); } }, Object.create(null)];
    for (const w of weird) assert.doesNotThrow(() => assert.ok(isErrorId(logError("search", w))));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => logError("search", circular));
  });

  test("an unknown area is recorded as 'unknown'", () => {
    assert.equal(cleanArea("search"), "search");
    assert.equal(cleanArea("../../etc"), "unknown");
    assert.equal(cleanArea(7), "unknown");
  });
});

describe("helpers", () => {
  test("messageOf", () => {
    assert.equal(messageOf(new TypeError("bad")), "TypeError: bad");
    assert.equal(messageOf(new Error("plain")), "plain");
    assert.equal(messageOf("text"), "text");
    assert.equal(messageOf({ message: "obj" }), "obj");
    assert.equal(messageOf({ a: 1 }), '{"a":1}');
    assert.equal(messageOf("x".repeat(5000)).length, 2000);
  });

  test("shortStack keeps only frames, at most 8", () => {
    const stack = ["Error: boom", ...Array.from({ length: 20 }, (_, i) => `    at f${i} (file.js:${i}:1)`)].join("\n");
    const out = shortStack(stack)!;
    assert.equal(out.split("\n").length, 8);
    assert.doesNotMatch(out, /boom/);
    assert.equal(shortStack("fn@http://localhost:3000/x.js:1:2\nother@x.js:3:4"), "fn@http://localhost:3000/x.js:1:2\nother@x.js:3:4");
    assert.equal(shortStack("no frames here"), undefined);
    assert.equal(shortStack(undefined), undefined);
  });

  test("envFileSecrets: secret-named values and token-looking values, not settings", () => {
    const env = [
      "# comment",
      "OPENAI_API_KEY=sk-proj-abcdef",
      'ANTHROPIC_API_KEY="sk-ant-quoted-value"',
      "EXA_API_KEY=",
      "LLM_PROVIDER=ollama",
      "LOCAL_LLM_MODEL=gemma4:latest",
      "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true",
      "CUSTOM_ENDPOINT_ID=a1b2c3d4e5f6g7h8i9j0",
      "export GITHUB_TOKEN=ghp_xyz",
    ].join("\n");
    assert.deepEqual(envFileSecrets(env), ["sk-proj-abcdef", "sk-ant-quoted-value", "a1b2c3d4e5f6g7h8i9j0", "ghp_xyz"]);
  });

  test("serverSanitizeContext reads scaffold/.env.local and secret-named env vars, not Windows' own variables", () => {
    const cwd = mkdtempSync(join(tmpdir(), "granted-ctx-"));
    try {
      writeFileSync(join(cwd, ".env.local"), "OPENAI_API_KEY=from-env-local-123\nLLM_PROVIDER=ollama\n");
      const ctx = serverSanitizeContext(cwd, { MY_SERVICE_TOKEN: "tok-from-env-9", SESSIONNAME: "Console", DEBUG: "true" });
      assert.ok(ctx.secrets?.includes("from-env-local-123"));
      assert.ok(ctx.secrets?.includes("tok-from-env-9"));
      assert.ok(!ctx.secrets?.includes("Console"));
      assert.ok(!ctx.secrets?.includes("ollama"));
      assert.equal(ctx.home, homedir());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
