import type { AssembledPackage } from "../../apply/package";
import type { SubmissionMeta, AorAuthorization } from "../types";

/**
 * Shared hermetic fixtures for the T-C gate/client tests. Not a `*.test.ts` file,
 * so the test runner glob (`**\/__tests__/**\/*.test.ts`) ignores it — it is
 * imported by `authorize.test.ts` and `client.test.ts`.
 */

export const ISO = "2026-08-16T12:00:00.000Z";
export const OPP_ID = "OPP-1";
export const ORG_UEI = "ABC123DEF456";

/**
 * A minimal-but-valid `AssembledPackage`. Only `opportunity_id` matters to the AOR
 * gate, but the whole shape must type-check and must render through the XML mapper
 * in the client test — so it carries a single gap-only budget total (which is how
 * G4's contract always models the exact total) and empty forms/narratives.
 */
export function makeAssembled(opportunityId: string = OPP_ID): AssembledPackage {
  return {
    opportunity_id: opportunityId,
    program_title: "Test Program",
    generated_at: ISO,
    narrativeStatus: "drafted",
    requirementsAvailable: true,
    narratives: [],
    draftableSections: [],
    forms: {
      opportunity_id: opportunityId,
      program_title: "Test Program",
      generated_at: ISO,
      forms: [],
      gaps: [],
    },
    budget: {
      generated_at: ISO,
      line_items: [],
      total: {
        range_statement: "[you to provide: total budget range]",
        range_grounded: false,
        amount: "[you to provide: total budget amount]",
      },
      constraints: [],
      advisories: [],
      notes: [],
      gaps: ["[you to provide: total budget amount]"],
    },
    checklist: { allRegistrationsSatisfied: false },
    gaps: ["[you to provide: total budget amount]"],
  };
}

export function makeMeta(opportunityId: string = OPP_ID): SubmissionMeta {
  return {
    opportunity_id: opportunityId,
    program_title: "Test Program",
    source_label: "grants.gov",
  };
}

/** A valid mock AOR attestation scoped to `OPP_ID`. */
export function makeAuthorization(overrides: Partial<AorAuthorization> = {}): AorAuthorization {
  return {
    org_uei: ORG_UEI,
    aor_name: "Jane Smith",
    attested: true,
    attested_at: ISO,
    scope: { opportunity_id: OPP_ID },
    is_demo: true,
    ...overrides,
  };
}
