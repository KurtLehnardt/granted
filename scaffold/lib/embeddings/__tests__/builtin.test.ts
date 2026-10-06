import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  builtinModelStatus,
  embedWithBuiltin,
  explainModelLoadError,
  ensureBuiltinModel,
  resetBuiltinRuntime,
  startBuiltinModelDownload,
  type BuiltinDeps,
} from "../builtin";

/**
 * The in-process backend's runtime rules, with a fake model: one embedder per
 * process, loaded lazily; one download shared by every caller; no download
 * under tests unless one is injected; and a failed download or load that
 * doesn't stick.
 */

afterEach(() => resetBuiltinRuntime());

function fakeDeps(over: Partial<BuiltinDeps> = {}) {
  let present = false;
  let loads = 0;
  let downloads = 0;
  let finishDownload: () => void = () => {};
  let failDownload: (e: Error) => void = () => {};
  const batches: string[][] = [];
  const deps: Partial<BuiltinDeps> = {
    dir: "/models",
    present: () => present,
    allowDownload: true,
    download: (async (opts: { onProgress?: (p: { pct: number; doneBytes: number }) => void }) => {
      downloads++;
      opts.onProgress?.({ pct: 40, doneBytes: 100 });
      await new Promise<void>((resolve, reject) => {
        finishDownload = () => {
          present = true;
          resolve();
        };
        failDownload = reject;
      });
      return { dir: "/models" };
    }) as any,
    load: async () => {
      loads++;
      return {
        dims: 2,
        embed: async (texts: string[]) => {
          batches.push(texts);
          return texts.map((t) => [t.length, 1]);
        },
      };
    },
    ...over,
  };
  return {
    deps,
    setPresent: (v: boolean) => (present = v),
    finishDownload: () => finishDownload(),
    failDownload: (e: Error) => failDownload(e),
    loads: () => loads,
    downloads: () => downloads,
    batches,
  };
}

describe("embedWithBuiltin", () => {
  test("loads the model once for the whole process, however many searches run at once", async () => {
    const f = fakeDeps();
    f.setPresent(true);
    const [a, b] = await Promise.all([embedWithBuiltin(["x"], {}, f.deps), embedWithBuiltin(["yy"], {}, f.deps)]);
    await embedWithBuiltin(["zzz"], {}, f.deps);
    assert.deepEqual(a, [[1, 1]]);
    assert.deepEqual(b, [[2, 1]]);
    assert.equal(f.loads(), 1);
  });

  test("splits work into batches, in order", async () => {
    const f = fakeDeps();
    f.setPresent(true);
    const out = await embedWithBuiltin(["a", "bb", "ccc"], { batch: 2 }, f.deps);
    assert.deepEqual(f.batches, [["a", "bb"], ["ccc"]]);
    assert.deepEqual(out, [[1, 1], [2, 1], [3, 1]]);
  });

  test("model missing -> downloads it first (first-use fallback), then embeds", async () => {
    const f = fakeDeps();
    const p = embedWithBuiltin(["x"], {}, f.deps);
    await new Promise((r) => setImmediate(r));
    assert.equal(builtinModelStatus(f.deps).state, "downloading");
    f.finishDownload();
    assert.deepEqual(await p, [[1, 1]]);
    assert.equal(f.downloads(), 1);
  });

  test("a failed load doesn't stick: the next call tries again", async () => {
    let attempt = 0;
    const f = fakeDeps({
      load: async () => {
        if (attempt++ === 0) throw new Error("corrupt model");
        return { dims: 2, embed: async (t: string[]) => t.map(() => [0, 1]) };
      },
    });
    f.setPresent(true);
    await assert.rejects(() => embedWithBuiltin(["x"], {}, f.deps), /corrupt model/);
    assert.deepEqual(await embedWithBuiltin(["x"], {}, f.deps), [[0, 1]]);
  });

  test("under node:test with no injected download it never downloads, and says how to fetch the model", async () => {
    await assert.rejects(
      () => ensureBuiltinModel(undefined, { dir: "/nowhere", present: () => false, allowDownload: false }),
      /npm run model:fetch/,
    );
  });
});

describe("ensureBuiltinModel / status", () => {
  test("every caller shares one download, and each hears its progress", async () => {
    const f = fakeDeps();
    const heard: number[] = [];
    const p1 = ensureBuiltinModel((pct) => heard.push(pct), f.deps);
    const p2 = ensureBuiltinModel(undefined, f.deps);
    startBuiltinModelDownload(f.deps);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.downloads(), 1);
    const st = builtinModelStatus(f.deps);
    assert.equal(st.state, "downloading");
    assert.equal(st.pct, 40);
    f.finishDownload();
    await Promise.all([p1, p2]);
    assert.equal(builtinModelStatus(f.deps).state, "ready");
  });

  test("a failed download is reported as failed with the reason, and a retry starts a new one", async () => {
    const f = fakeDeps();
    const p = ensureBuiltinModel(undefined, f.deps);
    await new Promise((r) => setImmediate(r));
    f.failDownload(new Error("HTTP 503"));
    await assert.rejects(p, /HTTP 503/);
    const st = builtinModelStatus(f.deps);
    assert.equal(st.state, "failed");
    assert.match(st.error!, /couldn't download the search model \(HTTP 503\)/);
    startBuiltinModelDownload(f.deps);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.downloads(), 2);
    assert.equal(builtinModelStatus(f.deps).state, "downloading");
  });

  test("missing until downloaded; reports the total size", () => {
    const f = fakeDeps();
    const st = builtinModelStatus(f.deps);
    assert.equal(st.state, "missing");
    assert.equal(st.model, "nomic-embed-text-v1.5");
    assert.equal(st.totalBytes, 274574153);
  });

  test("names the mirror when GRANTED_MODEL_URL is set", () => {
    const saved = process.env.GRANTED_MODEL_URL;
    process.env.GRANTED_MODEL_URL = "https://mirror.example.org/nomic/";
    try {
      assert.equal(builtinModelStatus(fakeDeps().deps).mirror, "https://mirror.example.org/nomic");
    } finally {
      if (saved === undefined) delete process.env.GRANTED_MODEL_URL;
      else process.env.GRANTED_MODEL_URL = saved;
    }
  });
});

describe("a model that won't load (e.g. no Visual C++ runtime on Windows)", () => {
  test("on Windows, a native-module load failure names the VC++ runtime and where to get it", () => {
    const msg = explainModelLoadError(new Error("\\?\C:\granted\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node: The specified module could not be found."), "win32");
    assert.match(msg, /Microsoft Visual C\+\+ runtime is missing/);
    assert.match(msg, /aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
  });

  test("elsewhere, the underlying reason is kept (shortened)", () => {
    assert.equal(explainModelLoadError(new Error("bad model file"), "linux"), "the search model couldn't start (bad model file)");
    assert.ok(explainModelLoadError(new Error("x".repeat(500)), "darwin").length < 260);
  });

  test("the load failure shows as 'failed' in the status, embedding rejects with it, and a Retry clears it", async () => {
    let fail = true;
    const f = fakeDeps({
      load: async () => {
        if (fail) throw new Error("The specified module could not be found.");
        return { dims: 2, embed: async (t: string[]) => t.map(() => [1, 0]) };
      },
    });
    f.setPresent(true);
    await assert.rejects(() => embedWithBuiltin(["x"], {}, f.deps), /search model couldn't start/);
    const st = builtinModelStatus(f.deps);
    assert.equal(st.state, "failed");
    assert.match(st.error!, /search model couldn't start/);
    fail = false;
    startBuiltinModelDownload(f.deps);
    assert.equal(builtinModelStatus(f.deps).state, "ready");
    assert.deepEqual(await embedWithBuiltin(["x"], {}, f.deps), [[1, 0]]);
  });
});
