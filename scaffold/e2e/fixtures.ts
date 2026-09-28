import type { Page } from "@playwright/test";

/**
 * A deterministic opportunity map for stubbing /api/match — enough shape for
 * OpportunityMap/OpportunityCard to render without a real (paid, ~2-min)
 * pipeline call. The distinctive program string is what the journeys assert on.
 */
export const FIXTURE_PROGRAM = "Rural Clinic AI Diagnostics Program";

export const fixtureMap = {
  profile: {
    description: "AI diagnostics for rural clinics",
    industry: "Health IT",
    employees: 12,
  },
  followUps: [],
  summary: {
    highPotential: 1,
    fundingIdentified: 500000,
    agencies: 1,
    closingIn90Days: 1,
  },
  matches: [
    {
      opportunity: {
        id: "grants-e2e-1",
        source: "grants.gov",
        kind: "grant",
        program: FIXTURE_PROGRAM,
        agency: "NIH",
        description: "Funds AI-assisted diagnostics for underserved rural clinics.",
        eligibility: "Open to small businesses and nonprofits.",
        fundingLow: 100000,
        fundingHigh: 500000,
        deadline: "2026-12-01",
      },
      tier: "likely",
      score: 82,
      criteria: [{ label: "Health IT focus", met: true }],
      whyCare: "This program funds exactly the rural-clinic AI diagnostics work you're building.",
      whyFit: "Directly funds AI diagnostics for rural clinics.",
      whyIneligible: "Confirm your entity type and SAM.gov registration.",
      whatToVerify: "SAM.gov registration and UEI.",
      whatToDoNext: "Register in SAM.gov, then prepare a concept paper.",
    },
  ],
  agencyIntelligence: [
    { agency: "NIH", why: "Funds AI diagnostics for rural clinics.", opportunityCount: 1 },
  ],
};

/** Serialize an array of NDJSON messages the client's stream reader expects. */
export function ndjson(messages: unknown[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

/** Stub the paid backend calls so journeys are deterministic and free. */
export async function stubBackend(page: Page, map: unknown = fixtureMap): Promise<void> {
  // Interview: return no questions so the free path proceeds straight to search
  // even if r1_interview is on.
  await page.route("**/api/interview", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questions: [] }),
    }),
  );
  // Match: stream a couple of progress milestones then the result map.
  await page.route("**/api/match", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      body: ndjson([
        { type: "progress", key: "start", label: "Reading the federal register…", pct: 5 },
        { type: "progress", key: "score", label: "Scoring your matches", pct: 52 },
        { type: "result", map },
      ]),
    }),
  );
}

/** Mark the first-visit welcome guide as seen so it doesn't block the page. */
export async function skipWelcomeGuide(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("ff.ui.welcomeGuide.seen.v1", "true");
    } catch {}
  });
}

/** A detailed (3+ sentence) description that skips the pre-search interview. */
export const DETAILED_DESCRIPTION =
  "We build AI-assisted diagnostics for rural clinics. We have 12 employees and have raised a seed round. We need federal funding to run a clinical validation study.";
