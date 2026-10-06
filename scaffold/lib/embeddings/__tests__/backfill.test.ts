import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillSettled, builtinBackfillStatus, resetBackfill, startBuiltinVectorBackfill } from "../backfill";
import { buildSearchStatus, needsBuiltinBackfill } from "../searchStatus";
import { getSpace } from "../spaces";
import { readVectorFile, textHash, writeVectorFile } from "../../../scripts/lib/vectorFile.mjs";
import { spaceDocumentText } from "../../../scripts/lib/spaceVectors.mjs";
import { BUILTIN_MODEL } from "../../../scripts/lib/builtinModel.mjs";
import { describeLocalSearchStatus } from "../../../components/LocalSearchStatus";

/**
 * A data:refresh copy from before the built-in model (or made while search used
 * OpenAI) has records with no built-in vector. Search on the built-in model fills
 * them in, once, in the background, embedding only what's missing.
 */

afterEach(() => resetBackfill());

const space = getSpace("builtin");
const opp = (id: string) => ({ id, program: `P ${id}`, agency: "A", description: `About ${id}.` });
const vec = (x: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? x : 0));

function setup() {
  const baseDir = mkdtempSync(join(tmpdir(), "granted-backfill-"));
  const [a, b, c] = [opp("a"), opp("b"), opp("c")];
  mkdirSync(join(baseDir, "data", "local"), { recursive: true });
  writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify([a]));
  writeFileSync(join(baseDir, "data", "local", "opportunities.json"), JSON.stringify([a, b, c]));
  // The committed file covers "a" only (the shipped corpus).
  writeVectorFile(join(baseDir, "data", "vectors"), "nomic-embed-text-v1.5", { space: "builtin", model: space.model, revision: BUILTIN_MODEL.revision, dims: 768 }, [
    { id: "a", vector: vec(1), textHash: textHash(spaceDocumentText(space, a)) },
  ]);
  return baseDir;
}

describe("startBuiltinVectorBackfill", () => {
  test("embeds only the records without a vector and writes data/local/vectors with all of them", async () => {
    const baseDir = setup();
    const seen: string[][] = [];
    try {
      const started = startBuiltinVectorBackfill({
        baseDir,
        modelPresent: () => true,
        pauseMs: 0,
        batch: 1,
        embed: async (texts) => {
          seen.push(texts);
          return texts.map(() => vec(0.5));
        },
      });
      assert.equal(started, true);
      assert.equal(builtinBackfillStatus().running, true);
      await backfillSettled();
      assert.deepEqual(seen.flat().sort(), [spaceDocumentText(space, opp("b")), spaceDocumentText(space, opp("c"))].sort());
      const file = readVectorFile(join(baseDir, "data", "local", "vectors"), "nomic-embed-text-v1.5")!;
      assert.deepEqual(Array.from(file.vectors.keys()).sort(), ["a", "b", "c"]);
      assert.equal(file.meta.revision, BUILTIN_MODEL.revision);
      assert.equal(builtinBackfillStatus().running, false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("one run at a time, and none without the model", async () => {
    const baseDir = setup();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const deps = { baseDir, modelPresent: () => true, pauseMs: 0, batch: 8, embed: async (t: string[]) => (await gate, t.map(() => vec(1))) };
      assert.equal(startBuiltinVectorBackfill(deps), true);
      assert.equal(startBuiltinVectorBackfill(deps), false, "a second start while running does nothing");
      release();
      await backfillSettled();
      assert.equal(startBuiltinVectorBackfill({ ...deps, modelPresent: () => false }), false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("a failure is kept for the status line, and the next start tries again", async () => {
    const baseDir = setup();
    try {
      startBuiltinVectorBackfill({ baseDir, modelPresent: () => true, pauseMs: 0, batch: 8, embed: async () => { throw new Error("model crashed"); } });
      await backfillSettled();
      assert.match(builtinBackfillStatus().error!, /model crashed/);
      assert.equal(startBuiltinVectorBackfill({ baseDir, modelPresent: () => true, pauseMs: 0, batch: 8, embed: async (t) => t.map(() => vec(1)) }), true);
      await backfillSettled();
      assert.equal(builtinBackfillStatus().error, undefined);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("the Search line's coverage", () => {
  const info = (withVectors: number, total: number) => ({ space, withVectors, opportunities: new Array(total).fill({}) });

  test("needsBuiltinBackfill only on the built-in space with records missing", () => {
    assert.equal(needsBuiltinBackfill(info(4120, 4698) as any), true);
    assert.equal(needsBuiltinBackfill(info(4698, 4698) as any), false);
    assert.equal(needsBuiltinBackfill({ ...info(1, 2), space: getSpace("openai") } as any), false);
  });

  test("status reports coverage, starts the backfill, and the line says how much is indexed", () => {
    const KEYS = ["OPENAI_API_KEY", "EMBEDDINGS_API_KEY", "SEARCH_EMBEDDINGS", "EMBEDDINGS_BASE_URL", "EMBEDDINGS_MODEL", "EMBEDDINGS_DIMENSIONS", "LLM_PROVIDER"];
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    KEYS.forEach((k) => delete process.env[k]);
    try {
      let starts = 0;
      const status = buildSearchStatus({
        corpus: () => info(4120, 4698) as any,
        builtin: () => ({ state: "ready", model: "nomic-embed-text-v1.5", totalBytes: 1 }),
        backfill: () => ({ running: true, done: 289, total: 578 }),
        startBackfill: () => void starts++,
      });
      assert.equal(status.space, "builtin");
      assert.equal(starts, 1);
      assert.deepEqual(status.coverage, { withVectors: 4120, total: 4698, backfill: { running: true, done: 289, total: 578 } });
      const view = describeLocalSearchStatus(status)!;
      assert.match(view.detail!, /4,120 of 4,698 grants are indexed for search/);
      assert.match(view.detail!, /\(50%\)/);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("fully indexed: nothing extra on the line", () => {
    const view = describeLocalSearchStatus({
      space: "builtin",
      label: "Built-in, on this computer",
      model: "nomic-embed-text-v1.5",
      reason: "No OpenAI key",
      setting: "auto",
      builtin: { state: "ready", model: "nomic-embed-text-v1.5", totalBytes: 1 },
      coverage: { withVectors: 10, total: 10 },
    })!;
    assert.doesNotMatch(view.detail!, /indexed for search/);
  });

  test("the store's note (a refresh copy from another model) is shown", () => {
    const view = describeLocalSearchStatus({
      space: "openai",
      label: "OpenAI embeddings",
      model: "text-embedding-3-small",
      reason: "OpenAI key present",
      setting: "auto",
      builtin: { state: "ready", model: "nomic-embed-text-v1.5", totalBytes: 1 },
      note: "Your refreshed grant list was embedded with another model.",
    })!;
    assert.match(view.detail!, /embedded with another model/);
  });
});
