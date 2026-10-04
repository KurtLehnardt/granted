import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpportunityMap } from "../match";
import { embeddingTargetForCorpus, type EmbedOptions } from "../embed";
import { resetLlmConfigCache } from "../llm/config";

/**
 * One decision for corpus + query embedding: buildOpportunityMap loads the corpus
 * once and embeds the query with the target matching THAT corpus (the Settings →
 * Local index, or the hosted one), so a local 768-dim query can never be compared
 * against the 512-dim hosted corpus because two separate checks disagreed.
 */

const saved = { cfg: process.env.GRANTED_LLM_CONFIG_PATH, base: process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR };
let dir = "";
afterEach(() => {
  for (const [k, v] of [["GRANTED_LLM_CONFIG_PATH", saved.cfg], ["GRANTED_LOCAL_EMBEDDINGS_BASE_DIR", saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetLlmConfigCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function setup(provider: "ollama" | "cloud") {
  dir = mkdtempSync(join(tmpdir(), "granted-match-target-"));
  writeFileSync(join(dir, "llm-config.json"), JSON.stringify({ provider }));
  process.env.GRANTED_LLM_CONFIG_PATH = join(dir, "llm-config.json");
  process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR = dir;
  resetLlmConfigCache();
  const idx = join(dir, "data", "local", "local-embeddings");
  mkdirSync(idx, { recursive: true });
  const opp = { id: "x1", source: "grants.gov", kind: "grant", program: "P", agency: "A", description: "D", eligibility: "E", embedding: [1, 0, 0] };
  writeFileSync(join(idx, "opportunities.json"), JSON.stringify([opp]));
  writeFileSync(join(idx, "corpus-meta.json"), JSON.stringify({ complete: true, embeddingModel: "nomic-embed-text", dims: 3, count: 1 }));
}

async function targetUsedBySearch(): Promise<EmbedOptions["target"]> {
  let seen: EmbedOptions | undefined;
  await assert.rejects(
    buildOpportunityMap("We build sensing hardware.", undefined, {
      extractProfile: async () => ({ profile: { description: "x" }, followUps: [] }) as any,
      embed: (async (_t: string, _m: unknown, _s: unknown, opts?: EmbedOptions) => {
        seen = opts;
        throw new Error("stop after the first embed");
      }) as any,
    }),
    /stop after the first embed/,
  );
  return seen?.target;
}

describe("buildOpportunityMap — query embedding follows the loaded corpus", () => {
  test("Local + ready index → the search loads the index and embeds the query locally", async () => {
    setup("ollama");
    const target = await targetUsedBySearch();
    assert.equal(target?.source, "settings-local");
    assert.equal(target?.model, "nomic-embed-text");
  });

  test("Cloud → hosted corpus, hosted (env) query embedding, even with the index on disk", async () => {
    setup("cloud");
    const target = await targetUsedBySearch();
    assert.equal(target?.source, "env");
  });

  test("embeddingTargetForCorpus maps each corpus source to its embedding space", () => {
    assert.equal(embeddingTargetForCorpus("local-embeddings").source, "settings-local");
    assert.equal(embeddingTargetForCorpus("local").source, "env");
    assert.equal(embeddingTargetForCorpus("committed").source, "env");
  });
});
