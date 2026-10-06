import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleSearchModelDownloadPost, handleSearchStatusGet, type SearchStatusRouteDeps } from "../handler";
import type { SearchStatus } from "@/lib/embeddings/searchStatus";
import type { BuiltinModelStatus } from "@/lib/embeddings/builtin";

const req = { headers: { get: () => null } };
const status = (builtin: Partial<BuiltinModelStatus> = {}): SearchStatus => ({
  space: "builtin",
  label: "Built-in, on this computer",
  model: "nomic-embed-text-v1.5",
  reason: "No OpenAI key",
  setting: "auto",
  builtin: { state: "missing", model: "nomic-embed-text-v1.5", totalBytes: 274574153, ...builtin },
});

function deps(over: Partial<SearchStatusRouteDeps> = {}) {
  let starts = 0;
  let current = status();
  const d: SearchStatusRouteDeps = {
    isLoopbackRequest: () => true,
    buildStatus: () => current,
    startDownload: () => {
      starts++;
      current = status({ state: "downloading", pct: 0 });
    },
    ...over,
  };
  return { d, starts: () => starts };
}

describe("GET /api/llm/embeddings", () => {
  test("returns which embeddings search uses and the model's download state", async () => {
    const { d } = deps({ buildStatus: () => status({ state: "downloading", pct: 40 }) });
    const res = handleSearchStatusGet(d);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.label, "Built-in, on this computer");
    assert.equal(json.builtin.pct, 40);
  });
});

describe("POST /api/llm/embeddings", () => {
  test("403 off loopback (it writes the model to disk)", async () => {
    const { d, starts } = deps({ isLoopbackRequest: () => false });
    const res = handleSearchModelDownloadPost(req, d);
    assert.equal(res.status, 403);
    assert.equal(starts(), 0);
  });

  test("starts the download when the model is missing", async () => {
    const { d, starts } = deps();
    const res = handleSearchModelDownloadPost(req, d);
    assert.equal(res.status, 202);
    assert.equal(starts(), 1);
    assert.equal((await res.json()).status.builtin.state, "downloading");
  });

  test("retries after a failed download", async () => {
    const { d, starts } = deps({ buildStatus: () => status({ state: "failed", error: "offline" }) });
    const res = handleSearchModelDownloadPost(req, d);
    assert.equal(res.status, 202);
    assert.equal(starts(), 1);
  });

  test("no second download while one runs, and nothing to do once ready", async () => {
    for (const state of ["downloading", "ready"] as const) {
      const { d, starts } = deps({ buildStatus: () => status({ state }) });
      const res = handleSearchModelDownloadPost(req, d);
      assert.equal(res.status, 200);
      assert.equal(starts(), 0);
    }
  });

  test("a start that throws is a 500 with the reason", async () => {
    const { d } = deps({
      startDownload: () => {
        throw new Error("disk full");
      },
    });
    const res = handleSearchModelDownloadPost(req, d);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /disk full/);
  });
});
