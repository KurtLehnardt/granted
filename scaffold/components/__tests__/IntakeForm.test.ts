import { test } from "node:test";
import assert from "node:assert/strict";
import { canRunSample } from "../IntakeForm";

// IntakeFormHandle.runSample must never start a concurrent search — replaying
// the welcome guide from Settings mid-search and picking a sample must be a
// no-op until the current search finishes.
test("canRunSample: false while a search is in flight, true when idle", () => {
  assert.equal(canRunSample(true), false);
  assert.equal(canRunSample(false), true);
});
