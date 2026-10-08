import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGrantProposalPrompt } from "../proposalPrompt";
import { parseCompetitorAnalysis, type CompetitorAnalysis } from "@/lib/contracts/competitorAnalysis";

/** A minimal, fully-grounded fixture (real schema, two records). */
function fixture(overrides: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...overrides };
}

function base() {
  return {
    persona: "Acme QMS",
    personaDescription: "A Utah company building cloud QMS/MES software for regulated life sciences.",
    capturedAt: "2026-08-15T18:35:24.229Z",
    records: [
      {
        id: "usa_1",
        source: "USAspending" as const,
        recipient: "QUALTRAX, INC",
        amount: 71084,
        agency: "Environmental Protection Agency",
        program: "Award EP135000141",
        abstract: "The system will support the CRL's ISO/IEC 17025 accreditation by managing quality through document control and workflows.",
        sourceUrl: "https://www.usaspending.gov/award/CONT_AWD_EP135000141_6800_-NONE-_-NONE-",
      },
      {
        id: "nih_2",
        source: "NIH RePORTER" as const,
        recipient: "PHYSICAL SCIENCES, INC",
        amount: 1049845,
        agency: "National Institute of General Medical Sciences",
        abstract: "Develop real-time in-line process analytical technology for biomanufacturing process understanding and control.",
        sourceUrl: "https://reporter.nih.gov/project-details/11313907",
        year: 2026,
      },
    ],
    awardStats: { count: 2, withAmount: 2, minAmount: 71084, medianAmount: 560464.5, maxAmount: 1049845 },
    analysis: {
      summary: "Federal funding concentrates in enterprise IT contracts and biomanufacturing analytics.",
      competitors: [
        {
          recordId: "usa_1",
          positioning: "Qualtrax won EPA business by aligning document control to ISO/IEC 17025.",
          quotedSnippet: "managing quality through document control and workflows",
        },
      ],
      recommendations: [{ advice: "Target lab QMS compliance contracts by mapping to specific accreditation standards.", citations: ["usa_1", "nih_2"] }],
      opportunities: [{ advice: "No one in this set addresses GxP validation directly -- a real gap.", citations: ["nih_2"] }],
    },
  };
}

function parsed(f: ReturnType<typeof fixture>): CompetitorAnalysis {
  return parseCompetitorAnalysis(f);
}

describe("buildGrantProposalPrompt", () => {
  test("includes the real company description verbatim", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.match(prompt, /A Utah company building cloud QMS\/MES software for regulated life sciences\./);
  });

  test("includes every real competitor's recipient, agency, amount, positioning, quote, and source URL", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.match(prompt, /QUALTRAX, INC/);
    assert.match(prompt, /Environmental Protection Agency/);
    assert.match(prompt, /\$71,084/);
    assert.match(prompt, /aligning document control to ISO\/IEC 17025/);
    assert.match(prompt, /"managing quality through document control and workflows"/);
    assert.match(prompt, /usaspending\.gov\/award\/CONT_AWD_EP135000141/);
  });

  test("never includes a competitor the analysis didn't actually keep (nih_2 has no competitor card in this fixture)", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.doesNotMatch(prompt, /PHYSICAL SCIENCES, INC \(/);
  });

  test("includes real award-size stats when present", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.match(prompt, /\$71,084/);
    assert.match(prompt, /\$1,049,845/);
    assert.match(prompt, /2 of 2 retrieved awards/);
  });

  test("omits the award-size section entirely when absent, never fabricating stats", () => {
    const f = fixture();
    delete (f as { awardStats?: unknown }).awardStats;
    const prompt = buildGrantProposalPrompt(parsed(f));
    assert.doesNotMatch(prompt, /Typical award size/);
  });

  test("includes real recommendations and gaps", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.match(prompt, /Target lab QMS compliance contracts/);
    assert.match(prompt, /No one in this set addresses GxP validation directly/);
  });

  test("omits the gaps section when the analysis has none (optional field)", () => {
    const f = fixture();
    delete (f.analysis as { opportunities?: unknown }).opportunities;
    const prompt = buildGrantProposalPrompt(parsed(f));
    assert.doesNotMatch(prompt, /Gaps to exploit/);
  });

  test("ends with an explicit instruction not to invent facts beyond what's given", () => {
    const prompt = buildGrantProposalPrompt(parsed(fixture()));
    assert.match(prompt, /Do not invent award amounts, agency names, or facts about this company/);
  });

  test("a missing amount on a cited record reads as undisclosed, never fabricated", () => {
    const f = fixture();
    f.records[0].amount = null as unknown as number;
    const prompt = buildGrantProposalPrompt(parsed(f));
    assert.match(prompt, /QUALTRAX, INC \([^)]*\) — undisclosed/);
  });
});
