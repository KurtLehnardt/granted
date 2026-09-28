/** The four standard test cases. Every team is judged on these. */
export const TEST_CASES = [
  {
    id: "ai-healthcare",
    label: "AI Healthcare",
    text: "We're a 15-person Utah company developing AI-powered software that helps hospitals reduce administrative work for nurses. We've raised $2.5M, have $1M in ARR, and are looking for $500K–$2M of non-dilutive capital to fund product development and hospital pilots.",
    expect: "Healthcare, AI/R&D, SBIR/STTR, workforce, HHS/NIH/NSF, historical recipients",
  },
  {
    id: "manufacturing",
    label: "Advanced Manufacturing",
    text: "We're a 35-person Utah hardware startup doing advanced manufacturing for lightweight aerospace components. $3M in revenue, raised $8M, looking for $2M–$5M for manufacturing scale-up and R&D.",
    expect: "Manufacturing, aerospace/defense, DoD/NASA/DOE, R&D, procurement, similar companies",
  },
  {
    id: "water",
    label: "Climate / Water",
    text: "We're a 10-person Utah startup with a sensor and AI platform that reduces municipal water loss. $500K revenue, raised $1.5M, seeking $500K–$3M for product development and municipal pilots.",
    expect: "Water/environmental, DOE/EPA, climate tech, infrastructure, research funding, procurement/pilots",
  },
  {
    id: "cyber",
    label: "Cybersecurity",
    text: "We're a 22-person Utah cybersecurity startup building AI-powered threat detection for small and mid-sized organizations. $2M ARR, raised $5M, seeking $1M–$3M for R&D and federal/commercial expansion.",
    expect: "Cybersecurity, DoD/DHS, SBIR/STTR, federal procurement, historical cyber recipients",
  },
] as const;
