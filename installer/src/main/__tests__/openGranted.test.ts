import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { InstallStatusEvent } from "../../shared/ipc";
import { waitForGrantedToStart, type ProbeResult } from "../openGranted";

/** A fake clock: sleep() advances time instantly instead of waiting. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

function sequence<T>(...values: T[]): () => Promise<T> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

describe("waitForGrantedToStart", () => {
  test("resolves ok as soon as a probe sees Granted's page", async () => {
    const probes: ProbeResult[] = ["down", "down", "granted"];
    let calls = 0;
    const outcome = await waitForGrantedToStart({
      probe: async () => probes[calls++],
      readStatus: async () => ({ state: "running", message: null }),
      timeoutMs: 60_000,
      intervalMs: 2000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { ok: true });
    assert.equal(calls, 3);
  });

  test("keeps waiting through a non-Granted answer (e.g. Next's compile-error page)", async () => {
    const outcome = await waitForGrantedToStart({
      probe: sequence<ProbeResult>("other", "other", "granted"),
      readStatus: async () => null,
      timeoutMs: 60_000,
      intervalMs: 2000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { ok: true });
  });

  test("reports 'exited' when the server's window reports it stopped before answering", async () => {
    let probed = 0;
    const outcome = await waitForGrantedToStart({
      probe: async () => {
        probed++;
        return "down";
      },
      readStatus: sequence<InstallStatusEvent | null>(
        { state: "running", message: null },
        { state: "error", message: "Granted stopped." },
      ),
      timeoutMs: 60_000,
      intervalMs: 2000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { ok: false, reason: "exited" });
    assert.equal(probed, 1, "stops probing once the server has exited");
  });

  test("a 'done' status (exit code 0 before ever answering) also counts as exited", async () => {
    const outcome = await waitForGrantedToStart({
      probe: async () => "down",
      readStatus: async () => ({ state: "done", message: null }),
      timeoutMs: 60_000,
      intervalMs: 2000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { ok: false, reason: "exited" });
  });

  test("times out after timeoutMs of nothing answering", async () => {
    let probed = 0;
    const outcome = await waitForGrantedToStart({
      probe: async () => {
        probed++;
        return "down";
      },
      readStatus: async () => ({ state: "running", message: null }),
      timeoutMs: 10_000,
      intervalMs: 2000,
      ...fakeClock(),
    });
    assert.deepEqual(outcome, { ok: false, reason: "timeout" });
    assert.equal(probed, 5);
  });
});
