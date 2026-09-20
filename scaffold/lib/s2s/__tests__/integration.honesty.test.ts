import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AssembledPackage } from "../../apply/package";
import type { AorAuthorization, SubmissionMeta, TransportKind } from "../types";
import { submitPackage } from "../client";
import { MockTransport } from "../transport";
import { toGrantApplicationXml, toSoapEnvelope } from "../xml";
// Reuse the EXACT check:prompts banned-phrasing definition (mirrors how
// lib/apply/draft.ts imports it) — not a parallel linter. This is the same
// dependency-free module `check-prompt-registry.mjs` re-exports.
import { findBannedPhrases } from "../../../scripts/banned-phrases.mjs";
import { ISO, OPP_ID, ORG_UEI, makeAuthorization } from "./_fixtures";

/**
 * WS-G / G6 · T-D — the cross-cutting integration + honesty-invariant capstone
 * eval (spec §0.4 T-D, §12/T6, §14, §15). This file does NOT introduce any new
 * behavior — it is a TEST-ONLY re-proof, over a realistic fixture and through
 * the real wired modules (`client.ts`, `xml.ts`, `transport.ts`), of the five
 * honesty invariants the frozen T-A/T-B/T-C modules already claim to hold:
 *
 *   - HR-4 — the CENTERPIECE: of the 12 `{flag on/off} × {authorized/not} ×
 *     {kind mock/sandbox/live}` cells, exactly ONE resolves — the rest throw —
 *     and no cell ever performs a network call / constructs a non-mock transport.
 *   - HR-1 — every gap in the fixture survives, visibly, all the way through
 *     the XML mapping AND the envelope actually handed to the transport; no
 *     fabricated value ever appears where the package had a gap.
 *   - HR-3 — the one receipt this can ever produce is honestly labeled mock.
 *   - HR-2 — G6's own mapping introduces no `BANNED_PHRASES` text. (Upstream
 *     G2 `lib/apply/draft.ts` and G5 `lib/apply/package.ts` already enforce
 *     grounding + banned-phrase refusal on the `AssembledPackage` before it
 *     ever reaches `lib/s2s` — spec §0.1, §10.7 — so G6 consumes already-honest
 *     input; this test proves the MAPPING layer adds nothing dishonest of its
 *     own, not that upstream refuses bad input.)
 *   - HR-6 — a source-scan over every non-test file under `lib/s2s` proves no
 *     production grants.gov host and no third-party-submit/AOR-authenticate
 *     operation name ever entered the wired path.
 *
 * Hermetic: static fixtures, no network, no model, no clock (spec §14).
 */

// ---------------------------------------------------------------------------
// A realistic fixture: grounded fields + `[you to provide: …]` gaps + an
// always-gap budget amount + an inline narrative gap + absent header ids.
// ---------------------------------------------------------------------------

const RICH_META: SubmissionMeta = {
  opportunity_id: OPP_ID,
  program_title: "Clean Water Infrastructure Grant",
  source_label: "grants.gov",
  agency: "Environmental Protection Agency",
  // cfda_number / competition_id intentionally ABSENT — the `Opportunity`
  // contract doesn't carry them (spec §9.3), so they must render as visible
  // gap markers, never invented numbers (HR-1).
};

const RICH_ASSEMBLED: AssembledPackage = {
  opportunity_id: OPP_ID,
  program_title: "Clean Water Infrastructure Grant",
  generated_at: ISO,
  narrativeStatus: "drafted",
  requirementsAvailable: true,
  narratives: [
    {
      key: "project_summary",
      title: "Project Summary",
      prompt: "Summarize the project.",
      draft_text:
        "Acme Water Labs builds decentralized water-treatment units for rural " +
        "municipalities. [you to provide: annual revenue] and has not yet " +
        "secured matching funds.",
      claims: [
        {
          text: "Acme Water Labs builds decentralized water-treatment units for rural municipalities.",
          profile_field: "raw_text",
        },
      ],
      gaps: [{ field_hint: "annual revenue", placeholder: "[you to provide: annual revenue]" }],
    },
  ],
  draftableSections: [],
  forms: {
    opportunity_id: OPP_ID,
    program_title: "Clean Water Infrastructure Grant",
    generated_at: ISO,
    forms: [
      {
        form_name: "SF-424",
        fields: [
          // Grounded: a real value, a named source, never a gap placeholder.
          {
            key: "uei",
            label: "Unique Entity Identifier (UEI)",
            status: "prefilled",
            value: ORG_UEI,
            display: ORG_UEI,
            source: "sam.uei",
          },
          {
            key: "org_name",
            label: "Organization Legal Name",
            status: "prefilled",
            value: "Acme Water Labs, Inc.",
            display: "Acme Water Labs, Inc.",
            source: "profile.legal_name",
          },
          // A gap: no value, no source, an honest [you to provide: …] display.
          {
            key: "project_title",
            label: "Project Title",
            status: "founder_to_provide",
            display: "[you to provide: project title]",
          },
        ],
      },
    ],
    gaps: ["[you to provide: project title]"],
  },
  budget: {
    generated_at: ISO,
    line_items: [
      {
        category: "personnel_salaries",
        label: "Personnel & Salaries",
        justification: "Salaries for the water-treatment engineering team.",
        justification_source: "template",
        source_quote: "",
        // ALWAYS a gap by G4's contract — a range bucket never yields an exact figure.
        amount: "[you to provide: personnel & salaries amount]",
      },
    ],
    total: {
      range_statement: "[you to provide: total budget range]",
      range_grounded: false,
      amount: "[you to provide: total budget amount]",
    },
    constraints: [],
    advisories: [],
    notes: [],
    gaps: [
      "[you to provide: personnel & salaries amount]",
      "[you to provide: total budget amount]",
    ],
  },
  checklist: { allRegistrationsSatisfied: false },
  gaps: [
    "[you to provide: annual revenue]",
    "[you to provide: project title]",
    "[you to provide: personnel & salaries amount]",
    "[you to provide: total budget amount]",
  ],
};

// ---------------------------------------------------------------------------
// HR-4 — THE HONESTY INVARIANT (the centerpiece)
// ---------------------------------------------------------------------------

describe("HR-4 — the honesty invariant (12-cell matrix)", () => {
  test("the only non-throwing cell is {flag on, authorized, mock}; every other cell rejects; the mock transport runs exactly once", async () => {
    const flags = [true, false];
    const authorizedStates = [true, false];
    const kinds: TransportKind[] = ["mock", "sandbox", "live"];

    // Spy on the ONLY transport G6 ever wires. If `submit` runs more than once,
    // or on anything but a `"mock"`-kind instance, the invariant is broken.
    const origSubmit = MockTransport.prototype.submit;
    let mockSubmitCalls = 0;
    const spy: typeof origSubmit = async function (this: MockTransport, envelope, cfg) {
      mockSubmitCalls += 1;
      assert.equal(this.kind, "mock", "submit only ever runs on the mock transport");
      return origSubmit.call(this, envelope, cfg);
    };
    MockTransport.prototype.submit = spy;

    let cellsRun = 0;
    try {
      for (const flag of flags) {
        for (const authorized of authorizedStates) {
          for (const kind of kinds) {
            cellsRun += 1;
            const isValidCell = flag && authorized && kind === "mock";
            const authorization: AorAuthorization | null = authorized ? makeAuthorization() : null;

            const call = submitPackage(RICH_ASSEMBLED, RICH_META, {
              transportKind: kind,
              authorization,
              // For the "authorized" arm, approve the legal gate too. This
              // isolates what actually refuses sandbox/live: HR-4 claims "even
              // with the flag on and a valid authorization, selectTransport
              // ('live'|'sandbox') throws" — i.e. the TRANSPORT layer itself is
              // the backstop, not merely the AOR gate's own non-mock clause. By
              // approving the legal gate here, a rejection in these cells can
              // only be coming from `selectTransport` (see the follow-up test).
              legalGate: { legalReviewApproved: authorized },
              configOverride: { g6_s2s_submission: flag ? "true" : "false" },
            });

            if (isValidCell) {
              const receipt = await call;
              assert.equal(receipt.is_mock, true);
              assert.equal(receipt.submitted_to, "MOCK");
            } else {
              await assert.rejects(
                call,
                `cell {flag:${flag}, authorized:${authorized}, kind:${kind}} must reject`,
              );
            }
          }
        }
      }
    } finally {
      MockTransport.prototype.submit = origSubmit;
    }

    assert.equal(cellsRun, 12, "the matrix must cover all 2×2×3 = 12 cells");
    assert.equal(mockSubmitCalls, 1, "MockTransport.submit ran in exactly the one valid cell");
  });

  test("even with the flag on and a valid, legally-approved authorization, sandbox/live refuse at the transport itself — submit never runs", async () => {
    const origSubmit = MockTransport.prototype.submit;
    let submitCalls = 0;
    const spy: typeof origSubmit = async function (this: MockTransport, envelope, cfg) {
      submitCalls += 1;
      return origSubmit.call(this, envelope, cfg);
    };
    MockTransport.prototype.submit = spy;

    try {
      for (const kind of ["sandbox", "live"] as TransportKind[]) {
        await assert.rejects(
          submitPackage(RICH_ASSEMBLED, RICH_META, {
            transportKind: kind,
            authorization: makeAuthorization(),
            legalGate: { legalReviewApproved: true },
            configOverride: { g6_s2s_submission: "true" },
          }),
          `kind=${kind} must reject even fully authorized`,
        );
      }
    } finally {
      MockTransport.prototype.submit = origSubmit;
    }

    assert.equal(submitCalls, 0, "no submit ever runs for a non-mock transport kind");
  });
});

// ---------------------------------------------------------------------------
// HR-1 — grounding preserved end-to-end (assemble → XML → the transported envelope)
// ---------------------------------------------------------------------------

describe("HR-1 — grounding preserved end-to-end; no fabrication where the package had a gap", () => {
  test("direct XML mapping: grounded values render intact; every gap renders a visible marker, never a plausible value", () => {
    const xml = toGrantApplicationXml(RICH_ASSEMBLED, RICH_META);

    // Grounded values ARE present, verbatim, with their named source.
    assert.ok(xml.includes(ORG_UEI), "grounded UEI is present");
    assert.ok(xml.includes("Acme Water Labs, Inc."), "grounded org name is present");
    assert.ok(/source="sam\.uei"/.test(xml), "the grounded UEI field names its source");

    // Absent header ids -> visible gap markers, never invented values.
    assert.ok(xml.includes("<!-- GAP: you to provide: CFDA number -->"));
    assert.ok(xml.includes("<!-- GAP: you to provide: competition id -->"));
    assert.ok(!xml.includes("<CFDANumber>"), "no (empty/invented) CFDANumber element");
    assert.ok(!xml.includes("<CompetitionID>"), "no (empty/invented) CompetitionID element");

    // The founder_to_provide form field -> gap marker, no source/value.
    assert.ok(xml.includes("[you to provide: project title]"));
    assert.ok(
      !xml.includes(`key="project_title"`) || !/project_title[^>]*source=/.test(xml),
      "the project_title field carries no source attribute",
    );

    // The inline narrative gap survives, visibly, after escaping.
    assert.ok(xml.includes("[you to provide: annual revenue]"));

    // Budget amounts are ALWAYS gaps (G4's contract) — never a number.
    assert.ok(xml.includes("[you to provide: personnel & salaries amount]"));
    assert.ok(xml.includes("[you to provide: total budget amount]"));
    const budgetSlice = xml.slice(xml.indexOf("<Budget>"), xml.indexOf("</Budget>"));
    assert.ok(!/\$\s*\d/.test(budgetSlice), "no $-amount anywhere in the budget section");
    assert.ok(!/<Amount>\s*\d/.test(budgetSlice), "no numeric <Amount> anywhere in the budget section");

    // Every entry in the package's own gap ledger is enumerated for the AOR.
    for (const gap of RICH_ASSEMBLED.gaps) {
      assert.ok(xml.includes(gap), `footer lists gap: ${gap}`);
    }
  });

  test("the mock submission path (submitPackage → MockTransport.submit) carries the SAME grounding through to the transported envelope", async () => {
    const origSubmit = MockTransport.prototype.submit;
    let capturedEnvelope: string | undefined;
    const spy: typeof origSubmit = async function (this: MockTransport, envelope, cfg) {
      capturedEnvelope = envelope;
      return origSubmit.call(this, envelope, cfg);
    };
    MockTransport.prototype.submit = spy;

    try {
      const receipt = await submitPackage(RICH_ASSEMBLED, RICH_META, {
        transportKind: "mock",
        authorization: makeAuthorization(),
        configOverride: { g6_s2s_submission: "true" },
      });
      assert.equal(receipt.is_mock, true);
    } finally {
      MockTransport.prototype.submit = origSubmit;
    }

    assert.ok(capturedEnvelope, "the envelope actually reached the transport");
    const envelope = capturedEnvelope as string;
    for (const gap of RICH_ASSEMBLED.gaps) {
      assert.ok(envelope.includes(gap), `transported envelope preserves gap: ${gap}`);
    }
    assert.ok(envelope.includes(ORG_UEI), "grounded UEI reaches the transported envelope");
    const budgetSlice = envelope.slice(envelope.indexOf("<Budget>"), envelope.indexOf("</Budget>"));
    assert.ok(!/\$\s*\d/.test(budgetSlice), "no fabricated $-amount reaches the transport");
  });
});

// ---------------------------------------------------------------------------
// HR-3 — never claims a real submission occurred
// ---------------------------------------------------------------------------

describe("HR-3 — every receipt is honestly labeled mock; nothing claims a real submission", () => {
  test("the receipt from the one valid cell carries is_mock:true, submitted_to:'MOCK', and the mock human_note", async () => {
    const receipt = await submitPackage(RICH_ASSEMBLED, RICH_META, {
      transportKind: "mock",
      authorization: makeAuthorization(),
      configOverride: { g6_s2s_submission: "true" },
    });

    assert.equal(receipt.is_mock, true);
    assert.equal(receipt.submitted_to, "MOCK");
    assert.match(receipt.human_note, /MOCK — nothing was submitted to any federal system\./);
    assert.match(receipt.tracking_id, /^MOCK-\d{4}$/, "tracking id is the mock format, never a real federal id");

    // No string anywhere on the receipt introduces banned/definitive phrasing
    // (ties HR-2 to the actual returned value, not just the XML).
    assert.deepEqual(findBannedPhrases(JSON.stringify(receipt)), []);
  });
});

// ---------------------------------------------------------------------------
// HR-2 — no banned eligibility/award/guarantee phrasing introduced by G6
// ---------------------------------------------------------------------------

describe("HR-2 — G6's own mapping introduces no BANNED_PHRASES", () => {
  // Upstream G2 (`lib/apply/draft.ts`) and G5 (`lib/apply/package.ts`) already
  // enforce grounding + banned-phrase refusal on the `AssembledPackage` BEFORE
  // it ever reaches `lib/s2s` (spec §0.1, §10.7) — G6 consumes that already-
  // validated output. This test proves the MAPPING layer (xml.ts's own strings:
  // element names, gap-marker prose, doc-comment blocks) introduces no banned
  // phrase of its own; it is not a re-test of the upstream refusal.
  test("the produced XML + SOAP envelope contain zero BANNED_PHRASES", () => {
    const xml = toGrantApplicationXml(RICH_ASSEMBLED, RICH_META);
    const envelope = toSoapEnvelope(xml, RICH_META);

    assert.deepEqual(findBannedPhrases(xml), []);
    assert.deepEqual(findBannedPhrases(envelope), []);
    assert.deepEqual(findBannedPhrases(`${xml}\n${envelope}`), []);
  });
});

// ---------------------------------------------------------------------------
// HR-6 — no forbidden symbol in the wired lib/s2s path
// ---------------------------------------------------------------------------

describe("HR-6 — no forbidden symbols in the wired lib/s2s path", () => {
  // Forbidden needles are built from string fragments so the exact banned
  // literals never appear verbatim in THIS file's own source — otherwise this
  // very test would trip its own scan (mirrors T-B's xml.test.ts / T-C's style).
  const PROD_HOST_WWW = "www" + "." + "grants" + "." + "gov";
  const PROD_HOST_API = "api" + "." + "grants" + "." + "gov";
  const AUTH_AOR = "Authenticate" + " AOR";
  const THIRD_PARTY = "Submit Application " + "As Third Party";

  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const S2S_DIR = join(__dirname, "..");

  /** Every non-`.test.ts` `.ts` file directly under `lib/s2s` (excludes `__tests__`). */
  function nonTestSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(...nonTestSourceFiles(full));
      } else if (extname(full) === ".ts" && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const files = nonTestSourceFiles(S2S_DIR);
  const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");

  test("the scan actually covers the wired modules (sanity — protects against a silently empty scan)", () => {
    assert.ok(files.length >= 6, `expected several lib/s2s modules, found ${files.length}`);
    for (const name of ["types.ts", "meta.ts", "xml.ts", "transport.ts", "authorize.ts", "client.ts"]) {
      assert.ok(files.some((f) => f.endsWith(`/${name}`)), `scan includes ${name}`);
    }
  });

  test("contains no production grants.gov host literal", () => {
    assert.ok(!combined.includes(PROD_HOST_WWW), "no www.grants.gov literal");
    assert.ok(!combined.includes(PROD_HOST_API), "no api.grants.gov literal");
    // Any authority/URL whose host is *.grants.gov. The honest UNVERIFIED
    // SCHEMA_VERSION tag ("grants.gov-apply/…") and the "urn:grants-gov:…" URN
    // are NOT hosts and deliberately do NOT match this pattern (no leading `//`).
    assert.ok(
      !/(?:https?:)?\/\/[a-z0-9.-]*grants\.gov/i.test(combined),
      "no //…grants.gov host literal anywhere in the wired path",
    );
  });

  test("contains neither the third-party-submit nor the AOR-authenticate operation name", () => {
    assert.ok(!combined.includes(AUTH_AOR), "no 'Authenticate AOR' operation name");
    assert.ok(!combined.includes(THIRD_PARTY), "no 'Submit Application As Third Party' operation name");
  });

  test("sandbox hosts / SCHEMA_VERSION / doc-comment mentions of grants.gov remain — proves the scan isn't vacuous", () => {
    assert.ok(combined.includes("training.grants.gov"), "sandbox allowlist host is present (allowed)");
    assert.ok(combined.includes("grants.gov-apply/UNVERIFIED"), "SCHEMA_VERSION tag is present (allowed)");
  });

  test("no network primitive appears anywhere in the wired path (defense-in-depth for 'no network call')", () => {
    assert.ok(!/\bfetch\s*\(/.test(combined), "no fetch(...) call");
    assert.ok(!combined.includes("XMLHttpRequest"));
    assert.ok(!/from\s+["']node:https?["']/.test(combined), "no node:http(s) import");
    assert.ok(!/require\(\s*["']https?["']\s*\)/.test(combined), "no require('http'/'https')");
  });
});
