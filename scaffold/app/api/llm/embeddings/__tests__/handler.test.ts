import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleLocalEmbeddingsGet, handleLocalEmbeddingsPost, type LocalEmbeddingsRouteDeps } from "../handler";
import type { LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";

const req = { headers: { get: () => null } };
const status = (s: Partial<LocalEmbeddingsStatus>): LocalEmbeddingsStatus => ({ state: "needed", model: "nomic-embed-text", active: false, ...s });

function deps(over: Partial<LocalEmbeddingsRouteDeps> = {}) {
  let starts = 0;
  let current = status({});
  const d: LocalEmbeddingsRouteDeps = {
    isLoopbackRequest: () => true,
    buildStatus: () => current,
    start: () => {
      starts++;
      current = status({ state: "running", progress: { stage: "checking" } });
      return { started: true };
    },
    ...over,
  };
  return { d, starts: () => starts };
}

describe("GET /api/llm/embeddings", () => {
  test("returns the current status", async () => {
    const { d } = deps({ buildStatus: () => status({ state: "running", progress: { stage: "pulling", pct: 40 } }) });
    const res = handleLocalEmbeddingsGet(d);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).progress, { stage: "pulling", pct: 40 });
  });
});

describe("POST /api/llm/embeddings", () => {
  test("403 off loopback (it spawns a process)", async () => {
    const { d, starts } = deps({ isLoopbackRequest: () => false });
    const res = handleLocalEmbeddingsPost(req, d);
    assert.equal(res.status, 403);
    assert.equal(starts(), 0);
  });

  test("202 + the fresh running status when started (also the Retry path)", async () => {
    const { d, starts } = deps();
    const res = handleLocalEmbeddingsPost(req, d);
    assert.equal(res.status, 202);
    const j = await res.json();
    assert.equal(j.started, true);
    assert.equal(j.status.state, "running");
    assert.equal(starts(), 1);
  });

  test("409 when a job is already running", async () => {
    const { d } = deps({ start: () => ({ started: false, reason: "running" }) });
    const res = handleLocalEmbeddingsPost(req, d);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "running");
  });

  test("embeddings configured in .env.local → nothing to do, nothing started", async () => {
    const { d, starts } = deps({ buildStatus: () => status({ state: "not-applicable" }) });
    const res = handleLocalEmbeddingsPost(req, d);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reason, "not-applicable");
    assert.equal(starts(), 0);
  });

  test("500 with a message when the job can't be spawned", async () => {
    const { d } = deps({
      start: () => {
        throw new Error("EACCES");
      },
    });
    const res = handleLocalEmbeddingsPost(req, d);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Couldn't start local search setup: EACCES/);
  });
});
