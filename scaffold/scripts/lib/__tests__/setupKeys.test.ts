import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupKeyReport } from "../setupKeys.mjs";

/** `npm run setup`: every key is optional; one scoring key (any) is the only thing it nudges for. */

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
const CLAUDE = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("setupKeyReport", () => {
  test("no keys at all: fine for search (built-in), just no scoring key yet", () => {
    const r = setupKeyReport("OPENAI_API_KEY=\nANTHROPIC_API_KEY=\n");
    assert.equal(r.hasScoringKey, false);
    assert.equal(r.searchUses, "builtin");
    assert.equal(r.openAiMalformed, false);
    assert.equal(r.anthropicMalformed, false);
  });

  test("the .env.example placeholders count as unset", () => {
    const r = setupKeyReport("OPENAI_API_KEY=sk-...\nANTHROPIC_API_KEY=sk-ant-...\n");
    assert.equal(r.hasScoringKey, false);
    assert.equal(r.openAiMalformed, false);
  });

  test("a Claude key alone is enough: it scores, and search runs built-in", () => {
    const r = setupKeyReport(`ANTHROPIC_API_KEY=${CLAUDE}\n`);
    assert.equal(r.hasScoringKey, true);
    assert.equal(r.searchUses, "builtin");
    assert.equal(r.anthropicMalformed, false);
  });

  test("an OpenAI key alone is enough, and search keeps using OpenAI's embeddings as before", () => {
    const r = setupKeyReport(`OPENAI_API_KEY=${OPENAI}\n`);
    assert.equal(r.hasScoringKey, true);
    assert.equal(r.searchUses, "openai");
  });

  test("malformed keys are flagged (and a malformed OpenAI key doesn't switch search to OpenAI)", () => {
    const r = setupKeyReport("OPENAI_API_KEY=sk-short\nANTHROPIC_API_KEY=sk-ant-bad key\n");
    assert.equal(r.openAiMalformed, true);
    assert.equal(r.anthropicMalformed, true);
    assert.equal(r.searchUses, "builtin");
  });
});
