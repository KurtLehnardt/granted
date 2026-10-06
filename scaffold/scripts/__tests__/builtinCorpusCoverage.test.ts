import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readVectorFile, textHash } from "../lib/vectorFile.mjs";
import { compatibleVectorFile, spaceDocumentText } from "../lib/spaceVectors.mjs";
import { SPACES } from "../lib/spaces.mjs";
import { BUILTIN_MODEL } from "../lib/builtinModel.mjs";

/**
 * No model needed: the committed built-in vectors must cover the committed
 * corpus exactly, record by record, by id AND by the text that was embedded.
 * A corpus edit without `npm run data:embed:builtin` fails here, instead of
 * silently leaving records searchable by keyword only.
 */

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

test("every committed record has a built-in vector for its current text, from the pinned model", () => {
  const space = SPACES.builtin;
  const file = readVectorFile(join(DATA, "vectors"), "nomic-embed-text-v1.5");
  assert.ok(file, "data/vectors/nomic-embed-text-v1.5 is committed and readable");
  assert.ok(compatibleVectorFile(file, space), "made by the built-in model's pinned revision");
  assert.equal(file!.meta.revision, BUILTIN_MODEL.revision);
  const opps = JSON.parse(readFileSync(join(DATA, "opportunities.json"), "utf8")) as Array<{ id: string; program: string; agency: string; description: string }>;
  const missing: string[] = [];
  const stale: string[] = [];
  for (const o of opps) {
    const v = file!.vectors.get(o.id);
    if (!v) missing.push(o.id);
    else if (v.textHash !== textHash(spaceDocumentText(space, o))) stale.push(o.id);
  }
  assert.deepEqual(missing, [], "records with no vector (run npm run data:embed:builtin)");
  assert.deepEqual(stale, [], "records whose text changed since they were embedded (run npm run data:embed:builtin)");
  assert.equal(file!.vectors.size, opps.length, "no vectors for records that are gone");
});
