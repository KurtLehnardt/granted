import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPidLock } from "../pidLock";
import { readJsonFile, writeFileAtomic } from "../atomicFile";

/**
 * The shared single-flight lock (refresh + local-embeddings jobs). The core
 * promise: however acquire/isHeld/transfer interleave across processes, at most
 * one owner ever holds it, and a live lock is never deleted.
 */

const PID_LOCK = pathToFileURL(fileURLToPath(new URL("../pidLock.ts", import.meta.url))).href;
const TSX = import.meta.resolve("tsx");
const DEAD_PID = 2 ** 30;

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "granted-pidlock-"));
  dirs.push(d);
  return d;
}

/** Run `body` (an ES module snippet with `lock` in scope) in a separate node process; resolves its stdout. */
function inChild(dir: string, lockPath: string, body: string): Promise<string> {
  const script = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    script,
    `import { createPidLock } from ${JSON.stringify(PID_LOCK)};\nconst lock = createPidLock(${JSON.stringify(lockPath)});\n${body}\n`,
  );
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", TSX, script], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

describe("createPidLock — single process", () => {
  test("acquire/release single-flight; isHeld reflects it", () => {
    const lock = createPidLock(join(tmp(), "data", "local", "x.lock"));
    assert.equal(lock.isHeld(), false);
    assert.equal(lock.acquire(), true);
    assert.equal(lock.isHeld(), true);
    assert.equal(lock.acquire(), false);
    lock.release();
    assert.equal(lock.isHeld(), false);
    assert.equal(lock.acquire(), true);
    lock.release();
  });

  test("an empty/unparseable lock (created, not yet written) is HELD and never deleted by a reader", () => {
    const p = join(tmp(), "x.lock");
    writeFileSync(p, "");
    const lock = createPidLock(p);
    assert.equal(lock.isHeld(), true);
    assert.equal(lock.acquire(), false);
    assert.equal(existsSync(p), true, "a reader must not delete a lock it can't parse");
    writeFileSync(p, '{"pid":12'); // torn write
    assert.equal(lock.isHeld(), true);
  });

  test("...until it's older than unreadableStaleMs (its writer died between create and write)", () => {
    const p = join(tmp(), "x.lock");
    writeFileSync(p, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(p, old, old);
    const lock = createPidLock(p, { unreadableStaleMs: 60_000 });
    assert.equal(lock.isHeld(), false);
    assert.equal(lock.acquire(), true);
    assert.equal(readJsonFile<{ pid: number }>(p)?.pid, process.pid);
  });

  test("a dead owner's lock is reclaimed by acquire; isHeld alone never deletes it", () => {
    const p = join(tmp(), "x.lock");
    writeFileSync(p, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    const lock = createPidLock(p);
    assert.equal(lock.isHeld(), false);
    assert.equal(existsSync(p), true);
    assert.equal(lock.acquire(), true);
    assert.equal(readJsonFile<{ pid: number }>(p)?.pid, process.pid);
    assert.deepEqual(readdirSync(join(p, "..")).filter((f) => f.endsWith(".reclaim")), [], "the reclaim mutex is released");
  });

  test("legacy bare-timestamp lock: held until legacyStaleMs (refresh's 30 min ceiling)", () => {
    const p = join(tmp(), "x.lock");
    writeFileSync(p, String(Date.now() - 5 * 60_000));
    assert.equal(createPidLock(p).isHeld(), true);
    writeFileSync(p, String(Date.now() - 60 * 60_000));
    assert.equal(createPidLock(p).isHeld(), false);
  });

  test("transfer rewrites the pid atomically and is a no-op once released", () => {
    const p = join(tmp(), "x.lock");
    const lock = createPidLock(p);
    lock.acquire();
    const startedAt = readJsonFile<{ startedAt: number }>(p)!.startedAt;
    lock.transfer(4242);
    assert.deepEqual(readJsonFile(p), { pid: 4242, startedAt });
    assert.deepEqual(readdirSync(join(p, "..")).filter((f) => f.includes(".tmp-")), [], "no temp files left behind");
    lock.release();
    lock.transfer(1);
    assert.equal(existsSync(p), false);
  });
});

describe("createPidLock — across processes", () => {
  test("8 processes racing for a free lock: exactly one wins", { timeout: 60_000 }, async () => {
    const d = tmp();
    const p = join(d, "race.lock");
    const at = Date.now() + 1500; // all children spin until the same instant
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        inChild(d, p, `while (Date.now() < ${at}) {}\nprocess.stdout.write(lock.acquire() ? "won" : "lost");\nsetTimeout(() => {}, 300);`),
      ),
    );
    assert.equal(results.filter((r) => r === "won").length, 1, results.join(","));
  });

  test("8 processes racing to reclaim the SAME dead owner's lock: exactly one wins", { timeout: 60_000 }, async () => {
    const d = tmp();
    const p = join(d, "stale.lock");
    writeFileSync(p, JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
    const at = Date.now() + 1500;
    // Each winner keeps its lock (its pid is alive while the others try), so a second "win" would be a double owner.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        inChild(d, p, `while (Date.now() < ${at}) {}\nprocess.stdout.write(lock.acquire() ? "won" : "lost");\nawait new Promise((r) => setTimeout(r, 800));`),
      ),
    );
    assert.equal(results.filter((r) => r === "won").length, 1, results.join(","));
  });

  test("a reader never sees a transferred lock as free while another process hands it back and forth", { timeout: 60_000 }, async () => {
    const d = tmp();
    const p = join(d, "xfer.lock");
    const lock = createPidLock(p);
    assert.equal(lock.acquire(), true);
    // The child flips the owner between two live pids (ours and its own) as fast as it can.
    const flipper = inChild(
      d,
      p,
      `const end = Date.now() + 1500; let n = 0;\nwhile (Date.now() < end) { lock.transfer(n++ % 2 ? process.pid : ${process.pid}); }\nprocess.stdout.write(String(n));`,
    );
    let reads = 0;
    let freeSeen = 0;
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      reads++;
      if (!lock.isHeld()) freeSeen++;
      await new Promise((r) => setImmediate(r));
    }
    const flips = Number(await flipper);
    assert.ok(flips > 10, `the child actually transferred (${flips})`);
    assert.ok(reads > 10);
    assert.equal(freeSeen, 0, `a reader saw the lock as free ${freeSeen}/${reads} times`);
    assert.equal(existsSync(p), true);
    lock.release();
  });
});

describe("writeFileAtomic / readJsonFile", () => {
  test("round-trips; missing/corrupt reads are null", () => {
    const p = join(tmp(), "a", "b.json");
    assert.equal(readJsonFile(p), null);
    writeFileAtomic(p, JSON.stringify({ x: 1 }));
    assert.deepEqual(readJsonFile(p), { x: 1 });
    writeFileSync(p, "{nope");
    assert.equal(readJsonFile(p), null);
    assert.equal(readFileSync(p, "utf8"), "{nope");
  });
});
