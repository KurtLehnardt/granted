import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeLlmClient, isLocalLlm, defaultLocalModel } from "../client";
import { withLocalModel } from "../modelContext";
import { unwrapArrayEnvelope, coerceProfileStrings, coerceEmployees } from "../../claude";

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

describe("defaultLocalModel — the single shared fallback", () => {
  test("uses LOCAL_LLM_MODEL when set", () => {
    process.env.LOCAL_LLM_MODEL = "qwen2.5:7b";
    assert.equal(defaultLocalModel(), "qwen2.5:7b");
  });
  test("falls back to gemma4:latest when unset OR set to an empty string", () => {
    delete process.env.LOCAL_LLM_MODEL;
    assert.equal(defaultLocalModel(), "gemma4:latest");
    process.env.LOCAL_LLM_MODEL = "";
    assert.equal(defaultLocalModel(), "gemma4:latest"); // `??` would wrongly keep ""
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

  test("withLocalModel overrides LOCAL_LLM_MODEL for calls made inside its scope", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma4:latest";
    let sentBody: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    const client = makeLlmClient({ timeout: 5000 });
    const msg: any = await withLocalModel("qwen2.5:7b", () =>
      client.messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    );

    assert.equal(sentBody.model, "qwen2.5:7b");
    assert.equal(msg.model, "qwen2.5:7b");

    // outside the scope, the env default is used again
    sentBody = null;
    await client.messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(sentBody.model, "gemma4:latest");
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

  test("undefined string fields pass through untouched", () => {
    const profile = { description: "d", revenue: undefined };
    const out = coerceProfileStrings(profile);
    assert.equal(out.revenue, undefined);
  });

  test("drops a `null` string field (optional(), not nullable() — null still fails the boundary)", () => {
    const out = coerceProfileStrings({ description: "d", location: null, revenue: "$1M" });
    assert.equal("location" in out, false);
    assert.equal(out.revenue, "$1M");
  });

  test("coerces a numeric string field (e.g. the model returning a bare number) to a string", () => {
    const out = coerceProfileStrings({ description: "d", revenue: 500000, capitalRaised: 250000 });
    assert.equal(out.revenue, "500000");
    assert.equal(out.capitalRaised, "250000");
  });

  test("non-string-field values (e.g. employees: number, expandedTerms: string[]) are left alone", () => {
    const profile = { description: "d", employees: 42, expandedTerms: ["a", "b"], naicsGuesses: ["541511"] };
    const out = coerceProfileStrings(profile);
    assert.equal(out.employees, 42);
    assert.deepEqual(out.expandedTerms, ["a", "b"]);
    assert.deepEqual(out.naicsGuesses, ["541511"]);
  });

  test("coerces a numeric-string `employees` to a number (drift → usable size fact)", () => {
    assert.equal(coerceProfileStrings({ description: "d", employees: "50" }).employees, 50);
    assert.equal(coerceProfileStrings({ description: "d", employees: "50 employees" }).employees, 50);
    assert.equal(coerceProfileStrings({ description: "d", employees: "1,200" }).employees, 1200);
  });

  test("coerces an `employees` range to its UPPER bound (conservative for the size cap)", () => {
    assert.equal(coerceProfileStrings({ description: "d", employees: "11-50" }).employees, 50);
    assert.equal(coerceProfileStrings({ description: "d", employees: "11–50" }).employees, 50);
  });

  test("drops an unrecoverable `employees` value so the number-typed zod field still validates", () => {
    const out = coerceProfileStrings({ description: "d", employees: "a few" });
    assert.equal("employees" in out, false);
  });
});

describe("coerceEmployees — number-field drift", () => {
  test("passes finite numbers through; rejects NaN/Infinity", () => {
    assert.equal(coerceEmployees(42), 42);
    assert.equal(coerceEmployees(0), 0);
    assert.equal(coerceEmployees(NaN), undefined);
    assert.equal(coerceEmployees(Infinity), undefined);
  });

  test("parses numeric strings, ranges (upper bound), and returns undefined when no integer", () => {
    assert.equal(coerceEmployees("500"), 500);
    assert.equal(coerceEmployees("~50 FTE"), 50);
    assert.equal(coerceEmployees("300-800"), 800);
    assert.equal(coerceEmployees("unknown"), undefined);
    assert.equal(coerceEmployees(null), undefined);
    assert.equal(coerceEmployees({ n: 5 }), undefined);
  });
});
