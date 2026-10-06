/**
 * Corpus vectors for one embedding space, stored apart from opportunities.json.
 *
 * Two files per space, side by side:
 *   <name>.f16.bin   every vector as little-endian IEEE half floats, one after another
 *                    (count x dims x 2 bytes; 4,698 x 768 is about 7.2 MB)
 *   <name>.json      { format, space, model, revision, dims, count, ids[], textHashes[], builtAt }
 *
 * Row i of the .bin belongs to ids[i]. textHashes[i] is a short hash of the exact
 * text that was embedded (document prefix included), so a refresh can reuse a
 * vector only when both the id and the text are unchanged.
 *
 * Half precision keeps the committed file small; for unit-length vectors the
 * rounding changes a cosine similarity by well under 0.001.
 *
 * Plain .mjs so scripts/3-embed.mjs and scripts/refresh-corpus.mjs can use it
 * under bare node, and lib/corpus/store.ts through TypeScript.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VECTOR_FILE_FORMAT = "granted-vectors/1";

/** Short, stable hash of an embedded text. */
export function textHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float -> IEEE 754 half (round to nearest even), as a uint16. */
export function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow -> 0
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

/** IEEE 754 half (uint16) -> float. */
export function fromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

let HALF_TABLE = null;
/** All 65,536 half values decoded once, so reading 3.6 million of them is a table lookup each. */
function halfTable() {
  if (!HALF_TABLE) {
    HALF_TABLE = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) HALF_TABLE[h] = fromHalf(h);
  }
  return HALF_TABLE;
}

export function vectorFilePaths(dir, name) {
  return { binPath: join(dir, `${name}.f16.bin`), metaPath: join(dir, `${name}.json`) };
}

/**
 * Write `entries` ([{ id, vector, textHash }]) for one space. Both files are
 * written to temporary names and renamed, the .json last, so a reader never sees
 * an index that doesn't match its .bin.
 *
 * @param {string} dir
 * @param {string} name
 * @param {{ space: string, model: string, revision?: string, dims: number, builtAt?: string }} info
 * @param {Array<{ id: string, vector: number[], textHash: string }>} entries
 */
export function writeVectorFile(dir, name, { space, model, revision, dims, builtAt = new Date().toISOString() }, entries) {
  mkdirSync(dir, { recursive: true });
  const { binPath, metaPath } = vectorFilePaths(dir, name);
  const buf = Buffer.alloc(entries.length * dims * 2);
  entries.forEach((e, i) => {
    if (e.vector.length !== dims) throw new Error(`Vector for ${e.id} has ${e.vector.length} dims, expected ${dims}.`);
    for (let j = 0; j < dims; j++) buf.writeUInt16LE(toHalf(e.vector[j]), (i * dims + j) * 2);
  });
  const meta = {
    format: VECTOR_FILE_FORMAT,
    space,
    model,
    ...(revision ? { revision } : {}),
    dims,
    count: entries.length,
    dtype: "float16",
    builtAt,
    ids: entries.map((e) => e.id),
    textHashes: entries.map((e) => e.textHash),
  };
  const tmpBin = `${binPath}.tmp-${process.pid}`;
  const tmpMeta = `${metaPath}.tmp-${process.pid}`;
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(tmpBin, buf);
  writeFileSync(tmpMeta, JSON.stringify(meta));
  renameSync(tmpBin, binPath);
  renameSync(tmpMeta, metaPath);
  return meta;
}

/**
 * Read one space's vectors. Returns { meta, vectors: Map<id, { vector: number[], textHash }> },
 * or null when the files are missing, malformed, or don't agree with each other.
 */
export function readVectorFile(dir, name) {
  const { binPath, metaPath } = vectorFilePaths(dir, name);
  let meta;
  let buf;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
    buf = readFileSync(binPath);
  } catch {
    return null;
  }
  const { dims, count, ids, textHashes } = meta ?? {};
  if (meta?.format !== VECTOR_FILE_FORMAT || !Number.isInteger(dims) || dims <= 0 || !Array.isArray(ids) || ids.length !== count) return null;
  if (buf.length !== count * dims * 2) return null;
  const table = halfTable();
  const vectors = new Map();
  for (let i = 0; i < count; i++) {
    const v = new Array(dims);
    const off = i * dims * 2;
    for (let j = 0; j < dims; j++) v[j] = table[buf.readUInt16LE(off + j * 2)];
    vectors.set(ids[i], { vector: v, textHash: Array.isArray(textHashes) ? textHashes[i] : undefined });
  }
  const { ids: _ids, textHashes: _th, ...rest } = meta;
  return { meta: rest, vectors };
}
