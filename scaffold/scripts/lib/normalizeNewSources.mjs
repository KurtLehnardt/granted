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

