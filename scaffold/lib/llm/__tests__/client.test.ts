import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeLlmClient, isLocalLlm } from "../client";
import { unwrapArrayEnvelope, coerceProfileStrings } from "../../claude";

/**
 * The local-model seam. The default (Anthropic) path is exercised by the rest of
 * the suite; here we lock in the translation the verification surfaced: provider
 * detection, the OpenAI-compatible request shape (system BLOCKS flattened to
 * text, JSON mode forced), the Anthropic-shaped response, and the array-envelope
 * unwrap that JSON-object mode makes necessary.
 */

const savedProvider = process.env.LLM_PROVIDER;
const savedModel = process.env.LOCAL_LLM_MODEL;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  globalThis.fetch = realFetch;
});

describe("isLocalLlm — provider detection", () => {
  test("default (unset) is NOT local", () => {
    delete process.env.LLM_PROVIDER;
    assert.equal(isLocalLlm(), false);
  });
  test("'anthropic' is NOT local; 'ollama' IS local", () => {
    process.env.LLM_PROVIDER = "anthropic";
    assert.equal(isLocalLlm(), false);
    process.env.LLM_PROVIDER = "ollama";
    assert.equal(isLocalLlm(), true);
  });
});

describe("openAI-compatible shim — request + response translation", () => {
  test("flattens system BLOCKS to text, forces JSON mode, returns Anthropic shape", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma4:latest";
    let sentBody: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      };
    }) as unknown as typeof fetch;

    const client = makeLlmClient({ timeout: 5000 });
    const msg: any = await client.messages.create({
      model: "claude-sonnet-4-6", // the shim ignores this and uses LOCAL_LLM_MODEL
      max_tokens: 1234,
      // system passed as Anthropic cache-control BLOCKS, not a string:
      system: [{ type: "text", text: "SCORE THINGS", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hello" }],
    });

    // request: model swapped to local, system flattened to text, JSON mode on
    assert.equal(sentBody.model, "gemma4:latest");
    assert.equal(sentBody.max_tokens, 1234);
    assert.deepEqual(sentBody.response_format, { type: "json_object" });
    assert.equal(sentBody.messages[0].role, "system");
    assert.equal(sentBody.messages[0].content, "SCORE THINGS"); // NOT "[object Object]"
    assert.equal(sentBody.messages[1].content, "hello");

    // response: Anthropic-shaped (content[].text + usage.{input,output}_tokens)
    assert.equal(msg.content[0].type, "text");
    assert.equal(msg.content[0].text, '{"ok":true}');
    assert.equal(msg.usage.input_tokens, 11);
    assert.equal(msg.usage.output_tokens, 7);
  });
});

describe("unwrapArrayEnvelope — undoes JSON-mode array wrapping", () => {
  test("unwraps a single array-valued key {candidates:[...]} → [...]", () => {
    assert.deepEqual(unwrapArrayEnvelope({ candidates: [{ id: "a", score: 5 }] }), [{ id: "a", score: 5 }]);
  });
  test("leaves a bare array untouched (the default Anthropic path)", () => {
    assert.deepEqual(unwrapArrayEnvelope([{ id: "a" }]), [{ id: "a" }]);
  });
  test("leaves a multi-key object untouched (the object-returning prompts)", () => {
    const profile = { profile: { industry: "bio" }, followUps: ["q"] };
    assert.deepEqual(unwrapArrayEnvelope(profile), profile);
  });
  test("leaves a single non-array key untouched", () => {
    assert.deepEqual(unwrapArrayEnvelope({ summary: "text" }), { summary: "text" });
  });
});

describe("coerceProfileStrings — local-model StartupProfile string-field drift", () => {
  test("leaves an already-correct (string-typed) profile untouched", () => {
    const profile = {
      description: "A biotech startup",
      location: "Austin, TX",
      revenue: "$1.2M",
      capitalRaised: "$500k seed",
      employees: 12,
      expandedTerms: ["biotech", "life sciences"],
    };
    assert.deepEqual(coerceProfileStrings(profile), profile);
  });

  test("coerces an object-valued string field (e.g. a structured location) to a compact JSON string", () => {
    const profile = { description: "d", location: { city: "Austin", state: "TX" } };
    const out = coerceProfileStrings(profile);
    assert.equal(out.location, '{"city":"Austin","state":"TX"}');
  });

  test("coerces an array of primitives on a string field by joining them", () => {
    const profile = { description: "d", capitalRaised: ["$500k", "seed round"] };
    const out = coerceProfileStrings(profile);
    assert.equal(out.capitalRaised, "$500k, seed round");
  });

  test("coerces an array of objects on a string field to a compact JSON string (not a naive join)", () => {
    const profile = { description: "d", revenue: [{ amount: "1M" }, { amount: "2M" }] };
    const out = coerceProfileStrings(profile);
    assert.equal(out.revenue, JSON.stringify([{ amount: "1M" }, { amount: "2M" }]));
  });

  test("null/undefined string fields pass through untouched", () => {
    const profile = { description: "d", location: null, revenue: undefined };
    const out = coerceProfileStrings(profile);
    assert.equal(out.location, null);
    assert.equal(out.revenue, undefined);
  });

  test("non-string-field values (e.g. employees: number, expandedTerms: string[]) are left alone", () => {
    const profile = { description: "d", employees: 42, expandedTerms: ["a", "b"], naicsGuesses: ["541511"] };
    const out = coerceProfileStrings(profile);
    assert.equal(out.employees, 42);
    assert.deepEqual(out.expandedTerms, ["a", "b"]);
    assert.deepEqual(out.naicsGuesses, ["541511"]);
  });
});
