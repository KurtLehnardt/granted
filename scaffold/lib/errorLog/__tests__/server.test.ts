import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cleanArea, envFileSecrets, isSecretEnv, logError, messageOf, resetOnceCache, serverSanitizeContext, shortStack } from "../server";
import { sanitize } from "../sanitize";
import { resetLlmConfigCache } from "../../llm/config";
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

  test("once: remembered in memory, not re-read from the log on every call (review of #286)", () => {
    const a = logError("app-update", "update failed", { once: "update-status:mem:1" });
    // The log file is gone, yet the key is still known: no re-read happened.
    rmSync(join(dir, "errors.jsonl"), { force: true });
    assert.equal(logError("app-update", "update failed", { once: "update-status:mem:1" }), a);
    assert.equal(readErrorEntries().length, 0);
    // After the log is cleared (resetOnceCache), the same failure can be logged again.
    resetOnceCache();
    assert.notEqual(logError("app-update", "update failed", { once: "update-status:mem:1" }), a);
    assert.equal(readErrorEntries().length, 1);
  });

  test("once: keys already in the log from an earlier run are honored", () => {
    const a = logError("app-update", "x", { once: "update-status:earlier:1" });
    resetOnceCache(); // a fresh process
    assert.equal(logError("app-update", "x", { once: "update-status:earlier:1" }), a);
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
    // the causes underneath, with their codes
    const conn = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
    assert.equal(messageOf(conn), "TypeError: fetch failed <- connect ECONNREFUSED 127.0.0.1:11434");
    assert.equal(messageOf(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "E_X" }) })), "outer <- inner (E_X)");
    const loop: Error & { cause?: unknown } = new Error("loop");
    loop.cause = loop;
    assert.equal(messageOf(loop), "loop");
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

  test("envFileSecrets: secret-named values and token-looking values, never ordinary settings", () => {
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
      // REGRESSION (review of #286): long, digit-bearing SETTINGS are not secrets.
      "OLLAMA_BASE_URL=http://127.0.0.1:11434",
      "EMBEDDINGS_BASE_URL=https://embed.example/v1/models123",
      "EMBEDDINGS_MODEL=nomic-embed-text-v1.5-q8_0",
      "LOCAL_LLM_MODEL_2=qwen2.5-coder:32b-instruct",
      "CLOUD_PROVIDER=openrouter2025abcdefgh",
      "SEARCH_EMBEDDINGS_CACHE=abc123def456ghi789",
      "MY_SECRET_KEY=short1",
    ].join("\n");
    assert.deepEqual(envFileSecrets(env), ["sk-proj-abcdef", "sk-ant-quoted-value", "a1b2c3d4e5f6g7h8i9j0", "ghp_xyz", "short1"]);
    assert.equal(isSecretEnv("OLLAMA_API_KEY", "abc123"), true, "a secret name always wins");
    assert.equal(isSecretEnv("DEBUG_TOKEN", "true"), false);
  });

  describe("serverSanitizeContext", () => {
    const savedCfg = process.env["GRANTED_LLM_CONFIG_PATH"];
    let cwd: string;
    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "granted-ctx-"));
      process.env["GRANTED_LLM_CONFIG_PATH"] = join(cwd, "llm-config.json");
      resetLlmConfigCache();
    });
    afterEach(() => {
      if (savedCfg === undefined) delete process.env["GRANTED_LLM_CONFIG_PATH"];
      else process.env["GRANTED_LLM_CONFIG_PATH"] = savedCfg;
      resetLlmConfigCache();
      rmSync(cwd, { recursive: true, force: true });
    });
    const saveCloud = (cloud: unknown) => {
      writeFileSync(join(cwd, "llm-config.json"), JSON.stringify({ provider: "cloud", cloud }));
      resetLlmConfigCache();
    };

    test("scaffold/.env.local and secret-named env vars, not Windows' own variables", () => {
      writeFileSync(join(cwd, ".env.local"), "OPENAI_API_KEY=from-env-local-123\nLLM_PROVIDER=ollama\nOLLAMA_BASE_URL=http://127.0.0.1:11434\n");
      const ctx = serverSanitizeContext(cwd, { MY_SERVICE_TOKEN: "tok-from-env-9", SESSIONNAME: "Console", DEBUG: "true" });
      assert.ok(ctx.secrets?.includes("from-env-local-123"));
      assert.ok(ctx.secrets?.includes("tok-from-env-9"));
      assert.ok(!ctx.secrets?.includes("Console"));
      assert.ok(!ctx.secrets?.includes("ollama"));
      assert.ok(!ctx.secrets?.includes("http://127.0.0.1:11434"));
      assert.equal(ctx.home, homedir());
    });

    test("the cloud key in use, from an env var with ANY name (review of #286)", () => {
      process.env["ODDLY_NAMED_VAR"] = "custom-key-value-from-env";
      try {
        saveCloud({ providerId: "other", baseUrl: "https://llm.acme-corp.example/v1", keySource: { type: "env", name: "ODDLY_NAMED_VAR" } });
        const ctx = serverSanitizeContext(cwd, {});
        assert.ok(ctx.secrets?.includes("custom-key-value-from-env"));
        assert.deepEqual(ctx.hosts, ["llm.acme-corp.example"]);
        assert.equal(sanitize("401 for custom-key-value-from-env at https://llm.acme-corp.example/v1", ctx), "401 for [redacted] at https://[private-host]/v1");
      } finally {
        delete process.env["ODDLY_NAMED_VAR"];
      }
    });

    test("the cloud key in use, from a key file (every line of it)", () => {
      const keyFile = join(cwd, "proxy_auth_token");
      writeFileSync(keyFile, "first-line-token-abc\nsecond-line-token-def\n");
      saveCloud({ providerId: "fcc", baseUrl: "http://127.0.0.1:8082", keySource: { type: "file", path: keyFile } });
      const ctx = serverSanitizeContext(cwd, {});
      assert.ok(ctx.secrets?.includes("first-line-token-abc"));
      assert.ok(ctx.secrets?.includes("second-line-token-def"));
      assert.deepEqual(ctx.hosts, [], "a loopback base URL is not private information");
    });

    test("the cloud key in use, saved inline", () => {
      saveCloud({ providerId: "groq", keySource: { type: "inline", key: "inline-saved-key-777" } });
      assert.ok(serverSanitizeContext(cwd, {}).secrets?.includes("inline-saved-key-777"));
    });

    test("private hosts from .env.local URLs and *_BASE_URL env vars; public and loopback hosts stay", () => {
      writeFileSync(join(cwd, ".env.local"), "EMBEDDINGS_BASE_URL=http://gpu-box.lan:8080/v1\nOPENAI_BASE_URL=https://api.openai.com/v1\n");
      const ctx = serverSanitizeContext(cwd, { ANTHROPIC_BASE_URL: "https://proxy.internal-co.example", OLLAMA_BASE_URL: "http://localhost:11434" });
      assert.deepEqual(ctx.hosts?.slice().sort(), ["gpu-box.lan", "proxy.internal-co.example"]);
    });
  });
});
