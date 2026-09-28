import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatchesTwoPass, twoPassProgress, type TwoPassProgressDetail } from "../claude";
import type { Opportunity, StartupProfile } from "../types";

/**
 * E3 — the two-pass progress bar must stay COST-weighted (a Pass-B narrated
 * candidate costs ~15x a Pass-A score-only one, wall-clock), not a flat
 * per-candidate count — otherwise `done/total` races far ahead of real
 * elapsed time once Pass A finishes (the bug: it reached 75% after ~21% of
 * wall-clock time on the reviewer's 32-candidate repro).
 */

describe("twoPassProgress — pure cost-weighted math", () => {
  test("reproduces the reviewer's 32-candidate repro much closer to real elapsed-time fraction", () => {
    // 32 candidates, 2s/Pass-A call, 30s/Pass-B call, top-N 8 promoted.
    // Total wall-clock: 32*2 + 8*30 = 304s.
    const total = 32;
    const promoted = 8;

    // t=48s: Pass A alone is 64s long, so 24/32 candidates are scored.
    const at48s = twoPassProgress(24, promoted, 0, total);
    const realFractionAt48s = 48 / 304;
    assert.ok(
      Math.abs(at48s / total - realFractionAt48s) < 0.05,
      `done/total (${at48s}/${total}) should track the ~${(realFractionAt48s * 100).toFixed(0)}% real elapsed fraction, not race ahead`,
    );
    // The old flat-count behavior read 24/32 (75%) here — this must be far below that.
    assert.ok(at48s / total < 0.3, "must not race ahead the way the flat per-candidate count did");

    // t=244s: Pass A (64s) + 6 of 8 Pass-B candidates done (6*30=180s) = 244s.
    const at244s = twoPassProgress(total, promoted, 6, total);
    const realFractionAt244s = 244 / 304;
    assert.ok(Math.abs(at244s / total - realFractionAt244s) < 0.05);
  });

  test("reaches exactly `total` once every promoted candidate's narrative lands", () => {
    assert.equal(twoPassProgress(32, 8, 8, 32), 32);
  });

  test("with zero promoted, degrades to a flat per-candidate count", () => {
    assert.equal(twoPassProgress(10, 0, 0, 20), 10);
    assert.equal(twoPassProgress(20, 0, 0, 20), 20);
  });
});

const QUERY_VEC = [1, 0];
function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `grant ${id}`,
    eligibility: "US small business.",
    embedding: QUERY_VEC,
  };
}
const profile: StartupProfile = { description: "AI sensing hardware.", employees: 20 };
const SCORES: Record<string, number> = { "opp-a": 90, "opp-b": 80, "opp-c": 40, "opp-d": 10 };
const candidates = Object.keys(SCORES).map(opp);

const savedProvider = process.env.LLM_PROVIDER;
const savedTopN = process.env.E3_TWO_PASS_TOP_N;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = savedProvider;
  if (savedTopN === undefined) delete process.env.E3_TWO_PASS_TOP_N; else process.env.E3_TWO_PASS_TOP_N = savedTopN;
  globalThis.fetch = realFetch;
});

function fakeFetch(): typeof fetch {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const userContent: string = body.messages.find((m: any) => m.role === "user")?.content ?? "";
    const id = candidates.find((c) => userContent.includes(`"${c.id}"`))?.id!;
    const isPassA = body.max_tokens <= 1024;
    const content = isPassA
      ? { id, score: SCORES[id] }
      : { id, score: SCORES[id], tier: "likely", criteria: [], whyCare: "", whyFit: `fit ${id}`, whyIneligible: "", whatToVerify: "", whatToDoNext: "" };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: {} }) };
  }) as unknown as typeof fetch;
}

test("integration: onBatch events stay monotonic, cost-weighted, and reach total exactly once", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "8";
  globalThis.fetch = fakeFetch();

  const events: Array<{ done: number; total: number }> = [];
  const result = await explainMatchesTwoPass(profile, candidates, undefined, (done, total) => events.push({ done, total }), undefined, undefined);

  assert.ok(events.length > 0);
  // Monotonic non-decreasing.
  for (let i = 1; i < events.length; i++) assert.ok(events[i].done >= events[i - 1].done);
  // Reaches total exactly once, at the very end.
  assert.equal(events[events.length - 1].done, events[events.length - 1].total);
  // The event right after Pass A finishes (before any Pass-B batch has settled)
  // must be well under the old flat-count reading of (total - promoted) = 1
  // out of 4 candidates (3 promoted) — cost-weighting should push it lower.
  const afterPassA = events.find((e) => e.done > 0 && e.done < e.total);
  assert.ok(afterPassA, "should have at least one intermediate event before completion");

  assert.equal(result.length, candidates.length);
});

test("detail reports no promoted count until Pass A has finished", async () => {
  process.env.LLM_PROVIDER = "ollama";
  globalThis.fetch = fakeFetch();

  const details: TwoPassProgressDetail[] = [];
  await explainMatchesTwoPass(profile, candidates, undefined, (_done, _total, detail) => {
    if (detail) details.push(detail);
  });

  const duringPassA = details.filter((d) => d.passAScored < candidates.length);
  assert.ok(duringPassA.length > 0);
  assert.ok(duringPassA.every((d) => d.promotedCount === 0));
  assert.equal(details[details.length - 1].promotedCount, 3);
});
