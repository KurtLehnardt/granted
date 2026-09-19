// ============================================================================
// CAN-02 — broadened grants.gov search-keyword coverage.
// ----------------------------------------------------------------------------
// v1 (scripts/1-fetch.mjs) hardcoded ~15 keywords shaped around five demo
// test cases. The CAN-02 DoD requires coverage "broadened beyond the 15 demo
// keywords (comprehensive or configurable)". This is that broadened,
// categorized list — grouped by sector so gaps/overlaps are auditable instead
// of one flat blob, and each category can be sliced independently (see
// `--categories=` in ingest-grants.mjs) for smoke tests or future per-sector
// scheduling.
//
// ============================================================================

export const KEYWORD_CATEGORIES = {
  ai_data: [
    "artificial intelligence",
    "machine learning",
    "data science",
    "quantum computing",
    "high performance computing",
  ],
  health: [
    "health information technology",
    "nursing workforce",
    "public health infrastructure",
    "behavioral health",
    "maternal health",
    "rural health care",
    "biomedical research",
    "medical device innovation",
    "infectious disease surveillance",
    "opioid response",
  ],
  manufacturing_materials: [
    "advanced manufacturing",
    "aerospace materials",
    "lightweight structures",
    "semiconductor manufacturing",
    "robotics automation",
    "additive manufacturing",
    "supply chain resilience",
  ],
  infrastructure_environment: [
    "water infrastructure",
    "environmental sensors",
    "climate technology",
    "clean energy",
    "renewable energy",
    "grid resilience",
    "wildfire resilience",
    "disaster preparedness",
    "coastal resilience",
    "brownfield redevelopment",
    "broadband deployment",
  ],
  security_defense: [
    "cybersecurity",
    "threat detection",
    "critical infrastructure security",
    "border security technology",
    "biodefense",
    "space technology",
  ],
  economy_workforce: [
    "small business innovation",
    "workforce development",
    "youth programs",
    "community development",
    "entrepreneurship training",
    "apprenticeship programs",
    "rural economic development",
    "minority business development",
    "veteran owned business",
  ],
  agriculture_food: [
    "sustainable agriculture",
    "food security",
    "precision agriculture",
    "agricultural biotechnology",
  ],
  education: [
    "STEM education",
    "career technical education",
    "early childhood education",
    "higher education research",
  ],
  transportation: [
    "transportation infrastructure",
    "electric vehicle technology",
    "aviation research",
    "maritime technology",
  ],
  housing_community: [
    "affordable housing",
    "homelessness services",
    "tribal community development",
  ],
};

/** Flattened, de-duplicated keyword list across every category. */
export const ALL_KEYWORDS = [...new Set(Object.values(KEYWORD_CATEGORIES).flat())];

/** Look up keywords for one or more category names; throws on an unknown name. */
export function keywordsForCategories(names) {
  const out = [];
  for (const name of names) {
    const list = KEYWORD_CATEGORIES[name];
    if (!list) {
      throw new Error(
        `Unknown keyword category "${name}". Known: ${Object.keys(KEYWORD_CATEGORIES).join(", ")}`,
      );
    }
    out.push(...list);
  }
  return [...new Set(out)];
}
