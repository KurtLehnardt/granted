import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AorAuthorizationSchema,
  SubmissionReceiptSchema,
  SubmissionStatusSchema,
  SubmissionMetaSchema,
} from "../types";

const ISO = "2026-08-16T12:00:00.000Z";

// ---------------------------------------------------------------------------
// AorAuthorization — an attestation, never a credential (§6.1, HR-4)
// ---------------------------------------------------------------------------

describe("AorAuthorizationSchema", () => {
  const valid = {
    org_uei: "ABC123DEF456",
    aor_name: "Jane Smith",
    attested: true as const,
    attested_at: ISO,
    scope: { opportunity_id: "OPP-1" },
  };

  test("accepts a well-formed attestation and defaults is_demo to true", () => {
    const parsed = AorAuthorizationSchema.parse(valid);
    assert.equal(parsed.attested, true);
    // is_demo is omitted above -> defaults true (G6 only produces demo auths).
    assert.equal(parsed.is_demo, true);
  });

  test("rejects attested:false — an unchecked box is the absence of authorization", () => {
    const res = AorAuthorizationSchema.safeParse({ ...valid, attested: false });
    assert.equal(res.success, false);
  });

  test("rejects a missing attested field (not merely a falsy one)", () => {
    const { attested: _omit, ...withoutAttested } = valid;
    const res = AorAuthorizationSchema.safeParse(withoutAttested);
    assert.equal(res.success, false);
  });

  test("requires org_uei, aor_name, attested_at, and scope.opportunity_id", () => {
    assert.equal(AorAuthorizationSchema.safeParse({ ...valid, org_uei: undefined }).success, false);
    assert.equal(AorAuthorizationSchema.safeParse({ ...valid, aor_name: undefined }).success, false);
    assert.equal(AorAuthorizationSchema.safeParse({ ...valid, attested_at: undefined }).success, false);
    assert.equal(AorAuthorizationSchema.safeParse({ ...valid, scope: {} }).success, false);
  });

  test("rejects a non-ISO attested_at timestamp", () => {
    assert.equal(AorAuthorizationSchema.safeParse({ ...valid, attested_at: "not-a-date" }).success, false);
  });
});

// ---------------------------------------------------------------------------
// SubmissionReceipt — always a MOCK (§8.2, HR-3)
// ---------------------------------------------------------------------------

describe("SubmissionReceiptSchema", () => {
  const valid = {
    tracking_id: "MOCK-0001",
    status: "MOCK_COMPLETE" as const,
    is_mock: true as const,
    submitted_to: "MOCK" as const,
    human_note: "MOCK — nothing was submitted to any federal system.",
    received_at: ISO,
  };

  test("accepts a well-formed mock receipt", () => {
    assert.doesNotThrow(() => SubmissionReceiptSchema.parse(valid));
  });

  test("rejects is_mock:false — G6 produces no non-mock receipt", () => {
    assert.equal(SubmissionReceiptSchema.safeParse({ ...valid, is_mock: false }).success, false);
  });

  test('rejects any submitted_to other than the literal "MOCK"', () => {
    assert.equal(SubmissionReceiptSchema.safeParse({ ...valid, submitted_to: "grants.gov" }).success, false);
    assert.equal(SubmissionReceiptSchema.safeParse({ ...valid, submitted_to: "LIVE" }).success, false);
  });

  test("rejects a status outside the mock lifecycle enum", () => {
    assert.equal(SubmissionReceiptSchema.safeParse({ ...valid, status: "SUBMITTED" }).success, false);
  });
});

// ---------------------------------------------------------------------------
// SubmissionStatus — mock-only convenience (§7)
// ---------------------------------------------------------------------------

describe("SubmissionStatusSchema", () => {
  test("accepts a well-formed mock status and rejects is_mock:false", () => {
    const valid = { tracking_id: "MOCK-0001", status: "RECEIVED" as const, is_mock: true as const, checked_at: ISO };
    assert.doesNotThrow(() => SubmissionStatusSchema.parse(valid));
    assert.equal(SubmissionStatusSchema.safeParse({ ...valid, is_mock: false }).success, false);
  });
});

// ---------------------------------------------------------------------------
// SubmissionMeta — optional ids may be absent, never fabricated (HR-1, §9.3)
// ---------------------------------------------------------------------------

describe("SubmissionMetaSchema", () => {
  test("accepts a meta with the optional ids absent", () => {
    const parsed = SubmissionMetaSchema.parse({
      opportunity_id: "OPP-1",
      program_title: "Some Program",
      source_label: "grants.gov",
    });
    assert.equal(parsed.agency, undefined);
    assert.equal(parsed.cfda_number, undefined);
    assert.equal(parsed.competition_id, undefined);
  });

  test("accepts the optional ids when present", () => {
    const parsed = SubmissionMetaSchema.parse({
      opportunity_id: "OPP-1",
      program_title: "Some Program",
      source_label: "grants.gov",
      agency: "DOE",
      cfda_number: "81.049",
      competition_id: "COMP-1",
    });
    assert.equal(parsed.cfda_number, "81.049");
    assert.equal(parsed.competition_id, "COMP-1");
  });

  test("requires opportunity_id, program_title, and source_label", () => {
    assert.equal(SubmissionMetaSchema.safeParse({ program_title: "x", source_label: "y" }).success, false);
  });
});
