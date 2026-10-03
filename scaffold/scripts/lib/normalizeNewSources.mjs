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

/** Extract a single dollar figure from free text, or undefined. Confirmed live
 *  that California's own `EstAmounts` column is often prose ("Dependant on
 *  number of submissions received...") rather than a number -- this must fail
 *  closed (undefined), never guess a figure out of unrelated text. */
function parseDollarAmount(text) {
  const m = clean(text).match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** California's ApplicationDeadline column mixes real datetimes ("2026-11-02
 *  17:00:00"), the literal "Ongoing", and absence. Only pass through something
 *  that is plausibly a real date -- "Ongoing" must become undefined
 *  (evergreen), not a literal string the UI would try to render as a date. */
function parseCaDeadline(text) {
  const c = clean(text);
  if (!c || !/\d{4}/.test(c)) return undefined; // no year-like token -> not a date ("Ongoing", etc.)
  const d = new Date(c);
  return Number.isNaN(d.getTime()) ? undefined : c;
}

/** One raw data/raw/ca-grants.json row (California Grants Portal, a real CKAN
 *  dataset) -> Opportunity. PortalID (not GrantID, confirmed almost always
 *  null/garbage in the live data) is the stable key. */
export function normalizeCaRow(p) {
  const title = clean(p.Title);
  if (!title) return null;
  const description =
    [title, clean(p.Purpose), clean(p.Description)].filter(Boolean).join(". ").slice(0, 4000) ||
    `${title}. See the official California Grants Portal listing for full eligibility and deadlines.`;
  const eligibility = [clean(p.ApplicantType), clean(p.ApplicantTypeNotes)].filter(Boolean).join(" — ") || undefined;
  const kind = /^loan$/i.test(clean(p.Type)) ? "loan" : "grant";
  return {
    id: `ca-${p.PortalID}`,
    source: "ca-grants",
    kind,
    program: title,
    agency: clean(p.AgencyDept) || "California state agency",
    description,
    eligibility,
    deadline: parseCaDeadline(p.ApplicationDeadline),
    fundingHigh: parseDollarAmount(p.EstAvailFunds) ?? parseDollarAmount(p.EstAmounts),
    url: clean(p.GrantURL) || undefined,
    geography: "California",
  };
}

