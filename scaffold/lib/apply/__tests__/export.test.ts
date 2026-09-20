import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { AssembledPackage } from "../package";
import type { PrefilledForms } from "../../contracts/applicationForms";
import type { ApplicationBudget } from "../../contracts/applicationBudget";
import {
  canonicalize,
  sha256Hex,
  buildEnvelope,
  exportFileName,
  EXTENSION_EXPORT_COPY,
  type GrantedExportEnvelope,
} from "../export";
// Reuse the SAME check:prompts machinery — not a parallel linter.
import { findBannedPhrases } from "../../../scripts/check-prompt-registry.mjs";

/**
 * T7 — app-side export tests. Hermetic, NO network. Covers: (1) the canonical-
 * JSON serialization the extension's importer (T3) must byte-for-byte agree
 * with, (2) the envelope shape + digest correctness/round-trip, and (3) the
 * honesty invariants on the export copy, mirroring the discipline of
 * `package.test.ts`'s "honest copy invariants" suite.
 */

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  test("sorts object keys ascending, no spaces, arrays keep order (spec worked example)", () => {
    assert.equal(
      canonicalize({ b: 1, a: [3, 2], c: { x: true } }),
      '{"a":[3,2],"b":1,"c":{"x":true}}',
    );
  });

  test("primitives serialize via JSON.stringify", () => {
    assert.equal(canonicalize("hi"), '"hi"');
    assert.equal(canonicalize(42), "42");
    assert.equal(canonicalize(true), "true");
    assert.equal(canonicalize(null), "null");
  });

  test("nested arrays of objects canonicalize recursively, in array order", () => {
    assert.equal(
      canonicalize([{ z: 1, a: 2 }, { b: 3 }]),
      '[{"a":2,"z":1},{"b":3}]',
    );
  });

  test("a key with an undefined value is dropped, matching JSON.stringify's own object semantics", () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  });

  test("is deterministic regardless of input key insertion order", () => {
    const first = canonicalize({ z: 1, a: 2, m: 3 });
    const second = canonicalize({ a: 2, m: 3, z: 1 });
    assert.equal(first, second);
  });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  test("matches the well-known SHA-256 of the empty string", async () => {
    assert.equal(
      await sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("returns lowercase hex", async () => {
    const digest = await sha256Hex('{"a":1}');
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same input", async () => {
    const a = await sha256Hex('{"a":1,"b":2}');
    const b = await sha256Hex('{"a":1,"b":2}');
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// Fixture AssembledPackage (static, no builders/model — mirrors package.test.ts's
// fixture discipline, kept minimal since export.ts only re-serializes the shape).
// ---------------------------------------------------------------------------

function sampleForms(): PrefilledForms {
  return {
    opportunity_id: "opp-42",
    program_title: "Advanced Diagnostics for Rural Health",
    generated_at: "2026-08-01T00:00:00.000Z",
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
            key: "project_title",
            label: "Descriptive Title",
            status: "founder_to_provide",
            display: "[you to provide: project title]",
          },
        ],
      },
    ],
    gaps: ["[you to provide: project title]"],
  };
}

function sampleBudget(): ApplicationBudget {
  return {
    generated_at: "2026-08-01T00:00:00.000Z",
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
  };
}

function samplePackage(): AssembledPackage {
  return {
    opportunity_id: "opp-42",
    program_title: "Advanced Diagnostics for Rural Health",
    generated_at: "2026-08-01T00:00:00.000Z",
    narrativeStatus: "unavailable",
    narrativeNote: "The drafting model was busy — retry to add the narrative drafts.",
    requirementsAvailable: false,
    narratives: [],
    draftableSections: [],
    forms: sampleForms(),
    budget: sampleBudget(),
    checklist: { allRegistrationsSatisfied: false },
    gaps: ["[you to provide: project title]", "[you to provide: total budget amount]"],
  };
}

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

describe("buildEnvelope", () => {
  test("produces the exact envelope shape spec'd in §6.3", async () => {
    const pkg = samplePackage();
    const envelope = await buildEnvelope(pkg);

    assert.equal(envelope.format, "granted.autofill.package");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.opportunity_id, pkg.opportunity_id);
    assert.equal(envelope.program_title, pkg.program_title);
    assert.ok(!Number.isNaN(Date.parse(envelope.generated_at)), "generated_at must be a valid ISO timestamp");
    assert.deepEqual(envelope.payload, pkg);
    // `signature` is reserved but never populated under the current no-server-key constraint.
    assert.equal("signature" in envelope, false);
  });

  test("digest.alg is SHA-256 and digest.value is lowercase hex", async () => {
    const envelope = await buildEnvelope(samplePackage());
    assert.equal(envelope.digest.alg, "SHA-256");
    assert.match(envelope.digest.value, /^[0-9a-f]{64}$/);
  });

  test("digest.value equals sha256Hex(canonicalize(payload)) — the shared cross-package algorithm", async () => {
    const pkg = samplePackage();
    const envelope = await buildEnvelope(pkg);
    const expected = await sha256Hex(canonicalize(pkg));
    assert.equal(envelope.digest.value, expected);
  });

  test("round-trip: recomputing the digest from envelope.payload matches the stored digest", async () => {
    const envelope: GrantedExportEnvelope = await buildEnvelope(samplePackage());
    const recomputed = await sha256Hex(canonicalize(envelope.payload));
    assert.equal(recomputed, envelope.digest.value);
  });

  test("digest changes if the payload is tampered with (tamper-evidence)", async () => {
    const pkg = samplePackage();
    const envelope = await buildEnvelope(pkg);
    const tampered = { ...envelope.payload, program_title: "Something else entirely" };
    const tamperedDigest = await sha256Hex(canonicalize(tampered));
    assert.notEqual(tamperedDigest, envelope.digest.value);
  });
});

// ---------------------------------------------------------------------------
// exportFileName
// ---------------------------------------------------------------------------

describe("exportFileName", () => {
  test("ends in .granted.json and is derived from the opportunity id", () => {
    const name = exportFileName(samplePackage());
    assert.match(name, /\.granted\.json$/);
    assert.match(name, /opp-42/);
  });

  test("sanitizes an opportunity id with unsafe filename characters", () => {
    const pkg = { ...samplePackage(), opportunity_id: "grants.gov/HHS 2026:001" };
    const name = exportFileName(pkg);
    assert.doesNotMatch(name, /[/\\:\s]/);
    assert.match(name, /\.granted\.json$/);
  });
});

// ---------------------------------------------------------------------------
// Honest export copy (mirrors package.test.ts's "honest copy invariants")
// ---------------------------------------------------------------------------

/** Positive submission/eligibility CONFIRMATIONS the export copy must never state.
 *  Crafted NOT to match honest negations ("nothing is submitted"). */
const SUBMIT_CONFIRMATION_PATTERNS: RegExp[] = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
  /files? (it |the application )?for you/i,
];

describe("EXTENSION_EXPORT_COPY honesty", () => {
  const allCopy = [
    EXTENSION_EXPORT_COPY.eyebrow,
    EXTENSION_EXPORT_COPY.headline,
    EXTENSION_EXPORT_COPY.body,
    EXTENSION_EXPORT_COPY.downloadCta,
    EXTENSION_EXPORT_COPY.copyCta,
  ].join("  ");

  test("contains NO banned definitive-eligibility phrasing (reuses findBannedPhrases)", () => {
    assert.deepEqual(findBannedPhrases(allCopy), []);
  });

  test("contains NO submit/eligibility CONFIRMATION words", () => {
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      assert.doesNotMatch(allCopy, re, `copy unexpectedly matched ${re}`);
    }
  });

  test("states plainly that nothing is submitted and the human AOR still submits", () => {
    assert.match(EXTENSION_EXPORT_COPY.body, /never submits, signs, or files/i);
    assert.match(EXTENSION_EXPORT_COPY.body, /nothing here is submitted/i);
    assert.match(EXTENSION_EXPORT_COPY.body, /authorized organization representative/i);
  });
});
