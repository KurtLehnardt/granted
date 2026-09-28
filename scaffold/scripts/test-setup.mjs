// Loaded via --import before any test file. Keeps the real, gitignored
// data/local/llm-config.json (see lib/llm/config.ts) out of the test run:
// without this, tests default to reading/writing that file, which is also
// where the dev server persists the Settings Local/Cloud switch — so once a
// user flips it, env-driven tests in that checkout start reading its
// contents, and in the worst case a saved Anthropic key gets used by tests
// that stub fetch but not the Anthropic SDK, making a real paid API call.
//
// Each test file runs in its own process (node:test's default), so this
// points every one at its own nonexistent path unless a suite (e.g.
// lib/llm/__tests__/config.test.ts) already set its own before importing
// anything.
import os from "node:os";
import path from "node:path";

if (!process.env.GRANTED_LLM_CONFIG_PATH) {
  process.env.GRANTED_LLM_CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-unset-${process.pid}.json`);
}
