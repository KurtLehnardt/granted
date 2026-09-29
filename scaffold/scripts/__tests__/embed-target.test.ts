import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/3-embed.mjs --target=local` must write to data/local/ (gitignored) and
 * leave the committed data/opportunities.json + data/corpus-meta.json untouched —
 * this is what setup:local relies on to keep a fresh clone's git status clean.
 * Plain `data:embed` (no flag) keeps writing the committed snapshot for maintainers.
 */

const SCRIPT = fileURLToPath(new URL("../3-embed.mjs", import.meta.url));

async function withFakeEmbeddingServer(fn: (baseUrl: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { input } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runInTempCwd(args: string[], baseUrl: string) {
  const dir = await mkdtemp(join(tmpdir(), "embed-target-"));
  await mkdir(join(dir, "data"), { recursive: true });
  const sample = [{ program: "P", agency: "A", description: "D" }];
  await writeFile(join(dir, "data", "opportunities.json"), JSON.stringify(sample));

  // spawn (not spawnSync): the fake embedding server above runs in THIS process,
  // so a synchronous spawn would block the event loop and starve it, hanging
  // until the HTTP client's own timeout fires.
  const { status, output } = await new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: { ...process.env, EMBEDDINGS_BASE_URL: baseUrl, EMBEDDINGS_API_KEY: "test" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ status: code, output: out }));
  });
  assert.equal(status, 0, output);
  return dir;
}

describe("3-embed.mjs --target=local", () => {
  let dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  test("writes data/local/, leaves the committed data/ snapshot untouched", async () => {
    await withFakeEmbeddingServer(async (baseUrl) => {
      const dir = await runInTempCwd(["--target=local"], baseUrl);
      dirs.push(dir);

      const localOpps = JSON.parse(await readFile(join(dir, "data", "local", "opportunities.json"), "utf8"));
      assert.equal(localOpps.length, 1);
      assert.deepEqual(localOpps[0].embedding, [0.1, 0.2, 0.3]);

      const localMeta = JSON.parse(await readFile(join(dir, "data", "local", "corpus-meta.json"), "utf8"));
      assert.equal(localMeta.count, 1);

      const committed = JSON.parse(await readFile(join(dir, "data", "opportunities.json"), "utf8"));
      assert.equal(committed[0].embedding, undefined); // committed input file untouched
    });
  });

  test("without --target, still writes the committed data/ snapshot (maintainer flow)", async () => {
    await withFakeEmbeddingServer(async (baseUrl) => {
      const dir = await runInTempCwd([], baseUrl);
      dirs.push(dir);

      const committed = JSON.parse(await readFile(join(dir, "data", "opportunities.json"), "utf8"));
      assert.deepEqual(committed[0].embedding, [0.1, 0.2, 0.3]);

      await assert.rejects(readFile(join(dir, "data", "local", "opportunities.json"), "utf8"));
    });
  });
});
