import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadRuns, latestRun, saveRun } from "../runsStore";
import { STORAGE_KEYS } from "@/lib/mockAuth";
import type { OpportunityMap, Match } from "@/lib/types";

let mem: Map<string, string>;

beforeEach(() => {
  mem = new Map();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
    },
  };
});

function opp(over: { id: string; source: string } & Record<string, unknown>) {
  return { kind: "grant", program: "Program", agency: "Agency", description: "A description.", ...over };
}

function match(over: { id: string; source: string } & Record<string, unknown>): Match {
  return { opportunity: opp(over), tier: "verify", score: 40, criteria: [] } as unknown as Match;
}

function mapWithPastAward(): OpportunityMap {
  return {
    version: "1.0.0",
    profile: {} as OpportunityMap["profile"],
    followUps: [],
    summary: { highPotential: 2, fundingIdentified: 0, agencies: 2, closingIn90Days: 0 },
    matches: [
      match({ id: "grants-1", source: "grants.gov", agency: "NSF" }),
      match({ id: "sbir-award-1", source: "sbir", agency: "DoD" }),
    ],
    weakFieldFinding: undefined,
    agencyIntelligence: [
      { agency: "NSF", why: "", opportunityCount: 1 },
      { agency: "DoD", why: "", opportunityCount: 1 },
    ],
  };
}

describe("loadRuns / latestRun", () => {
  test("strips past-award matches from a run saved before the filter shipped", () => {
    mem.set(
      STORAGE_KEYS.runs,
      JSON.stringify([{ id: "run_1", savedAt: new Date().toISOString(), map: mapWithPastAward() }]),
    );
    const [run] = loadRuns();
    assert.deepEqual(run.map.matches.map((m) => m.opportunity.id), ["grants-1"]);
    assert.equal(run.map.summary.highPotential, 1);
  });

  test("latestRun() (the restore path app/page.tsx uses on mount) is also filtered", () => {
    saveRun(mapWithPastAward());
    const last = latestRun();
    assert.ok(last);
    assert.deepEqual(last!.map.matches.map((m) => m.opportunity.id), ["grants-1"]);
  });
});
