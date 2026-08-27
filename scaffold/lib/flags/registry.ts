/**
 * CON-03 — Contracts-owned feature-flag registry.
 *
 * §8.2: every requirement ships behind a flag defaulting OFF until its acceptance criteria pass;
 * the pre-R1 path stays reachable for the whole buildout (one-flag revert); flags are
 * Contracts-owned infra, not per-team improvisation.
 *
 * These flags gate *rollout of a requirement's UI/behavior surface*. They are NOT entitlements —
 * Pro/paid access is `Entitlements`, enforced server-side (CON-01 contract, PLT-07 enforcement).
 * A flag answers "is this requirement's surface visible yet"; an entitlement answers "is this
 * user allowed to use it." Never read a flag to decide whether to grant paid content.
 *
 * This file only *declares* flags. Nothing in this module reads them into a component — that is
 * each feature team's own job when their slice ships (see accessor.ts / index.ts for the reader).
 *
 * Naming convention for new flags: `{requirement}_{short_name}`, lowercase snake_case, matching
 * the requirement ID in prompts/fundfinder-orchestrator-prompt.md (e.g. `r5_competitor_intel`,
 * `r6_assisted_apply`). To add one:
 *   1. Add the literal to `FlagName` below.
 *   2. Add a `FlagDefinition` entry to `FLAG_REGISTRY`.
 *   3. Add the matching static env read to `env.ts` (see the note there on why it must be static).
 * This file plus `env.ts` are the only two places a flag is declared — do not add ad hoc
 * `process.env.NEXT_PUBLIC_*` checks anywhere else in the app.
 */

export type FlagName =
  | "r1_interview"
  | "r2_verify"
  | "r3_enhance"
  | "r4_progress"
  | "r6_auto_fill"
  | "r6_export_autofill"
  | "r7_design"
  | "r8_eligibility"
  | "r9_0_mockauth"
  | "r9_supabase_auth"
  | "r10_analytics"
  | "r4b_cost_debug"
  | "left_sidebar"
  | "g6_s2s_submission"
  | "b2_enriched_ranking"
  | "c1b_type_groups"
  | "d4_opportunity_graph"
  | "d3_funding_strategy"
  | "d5_alerts"
  | "r5_deep_analysis"
  | "e3_two_pass"
  | "discernment_layer"
  | "commercial_ui";

export interface FlagDefinition {
  /** Stable identifier. Matches the key it's stored under in FLAG_REGISTRY. */
  name: FlagName;
  /** Requirement ID this gates, for traceability back to the orchestrator prompt. */
  requirement: string;
  /** One line: what turning this on reveals or changes. */
  description: string;
  /**
   * The env var that overrides this flag, for documentation/debugging purposes. The actual read
   * happens in `env.ts` via a static `process.env.NEXT_PUBLIC_*` reference — this field must stay
   * in sync with that file by hand, since it cannot be derived dynamically without breaking
   * Next.js's client-bundle inlining (see the comment in `env.ts`).
   */
  envVar: string;
}

export const FLAG_REGISTRY: Record<FlagName, FlagDefinition> = {
  r1_interview: {
    name: "r1_interview",
    requirement: "R1",
    description: "Pre-search clarification interview shown before the expensive pipeline runs.",
    envVar: "NEXT_PUBLIC_FLAG_R1_INTERVIEW",
  },
  r2_verify: {
    name: "r2_verify",
    requirement: "R2",
    description: "\"Verify these for me\" triage + web-search-backed verification on results.",
    envVar: "NEXT_PUBLIC_FLAG_R2_VERIFY",
  },
  r3_enhance: {
    name: "r3_enhance",
    requirement: "R3",
    description: "\"Enhance my company description\" guided-rewrite modal with live diff.",
    envVar: "NEXT_PUBLIC_FLAG_R3_ENHANCE",
  },
  r4_progress: {
    name: "r4_progress",
    requirement: "R4",
    description: "Event-driven streaming progress UI, replacing the fixed fake progress bar.",
    envVar: "NEXT_PUBLIC_FLAG_R4_PROGRESS",
  },
  r6_auto_fill: {
    name: "r6_auto_fill",
    requirement: "R6",
    description:
      "Assisted-apply demo: sign-in → requirements → admin-review-pending walkthrough " +
      "(preview only; never submits an application, gates nothing server-side).",
    envVar: "NEXT_PUBLIC_FLAG_R6_AUTO_FILL",
  },
  r6_export_autofill: {
    name: "r6_export_autofill",
    requirement: "R6",
    description:
      "\"Export for the browser autofill extension\" button on the package screen — client-side " +
      "serialization of the already-assembled package into a signed .granted.json download for the " +
      "Granted browser extension (T7). No server call, no server retention (§5.3).",
    envVar: "NEXT_PUBLIC_FLAG_R6_EXPORT_AUTOFILL",
  },
  r7_design: {
    name: "r7_design",
    requirement: "R7",
    description: "New design-token-driven landing page (sample picker, 60/30/10 palette, etc).",
    envVar: "NEXT_PUBLIC_FLAG_R7_DESIGN",
  },
  r8_eligibility: {
    name: "r8_eligibility",
    requirement: "R8",
    description: "Hard eligibility screening: eligible / conditionally eligible / excluded buckets.",
    envVar: "NEXT_PUBLIC_FLAG_R8_ELIGIBILITY",
  },
  r9_0_mockauth: {
    name: "r9_0_mockauth",
    requirement: "R9.0",
    description:
      "Mocked Google sign-in backed by localStorage (interim, pre-real-auth). Gates nothing " +
      "server-side; UI state machine only.",
    // Matches the mock-auth drop-in's own env var exactly (prompts/mock-auth-bundle.md), so this
    // flag and the drop-in read the same source of truth instead of two independent switches.
    envVar: "NEXT_PUBLIC_MOCK_AUTH",
  },
  r9_supabase_auth: {
    name: "r9_supabase_auth",
    requirement: "R9",
    description:
      "Real Supabase Auth + Google OAuth, drop-in replacing the R9.0 mock. Wins over " +
      "r9_0_mockauth when both are on. Still gates nothing server-side (§5.3).",
    envVar: "NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH",
  },
  r10_analytics: {
    name: "r10_analytics",
    requirement: "R10.1",
    description: "Funnel event instrumentation emission (landing view, search started, etc).",
    envVar: "NEXT_PUBLIC_FLAG_R10_ANALYTICS",
  },
  r4b_cost_debug: {
    name: "r4b_cost_debug",
    requirement: "R4b",
    description:
      "Attach a per-search cost/latency breakdown to the API response for a debug/admin view. " +
      "Cost figures must never reach the end-user UI without this flag.",
    envVar: "NEXT_PUBLIC_FLAG_R4B_COST_DEBUG",
  },
  left_sidebar: {
    name: "left_sidebar",
    requirement: "FE-07",
    description:
      "Left slide-out drawer (settings/grants/descriptions/account/mock-billing) replacing the " +
      "hamburger dropdown. Local-only; gates nothing server-side; billing is a labeled mock.",
    envVar: "NEXT_PUBLIC_FLAG_LEFT_SIDEBAR",
  },
  g6_s2s_submission: {
    name: "g6_s2s_submission",
    requirement: "G6",
    description:
      "S2S submission integration (package -> grants.gov XML -> MOCK transport). Demo/preview " +
      "only; never submits to any federal system, gates nothing server-side, handles no credentials.",
    envVar: "NEXT_PUBLIC_FLAG_G6_S2S_SUBMISSION",
  },
  b2_enriched_ranking: {
    name: "b2_enriched_ranking",
    requirement: "B2",
    description:
      "Profile-enriched retrieval: fold the structured StartupProfile fields (employee size, " +
      "funding stage, use-of-funds mechanism, industry/NAICS) into the query-embedding text and a " +
      "deterministic, non-negative re-rank boost. Never admits a below-floor opp; scoring/tiers " +
      "unchanged, so the honest-no is untouched.",
    envVar: "NEXT_PUBLIC_FLAG_B2_ENRICHED_RANKING",
  },
  c1b_type_groups: {
    name: "c1b_type_groups",
    requirement: "C1b",
    description:
      "Founder-facing opportunity-type filters plus grouping of the results map by instrument kind " +
      "(grants / R&D / procurement / loans / assistance / scholarships), replacing the flat list.",
    envVar: "NEXT_PUBLIC_FLAG_C1B_TYPE_GROUPS",
  },
  d4_opportunity_graph: {
    name: "d4_opportunity_graph",
    requirement: "D4",
    description:
      "Compact Startup -> Technology -> Agency -> Program -> Award node-link graph on the " +
      "opportunity map, rendered from the existing map/matches/agencyIntelligence data.",
    envVar: "NEXT_PUBLIC_FLAG_D4_OPPORTUNITY_GRAPH",
  },
  d3_funding_strategy: {
    name: "d3_funding_strategy",
    requirement: "D3",
    description:
      "\"Funding strategy\": an ordered 12-month plan of up to 5 programs to investigate, sequenced " +
      "by fit, real deadlines, and federal registration lead time. Presentation-only; derived from " +
      "the existing OpportunityMap; promises no award and never invents a deadline.",
    envVar: "NEXT_PUBLIC_FLAG_D3_FUNDING_STRATEGY",
  },
  d5_alerts: {
    name: "d5_alerts",
    requirement: "D5",
    description:
      "\"Since your last visit\" opportunity alerts: a client-only, localStorage-only diff " +
      "(new matches, tier upgrades, newly closing-soon) against the founder's last saved run " +
      "for the same profile. Never sent to a server (§5.3).",
    envVar: "NEXT_PUBLIC_FLAG_D5_ALERTS",
  },
  r5_deep_analysis: {
    name: "r5_deep_analysis",
    requirement: "R5",
    description:
      "Live, personalized competitor & grant-intelligence market brief (POST /api/competitors): " +
      "real federal awardees + how they positioned, typical award sizes, cited positioning " +
      "recommendations, and gaps to exploit — Max-tier gated, with a demo-fixture fallback. " +
      "Default OFF; the canned demo-first surface stays the default until this ships.",
    envVar: "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS",
  },
  e3_two_pass: {
    name: "e3_two_pass",
    requirement: "E3",
    description:
      "Two-pass candidate scoring: a cheap score-only Pass A over the whole candidate set, then the " +
      "full narrative (Pass B) only for candidates whose Pass-A score clears the render threshold. " +
      "Cuts cost/latency ~3x and hardens precompute against Anthropic 529 overload; non-promoted " +
      "candidates keep their Pass-A score so tiers still compute. Scoring bands (tierFromScore) are " +
      "unchanged, so the honest-no is untouched.",
    envVar: "NEXT_PUBLIC_FLAG_E3_TWO_PASS",
  },
  discernment_layer: {
    name: "discernment_layer",
    requirement: "DISC",
    description:
      "Matching discernment: an advisory per-match verdict (recommend / verify / do-not-recommend) plus a " +
      "whole-map verdict (strong/thin/no-fit), derived purely from the score, the model's own met-criteria, " +
      "and any FOUNDER-STATED disqualifier. Recounts 'high potential' as recommend-only and raises the bar " +
      "per instrument type. Advisory, never an eligibility ruling (R8.4); default OFF until golden-set validated.",
    envVar: "NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER",
  },
  commercial_ui: {
    name: "commercial_ui",
    requirement: "COMM",
    description:
      "Commercial / demo scaffolding in the UI: the mock Billing section + plan tiers, the 'Maximum/Pro " +
      "plan' framing and padlocks on the competitor & auto-fill surfaces, and the hackathon-judge demo " +
      "sign-in toggle. Default OFF so a self-hosted / run-it-locally user is never shown a subscription " +
      "for something that is free to run; the underlying code stays in place. Flip ON to restore the paid framing.",
    envVar: "NEXT_PUBLIC_FLAG_COMMERCIAL_UI",
  },
};
