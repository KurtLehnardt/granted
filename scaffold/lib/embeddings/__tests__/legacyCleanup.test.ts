import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLegacyLocalEmbeddings } from "../legacyCleanup";

test("the retired Ollama index and its job files are removed on upgrade, and nothing else", () => {
  const base = mkdtempSync(join(tmpdir(), "granted-legacy-"));
  try {
    const local = join(base, "data", "local");
    mkdirSync(join(local, "local-embeddings"), { recursive: true });
    writeFileSync(join(local, "local-embeddings", "opportunities.json"), "[]");
    for (const f of ["local-embeddings-job.json", "local-embeddings-job.log", "local-embeddings.lock", "opportunities.json", "llm-config.json"]) {
      writeFileSync(join(local, f), "{}");
    }
    removeLegacyLocalEmbeddings(base);
    for (const gone of ["local-embeddings", "local-embeddings-job.json", "local-embeddings-job.log", "local-embeddings.lock"]) {
      assert.equal(existsSync(join(local, gone)), false, gone);
    }
    assert.equal(existsSync(join(local, "opportunities.json")), true, "the refreshed corpus stays");
    assert.equal(existsSync(join(local, "llm-config.json")), true, "Settings stay");
    removeLegacyLocalEmbeddings(base); // nothing left: still fine
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
