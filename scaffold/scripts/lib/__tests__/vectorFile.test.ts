import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHalf, readVectorFile, textHash, toHalf, vectorFilePaths, writeVectorFile } from "../vectorFile.mjs";

describe("half-precision encoding", () => {
  test("exact values round-trip exactly", () => {
    for (const v of [0, 1, -1, 0.5, -0.25, 2, 65504]) assert.equal(fromHalf(toHalf(v)), v);
  });

  test("unit-vector components keep about 3 significant digits", () => {
    for (const v of [0.0123, -0.0456, 0.1789, -0.3333, 0.7071]) {
      assert.ok(Math.abs(fromHalf(toHalf(v)) - v) <= Math.abs(v) * 1e-3 + 1e-6, String(v));
    }
  });

  test("tiny values go subnormal or to zero, never garbage; huge ones saturate to Infinity", () => {
    assert.ok(Math.abs(fromHalf(toHalf(1e-5)) - 1e-5) < 1e-6);
    assert.equal(fromHalf(toHalf(1e-9)), 0);
    assert.equal(fromHalf(toHalf(1e6)), Infinity);
  });

  test("cosine similarity barely moves after a round trip", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const unit = (v: number[]) => {
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
    const a = unit(Array.from({ length: 768 }, rnd));
    const b = unit(Array.from({ length: 768 }, rnd));
    const dot = (x: number[], y: number[]) => x.reduce((s, xi, i) => s + xi * y[i], 0);
    const half = (v: number[]) => v.map((x) => fromHalf(toHalf(x)));
    assert.ok(Math.abs(dot(a, b) - dot(half(a), half(b))) < 1e-3);
  });
});

describe("writeVectorFile / readVectorFile", () => {
  test("round-trips ids, hashes and vectors; the .bin is count x dims x 2 bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "granted-vectors-"));
    try {
      const meta = writeVectorFile(dir, "space", { space: "builtin", model: "m", revision: "r1", dims: 2 }, [
        { id: "a", vector: [0.5, -0.25], textHash: "h1" },
        { id: "b", vector: [1, 0], textHash: "h2" },
      ]);
      assert.equal(meta.count, 2);
      const { binPath } = vectorFilePaths(dir, "space");
      assert.equal(readFileSync(binPath).length, 2 * 2 * 2);
      const read = readVectorFile(dir, "space")!;
      assert.equal(read.meta.model, "m");
      assert.equal(read.meta.revision, "r1");
      assert.equal(read.meta.dtype, "float16");
      assert.deepEqual(read.vectors.get("a"), { vector: [0.5, -0.25], textHash: "h1" });
      assert.deepEqual(read.vectors.get("b"), { vector: [1, 0], textHash: "h2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing, mismatched or foreign files read as null, never as wrong vectors", () => {
    const dir = mkdtempSync(join(tmpdir(), "granted-vectors-"));
    try {
      assert.equal(readVectorFile(dir, "none"), null);
      writeVectorFile(dir, "s", { space: "builtin", model: "m", dims: 2 }, [{ id: "a", vector: [1, 0], textHash: "h" }]);
      const { binPath, metaPath } = vectorFilePaths(dir, "s");
      writeFileSync(binPath, Buffer.alloc(3)); // truncated
      assert.equal(readVectorFile(dir, "s"), null);
      writeFileSync(binPath, Buffer.alloc(4));
      writeFileSync(metaPath, JSON.stringify({ format: "something-else", dims: 2, count: 1, ids: ["a"] }));
      assert.equal(readVectorFile(dir, "s"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a vector of the wrong size", () => {
    const dir = mkdtempSync(join(tmpdir(), "granted-vectors-"));
    try {
      assert.throws(() => writeVectorFile(dir, "s", { space: "x", model: "m", dims: 3 }, [{ id: "a", vector: [1, 0], textHash: "h" }]), /2 dims, expected 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("textHash is stable and short", () => {
    assert.equal(textHash("abc"), textHash("abc"));
    assert.notEqual(textHash("abc"), textHash("abd"));
    assert.equal(textHash("abc").length, 16);
  });
});
