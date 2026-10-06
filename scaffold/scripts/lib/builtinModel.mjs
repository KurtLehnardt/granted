/**
 * The built-in search model: nomic-embed-text-v1.5 as an fp16 ONNX file, run in
 * this process by @huggingface/transformers (onnxruntime-node). Its vectors match
 * Ollama's `nomic-embed-text`, so one shipped corpus (data/vectors/) serves both.
 *
 * Plain .mjs so `node scripts/fetch-model.mjs` (the installers) and
 * `node scripts/3-embed.mjs --space=builtin` run under bare node, while the app
 * imports the same code through lib/embeddings/builtin.ts.
 *
 * The model files are pinned to one Hugging Face revision and verified by
 * SHA-256, then kept in scaffold/models/ (gitignored). At runtime the app only
 * loads from that folder (remote loading is switched off), so search works
 * offline once the files are there. GRANTED_MODEL_URL points the download at a
 * mirror: files are fetched from `${GRANTED_MODEL_URL}/<file path>`.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_MODEL = {
  /** Hugging Face repo; also the folder under the models directory transformers.js loads from. */
  repo: "nomic-ai/nomic-embed-text-v1.5",
  revision: "e9b6763023c676ca8431644204f50c2b100d9aab",
  dtype: "fp16",
  dims: 768,
  /** Inputs are cut to this many tokens (the corpus was embedded the same way). */
  maxTokens: 512,
  files: [
    { path: "config.json", size: 2538, sha256: "9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b" },
    { path: "tokenizer.json", size: 711396, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
    { path: "tokenizer_config.json", size: 1191, sha256: "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc" },
    { path: "onnx/model_fp16.onnx", size: 273859028, sha256: "cf5b5a86edb00f895561803cfc04729090a958340b8ca2ad76c143f565f6bb04" },
  ],
};

export const BUILTIN_MODEL_TOTAL_BYTES = BUILTIN_MODEL.files.reduce((n, f) => n + f.size, 0);

const SCAFFOLD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where model files live: GRANTED_MODELS_DIR, else scaffold/models. Under node:test with no
 * override, a folder that never exists, so a developer's downloaded model never leaks into
 * unit tests (the integration test points GRANTED_MODELS_DIR at the real one).
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function modelsDir(env = process.env) {
  if (env.GRANTED_MODELS_DIR) return env.GRANTED_MODELS_DIR;
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), `granted-models-unset-${process.pid}`);
  return join(SCAFFOLD_DIR, "models");
}

/** The pinned model's own folder inside the models directory. */
export function builtinModelDir(dir = modelsDir()) {
  return join(dir, ...BUILTIN_MODEL.repo.split("/"));
}

/**
 * Download base: GRANTED_MODEL_URL (a mirror holding the same file layout), else the pinned Hugging Face revision.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function modelBaseUrl(env = process.env) {
  const mirror = (env.GRANTED_MODEL_URL || "").trim().replace(/\/+$/, "");
  return mirror || `https://huggingface.co/${BUILTIN_MODEL.repo}/resolve/${BUILTIN_MODEL.revision}`;
}

/** A small stamp written after every file verified, so later checks don't re-hash 270 MB. */
function stampPath(dir) {
  return join(builtinModelDir(dir), ".verified.json");
}

function stampFor() {
  return { revision: BUILTIN_MODEL.revision, files: BUILTIN_MODEL.files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
}

/**
 * Cheap readiness check (no hashing): every file present at its pinned size and
 * the verification stamp matching this revision. This is what runtime uses.
 */
export function builtinModelPresent(dir = modelsDir()) {
  const base = builtinModelDir(dir);
  for (const f of BUILTIN_MODEL.files) {
    try {
      if (statSync(join(base, f.path)).size !== f.size) return false;
    } catch {
      return false;
    }
  }
  try {
    const stamp = JSON.parse(readFileSync(stampPath(dir), "utf8"));
    return JSON.stringify(stamp) === JSON.stringify(stampFor());
  } catch {
    return false;
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

export class ModelDownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelDownloadError";
  }
}

/**
 * Download (or finish downloading) the pinned model into `dir`, verifying each
 * file's SHA-256. Files already present with the right checksum are kept. Each
 * file is written to a temporary name and renamed into place only once it
 * verifies, so a cut-off download never leaves a half file where the app looks.
 *
 * `onProgress({ doneBytes, totalBytes, pct, file })` fires as bytes arrive.
 * `fetchFn` is injectable for tests.
 *
 * @param {{
 *   dir?: string, baseUrl?: string, fetchFn?: typeof fetch, signal?: AbortSignal,
 *   onProgress?: (p: { doneBytes: number, totalBytes: number, pct: number, file: string }) => void,
 * }} [opts]
 */
export async function downloadBuiltinModel({
  dir = modelsDir(),
  baseUrl = modelBaseUrl(),
  fetchFn = fetch,
  onProgress,
  signal,
} = {}) {
  const base = builtinModelDir(dir);
  const total = BUILTIN_MODEL.files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const report = (file) => onProgress?.({ doneBytes: done, totalBytes: total, pct: Math.min(100, Math.floor((done / total) * 100)), file });

  for (const f of BUILTIN_MODEL.files) {
    const dest = join(base, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest) && statSync(dest).size === f.size && (await sha256File(dest)) === f.sha256) {
      done += f.size;
      report(f.path);
      continue;
    }
    const url = `${baseUrl}/${f.path}`;
    let res;
    try {
      res = await fetchFn(url, { signal, redirect: "follow" });
    } catch (e) {
      throw new ModelDownloadError(`Couldn't download ${f.path} from ${url}: ${e?.message ?? e}`);
    }
    if (!res.ok || !res.body) throw new ModelDownloadError(`Couldn't download ${f.path} from ${url} (HTTP ${res.status}).`);

    const tmp = `${dest}.part-${process.pid}`;
    const hash = createHash("sha256");
    const out = createWriteStream(tmp);
    const before = done;
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
        done += buf.length;
        report(f.path);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw new ModelDownloadError(`Downloading ${f.path} was interrupted: ${e?.message ?? e}`);
    }
    const digest = hash.digest("hex");
    if (digest !== f.sha256) {
      rmSync(tmp, { force: true });
      done = before;
      throw new ModelDownloadError(
        `${f.path} failed its checksum (expected ${f.sha256.slice(0, 12)}..., got ${digest.slice(0, 12)}...). ` +
          "The download may be corrupt, or GRANTED_MODEL_URL points at a different revision.",
      );
    }
    rmSync(dest, { force: true });
    renameSync(tmp, dest);
    done = before + f.size;
    report(f.path);
  }
  writeFileSync(stampPath(dir), JSON.stringify(stampFor()));
  return { dir: base };
}

// ---------------------------------------------------------------------------
// In-process embedding
// ---------------------------------------------------------------------------

/**
 * Load the model from the local folder only. `env.allowRemoteModels = false`
 * means transformers.js never reaches the network at runtime; a missing file is
 * an error the caller turns into "downloading the search model".
 *
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<{ embed: (texts: string[]) => Promise<number[][]>, dims: number }>}
 */
export async function loadBuiltinEmbedder({ dir = modelsDir() } = {}) {
  const t = await import("@huggingface/transformers");
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  t.env.localModelPath = dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
  t.env.useFSCache = false;
  const tokenizer = await t.AutoTokenizer.from_pretrained(BUILTIN_MODEL.repo, { local_files_only: true });
  const model = await t.AutoModel.from_pretrained(BUILTIN_MODEL.repo, { local_files_only: true, dtype: BUILTIN_MODEL.dtype });

  /** Mean-pooled, L2-normalised vectors for `texts`, each cut to maxTokens tokens. */
  async function embed(texts) {
    if (texts.length === 0) return [];
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: BUILTIN_MODEL.maxTokens });
    const outputs = await model(inputs);
    const pooled = t.mean_pooling(outputs.last_hidden_state, inputs.attention_mask).normalize(2, -1);
    const dims = pooled.dims[1];
    const data = pooled.data;
    const out = [];
    for (let i = 0; i < texts.length; i++) out.push(Array.from(data.subarray(i * dims, (i + 1) * dims)));
    return out;
  }
  return { embed, dims: BUILTIN_MODEL.dims };
}
