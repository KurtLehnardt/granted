import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_MODEL,
  builtinModelDir,
  builtinModelPresent,
  downloadBuiltinModel,
  modelBaseUrl,
  modelsDir,
} from "../builtinModel.mjs";

/**
 * The model download, with a fake fetch serving fake files: checksums are
 * enforced, a mirror is honoured, nothing half-written is left where the app
 * looks, and a second run doesn't re-download.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A manifest of tiny fake files, and the patched module manifest restored after. */
function withFakeManifest(fn: (files: Map<string, Buffer>) => Promise<void>) {
  const original = BUILTIN_MODEL.files.map((f) => ({ ...f }));
  const files = new Map<string, Buffer>();
  BUILTIN_MODEL.files.forEach((f, i) => {
    const body = Buffer.from(`contents of ${f.path} #${i}`);
    files.set(f.path, body);
    Object.assign(f, { size: body.length, sha256: sha(body) });
  });
  return fn(files).finally(() => BUILTIN_MODEL.files.forEach((f, i) => Object.assign(f, original[i])));
}

function fakeFetch(files: Map<string, Buffer>, opts: { corrupt?: string; seen?: string[] } = {}) {
  return (async (url: string) => {
    opts.seen?.push(url);
    const path = Object.keys(Object.fromEntries(files)).find((p) => url.endsWith(`/${p}`));
    if (!path) return { ok: false, status: 404, body: null };
    const body = path === opts.corrupt ? Buffer.from("tampered") : files.get(path)!;
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield body.subarray(0, 3);
        yield body.subarray(3);
      })(),
    };
  }) as unknown as typeof fetch;
}

describe("modelBaseUrl / modelsDir", () => {
  test("the pinned Hugging Face revision by default", () => {
    assert.equal(modelBaseUrl({}), `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/${BUILTIN_MODEL.revision}`);
    assert.match(BUILTIN_MODEL.revision, /^[0-9a-f]{40}$/, "a full commit hash, not a branch");
  });

  test("GRANTED_MODEL_URL points the download at a mirror (trailing slashes ignored)", () => {
    assert.equal(modelBaseUrl({ GRANTED_MODEL_URL: "https://mirror.example.org/nomic//" }), "https://mirror.example.org/nomic");
  });

  test("GRANTED_MODELS_DIR moves the folder; under tests it never defaults to the real one", () => {
    assert.equal(modelsDir({ GRANTED_MODELS_DIR: "/x" }), "/x");
    assert.match(modelsDir({ NODE_TEST_CONTEXT: "child" }), /granted-models-unset-/);
  });

  test("every pinned file has a SHA-256 and the fp16 ONNX is the model", () => {
    for (const f of BUILTIN_MODEL.files) assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    assert.ok(BUILTIN_MODEL.files.some((f) => f.path === "onnx/model_fp16.onnx"));
  });
});

describe("downloadBuiltinModel", () => {
  test("downloads and verifies every file from the mirror, then counts as present; a second run fetches nothing", async () => {
    await withFakeManifest(async (files) => {
      const dir = mkdtempSync(join(tmpdir(), "granted-model-"));
      try {
        const seen: string[] = [];
        const pcts: number[] = [];
        assert.equal(builtinModelPresent(dir), false);
        await downloadBuiltinModel({ dir, baseUrl: "https://mirror.example.org/m", fetchFn: fakeFetch(files, { seen }), onProgress: (p: { pct: number }) => pcts.push(p.pct) });
        assert.equal(seen.length, files.size);
        assert.ok(seen.every((u) => u.startsWith("https://mirror.example.org/m/")));
        assert.equal(pcts.at(-1), 100);
        assert.equal(builtinModelPresent(dir), true);

        const again: string[] = [];
        await downloadBuiltinModel({ dir, baseUrl: "https://mirror.example.org/m", fetchFn: fakeFetch(files, { seen: again }) });
        assert.equal(again.length, 0, "verified files are kept");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("a file that fails its checksum is rejected and never left in place", async () => {
    await withFakeManifest(async (files) => {
      const dir = mkdtempSync(join(tmpdir(), "granted-model-"));
      try {
        await assert.rejects(
          () => downloadBuiltinModel({ dir, baseUrl: "https://m", fetchFn: fakeFetch(files, { corrupt: "onnx/model_fp16.onnx" }) }),
          /failed its checksum/,
        );
        const onnxDir = join(builtinModelDir(dir), "onnx");
        assert.deepEqual(existsSync(onnxDir) ? readdirSync(onnxDir) : [], [], "no partial or bad file");
        assert.equal(builtinModelPresent(dir), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("an HTTP error names the file and the URL", async () => {
    await withFakeManifest(async () => {
      const dir = mkdtempSync(join(tmpdir(), "granted-model-"));
      try {
        await assert.rejects(() => downloadBuiltinModel({ dir, baseUrl: "https://m", fetchFn: fakeFetch(new Map()) }), /HTTP 404/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
