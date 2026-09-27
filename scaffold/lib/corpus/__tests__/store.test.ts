import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorpusStore } from "../store";

function makeBaseDir() {
  return mkdtempSync(join(tmpdir(), "granted-corpus-store-"));
}

function writeCommitted(baseDir: string, opps: unknown[], meta: object = {}) {
  mkdirSync(join(baseDir, "data"), { recursive: true });
  writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify(opps));
  writeFileSync(join(baseDir, "data", "corpus-meta.json"), JSON.stringify(meta));
}

function writeLocal(baseDir: string, opps: unknown[], meta: object = {}) {
  mkdirSync(join(baseDir, "data", "local"), { recursive: true });
  writeFileSync(join(baseDir, "data", "local", "opportunities.json"), JSON.stringify(opps));
  writeFileSync(join(baseDir, "data", "local", "corpus-meta.json"), JSON.stringify(meta));
}

describe("CorpusStore", () => {
  test("falls back to the committed corpus when no local refresh exists", () => {
    const baseDir = makeBaseDir();
    writeCommitted(baseDir, [{ id: "a" }], { builtAt: "2026-01-01T00:00:00.000Z" });
    const store = new CorpusStore(baseDir);
    const info = store.load();
    assert.equal(info.source, "committed");
    assert.equal(info.opportunities.length, 1);
    assert.equal(info.meta.builtAt, "2026-01-01T00:00:00.000Z");
    assert.equal(info.meta.count, 1);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("prefers the local refresh over the committed corpus", () => {
    const baseDir = makeBaseDir();
    writeCommitted(baseDir, [{ id: "committed" }], { builtAt: "2026-01-01T00:00:00.000Z" });
    writeLocal(baseDir, [{ id: "local-1" }, { id: "local-2" }], { builtAt: "2026-09-01T00:00:00.000Z", embeddingModel: "nomic-embed-text" });
    const store = new CorpusStore(baseDir);
    const info = store.load();
    assert.equal(info.source, "local");
    assert.equal(info.opportunities.length, 2);
    assert.equal(info.meta.embeddingModel, "nomic-embed-text");
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("caches until the resolved file's mtime changes", () => {
    const baseDir = makeBaseDir();
    const path = join(baseDir, "data", "opportunities.json");
    writeCommitted(baseDir, [{ id: "a" }]);
    const fixed = new Date(2026, 0, 1);
    utimesSync(path, fixed, fixed);

    const store = new CorpusStore(baseDir);
    const first = store.load();
    assert.equal(first.opportunities.length, 1);

    // Rewrite with different content but pin the SAME mtime — cache should stick.
    writeFileSync(path, JSON.stringify([{ id: "a" }, { id: "b" }]));
    utimesSync(path, fixed, fixed);
    const stillCached = store.load();
    assert.equal(stillCached.opportunities.length, 1);

    // Bump mtime forward — the store must pick up the new content.
    const future = new Date(fixed.getTime() + 60_000);
    utimesSync(path, future, future);
    const reloaded = store.load();
    assert.equal(reloaded.opportunities.length, 2);

    rmSync(baseDir, { recursive: true, force: true });
  });

  test("invalidate() forces a fresh read regardless of mtime", () => {
    const baseDir = makeBaseDir();
    writeCommitted(baseDir, [{ id: "a" }]);
    const store = new CorpusStore(baseDir);
    store.load();
    writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
    store.invalidate();
    assert.equal(store.load().opportunities.length, 2);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("a corrupt local opportunities.json falls back to the committed corpus", () => {
    const baseDir = makeBaseDir();
    writeCommitted(baseDir, [{ id: "committed" }], { builtAt: "2026-01-01T00:00:00.000Z" });
    mkdirSync(join(baseDir, "data", "local"), { recursive: true });
    writeFileSync(join(baseDir, "data", "local", "opportunities.json"), "{not valid json");
    const store = new CorpusStore(baseDir);
    const info = store.load();
    assert.equal(info.source, "committed");
    assert.deepEqual(info.opportunities, [{ id: "committed" }]);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("missing/corrupt files degrade to an empty corpus, never throw", () => {
    const baseDir = makeBaseDir();
    const store = new CorpusStore(baseDir);
    const info = store.load();
    assert.deepEqual(info.opportunities, []);
    assert.equal(info.meta.count, 0);
    rmSync(baseDir, { recursive: true, force: true });
  });
});
