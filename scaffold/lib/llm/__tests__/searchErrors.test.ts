import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderHttpError, markChatError } from "../errors";
import { LocalSetupError, describeSearchError, isConnectionError, shortProviderLabel } from "../searchErrors";

/** Errors as the chat client throws them (makeLlmClient marks every one). */
const chat = <T,>(e: T) => markChatError(e);

const anthropicErr = (status: number, message: string, type = "invalid_request_error") =>
  chat(Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, {} as any));

const connRefused = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
  });

const cloud = { local: false, provider: "Anthropic", baseUrl: "https://api.anthropic.com" };
const local = { local: true, model: "gemma4:latest", host: "http://localhost:11434" };

describe("describeSearchError — Local", () => {
  test("Ollama unreachable (preflight)", () => {
    const msg = describeSearchError(new LocalSetupError("ollama_unreachable"), local)!;
    assert.match(msg, /^Granted couldn't reach Ollama/);
    assert.match(msg, /start it in Settings → Model/);
  });
  test("Ollama unreachable mid-search: a refused connection, even wrapped as a batch failure's cause", () => {
    assert.match(describeSearchError(chat(connRefused()), local)!, /couldn't reach Ollama/);
    const wrapped = new Error("All scoring batches failed: fetch failed", { cause: chat(connRefused()) });
    assert.match(describeSearchError(wrapped, local)!, /couldn't reach Ollama/);
  });
  test("a non-Ollama local server (LM Studio on :1234) unreachable names that server, not Ollama", () => {
    const msg = describeSearchError(chat(connRefused()), { local: true, host: "http://127.0.0.1:1234" })!;
    assert.equal(msg, "Couldn't reach the local model server at http://127.0.0.1:1234 — start it, or switch to Cloud in Settings → Model.");
    assert.equal(
      describeSearchError(new LocalSetupError("server_unreachable", { host: "http://127.0.0.1:1234" }), local),
      msg,
    );
  });
  test("no chat model (preflight)", () => {
    assert.match(describeSearchError(new LocalSetupError("no_chat_models"), local)!, /no chat model installed/);
  });
  test("Ollama's 'model not found' 404 mid-search", () => {
    const ollama404 = chat(new ProviderHttpError(404, JSON.stringify({ error: { message: 'model "gemma4:latest" not found, try pulling it first' } })));
    const msg = describeSearchError(ollama404, local)!;
    assert.match(msg, /"gemma4:latest" isn't installed in Ollama/);
    assert.match(msg, /Settings → Model/);
  });
  test("a 404 that isn't about a model (wrong base URL) is left to the existing handling", () => {
    assert.equal(describeSearchError(chat(new ProviderHttpError(404, "404 page not found")), local), undefined);
  });
  test("unknown errors are left alone", () => {
    assert.equal(describeSearchError(chat(new Error("kaboom")), local), undefined);
  });
});

describe("describeSearchError — Cloud", () => {
  test("Anthropic out of credits (400 'credit balance is too low')", () => {
    const err = anthropicErr(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
    assert.equal(
      describeSearchError(err, cloud),
      "Your Anthropic account is out of credits — add credits, or switch to Local in Settings → Model.",
    );
  });
  test("OpenAI out of quota (429 insufficient_quota) and a generic 402", () => {
    const quota = chat(new ProviderHttpError(429, JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } })));
    assert.match(describeSearchError(quota, { local: false, provider: "OpenAI" })!, /^Your OpenAI account is out of credits/);
    assert.match(describeSearchError(chat(new ProviderHttpError(402, "Payment Required")), { local: false, provider: "OpenRouter" })!, /OpenRouter account is out of credits/);
  });
  test("a rate limit that links a billing page is not 'out of credits'", () => {
    const groq = chat(new ProviderHttpError(429, JSON.stringify({ error: { message: "Rate limit reached for model llama-3.3-70b on tokens per minute. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing" } })));
    assert.equal(describeSearchError(groq, { local: false, provider: "Groq" }), undefined);
  });
  test("an invalid or revoked key", () => {
    assert.match(describeSearchError(anthropicErr(401, "invalid x-api-key", "authentication_error"), cloud)!, /Anthropic API key was rejected/);
    const openai = chat(new ProviderHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-abc***xyz." } })));
    const msg = describeSearchError(openai, { local: false, provider: "OpenAI" })!;
    assert.match(msg, /OpenAI API key was rejected \(it's invalid or has been revoked\)/);
    assert.doesNotMatch(msg, /sk-/);
  });
  test("the provider unreachable", () => {
    assert.match(describeSearchError(chat(connRefused()), cloud)!, /couldn't reach Anthropic — check your internet connection/);
  });
  test("a 5xx or an unrecognized 4xx is left to the existing handling", () => {
    assert.equal(describeSearchError(anthropicErr(500, "internal error", "api_error"), cloud), undefined);
    assert.equal(describeSearchError(anthropicErr(400, "max_tokens: too large"), cloud), undefined);
  });
  test("no provider name -> 'cloud provider'", () => {
    assert.match(describeSearchError(chat(new ProviderHttpError(402, "x")), { local: false })!, /Your cloud provider account/);
  });
});

describe("describeSearchError — only the chat provider is blamed for the chat client's errors", () => {
  test("an error not thrown by the chat client (an embeddings call, the built-in model) maps to nothing", () => {
    const embeddings401 = new ProviderHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    assert.equal(describeSearchError(embeddings401, cloud), undefined);
    assert.equal(describeSearchError(connRefused(), cloud), undefined);
    assert.equal(describeSearchError(connRefused(), local), undefined);
  });
});

describe("describeSearchError — a proxy on this machine (fcc)", () => {
  const fcc = { local: false, provider: "proxy", baseUrl: "http://127.0.0.1:8082" };
  test("unreachable -> 'is the proxy running at <url>?', not 'check your internet connection'", () => {
    const msg = describeSearchError(chat(connRefused()), fcc)!;
    assert.match(msg, /couldn't reach the proxy at http:\/\/127\.0\.0\.1:8082 — is it running\?/);
    assert.doesNotMatch(msg, /internet/);
  });
  test("a bare 402 from the proxy isn't 'your proxy account is out of credits'", () => {
    assert.equal(describeSearchError(chat(new ProviderHttpError(402, "Payment Required")), fcc), undefined);
  });
  test("…unless its error really says the upstream credit is gone", () => {
    const err = anthropicErr(400, "Your credit balance is too low to access the Anthropic API.");
    assert.match(describeSearchError(err, fcc)!, /out of credits/);
  });
});

test("isConnectionError: refused/DNS/reset yes, HTTP errors and timeouts no", () => {
  assert.equal(isConnectionError(connRefused()), true);
  assert.equal(isConnectionError(Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), { code: "ENOTFOUND" })), true);
  assert.equal(isConnectionError(new ProviderHttpError(500, "")), false);
  assert.equal(isConnectionError(new Error("timeout")), false);
});

test("shortProviderLabel", () => {
  assert.equal(shortProviderLabel("Anthropic (Claude)"), "Anthropic");
  assert.equal(shortProviderLabel("OpenAI"), "OpenAI");
  assert.equal(shortProviderLabel("Other (OpenAI-compatible)"), undefined);
  assert.equal(shortProviderLabel("Anthropic-compatible proxy (e.g. Free Claude Code)"), "proxy");
});
