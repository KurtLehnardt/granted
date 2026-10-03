import { createHash } from "node:crypto";

export const clean = (s) =>
  (s ?? "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const shortId = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** One raw data/raw/sam-assistance.json row -> Opportunity (evergreen: no deadline/funding). */
export function normalizeSamRow(p) {
  const title = clean(p.title);
  if (!title) return null;
  const description = [title, clean(p.objectives), clean(p.uses)].filter(Boolean).join(". ").slice(0, 4000);
  return {
    id: `sam-${p.programNumber || shortId(title)}`,
    source: "assistance-listings",
    kind: p.kind,
    program: title,
    agency: clean(p.agency) || "Federal agency",
    description,
    eligibility: clean(p.eligibility) || undefined,
    status: "continuous",
    forecasted: false,
    industryTags: p._keywords ?? [],
    url: clean(p.url) || clean(p.website) || undefined,
  };
}

/** Extract every dollar figure from free text and return {low, high}, or
 *  {undefined, undefined} if none found. Confirmed live that California's
 *  EstAmounts column is sometimes pure prose ("Dependant on number of
 *  submissions received...") -- that must fail closed, never guess a figure
 *  out of unrelated text -- but 46/2017 real rows are a genuine range,
 *  "Between $A and $B" (A is the floor, B the ceiling). Extracting EVERY
 *  figure and taking min/max handles both the single-number and range cases
 *  without caring about the exact wording, and fixes a real bug: taking only
 *  the FIRST match on a range string silently returns the floor (sometimes
 *  $1) as if it were the ceiling. */
function parseDollarAmounts(text) {
  const matches = [...clean(text).matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const valid = matches.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length === 0) return { low: undefined, high: undefined };
  return { low: Math.min(...valid), high: Math.max(...valid) };
}

/** California's ApplicationDeadline column mixes real datetimes ("2026-11-02
 *  17:00:00"), the literal "Ongoing", and absence. Require an explicit
 *  YYYY-MM-DD shape (not just "any 4-digit substring", which would wrongly
 *  accept non-date text like "FY 2027" or "Round 2027" and fabricate a
 *  Jan-1 deadline via Date's permissive parsing) -- anything else, including
 *  "Ongoing", becomes undefined (evergreen), not a literal string the UI
 *  would try to render as a date. */
function parseCaDeadline(text) {
  const c = clean(text);
  if (!/^\d{4}-\d{2}-\d{2}/.test(c)) return undefined;
  const d = new Date(c);
  return Number.isNaN(d.getTime()) ? undefined : c;
}

/** One raw data/raw/ca-grants.json row (California Grants Portal, a real CKAN
 *  dataset) -> Opportunity. PortalID (not GrantID, confirmed null or garbage
 *  for the large majority of live rows) is the stable key. */
export function normalizeCaRow(p) {
  const title = clean(p.Title);
  if (!title) return null;
  const description =
    [title, clean(p.Purpose), clean(p.Description)].filter(Boolean).join(". ").slice(0, 4000) ||
    `${title}. See the official California Grants Portal listing for full eligibility and deadlines.`;
  const eligibility = [clean(p.ApplicantType), clean(p.ApplicantTypeNotes)].filter(Boolean).join(" — ") || undefined;
  const kind = /^loan$/i.test(clean(p.Type)) ? "loan" : "grant";
  // Prefer EstAvailFunds (the total pool) wholesale over EstAmounts (the
  // per-award range) when it has a real figure -- never mix a low from one
  // field with a high from the other, each column means something different.
  const avail = parseDollarAmounts(p.EstAvailFunds);
  const amounts = avail.high !== undefined ? avail : parseDollarAmounts(p.EstAmounts);
  return {
    id: `ca-${p.PortalID}`,
    source: "ca-grants",
    kind,
    program: title,
    agency: clean(p.AgencyDept) || "California state agency",
    description,
    eligibility,
    deadline: parseCaDeadline(p.ApplicationDeadline),
    fundingLow: amounts.low !== amounts.high ? amounts.low : undefined,
    fundingHigh: amounts.high,
    url: clean(p.GrantURL) || undefined,
    geography: "California",
  };
}

