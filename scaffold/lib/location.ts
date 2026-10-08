/**
 * US state/territory name normalization — pure logic, no dependencies.
 *
 * Exists to compare a company's free-text "Primary US location" (collected
 * with zero format guidance — could be "Utah", "UT", "Draper, UT", "Draper,
 * Utah 84020", etc.) against an award row's state (always a full Proper-Case
 * name, e.g. "Utah"). Never guesses: unparseable input resolves to
 * `undefined`, not a default state.
 */

/** lowercase 2-letter USPS abbreviation -> canonical Proper-Case full name. */
export const STATE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  al: "Alabama",
  ak: "Alaska",
  az: "Arizona",
  ar: "Arkansas",
  ca: "California",
  co: "Colorado",
  ct: "Connecticut",
  de: "Delaware",
  dc: "District of Columbia",
  fl: "Florida",
  ga: "Georgia",
  hi: "Hawaii",
  id: "Idaho",
  il: "Illinois",
  in: "Indiana",
  ia: "Iowa",
  ks: "Kansas",
  ky: "Kentucky",
  la: "Louisiana",
  me: "Maine",
  md: "Maryland",
  ma: "Massachusetts",
  mi: "Michigan",
  mn: "Minnesota",
  ms: "Mississippi",
  mo: "Missouri",
  mt: "Montana",
  ne: "Nebraska",
  nv: "Nevada",
  nh: "New Hampshire",
  nj: "New Jersey",
  nm: "New Mexico",
  ny: "New York",
  nc: "North Carolina",
  nd: "North Dakota",
  oh: "Ohio",
  ok: "Oklahoma",
  or: "Oregon",
  pa: "Pennsylvania",
  ri: "Rhode Island",
  sc: "South Carolina",
  sd: "South Dakota",
  tn: "Tennessee",
  tx: "Texas",
  ut: "Utah",
  vt: "Vermont",
  va: "Virginia",
  wa: "Washington",
  wv: "West Virginia",
  wi: "Wisconsin",
  wy: "Wyoming",
  // Inhabited territories
  as: "American Samoa",
  gu: "Guam",
  mp: "Northern Mariana Islands",
  pr: "Puerto Rico",
  vi: "U.S. Virgin Islands",
};

// Derived, not hand-duplicated, so the two directions can never drift apart.
const FULL_NAME_TO_ABBREV: ReadonlyMap<string, string> = new Map(
  Object.entries(STATE_ABBREVIATIONS).map(([abbr, full]) => [full.toLowerCase(), abbr]),
);

function resolveExact(cleaned: string): string | undefined {
  const abbrevMatch = STATE_ABBREVIATIONS[cleaned];
  if (abbrevMatch) return abbrevMatch;
  const fullMatch = FULL_NAME_TO_ABBREV.get(cleaned);
  if (fullMatch) return STATE_ABBREVIATIONS[fullMatch];
  return undefined;
}

/**
 * Normalizes free-text to a canonical Proper-Case US state/territory name
 * (e.g. "Utah"), or `undefined` when none can be confidently extracted.
 *
 * Resolution order:
 *  1. Whole-string exact match (abbreviation or full name) — "Utah", "UT".
 *  2. If the string contains a comma, the segment after the LAST comma
 *     (with a trailing ZIP/ZIP+4 stripped) — handles "Draper, UT",
 *     "Draper, UT 84020", "Salt Lake City, Utah 84020", and correctly
 *     resolves "Washington, DC" to the District of Columbia rather than
 *     misfiring on "Washington" the state.
 *
 * Deliberately NOT done: any scan over comma-less free-text prose for a
 * state name appearing anywhere in the string. An earlier version of this
 * function did this (word-boundary-guarded) specifically to catch phrasing
 * like "Headquartered in Draper, Utah" without a comma before "Headquartered"
 * — but a word boundary alone cannot distinguish a real state name from the
 * first word of an unrelated multi-word place name: "Idaho Springs" (a real
 * town in COLORADO) and "Nevada City" (a real town in CALIFORNIA) both
 * contain a full, word-bounded state name as their first token, so that scan
 * confidently returned the wrong state for them — the same failure mode
 * (confident wrong guess instead of honest `undefined`) the original bug fix
 * was trying to eliminate, just a narrower trigger. There is no bounded way
 * to close this for arbitrary free text, so this function only ever resolves
 * a state from the whole input or an explicit comma-delimited tail, matching
 * this codebase's existing conservative philosophy for free-text geography
 * (see `lib/eligibility/screen.ts`'s `geography_in` predicate comment: "too
 * ambiguous to fail on without risking a false exclusion, stays
 * indeterminate"). Likewise, no scanning for bare 2-letter abbreviations at
 * arbitrary positions in prose — common words collide with real state codes
 * ("in"->Indiana, "or"->Oregon, "me"->Maine, "co"->Colorado).
 */
export function normalizeStateName(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const whole = trimmed.toLowerCase();
  const wholeMatch = resolveExact(whole);
  if (wholeMatch) return wholeMatch;

  const lastComma = trimmed.lastIndexOf(",");
  if (lastComma !== -1) {
    const tail = trimmed
      .slice(lastComma + 1)
      .replace(/\s*\d{5}(-\d{4})?\s*$/, "")
      .trim()
      .toLowerCase();
    if (tail) {
      const tailMatch = resolveExact(tail);
      if (tailMatch) return tailMatch;
    }
  }

  return undefined;
}

/**
 * True only when BOTH sides normalize to a known state and agree. Never
 * guesses — an unresolvable `a` or `b` makes this false, not a fallback match.
 */
export function statesMatch(a?: string | null, b?: string | null): boolean {
  const na = normalizeStateName(a);
  return na !== undefined && na === normalizeStateName(b);
}

/** The states Granted has a real grant-data source for (mirrors
 *  components/StateSourcesSection.tsx's STATE_SOURCE_OPTIONS ids) --
 *  duplicated by hand, like TOGGLEABLE_STATE_SOURCES in
 *  app/api/corpus/refresh/handler.ts, rather than importing a component
 *  file into this dependency-free lib module. */
export const SUPPORTED_STATE_SOURCES: Readonly<Record<string, string>> = {
  California: "ca-grants",
  Illinois: "il-grants",
  "North Carolina": "nc-grants",
  Utah: "ut-grants",
};

/**
 * Resolves free-text location input (the "Primary US location" field) to a
 * supported, not-yet-selected state source -- the trigger for Settings'
 * "Enable grants for <state>?" prompt. `null` when the location doesn't
 * resolve to a state at all (normalizeStateName's own conservative rules),
 * resolves to a state Granted has no source for, or resolves to one already
 * in `selectedSources` (nothing to prompt about).
 */
export function detectUnselectedSupportedState(
  locationText: string | null | undefined,
  selectedSources: readonly string[],
): { id: string; label: string } | null {
  const state = normalizeStateName(locationText);
  if (!state) return null;
  const id = SUPPORTED_STATE_SOURCES[state];
  if (!id || selectedSources.includes(id)) return null;
  return { id, label: state };
}
