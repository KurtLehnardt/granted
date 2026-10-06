/**
 * Building one space's vector file (scripts/lib/vectorFile.mjs) for a corpus:
 * reuse every vector whose record id AND embedded text are unchanged, embed the
 * rest in batches with whatever embedder the space uses, and return the entries
 * in corpus order. Shared by `npm run data:embed -- --space=builtin` and
 * `npm run data:refresh`, so a refresh needs no API key when search is built-in.
 *
 * The embedder is injected (`embed(texts) -> Promise<number[][]>`), so tests
 * run this with a fake one.
 */
import { corpusEmbedText } from "./embedCorpus.mjs";
import { textHash } from "./vectorFile.mjs";

/** The exact text a space embeds for one program: its document prefix + the shared program text. */
export function spaceDocumentText(space, opp) {
  return `${space.documentPrefix ?? ""}${corpusEmbedText(opp)}`;
}

/**
 * Split `opps` into reusable and to-embed, by id and text hash against `prior`
 * (a Map id -> { vector, textHash }, e.g. readVectorFile(...).vectors).
 * Vectors of the wrong size are never reused.
 */
export function planSpaceVectors(space, opps, prior, dims = space.dims) {
  const reused = [];
  const toEmbed = [];
  let added = 0;
  let updated = 0;
  for (const o of opps) {
    const text = spaceDocumentText(space, o);
    const hash = textHash(text);
    const p = prior?.get(o.id);
    if (p && p.textHash === hash && Array.isArray(p.vector) && (dims == null || p.vector.length === dims)) {
      reused.push({ id: o.id, vector: p.vector, textHash: hash });
    } else {
      toEmbed.push({ id: o.id, text, textHash: hash });
      if (p) updated++;
      else added++;
    }
  }
  return { reused, toEmbed, added, updated };
}

/**
 * Embed `plan.toEmbed` in batches of `batch` (shortest texts first, so each
 * batch pads little), then return every entry in the order of `opps`.
 * `shouldStop()` is checked between batches; when it returns true the result has
 * `stopped: true` and holds only what was finished (reused + embedded so far).
 *
 * @param {any} space
 * @param {Array<{ id: string, program: string, agency: string, description: string }>} opps
 * @param {{
 *   prior?: Map<string, { vector: number[], textHash?: string }>,
 *   embed: (texts: string[]) => Promise<number[][]>,
 *   batch?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   shouldStop?: () => boolean,
 * }} opts
 */
export async function buildSpaceVectors(space, opps, { prior, embed, batch = 16, onProgress, shouldStop }) {
  const plan = planSpaceVectors(space, opps, prior);
  const byId = new Map(plan.reused.map((e) => [e.id, e]));
  const queue = plan.toEmbed.slice().sort((a, b) => a.text.length - b.text.length);
  let done = 0;
  let stopped = false;
  for (let i = 0; i < queue.length; i += batch) {
    if (shouldStop?.()) {
      stopped = true;
      break;
    }
    const slice = queue.slice(i, i + batch);
    const vectors = await embed(slice.map((e) => e.text));
    if (!Array.isArray(vectors) || vectors.length !== slice.length) {
      throw new Error(`The embedder returned ${vectors?.length ?? 0} vectors for ${slice.length} texts.`);
    }
    slice.forEach((e, k) => byId.set(e.id, { id: e.id, vector: vectors[k], textHash: e.textHash }));
    done += slice.length;
    onProgress?.(done, queue.length);
  }
  const entries = /** @type {Array<{ id: string, vector: number[], textHash: string }>} */ (
    opps.map((o) => byId.get(o.id)).filter(Boolean)
  );
  return { entries, stopped, reused: plan.reused.length, embedded: done, added: plan.added, updated: plan.updated };
}
