import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AssembledPackage } from "../../apply/package";
import type { SubmissionMeta } from "../types";
import { SCHEMA_VERSION, toGrantApplicationXml, toSoapEnvelope } from "../xml";

/**
 * T-B — deterministic `AssembledPackage` → grants.gov application-XML + SOAP
 * mapping. Hermetic: static fixtures, no network, no clock, no model.
 */

const ISO = "2026-08-16T12:00:00.000Z";

// A field value exercising ALL five XML metacharacters: & < > " '
const SPICY_VALUE = `O'Brien & Co "R&D" <Labs>`;

/**
 * SubmissionMeta with the optional ids ABSENT (cfda_number / competition_id) so
 * they must render as visible gap markers, plus a title carrying `& < > " '`.
 */
const meta: SubmissionMeta = {
  opportunity_id: "OPP-XYZ",
  program_title: `Clean & Green "Energy" <R&D> Program`,
  source_label: "grants.gov",
  agency: "Department of Energy",
  // cfda_number / competition_id intentionally undefined -> header gaps.
};

/**
 * A small but representative package: a grounded field + a `founder_to_provide`
 * field, a budget with gap amounts, and a narrative with an inline
 * `[you to provide: …]`.
 */
const assembled: AssembledPackage = {
  opportunity_id: "OPP-XYZ",
  program_title: "Clean Energy R&D Program",
  generated_at: ISO,
  narrativeStatus: "drafted",
  requirementsAvailable: true,
  narratives: [
    {
      key: "project_summary",
      title: "Project Summary",
      prompt: "Summarize the project.",
      draft_text:
        "We build clean-energy systems. [you to provide: annual revenue] & more.",
      claims: [],
      gaps: [
        { field_hint: "annual revenue", placeholder: "[you to provide: annual revenue]" },
      ],
    },
  ],
  draftableSections: [],
  forms: {
    opportunity_id: "OPP-XYZ",
    program_title: "Clean Energy R&D Program",
    generated_at: ISO,
    forms: [
      {
        form_name: "SF-424",
        fields: [
          {
            key: "uei",
            label: "Unique Entity Identifier (UEI)",
            status: "prefilled",
            value: "ABC123DEF456",
            display: "ABC123DEF456",
            source: "sam.uei",
          },
          {
            key: "org_name",
            label: "Organization Legal Name",
            status: "prefilled",
            value: SPICY_VALUE,
            display: SPICY_VALUE,
            source: "profile.legal_name",
          },
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
        justification: "Salaries for the R&D team.",
        justification_source: "use_of_funds",
        source_quote: "R&D team",
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
// (a) Deterministic — stable across two runs
// ---------------------------------------------------------------------------

describe("determinism", () => {
  test("toGrantApplicationXml is byte-identical across two runs", () => {
    assert.equal(toGrantApplicationXml(assembled, meta), toGrantApplicationXml(assembled, meta));
  });

  test("toSoapEnvelope is byte-identical across two runs", () => {
    const xml = toGrantApplicationXml(assembled, meta);
    assert.equal(toSoapEnvelope(xml, meta), toSoapEnvelope(xml, meta));
  });
});

// ---------------------------------------------------------------------------
// (b) XML escaping of & < > " '
// ---------------------------------------------------------------------------

describe("xml escaping", () => {
  const xml = toGrantApplicationXml(assembled, meta);

  test("escapes all five metacharacters in a grounded field value", () => {
    // O'Brien & Co "R&D" <Labs>  ->  fully entity-escaped
    assert.ok(xml.includes("&amp;"), "& -> &amp;");
    assert.ok(xml.includes("&lt;"), "< -> &lt;");
    assert.ok(xml.includes("&gt;"), "> -> &gt;");
    assert.ok(xml.includes("&quot;"), '" -> &quot;');
    assert.ok(xml.includes("&apos;"), "' -> &apos;");
    assert.ok(
      xml.includes(`O&apos;Brien &amp; Co &quot;R&amp;D&quot; &lt;Labs&gt;`),
      "the whole spicy value is escaped in place",
    );
  });

  test("no raw metacharacter from the value leaks as markup", () => {
    // The literal `<Labs>` would be a bogus element if escaping failed.
    assert.ok(!xml.includes("<Labs>"), "no raw <Labs> element");
    assert.ok(!xml.includes(SPICY_VALUE), "the raw unescaped value never appears");
  });
});

// ---------------------------------------------------------------------------
// (c) Gap-preserving: every gap is a VISIBLE marker, never an empty value
// ---------------------------------------------------------------------------

describe("gap preservation (HR-1)", () => {
  const xml = toGrantApplicationXml(assembled, meta);

  test("missing cfda_number / competition_id render as visible gap markers, not empty elements", () => {
    assert.ok(xml.includes("<!-- GAP: you to provide: CFDA number -->"));
    assert.ok(xml.includes("<!-- GAP: you to provide: competition id -->"));
    // Crucially: no empty-but-plausible element was emitted for either.
    assert.ok(!xml.includes("<CFDANumber>"), "no (empty) CFDANumber element");
    assert.ok(!xml.includes("<CompetitionID>"), "no (empty) CompetitionID element");
  });

  test("a founder_to_provide form field renders a gap marker, never a value/source", () => {
    assert.ok(
      xml.includes("<!-- GAP: Project Title: [you to provide: project title] -->"),
    );
    // The gap field carries no source attribute (nothing was grounded).
    assert.ok(
      !xml.includes(`key="project_title"`) || !/project_title[^>]*source=/.test(xml),
      "the project_title field has no source attribute",
    );
  });

  test("every budget amount renders a gap marker, never a number", () => {
    assert.ok(
      xml.includes(
        "<!-- GAP: Personnel & Salaries amount: [you to provide: personnel & salaries amount] -->",
      ),
    );
    assert.ok(
      xml.includes("<!-- GAP: total budget amount: [you to provide: total budget amount] -->"),
    );
    // No fabricated dollar figure anywhere in the budget section.
    const budget = xml.slice(xml.indexOf("<Budget>"), xml.indexOf("</Budget>"));
    assert.ok(!/\$\s*\d/.test(budget), "no $-amount");
    assert.ok(!/<Amount>\s*\d/.test(budget), "no numeric <Amount>");
  });

  test("an inline narrative [you to provide: …] stays visible after escaping", () => {
    assert.ok(xml.includes("[you to provide: annual revenue]"));
  });

  test("the footer enumerates every assembled.gaps entry for the AOR", () => {
    assert.ok(xml.includes("GAP SUMMARY"));
    for (const gap of assembled.gaps) {
      assert.ok(xml.includes(gap), `footer lists ${gap}`);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) SCHEMA_VERSION present + re-verify requirement named
// ---------------------------------------------------------------------------

describe("version pinning + re-verify honesty", () => {
  const xml = toGrantApplicationXml(assembled, meta);

  test("SCHEMA_VERSION is the honest UNVERIFIED tag and appears in the XML", () => {
    assert.equal(SCHEMA_VERSION, "grants.gov-apply/UNVERIFIED-2026-08");
    assert.ok(xml.includes(SCHEMA_VERSION));
    assert.ok(xml.includes("<SchemaVersion>grants.gov-apply/UNVERIFIED-2026-08</SchemaVersion>"));
  });

  test("the header doc block names the re-verify requirement + the WSDL/Forms Repository source", () => {
    assert.ok(/re-verif/i.test(xml), "states re-verify");
    assert.ok(/WSDL/i.test(xml) && /Forms Repository/i.test(xml), "names the authoritative source");
  });
});

// ---------------------------------------------------------------------------
// (e) Source-scan: no production grants.gov host; no NG-1 / HR-6 operations
// ---------------------------------------------------------------------------

describe("no production endpoint / no third-party-submit operation (HR-6)", () => {
  // Build the forbidden needles from fragments so the exact contiguous strings
  // never appear verbatim in this source file (avoids any future grep tripping).
  const AUTH_AOR = "Authenticate" + " AOR";
  const THIRD_PARTY = "Submit Application " + "As Third Party";

  const xml = toGrantApplicationXml(assembled, meta);
  const envelope = toSoapEnvelope(xml, meta);
  const combined = `${xml}\n${envelope}`;

  test("contains no production grants.gov host/URL", () => {
    assert.ok(!combined.includes("www.grants.gov"), "no www.grants.gov");
    assert.ok(!combined.includes("api.grants.gov"), "no api.grants.gov");
    // Any authority/URL whose host is *.grants.gov (the honest UNVERIFIED tag
    // `grants.gov-apply/…` and the `urn:grants-gov:…` URN are NOT hosts).
    assert.ok(
      !/(?:https?:)?\/\/[a-z0-9.-]*grants\.gov/i.test(combined),
      "no //…grants.gov host",
    );
  });

  test("contains neither third-party-submitter nor AOR-authentication operation names", () => {
    assert.ok(!combined.includes(AUTH_AOR), "no AOR-authenticate operation");
    assert.ok(!combined.includes(THIRD_PARTY), "no third-party-submit operation");
  });
});

// ---------------------------------------------------------------------------
// (f) toSoapEnvelope wraps the application XML inside soap:Body
// ---------------------------------------------------------------------------

describe("SOAP envelope", () => {
  const xml = toGrantApplicationXml(assembled, meta);
  const env = toSoapEnvelope(xml, meta);

  test("embeds the application XML inside <soap:Body>", () => {
    assert.ok(env.includes("<soap:Body>"));
    assert.ok(env.includes("</soap:Body>"));
    const bodyOpen = env.indexOf("<soap:Body>");
    const bodyClose = env.indexOf("</soap:Body>");
    const bodyInner = env.slice(bodyOpen, bodyClose);
    // The whole application document (root, schema version, a gap marker) is
    // nested inside the body — re-indented, but content-preserved.
    assert.ok(bodyInner.includes("<GrantApplication"), "app root inside body");
    assert.ok(bodyInner.includes("</GrantApplication>"), "app close inside body");
    assert.ok(
      bodyInner.includes("<SchemaVersion>grants.gov-apply/UNVERIFIED-2026-08</SchemaVersion>"),
      "schema version inside body",
    );
    assert.ok(
      bodyInner.includes("<!-- GAP: you to provide: CFDA number -->"),
      "gap markers preserved inside body",
    );
    // The app XML's own content is not lost to indentation: strip leading
    // whitespace on each side and confirm the app doc is a substring.
    const strip = (s: string) => s.replace(/^[ \t]+/gm, "");
    assert.ok(strip(env).includes(strip(xml)), "application XML content is embedded");
  });

  test("uses the UNVERIFIED placeholder request element + standard SOAP namespace", () => {
    assert.ok(env.includes(`xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"`));
    assert.ok(env.includes(`<SubmitApplicationRequest xmlns="urn:grants-gov:apply:UNVERIFIED">`));
  });

  test("carries exactly one XML prolog (the embedded app XML has none)", () => {
    assert.equal(env.indexOf("<?xml"), env.lastIndexOf("<?xml"));
  });
});
