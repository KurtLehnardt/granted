import { canonicalize, digestPayload } from "../../src/lib/envelope";
import type { AssembledPackage } from "../../src/lib/contracts/package";

/** A minimal but honesty-contract-valid `AssembledPackage` for tests. */
export function validPackage(): AssembledPackage {
  return {
    opportunity_id: "opp-123",
    program_title: "Small Business Innovation Grant",
    generated_at: "2026-08-16T00:00:00.000Z",
    narrativeStatus: "drafted",
    requirementsAvailable: true,
    narratives: [],
    draftableSections: [],
    forms: {
      opportunity_id: "opp-123",
      program_title: "Small Business Innovation Grant",
      generated_at: "2026-08-16T00:00:00.000Z",
      forms: [
        {
          form_name: "SF-424",
          fields: [
            {
              key: "uei",
              label: "Unique Entity Identifier (UEI)",
              status: "prefilled",
              value: "ABC123XYZ789",
              display: "ABC123XYZ789",
              source: "sam.uei",
            },
            {
              key: "organization_name",
              label: "Organization legal name",
              status: "founder_to_provide",
              display: "[you to provide: organization legal name]",
            },
          ],
        },
      ],
      gaps: ["[you to provide: organization legal name]"],
    },
    budget: {
      generated_at: "2026-08-16T00:00:00.000Z",
      line_items: [],
      total: {
        range_statement: "[you to provide: total budget amount]",
        range_grounded: false,
        amount: "[you to provide: total budget amount]",
      },
      constraints: [],
      advisories: [],
      notes: [],
      gaps: ["[you to provide: total budget amount]"],
    },
    checklist: { allRegistrationsSatisfied: false },
    gaps: ["[you to provide: organization legal name]", "[you to provide: total budget amount]"],
  };
}

/** Wrap `payload` in a correctly-digested envelope, as JSON text ready for `validateImport`. */
export async function validEnvelopeJson(payload: AssembledPackage = validPackage()): Promise<string> {
  const digestValue = await digestPayload(payload);
  const envelope = {
    format: "granted.autofill.package",
    version: 1,
    generated_at: "2026-08-16T00:00:00.000Z",
    opportunity_id: payload.opportunity_id,
    program_title: payload.program_title,
    digest: { alg: "SHA-256", value: digestValue },
    payload,
  };
  return JSON.stringify(envelope);
}

export { canonicalize, digestPayload };
