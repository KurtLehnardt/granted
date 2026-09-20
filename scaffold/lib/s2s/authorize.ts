import { AorAuthorizationSchema } from "./types";
import type {
  AorAuthorization,
  AssembledPackage,
  LegalGate,
  SubmissionMeta,
  TransportKind,
} from "./types";

/**
 * WS-G / G6 · T-C — the AOR-authorization gate (pure, model-free, credential-free).
 *
 * This is the code embodiment of the memo's "human review-and-attest, the human is
 * the AOR" boundary (spec §6). It is NOT authentication and holds NO credentials —
 * an {@link AorAuthorization} records THAT a named human AOR of the org reviewed the
 * package and attested, scoped to one opportunity and timestamped. It is an
 * attestation check, not an auth check.
 *
 * The gate refuses (throws {@link SubmissionNotAuthorizedError}) unless every clause
 * below holds; it returns void on success. For any non-mock transport it
 * ADDITIONALLY requires the server-only legal-review gate — which, because G6 ships
 * no non-mock transport, is only ever reachable from tests with a fake transport
 * (exactly how the HR-4 invariant is proven, spec §6.2).
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown by {@link assertSubmissionAuthorized} when the AOR gate refuses. */
export class SubmissionNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionNotAuthorizedError";
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Assert that this (mock) submission is authorized, or throw
 * {@link SubmissionNotAuthorizedError}. Returns void on success. Holds NO
 * credentials — this is an attestation check, not authentication (spec §6.1).
 *
 * Throws unless ALL of:
 *   (1) `authorization` is non-null AND parses (`AorAuthorizationSchema.safeParse`),
 *       which already forces `attested === true` (a `z.literal(true)`) — an
 *       unchecked box is the ABSENCE of an authorization, not a `false` one;
 *   (2) `authorization.attested === true` (re-asserted explicitly as defense in
 *       depth, independent of the schema);
 *   (3) `authorization.org_uei` is non-empty;
 *   (4) `authorization.scope.opportunity_id === meta.opportunity_id`, and the two
 *       inputs agree (`assembled.opportunity_id === meta.opportunity_id`) — the
 *       attestation must be scoped to exactly the opportunity being submitted;
 *   (5) for `transportKind !== "mock"`: `gate.legalReviewApproved === true` (the
 *       server-only legal gate; unreachable in G6 since no non-mock transport ships).
 *
 * On the org UEI: the v4 shared input is {@link AssembledPackage}, which exposes no
 * single canonical org-UEI field to match against — the UEI lives inside the SF-424
 * form fields (`forms.forms[].fields[]`), where it may itself be a you-to-provide
 * gap. The gate therefore requires the attestation's `org_uei` to be present and
 * non-empty (the AOR names the org they are attesting for) rather than cross-matching
 * a package field that may not exist. This is the deliberate scoping of the old
 * §6.2 clause (1) onto the v4 `AssembledPackage` shape.
 */
export function assertSubmissionAuthorized(
  assembled: AssembledPackage,
  meta: SubmissionMeta,
  authorization: AorAuthorization | null,
  transportKind: TransportKind,
  gate: LegalGate,
): void {
  // (1) Must be present and structurally valid. safeParse forces attested === true.
  if (authorization === null) {
    throw new SubmissionNotAuthorizedError(
      "No AOR authorization on record: an unchecked attestation is the absence of authorization.",
    );
  }
  const parsed = AorAuthorizationSchema.safeParse(authorization);
  if (!parsed.success) {
    throw new SubmissionNotAuthorizedError(
      `AOR authorization is not a valid attestation record: ${parsed.error.message}`,
    );
  }
  const auth = parsed.data;

  // (2) Re-assert attestation explicitly (defense-in-depth, independent of schema).
  if (auth.attested !== true) {
    throw new SubmissionNotAuthorizedError("AOR authorization is not attested.");
  }

  // (3) The org UEI the AOR is attesting for must be present.
  if (auth.org_uei.trim().length === 0) {
    throw new SubmissionNotAuthorizedError("AOR authorization names no org UEI.");
  }

  // (4) The attestation must be scoped to exactly the opportunity being submitted,
  // and the two inputs must agree on which opportunity that is.
  if (assembled.opportunity_id !== meta.opportunity_id) {
    throw new SubmissionNotAuthorizedError(
      `Package/opportunity mismatch: assembled.opportunity_id ${JSON.stringify(
        assembled.opportunity_id,
      )} !== meta.opportunity_id ${JSON.stringify(meta.opportunity_id)}.`,
    );
  }
  if (auth.scope.opportunity_id !== meta.opportunity_id) {
    throw new SubmissionNotAuthorizedError(
      `AOR authorization is scoped to opportunity ${JSON.stringify(
        auth.scope.opportunity_id,
      )}, not the one being submitted (${JSON.stringify(meta.opportunity_id)}).`,
    );
  }

  // (5) Non-mock ADDITIONALLY requires the server-only legal-review gate. G6 ships
  // no non-mock transport, so this is only reachable via tests (HR-4 proof).
  if (transportKind !== "mock" && gate.legalReviewApproved !== true) {
    throw new SubmissionNotAuthorizedError(
      `Transport ${JSON.stringify(
        transportKind,
      )} requires legal-review approval (server-only gate), which is not granted.`,
    );
  }
}
