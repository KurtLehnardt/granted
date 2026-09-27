/**
 * Shared SAM assistance / SBIR-award / USAspending-procurement normalization —
 * the per-record logic assemble-mvp-corpus.mjs and scripts/refresh-corpus.mjs
 * both need, extracted so the two never drift.
 */
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

/** One raw data/raw/sbir-corpus.json row (recent award) -> Opportunity. */
export function normalizeSbirAward(a) {
  const title = clean(a.title);
  if (!title) return null;
  const yr = a.year ? `FY${a.year}` : "recently";
  const framing =
    `Recent SBIR/STTR award (${yr})` +
    (a.state ? ` to a ${a.state} small business` : "") +
    `; ${clean(a.agency)} funds R&D in this area under its ongoing SBIR/STTR program.`;
  const description = [title, framing, clean(a.abstract)].filter(Boolean).join(" ").slice(0, 4000);
  return {
    id: `sbir-award-${shortId(`${a.company}|${a.year}|${title}`)}`,
    source: "sbir",
    kind: "rd",
    program: title,
    agency: clean(a.agency) || "SBIR/STTR agency",
    description,
    eligibility: "US small business, generally under 500 employees (SBIR/STTR).",
    status: "continuous",
    forecasted: false,
    industryTags: a._keywords ?? [],
    url: clean(a.website) || "https://www.sbir.gov/awards",
  };
}

/** One raw data/raw/usaspending-contracts.json row -> Opportunity (past award, gov-as-customer). */
export function normalizeProcurementRecord(c) {
  const recipient = clean(c["Recipient Name"]);
  const rawDesc = clean(c["Description"]);
  const naics = c["NAICS"] || {};
  const naicsDesc = clean(naics.description);
  const agency = clean(c["Awarding Agency"]) || "Federal agency";
  const subAgency = clean(c["Awarding Sub Agency"]) || agency;
  const amount = Number(c["Award Amount"]) || 0;
  const startDate = clean(c["Start Date"]);
  const program = (rawDesc || `${naicsDesc || "Federal"} contract`).slice(0, 120);
  const amountStr = amount ? `$${amount.toLocaleString("en-US")}` : "an undisclosed amount";
  const description = [
    rawDesc,
    `Federal ${naicsDesc ? `(${naicsDesc}) ` : ""}contract awarded to ${recipient || "a contractor"} for ${amountStr}` +
      (startDate ? ` (start ${startDate})` : "") + ".",
    `Government-as-customer signal: ${subAgency} buys in this area — this is a procurement / business-development path (government as a customer), not a grant. Verify current solicitations on SAM.gov.`,
  ].filter(Boolean).join(" ").slice(0, 4000);
  const internalId = clean(c.generated_internal_id);
  return {
    id: `usasp-${clean(c["Award ID"]) || shortId(internalId || program)}`,
    source: "usaspending",
    kind: "procurement",
    program,
    agency,
    description,
    eligibility: "Open to firms able to perform the contract scope and holding the required registrations (active SAM.gov / UEI).",
    status: "closed",
    forecasted: false,
    industryTags: [c._keyword, clean(naics.code)].filter(Boolean),
    url: internalId ? `https://www.usaspending.gov/award/${internalId}` : undefined,
  };
}
