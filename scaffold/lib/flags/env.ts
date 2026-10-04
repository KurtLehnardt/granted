import type { FlagName } from "./registry";

/**
 * Raw (unparsed) per-flag env-var overrides, read once per call.
 *
 * IMPORTANT — this function must stay written exactly like this. Next.js only inlines
 * `process.env.NEXT_PUBLIC_*` into the *client* bundle when the reference is a static
 * `process.env.NEXT_PUBLIC_X` member expression visible to its build-time replacement pass. A
 * dynamic/computed lookup (e.g. `process.env[computedKey]`) is invisible to that pass and reads
 * `undefined` in the browser even when the var is set — the flag would then silently behave
 * differently on server vs. client, which breaks the "one source of truth" requirement.
 *
 * So: every flag gets one hand-written static line below, even though it's repetitive. Do not
 * refactor this into a loop over `FLAG_REGISTRY` — that would reintroduce the dynamic-lookup bug.
 *
 * Wrapping this in a function (rather than a module-level constant) also means every call re-reads
 * `process.env` at call time, which is what makes the flags testable: tests can mutate
 * `process.env` and immediately observe the new value without re-importing the module.
 */
export function readRawOverrides(): Record<FlagName, string | undefined> {
  return {
    r1_interview: process.env.NEXT_PUBLIC_FLAG_R1_INTERVIEW,
    r2_verify: process.env.NEXT_PUBLIC_FLAG_R2_VERIFY,
    r3_enhance: process.env.NEXT_PUBLIC_FLAG_R3_ENHANCE,
    r4_progress: process.env.NEXT_PUBLIC_FLAG_R4_PROGRESS,
    r8_eligibility: process.env.NEXT_PUBLIC_FLAG_R8_ELIGIBILITY,
    // Matches the mock-auth drop-in's own env var — see registry.ts's r9_0_mockauth entry.
    r9_0_mockauth: process.env.NEXT_PUBLIC_MOCK_AUTH,
    r10_analytics: process.env.NEXT_PUBLIC_FLAG_R10_ANALYTICS,
    r4b_cost_debug: process.env.NEXT_PUBLIC_FLAG_R4B_COST_DEBUG,
    left_sidebar: process.env.NEXT_PUBLIC_FLAG_LEFT_SIDEBAR,
    b2_enriched_ranking: process.env.NEXT_PUBLIC_FLAG_B2_ENRICHED_RANKING,
    c1b_type_groups: process.env.NEXT_PUBLIC_FLAG_C1B_TYPE_GROUPS,
    d4_opportunity_graph: process.env.NEXT_PUBLIC_FLAG_D4_OPPORTUNITY_GRAPH,
    d3_funding_strategy: process.env.NEXT_PUBLIC_FLAG_D3_FUNDING_STRATEGY,
    d5_alerts: process.env.NEXT_PUBLIC_FLAG_D5_ALERTS,
    r5_deep_analysis: process.env.NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS,
    e3_two_pass: process.env.NEXT_PUBLIC_FLAG_E3_TWO_PASS,
    discernment_layer: process.env.NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER,
    commercial_ui: process.env.NEXT_PUBLIC_FLAG_COMMERCIAL_UI,
    match_filters: process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS,
    update_check: process.env.NEXT_PUBLIC_FLAG_UPDATE_CHECK,
  };
}
