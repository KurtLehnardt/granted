/**
 * F3 — real named Utah/SBA weak-field redirects.
 *
 * `explainWeakField` (lib/claude.ts) asks the model for 3-5 "redirects" when a
 * search comes back with no strong federal grant match (the honest no). The
 * model's redirects are useful but CATEGORY-shaped ("SBA programs", "state
 * economic development") rather than a real program an applicant could actually
 * go open a tab for. This module is the fix: a small, curated, deterministic
 * list of REAL, currently-operating Utah/SBA-adjacent programs, plus a pure
 * helper that guarantees at least a couple of them land in the finding.
 *
 * Every entry below was checked against the program's own site (or the SBA's)
 * before being added — see the URL folded into each `why`. Keep this list
 * honest: only a program that genuinely exists today belongs here, and every
 * `why` is deliberately HEDGED ("may help with…", "worth checking whether…").
 * This module never asserts eligibility or an award — only that the program
 * exists and is a reasonable next place to look. If a program is renamed,
 * sunset, or its scope drifts from the label below, fix or remove the entry
 * rather than let a stale claim sit here.
 *
 * Pure and dependency-free by design (no SDK, no network, no `lib/claude.ts`
 * import) so it is trivially hermetic to unit test and safe to call from
 * `lib/match.ts`'s weak-field branch without adding a live-call surface.
 */

/** The shape `explainWeakField` returns and `OpportunityMapSchema.weakFieldFinding`
 *  validates (lib/contracts/opportunityMap.ts) — restated here, structurally,
 *  so this module stays decoupled from lib/claude.ts. */
export type RedirectSuggestion = { label: string; why: string };
export type WeakFieldFinding = {
  headline: string;
  reasoning: string;
  redirects: RedirectSuggestion[];
};

/** A curated, real program entry. Same shape as `RedirectSuggestion` — this is
 *  just a named alias so the intent (curated fact vs. model output) is clear
 *  at the type level. */
export type RealProgram = RedirectSuggestion;

/**
 * Curated, deterministic list of REAL Utah/SBA-adjacent programs. Order is
 * the priority order `ensureRealRedirects` draws from (top entries preferred)
 * — chosen for breadth (advising, financing, R&D assistance, rural, women-
 * owned) so the first couple picked are rarely redundant with each other.
 */
export const UTAH_SBA_PROGRAMS: readonly RealProgram[] = [
  {
    label: "Utah SBDC (Small Business Development Center)",
    why: "A statewide network of 14 centers offering free one-on-one advising, business planning, and capital-access coaching for Utah small businesses, funded jointly by the SBA and the state — worth a look regardless of what this search found. https://utahsbdc.org",
  },
  {
    label: "SBA Utah District Office",
    why: "The SBA's Salt Lake City district office connects small businesses to 7(a)/504 loan programs, federal-contracting certifications, and local lender referrals — a source of financing outside the federal grant system. https://www.sba.gov/district/utah",
  },
  {
    label: "Utah Innovation Center (GOEO SBIR/STTR assistance)",
    why: "State-run technical assistance (formerly the Utah SBIR Center) that helps Utah small businesses prepare and compete for federal SBIR/STTR R&D awards — may still be a route into federal R&D funding even when this search's direct grant match is weak. https://business.utah.gov/innovation-center/",
  },
  {
    label: "Utah Technology Innovation Fund (UTIF)",
    why: "A state matching-grant program that can add roughly $50,000-$60,000 on top of a company's own federal SBIR/STTR Phase I/II award — only relevant once a federal award is in hand, but worth knowing about ahead of time. https://business.utah.gov/innovation-center/empowering-utahs-entrepreneurs/",
  },
  {
    label: "GOEO Rural Business Grants (REDI / Rural Communities Opportunity Grant)",
    why: "State grant programs aimed at job creation and economic development in rural Utah counties — may fit a company based, or expanding, outside the Wasatch Front. https://business.utah.gov/grants-funding/",
  },
  {
    label: "Women's Business Center of Utah",
    why: "An SBA-partnered center (with the Salt Lake Chamber) offering advising, training, and funding navigation for women-owned businesses — worth checking if that describes this company. https://www.wbcutah.org",
  },
] as const;

/** Guarantee floor: `ensureRealRedirects` never returns fewer than this many
 *  curated real programs in `redirects`. */
export const MIN_REAL_REDIRECTS = 2;

/** Total-redirects cap so a finding never turns into an unreadable wall of
 *  links — matches the model prompt's own "3-5" guidance (lib/prompts/
 *  registry.ts EXPLAIN_WEAK_FIELD_V1_TEMPLATE). */
export const MAX_REDIRECTS = 5;

/** Case/whitespace-insensitive label key, so a curated program is recognized
 *  as "already present" even if the model phrased the same program's name
 *  with different casing or incidental spacing. */
function labelKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * PURE. Returns `finding` with `redirects` guaranteed to contain at least
 * `MIN_REAL_REDIRECTS` real, curated Utah/SBA programs (from
 * `UTAH_SBA_PROGRAMS`), deduped by label against whatever the model already
 * produced, with the total length capped at `MAX_REDIRECTS`.
 *
 * Policy (deterministic, no randomness, no I/O):
 *  1. A curated program already present in `finding.redirects` (by
 *     case/whitespace-insensitive label match) counts toward the guarantee —
 *     it is never duplicated.
 *  2. Missing curated programs are appended, in `UTAH_SBA_PROGRAMS` order,
 *     only as many as needed to reach the `MIN_REAL_REDIRECTS` floor.
 *  3. The real programs (already-present + newly-appended) are NEVER dropped
 *     to make room. If the combined list would exceed `MAX_REDIRECTS`, the
 *     model's own OTHER (non-curated) suggestions are trimmed first, keeping
 *     the earliest ones, so `redirects` never exceeds the cap.
 *  4. Everything else about `finding` (headline, reasoning, non-redirect
 *     fields) passes through unchanged — this never rewrites the model's
 *     narrative, only backs its redirect list with real programs.
 */
export function ensureRealRedirects(finding: WeakFieldFinding): WeakFieldFinding {
  const existing = Array.isArray(finding.redirects) ? finding.redirects : [];
  const existingKeys = new Set(existing.map((r) => labelKey(r.label)));

  const alreadyPresent = UTAH_SBA_PROGRAMS.filter((p) => existingKeys.has(labelKey(p.label)));
  const missing = UTAH_SBA_PROGRAMS.filter((p) => !existingKeys.has(labelKey(p.label)));

  const stillNeeded = Math.max(0, MIN_REAL_REDIRECTS - alreadyPresent.length);
  const toAppend = missing.slice(0, stillNeeded);

  const realKeys = new Set([...alreadyPresent, ...toAppend].map((p) => labelKey(p.label)));
  const real = existing.filter((r) => realKeys.has(labelKey(r.label))).concat(toAppend);
  const modelOnly = existing.filter((r) => !realKeys.has(labelKey(r.label)));

  const budgetForModelOnly = Math.max(0, MAX_REDIRECTS - real.length);
  const redirects = [...real, ...modelOnly.slice(0, budgetForModelOnly)];

  return { ...finding, redirects };
}
