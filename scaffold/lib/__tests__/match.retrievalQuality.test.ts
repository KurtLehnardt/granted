import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap } from "../match";
import { screen as realScreen } from "../eligibility/screen";
import type { Opportunity, StartupProfile } from "../types";

/**
 * Retrieval quality fixes, hermetic (no network):
 *
 *  - BM25 must never re-order or evict cosine+quota's own selection (the
 *    Jaccard-overlap regression: fusing BM25 over the whole corpus with a
 *    long expandedTerms-driven query text replaced ~55% of the cosine set,
 *    including main's own top-cosine candidates). BM25 may only ADD a
 *    candidate cosine+quota missed — including one below the cosine floor,
 *    which is the case a lexical layer exists to catch — never displace one.
 *  - `expandedTerms` must still shape the profile-based retrieval re-run,
 *    both the embed() query text and the BM25 supplement query.
 *  - The final scored set stays capped at the profile-based retrieval's own
 *    size, even after unioning in provisional-only extras.
 */

const QUERY_VEC = [1, 0];

function emb(sim: number): number[] {
  return [sim, Math.sqrt(1 - sim * sim)];
}

function opp(over: Partial<Opportunity> & Pick<Opportunity, "id">, sim: number): Opportunity {
  return {
    kind: "grant",
    source: "grants.gov",
    program: `program ${over.id}`,
    agency: "TestAgency",
    description: "A federal opportunity for testing retrieval.",
    eligibility: "US small business.",
    embedding: emb(sim),
    ...over,
  } as Opportunity;
}

function assess(id: string) {
  return {
    id, score: 50, tier: "verify" as const, criteria: [],
    whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
  };
}

describe("retrieval quality — BM25 only supplements, never displaces, cosine+quota", () => {
  test("main's top cosine candidates all survive: BM25 adds, it doesn't reorder or evict", async () => {
    // 4 noise grants at descending cosine, all above the target's — with
    // maxCandidates=4 and perTypeQuota=3 (all same kind), the target is
    // excluded from the base cosine+quota selection entirely.
    const noise = [0.9, 0.8, 0.7, 0.6].map((sim, i) => opp({ id: `noise-${i}` }, sim));
    // Clears the floor (0.22) but ranks below every noise opp on cosine.
    const target = opp({ id: "target", program: "hydrofoil sensing pilot program", description: "hydrofoil water sensing." }, 0.23);
    const corpus = [...noise, target];

    const captured: string[] = [];
    const profile: StartupProfile = {
      description: "We build advanced sensing hardware.",
      expandedTerms: ["hydrofoil"],
    };

    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => QUERY_VEC,
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
      undefined,
      undefined,
      4,
    );

    // Every noise opp (main's cosine+quota selection) survives.
    for (const n of noise) assert.ok(captured.includes(n.id), `${n.id} (cosine+quota) must survive BM25`);
    // The keyword-matching target is ADDED by the BM25 supplement, not swapped in for a noise opp.
    assert.ok(captured.includes("target"), "a floor-clearing, keyword-strong opp cosine+quota missed is still added");
  });

  test("a floor-clearing opp with no keyword overlap and outside the quota never reaches the scorer", async () => {
    const noise = [0.9, 0.8, 0.7, 0.6].map((sim, i) => opp({ id: `noise-${i}` }, sim));
    const target = opp({ id: "target-no-keywords" }, 0.23);
    const corpus = [...noise, target];
    const captured: string[] = [];
    const profile: StartupProfile = { description: "We build advanced sensing hardware." };

    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => QUERY_VEC,
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
      undefined,
      undefined,
      4,
    );

    assert.ok(!captured.includes("target-no-keywords"), "no cosine, quota, or keyword reason to include it");
  });

  test("a keyword-strong opp the EMBEDDINGS missed (below the cosine floor) is still rescued", async () => {
    // The whole point of a lexical layer: catch what the vector space doesn't.
    // This target is a near-verbatim match on a distinctive term but sits BELOW
    // candidateFloor (0.22), so cosine alone would never surface it.
    const noise = [0.9, 0.8, 0.7, 0.6].map((sim, i) => opp({ id: `noise-${i}` }, sim));
    const target = opp(
      { id: "below-floor-keyword", program: "hydrofoil sensing pilot program", description: "hydrofoil water sensing." },
      0.05,
    );
    const corpus = [...noise, target];
    const captured: string[] = [];
    const profile: StartupProfile = {
      description: "We build advanced sensing hardware.",
      expandedTerms: ["hydrofoil"],
    };

    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => QUERY_VEC,
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
      undefined,
      undefined,
      4,
    );

    assert.ok(
      captured.includes("below-floor-keyword"),
      "BM25 must be able to rescue a keyword-strong opp the embeddings ranked below the floor",
    );
    // And it still must not cost cosine+quota any of its own picks.
    for (const n of noise) assert.ok(captured.includes(n.id), `${n.id} (cosine+quota) must survive`);
  });

  test("a below-floor opp with NO keyword overlap stays out (the floor still holds)", async () => {
    const noise = [0.9, 0.8, 0.7, 0.6].map((sim, i) => opp({ id: `noise-${i}` }, sim));
    const target = opp({ id: "below-floor-no-keywords" }, 0.05);
    const corpus = [...noise, target];
    const captured: string[] = [];
    const profile: StartupProfile = { description: "We build advanced sensing hardware." };

    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => QUERY_VEC,
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
      undefined,
      undefined,
      4,
    );

    assert.ok(
      !captured.includes("below-floor-no-keywords"),
      "rescuing on keywords must not become 'anything below the floor gets in'",
    );
  });
});

describe("retrieval quality — expandedTerms still shapes the profile-based re-run", () => {
  test("expandedTerms is folded into the profile-based embed() query text", async () => {
    const corpus = [opp({ id: "only" }, 0.5)];
    const capturedTexts: string[] = [];
    const profile: StartupProfile = {
      description: "We build advanced sensing hardware.",
      expandedTerms: ["hydrofoil", "municipal water loss"],
    };

    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async (text: string) => { capturedTexts.push(text); return QUERY_VEC; },
        explainMatches: async (_p, candidates) => candidates.map((c) => assess(c.id)),
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
    );

    // First embed() call is the raw-description instant pass; the second is
    // the profile-based re-run, which must carry expandedTerms.
    assert.equal(capturedTexts.length, 2);
    assert.match(capturedTexts[1], /hydrofoil/);
    assert.match(capturedTexts[1], /municipal water loss/);
  });
});

describe("retrieval quality — scored-candidate cap", () => {
  test("provisional-only extras are added by trimming the profile set's tail, not by growing the total", async () => {
    // The raw-description pass (query vector [1,0]) and the profile-based
    // re-run (query vector [0,1]) disagree entirely: "prov-only" only clears
    // the floor on the raw pass, the 5 "profile-*" opps only clear it on the
    // profile pass. "prov-only" becomes a provisional-only extra — the fix
    // must trim one profile-set opp to make room for it, not just append it.
    const provOnly: Opportunity = { ...opp({ id: "prov-only" }, 0), embedding: [1, 0] };
    const profileMatches: Opportunity[] = Array.from({ length: 5 }, (_, i) => ({
      ...opp({ id: `profile-${i}` }, 0),
      embedding: [0, 1],
    }));
    const corpus = [provOnly, ...profileMatches];
    const profile: StartupProfile = { description: "We build advanced sensing hardware." };

    let embedCalls = 0;
    const captured: string[] = [];
    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => (++embedCalls === 1 ? [1, 0] : [0, 1]),
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
    );

    assert.equal(captured.length, 5, "total scored count stays at the profile set's own size (5), not 5+1");
    assert.ok(captured.includes("prov-only"), "the provisional-only extra is still scored");
    assert.ok(!captured.includes("profile-4"), "the lowest-ranked profile-set member was trimmed to make room");
  });

  test("the scored-set trim never evicts a C1a per-type-quota pick", async () => {
    // Raw query [1,0,0], profile query [0,1,0]: "prov-only" clears only the
    // raw pass, everything else clears only the profile pass, so trimming and
    // quota selection both act purely on the profile-based set. maxCandidates
    // =4, perTypeQuota=3: the global top-4 cut takes the 4 "noise" grants, and
    // the quota adds the lower-cosine "loan-pick" (a different kind) as a 5th,
    // quota-only entry. The provisional-only extra then forces a 1-slot trim
    // — it must come out of the global-top-4 tail, never the quota pick.
    const noise = [0.9, 0.8, 0.7, 0.6].map((sim, i) => ({
      ...opp({ id: `noise-${i}` }, sim),
      embedding: [0, sim, Math.sqrt(1 - sim * sim)],
    }));
    const loanPick: Opportunity = { ...opp({ id: "loan-pick", kind: "loan" }, 0.3), embedding: [0, 0.3, Math.sqrt(1 - 0.09)] };
    const provOnly: Opportunity = { ...opp({ id: "prov-only" }, 0), embedding: [1, 0, 0] };
    const corpus = [...noise, loanPick, provOnly];
    const profile: StartupProfile = { description: "We build advanced sensing hardware." };

    let embedCalls = 0;
    const captured: string[] = [];
    await buildOpportunityMap(
      profile.description,
      undefined,
      {
        corpus,
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => (++embedCalls === 1 ? [1, 0, 0] : [0, 1, 0]),
        explainMatches: async (_p, candidates) => {
          captured.push(...candidates.map((c) => c.id));
          return candidates.map((c) => assess(c.id));
        },
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
        screen: realScreen,
      },
      undefined,
      undefined,
      4,
    );

    assert.ok(captured.includes("loan-pick"), "the C1a quota pick survives the trim");
    assert.ok(captured.includes("prov-only"), "the provisional-only extra is still scored");
    assert.ok(!captured.includes("noise-3"), "the lowest-cosine global-top-N entry was trimmed instead");
  });
});
