import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILTIN_MODEL, builtinModelPresent, loadBuiltinEmbedder } from "../../../scripts/lib/builtinModel.mjs";
import { readVectorFile } from "../../../scripts/lib/vectorFile.mjs";
import { spaceDocumentText } from "../../../scripts/lib/spaceVectors.mjs";
import { getSpace } from "../spaces";

/**
 * The real built-in model, end to end. Skipped unless the model files are in
 * scaffold/models/ (`npm run model:fetch`), so CI and fresh clones stay
 * hermetic. The Ollama comparison is also skipped unless an Ollama with
 * nomic-embed-text answers on 127.0.0.1:11434.
 *
 *   1. A known query embeds to a known vector (checksum of the rounded values),
 *      so a model, dtype, tokenizer or pooling change can't slip in unnoticed.
 *   2. The shipped corpus vectors are what this model produces for those records.
 *   3. Ollama's nomic-embed-text gives the same vectors, which is why Local
 *      (Ollama) users can search the shipped corpus.
 */

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODELS = join(SCAFFOLD, "models");
const present = builtinModelPresent(MODELS);
// CI's Windows model job sets GRANTED_REQUIRE_MODEL so a missing model fails instead of skipping.
const skip = present || process.env.GRANTED_REQUIRE_MODEL ? false : "model files not in scaffold/models (npm run model:fetch)";

const QUERY = "search_query: Community health clinic expanding mental health services for rural veterans";
/** sha256 of the query vector's components rounded to 3 decimals and joined with ",". */
const QUERY_CHECKSUM = "c856f1c69c4ceaf06a38537439aeea39fe162df0ae9c7e0df41f9d59d99e9ac1";

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
};

const checksum = (v: number[]) =>
  createHash("sha256")
    .update(v.map((x) => (Math.round(x * 1000) / 1000).toFixed(3)).join(","))
    .digest("hex");

describe("built-in search model (integration)", { skip }, () => {
  let embedder: Awaited<ReturnType<typeof loadBuiltinEmbedder>>;
  before(async () => {
    embedder = await loadBuiltinEmbedder({ dir: MODELS });
  });

  test("a known query embeds to the known vector", async () => {
    const [v] = await embedder.embed([QUERY]);
    assert.equal(v.length, BUILTIN_MODEL.dims);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-4, "unit length");
    assert.equal(checksum(v), QUERY_CHECKSUM);
  });

  test("the shipped corpus vectors match what the model produces for those records", async () => {
    const space = getSpace("builtin");
    const file = readVectorFile(join(SCAFFOLD, "data", "vectors"), "nomic-embed-text-v1.5");
    assert.ok(file, "data/vectors/nomic-embed-text-v1.5 is committed");
    const opps = JSON.parse(readFileSync(join(SCAFFOLD, "data", "opportunities.json"), "utf8")) as Array<{ id: string; program: string; agency: string; description: string }>;
    for (const o of [opps[0], opps[Math.floor(opps.length / 2)], opps[opps.length - 1]]) {
      const shipped = file!.vectors.get(o.id);
      assert.ok(shipped, `${o.id} has a shipped vector`);
      const [fresh] = await embedder.embed([spaceDocumentText(space, o)]);
      assert.ok(cos(fresh, shipped!.vector) > 0.999, `${o.id}: cos ${cos(fresh, shipped!.vector)}`);
    }
  });

  test("Ollama's nomic-embed-text gives the same vectors", async (t) => {
    const texts = [QUERY, "search_document: Grants to support small farmers adopting sustainable irrigation.", "search_query: iron-based grid-scale batteries"];
    let ollama: number[][];
    try {
      const res = await fetch("http://127.0.0.1:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: texts }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return t.skip(`Ollama answered HTTP ${res.status} (is nomic-embed-text pulled?)`);
      ollama = (await res.json()).embeddings;
    } catch {
      return t.skip("no Ollama on 127.0.0.1:11434");
    }
    const onnx = await embedder.embed(texts);
    texts.forEach((_, i) => assert.ok(cos(ollama[i], onnx[i]) > 0.99, `text ${i}: cos ${cos(ollama[i], onnx[i])}`));
  });
});
