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

// Longest-first so a substring scan matches "New York" before a hypothetical
// shorter prefix could steal the match.
const FULL_NAMES_LONGEST_FIRST: readonly string[] = Array.from(FULL_NAME_TO_ABBREV.keys()).sort(
  (a, b) => b.length - a.length,
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
 *  1. Whole-string exact match (abbreviation or full name).
 *  2. If the string contains a comma, the segment after the LAST comma
 *     (with a trailing ZIP/ZIP+4 stripped) — handles "Draper, UT",
 *     "Draper, UT 84020", "Salt Lake City, Utah 84020", and correctly
 *     resolves "Washington, DC" to the District of Columbia rather than
 *     misfiring on "Washington" the state.
 *  3. A longest-name-first, WORD-BOUNDARY scan of the whole string — catches
 *     "Headquartered in Draper, Utah" without falsely matching a state name
 *     that's merely a substring of an unrelated word ("Ohiopyle", PA, must
 *     not match "Ohio"; "Washingtonville", NY, must not match "Washington").
 *
 * Deliberately NOT done: scanning for bare 2-letter abbreviations at
 * arbitrary positions in prose. Common words collide with real state codes
 * ("in"->Indiana, "or"->Oregon, "me"->Maine, "co"->Colorado) — "based in
 * Texas" must not wrongly hit "in" -> Indiana. Abbreviation matching is
 * restricted to the whole input or the comma-tail, never a free scan.
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

  // Word-boundary, not a bare substring check: "Ohiopyle" (a real Pennsylvania
  // town) and "Washingtonville" (a real New York village) both contain a
  // full state name as a substring but are not that state.
  for (const name of FULL_NAMES_LONGEST_FIRST) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (pattern.test(whole)) return STATE_ABBREVIATIONS[FULL_NAME_TO_ABBREV.get(name)!];
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
