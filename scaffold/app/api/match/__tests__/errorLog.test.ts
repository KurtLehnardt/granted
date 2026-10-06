/**
 * Failed searches and the error log (after merging the specific search
 * errors of #285): a Local setup step the user can take (Ollama not running,
 * the model not installed, no chat model) is guidance -- shown, not logged,
 * no report link. Anything else is logged, sanitized, with the message the
 * user saw, and its id goes to the page.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { handleMatchRequest, isLocalSetupGuidance, withShownMessage, type MatchDeps } from "../handler";
import { markChatError, ProviderHttpError } from "@/lib/llm/errors";
import { LocalSetupError } from "@/lib/llm/searchErrors";
import { __resetRateLimits } from "@/lib/security/rateLimit";
import { readErrorEntries } from "@/lib/errorLog/store";
import { isErrorId } from "@/lib/errorLog/errorId";

const DESCRIPTION = "We build AI-assisted diagnostics for rural clinics and need federal funding.";
let dir: string;
const saved = process.env["GRANTED_LOG_DIR"];
beforeEach(() => {
  __resetRateLimits();
  dir = mkdtempSync(join(tmpdir(), "granted-match-log-"));
  process.env["GRANTED_LOG_DIR"] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env["GRANTED_LOG_DIR"];
  else process.env["GRANTED_LOG_DIR"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

async function errorLine(deps: MatchDeps): Promise<{ error: string; errorId?: string; guidance?: boolean }> {
  const req = new Request("http://localhost/api/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: DESCRIPTION }) });
  const res = await handleMatchRequest(req, deps);
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === "error");
}

const origError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = origError;
  }
};

describe("Local setup steps are guidance: shown, not logged, no report link", () => {
  for (const kind of ["ollama_unreachable", "no_chat_models", "server_unreachable"] as const) {
    test(`preflight: ${kind}`, async () => {
      const line = await quiet(() =>
        errorLine({ cached: () => undefined, buildOpportunityMap: async () => { throw new Error("unreached"); }, resolveLlm: async () => { throw new LocalSetupError(kind, { host: "http://gpu-box:11434" }); } }),
      );
      assert.ok(line.error.length > 0);
      assert.equal(line.errorId, undefined);
      assert.equal(line.guidance, true, "the page mustn't log it either");
      assert.deepEqual(readErrorEntries(), []);
    });
  }

  test("Ollama stopping mid-search, and a model that isn't installed", async () => {
    const conn = markChatError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) }));
    const missing = markChatError(new ProviderHttpError(404, JSON.stringify({ error: { message: 'model "llama9:1b" not found, try pulling it first' } })));
    for (const thrown of [new Error("All scoring batches failed", { cause: conn }), missing]) {
      const line = await quiet(() => errorLine({ cached: () => undefined, buildOpportunityMap: async () => { throw thrown; }, resolveLlm: async () => ({ local: true, model: "llama9:1b" }) }));
      assert.equal(line.errorId, undefined, line.error);
    }
    assert.deepEqual(readErrorEntries(), []);
  });
});

describe("other failures are logged, with the message shown, and get an id", () => {
  test("a cloud provider out of credits: their specific message, logged (sanitized) as an llm-provider error", async () => {
    const providerErr = markChatError(
      Anthropic.APIError.generate(400, { error: { message: "Your credit balance is too low. key sk-ant-api03-SECRETSECRETSECRET for ops@example.com" } }, undefined, {}),
    );
    const line = await quiet(() => errorLine({ cached: () => undefined, buildOpportunityMap: async () => { throw providerErr; }, cloudProviderName: () => "Anthropic" }));
    assert.match(line.error, /Your Anthropic account is out of credits/);
    assert.ok(isErrorId(line.errorId));
    assert.equal(line.guidance, undefined);
    const [entry] = readErrorEntries();
    assert.equal(entry.id, line.errorId);
    assert.equal(entry.area, "llm-provider");
    assert.match(entry.message, /^Your Anthropic account is out of credits.*\(cause: /);
    assert.doesNotMatch(readFileSync(join(dir, "errors.jsonl"), "utf8"), /SECRETSECRET|ops@example\.com/);
  });

  test("a cloud proxy that's down: their message names it; the log has it, its host sanitized if private", async () => {
    const conn = markChatError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8082"), { code: "ECONNREFUSED" }) }));
    const line = await quiet(() => errorLine({ cached: () => undefined, buildOpportunityMap: async () => { throw conn; }, cloudProviderName: () => "OpenAI" }));
    assert.ok(isErrorId(line.errorId));
    const [entry] = readErrorEntries();
    assert.doesNotMatch(entry.message, /10\.1\.2\.3/);
    assert.match(entry.message, /\[private-host\]/);
  });

  test("an unknown error keeps the generic message, logged as a search error", async () => {
    const line = await quiet(() => errorLine({ cached: () => undefined, buildOpportunityMap: async () => { throw new Error("boom in C:\\Users\\kurt\\x"); } }));
    assert.equal(line.error, "The search didn't complete. Please try again.");
    assert.ok(isErrorId(line.errorId));
    const [entry] = readErrorEntries();
    assert.equal(entry.area, "search");
    assert.equal(entry.message, "boom in ~\\x");
  });
});

test("helpers", () => {
  assert.equal(isLocalSetupGuidance(new Error("x"), true), true);
  assert.equal(isLocalSetupGuidance(new Error("wrap", { cause: new LocalSetupError("no_chat_models") }), false), true);
  assert.equal(isLocalSetupGuidance(new Error("x"), false), false);
  const err = new Error("raw");
  assert.equal(withShownMessage(err, undefined), err);
  assert.deepEqual(withShownMessage(err, "Shown."), { message: "Shown. (cause: raw)", stack: err.stack });
  assert.ok(!existsSync(join(dir, "errors.jsonl")));
});
