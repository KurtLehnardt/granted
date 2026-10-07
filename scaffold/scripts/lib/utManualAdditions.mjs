/**
 * The Utah Looker Studio dashboard (see 1-fetch-ut-grants.mjs's header) is
 * the state's only central listing, but it is not exhaustive: these 7 real
 * Utah Governor's Office of Economic Opportunity (GOEO) programs are
 * confirmed live on business.utah.gov (and, for the Utah Innovation Fund,
 * utahinnovationfund.com) as of 2026-10-07, but do not appear among the
 * dashboard's ~200 cards. Hand-added here in the exact raw card shape
 * extractCards() produces, so they flow through the same normalizeUtRow()
 * pipeline as scraped rows -- no separate code path. If the dashboard ever
 * starts including one of these, normalizeUtRow's id (a content hash of
 * title+agency) will collide and de-dupe it harmlessly; no action needed.
 *
 * A plain data module (no Playwright import, no top-level await) so it can
 * be unit-tested without launching a browser -- unlike 1-fetch-ut-grants.mjs
 * itself, which runs its scrape unconditionally on import.
 */
export const MANUAL_ADDITIONS = [
  {
    title: "Housing and Transit Reinvestment Zone (HTRZ)",
    category: "Community & Economic Development",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Lets a municipality or public transit county capture a portion of the property- and sales-tax revenue growth around a light rail, bus rapid transit, or commuter rail station to fund mixed-use, multifamily, and affordable housing development nearby. Proposals go to GOEO and the Housing & Transit Reinvestment Zone Committee.",
    url: "https://business.utah.gov/community-initiatives/htrz/",
  },
  {
    title: "First Home Investment Zone (FHIZ)",
    category: "Community & Economic Development",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Lets a municipality capture incremental tax revenue growth to fund infrastructure for a 10-100 acre mixed-use, medium-density town center surrounded by single-family homes, in exchange for meeting density and affordable/owner-occupied housing requirements. Open through December 31, 2027.",
    url: "https://business.utah.gov/community-initiatives/fhiz/",
  },
  {
    title: "Regionally Significant Development Zone (RSDZ)",
    category: "Community & Economic Development",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Lets a municipality or county capture property- and personal-property-tax increment to fund infrastructure for a Transit-Oriented, First Home Village, or Economic Development Opportunity zone of regional significance (housing, data centers, large commercial development). Created by the 2026 Legislature (H.B. 507); proposals go to GOEO's tax-increment committee.",
    url: "https://business.utah.gov/community-initiatives/rsdz/",
  },
  {
    title: "Major Sporting Event Venue Zone (MSEVZ)",
    category: "Community & Economic Development",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Lets a municipality or county capture property, sales-and-use, and transient room tax increment to finance an Olympic or professional sports venue and its supporting infrastructure, with venue-owner consent and school-district input required. Created by S.B. 333 (2025); proposals go to GOEO.",
    url: "https://business.utah.gov/community-initiatives/msevz/",
  },
  {
    title: "Hotel Impact Mitigation Fund",
    category: "Business Assistance",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "$2,100,000",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Reimburses a qualifying Salt Lake City hotel, built before July 1, 2014 and located within one mile of the Grand America/Hyatt Regency convention hotel, for city-wide-event revenue it lost because of that hotel's entry into the market, measured against its own 2017-2019 baseline. Version two runs May 2025 onward with $2.1 million available, prorated across eligible claims.",
    url: "https://business.utah.gov/grants-funding/hotel-impact-mitigation-fund/",
  },
  {
    title: "Affordable Housing Infrastructure Grant",
    category: "Housing",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "Grants infrastructure funding to a county, municipality, public housing authority, special service district, or transit district in Salt Lake County building at least 50 affordable housing units (80% AMI rental, or 120% AMI for-sale with a deed restriction). Paid in a planning/design phase then a construction phase, at a ratio of at least one affordable unit per $20,000 awarded. Created by the 2025 Legislature.",
    url: "https://business.utah.gov/grants-funding/affordable-housing-infrastructure-grant/",
  },
  {
    title: "Utah Innovation Fund",
    category: "Technology & Innovation",
    agency: "Utah Governor's Office of Economic Opportunity",
    amount: "",
    grantMatch: "N/A",
    loanInterest: "N/A",
    description:
      "A $15 million evergreen fund created by the Legislature (H.B. 42) that makes early equity investments in startups commercializing technology from Utah's public research universities, aiming to carry promising university spinouts to the point traditional investors will fund them. This is equity investment, not a grant -- listed here because it is real, state-created startup capital a Utah research-based company can pursue.",
    url: "https://www.utahinnovationfund.com/",
  },
];
