const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  ndash: "–", mdash: "—", sect: "§", trade: "™",
  bull: "•", hellip: "…", copy: "©", reg: "®",
  atilde: "ã", eacute: "é", iacute: "í", ocirc: "ô",
};

const decodeEntitiesOnce = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

const TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

export const stripHtml = (html) => {
  if (!html) return "";
  let text = html.replace(TAG_RE, " ");
  for (let i = 0; i < 3; i++) {
    const next = decodeEntitiesOnce(text);
    if (next === text) break;
    text = next;
  }
  return text
    .replace(TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/** One raw grants.gov search2 hit (with `_detail` from fetchOpportunity) -> Opportunity. */
export function normalizeGrantsRecord(g) {
  const detail = g._detail ?? {};
  const title = stripHtml(g.title) || "Untitled opportunity";
  const descText = stripHtml(detail.synopsisDesc ?? detail.forecastDesc);
  const eligText = stripHtml(detail.applicantEligibilityDesc) ||
    stripHtml((detail.applicantTypes ?? []).map((t) => t.description).filter(Boolean).join("; "));
  return {
    id: `grants-${g.id ?? g.number}`,
    source: "grants.gov",
    kind: "grant",
    program: title,
    agency: g.agency ?? g.agencyCode ?? "Unknown agency",
    description: [title, descText, g._keyword].filter(Boolean).join(". ").slice(0, 4000),
    eligibility: eligText,
    fundingLow: Number(detail.awardFloor) || undefined,
    fundingHigh: Number(detail.awardCeiling) || undefined,
    deadline: g.closeDate || undefined,
    forecasted: (g.oppStatus ?? "").toLowerCase() === "forecasted",
    industryTags: [g._keyword].filter(Boolean),
    url: g.id ? `https://www.grants.gov/search-results-detail/${g.id}` : undefined,
  };
}

/** One raw sbir-solicitations.json entry -> Opportunity. */
export function normalizeSbirSolicitation(s) {
  const solTitle = stripHtml(s.solicitation_title) || "SBIR/STTR solicitation";
  return {
    id: `sbir-${s.solicitation_id ?? s.solicitation_number}`,
    source: "sbir",
    kind: "rd",
    program: solTitle,
    agency: s.agency ?? "Unknown agency",
    description: [solTitle, (s.solicitation_topics ?? [])
      .map((t) => `${stripHtml(t.topic_title)}: ${stripHtml(t.topic_description) ?? ""}`).join(" ")]
      .filter(Boolean).join(". ").slice(0, 4000),
    eligibility: "US small business, generally under 500 employees",
    deadline: s.close_date ?? undefined,
    url: s.solicitation_agency_url ?? undefined,
  };
}
