/**
 * A start / download / install the user asked for that FAILS is logged
 * (sanitized) and the job carries its id, for "Report this problem". A
 * cancel isn't a failure: nothing logged, no id.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelOllamaJob, getOllamaJobs, pullModel, resetOllamaJobs, startOllamaAndWait } from "../ollamaJobs";
import { readErrorEntries } from "../../errorLog/store";
import { isErrorId } from "../../errorLog/errorId";

let dir: string;
const saved = process.env["GRANTED_LOG_DIR"];
beforeEach(() => {
  resetOllamaJobs();
  dir = mkdtempSync(join(tmpdir(), "granted-ollama-log-"));
  process.env["GRANTED_LOG_DIR"] = dir;
});
afterEach(() => {
  resetOllamaJobs();
  if (saved === undefined) delete process.env["GRANTED_LOG_DIR"];
  else process.env["GRANTED_LOG_DIR"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

const nothingListening = (async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}) as unknown as typeof fetch;

const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

test("a start that fails is logged, and the job carries the entry's id", async () => {
  const up = await startOllamaAndWait({
    host: "http://127.0.0.1:1",
    fetch: nothingListening,
    launch: () => {
      throw new Error("spawn C:\\Users\\kurt\\AppData\\Local\\Programs\\Ollama\\ollama.exe ENOENT");
    },
  });
  assert.equal(up, false);
  const job = getOllamaJobs().start!;
  assert.equal(job.status, "error");
  assert.ok(isErrorId(job.errorId));
  const [entry] = readErrorEntries();
  assert.equal(entry.id, job.errorId);
  assert.equal(entry.area, "ollama-start");
  assert.match(entry.message, /^Couldn't launch Ollama: spawn ~\\AppData/);
});

test("a download that fails is logged with an id", async () => {
  pullModel("qwen2.5:7b", { host: "http://127.0.0.1:1", fetch: nothingListening });
  await until(() => getOllamaJobs().pull?.status === "error");
  const job = getOllamaJobs().pull!;
  assert.equal(job.status, "error");
  assert.ok(isErrorId(job.errorId), JSON.stringify(job));
  assert.equal(readErrorEntries()[0]?.area, "ollama-pull");
});

test("a cancelled download is not a failure: nothing logged, no id", async () => {
  const stalls = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
  pullModel("qwen2.5:7b", { host: "http://127.0.0.1:1", fetch: stalls, idleMs: 60_000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cancelOllamaJob("pull"), true);
  await new Promise((r) => setTimeout(r, 100));
  const job = getOllamaJobs().pull!;
  assert.equal(job.status, "error");
  assert.equal(job.errorId, undefined);
  assert.deepEqual(readErrorEntries(), []);
});
