import { test } from "node:test";
import assert from "node:assert/strict";

import { usageAttribution } from "../claude";

// The cost log must name the model that actually ran. With only an OpenAI key
// the scoring runs on OpenAI's model through the shim — metering it as the
// stage's Claude model would price a gpt-4o-mini call at Sonnet rates.

const STAGE_MODEL = "claude-sonnet-4-5";

test("local runs are metered as the local model via the shim", () => {
  assert.deepEqual(usageAttribution({ local: true, localModel: "qwen2.5:7b", stageModel: STAGE_MODEL }), {
    provider: "openai",
    model: "qwen2.5:7b",
  });
});

test("an OpenAI-only cloud config is metered as OpenAI's model, not Claude's", () => {
  const got = usageAttribution({
    local: false,
    cloud: { providerId: "openai", keySource: { type: "env", name: "OPENAI_API_KEY" } },
    stageModel: STAGE_MODEL,
  });
  assert.equal(got.provider, "openai");
  assert.notEqual(got.model, STAGE_MODEL);
  assert.match(got.model, /gpt/);
});

test("Anthropic is metered as the stage's Claude model", () => {
  assert.deepEqual(
    usageAttribution({
      local: false,
      cloud: { providerId: "anthropic", keySource: { type: "env", name: "ANTHROPIC_API_KEY" } },
      stageModel: STAGE_MODEL,
    }),
    { provider: "anthropic", model: STAGE_MODEL },
  );
});

test("no cloud config falls back to the stage model on Anthropic", () => {
  assert.deepEqual(usageAttribution({ local: false, stageModel: STAGE_MODEL }), {
    provider: "anthropic",
    model: STAGE_MODEL,
  });
});
