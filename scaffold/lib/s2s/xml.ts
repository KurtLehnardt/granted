import type { AssembledPackage } from "../apply/package";
import type { SubmissionMeta } from "./types";
import type { PrefilledForm, PrefilledField } from "../contracts/applicationForms";
import type { DraftSection } from "../contracts/applicationDraft";
import type { BudgetLineItem, BudgetTotal } from "../contracts/applicationBudget";

/**
 * WS-G / G6 · T-B — deterministic `AssembledPackage` → grants.gov
 * application-XML + SOAP-envelope mapping.
 *
 * This module is PURE, model-free, and network-free: it is nothing but
 * string construction over an already-validated, already-grounded
 * `AssembledPackage` (spec §0.1). It calls no model, reads no clock, and has no
 * side effects — identical inputs yield a byte-identical result, so snapshots
 * are stable.
 *
 * ── The mapping shape is UNVERIFIED (memo §2, spec §9) ──────────────────────
 * The XML structure below reproduces the *documented shape as of the memo's
 * Aug-2026 retrieval window* — a legacy SOAP/XML S2S interface — and is
 * **treated as re-verify-required**. It is pinned behind {@link SCHEMA_VERSION}
 * (a deliberately honest, non-authoritative tag) so a schema change is
 * contained, and **no live path may use it until it is re-verified against the
 * current official grants.gov Forms Repository / S2S WSDLs.** G6 emits this
 * mapping ONLY into the mock transport, so a stale schema has zero live
 * consequence: nothing here is, or ever was, submitted to any federal system.
 *
 * ── Gap-preserving everywhere (HR-1, spec §9.2) ─────────────────────────────
 * Every value that cannot be grounded is rendered as a VISIBLE XML gap marker
 * (`<!-- GAP: … -->`), never as an empty-but-plausible value:
 *   - `cfda_number` / `competition_id` absent on the record → header gap marker;
 *   - a `founder_to_provide` form field → a gap marker naming the blank;
 *   - every budget amount (always a `[you to provide: …]` gap by G4's
 *     contract) → a gap marker, never a number;
 *   - inline `[you to provide: …]` in a narrative stays literal + visible;
 *   - the footer enumerates `assembled.gaps` so the human AOR sees exactly what
 *     is unfilled before they (the human) submit through the official portal.
 *
 * ── What is deliberately NOT here (NG-1, HR-6) ──────────────────────────────
 * No production `grants.gov` host/URL. No authenticated / third-party-submitter
 * branch and none of its operation names. G6 never builds that path.
 */

/**
 * The honest, non-authoritative version tag for this mapping. It intentionally
 * carries `UNVERIFIED` in its name so the tag itself announces the re-verify
 * requirement (memo §2): the shape is documented, not confirmed-current.
 */
export const SCHEMA_VERSION = "grants.gov-apply/UNVERIFIED-2026-08";

// ---------------------------------------------------------------------------
// Escaping + comment helpers (a tiny, correct escaper — no XML lib dependency)
// ---------------------------------------------------------------------------

/**
 * Escape the five XML metacharacters in text/attribute content. `&` MUST be
 * replaced first, otherwise the `&` introduced by the later replacements would
 * itself be double-escaped.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A single-line XML comment. XML forbids `--` inside a comment and forbids a
 * comment ending in `-`; gap hints are plain text and virtually never contain
 * either, but we sanitize defensively so any hint is safely embeddable.
 */
function xmlComment(body: string): string {
  const safe = body
    .replace(/-{2,}/g, "-") // no "--" run inside a comment
    .replace(/-+$/g, "") // never end the content on "-"
    .trim();
  return `<!-- ${safe} -->`;
}

/** A visible, human-readable gap marker (the XML-layer expression of HR-1). */
function gapMarker(detail: string): string {
  return xmlComment(`GAP: ${detail}`);
}

/** ` name="escaped"` when `value` is present, else `""` (never an empty attr). */
function attr(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeXml(value)}"`;
}

/** Indent every non-empty physical line of `block` by two spaces. */
function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

/**
 * Wrap `body` in `<name attrs>…</name>`, indenting the body; self-close when
 * empty. `attrs` (already a leading-space-prefixed string) is applied to the
 * OPENING tag only — the closing tag always uses the bare element name so the
 * result is well-formed.
 */
function element(name: string, attrs: string, body: string): string {
  if (body.length === 0) return `<${name}${attrs}/>`;
  return `<${name}${attrs}>\n${indent(body)}\n</${name}>`;
}

/** `element` with no attributes (the common case). */
function wrap(name: string, body: string): string {
  return element(name, "", body);
}

// ---------------------------------------------------------------------------
// Section renderers (stable iteration → stable snapshots)
// ---------------------------------------------------------------------------

/**
 * `GrantSubmissionHeader`. `OpportunityID` / `SubmissionTitle` / `SchemaVersion`
 * are always grounded; `CFDANumber` / `CompetitionID` / `Agency` are grounded
 * ONLY when the record carries them and are otherwise a VISIBLE gap marker —
 * never an empty-but-plausible element (HR-1, spec §9.3).
 */
function renderHeader(meta: SubmissionMeta): string {
  const lines: string[] = [];
  lines.push(`<OpportunityID>${escapeXml(meta.opportunity_id)}</OpportunityID>`);
  lines.push(
    meta.cfda_number !== undefined
      ? `<CFDANumber>${escapeXml(meta.cfda_number)}</CFDANumber>`
      : gapMarker("you to provide: CFDA number"),
  );
  lines.push(
    meta.competition_id !== undefined
      ? `<CompetitionID>${escapeXml(meta.competition_id)}</CompetitionID>`
      : gapMarker("you to provide: competition id"),
  );
  lines.push(
    meta.agency !== undefined
      ? `<Agency>${escapeXml(meta.agency)}</Agency>`
      : gapMarker("you to provide: awarding agency"),
  );
  lines.push(`<SubmissionTitle>${escapeXml(meta.program_title)}</SubmissionTitle>`);
  lines.push(`<SchemaVersion>${escapeXml(SCHEMA_VERSION)}</SchemaVersion>`);
  return wrap("GrantSubmissionHeader", lines.join("\n"));
}

/**
 * One SF-424 field. Grounded (`prefilled`) → its escaped value plus the `source`
 * attribute that names where it came from. A gap (`founder_to_provide`) → NO
 * value, NO source, just a visible marker built from the field's own
 * `[you to provide: …]` display (HR-1). Org identity (uei, org name, project
 * title, …) is exactly these fields — never a separate, invented org block.
 */
function renderField(field: PrefilledField): string {
  const open = `<Field${attr("key", field.key)}${attr("label", field.label)}`;
  if (field.status === "prefilled") {
    return `${open}${attr("source", field.source)}>${escapeXml(field.value ?? "")}</Field>`;
  }
  return `${open}>${gapMarker(`${field.label}: ${field.display}`)}</Field>`;
}

function renderForm(form: PrefilledForm): string {
  const body = form.fields.map(renderField).join("\n");
  return `<Form${attr("name", form.form_name)}>${
    body.length > 0 ? `\n${indent(body)}\n` : ""
  }</Form>`;
}

function renderForms(forms: PrefilledForm[]): string {
  return wrap("Forms", forms.map(renderForm).join("\n"));
}

/**
 * One narrative section. `draft_text` is escaped as text — its inline
 * `[you to provide: …]` placeholders survive escaping (`[` `]` `:` are not
 * XML metacharacters) so they stay visible, and we additionally emit a comment
 * enumerating the section's recorded gaps for the reviewer.
 */
function renderNarrative(section: DraftSection): string {
  const lines: string[] = [];
  lines.push(`<DraftText>${escapeXml(section.draft_text)}</DraftText>`);
  if (section.gaps.length > 0) {
    const list = section.gaps.map((g) => g.placeholder).join(", ");
    lines.push(xmlComment(`GAPS in this section: ${list}`));
  }
  return element(
    "Narrative",
    `${attr("key", section.key)}${attr("title", section.title)}`,
    lines.join("\n"),
  );
}

function renderNarratives(sections: DraftSection[]): string {
  return wrap("Narratives", sections.map(renderNarrative).join("\n"));
}

/**
 * One budget line item. `amount` is ALWAYS a `[you to provide: …]` gap by
 * G4's contract (an exact figure is not derivable from a coarse range bucket),
 * so it is rendered as a visible gap marker, NEVER a number. The grounded
 * justification prose is carried through, escaped.
 */
function renderLineItem(item: BudgetLineItem): string {
  const lines = [
    `<Amount>${gapMarker(`${item.label} amount: ${item.amount}`)}</Amount>`,
    `<Justification>${escapeXml(item.justification)}</Justification>`,
  ];
  return element(
    "LineItem",
    `${attr("category", item.category)}${attr("label", item.label)}`,
    lines.join("\n"),
  );
}

/** The SF-424 budget total — its `range_statement` (may itself be a gap) + the always-gap `amount`. */
function renderTotal(total: BudgetTotal): string {
  const lines = [
    `<RangeStatement>${escapeXml(total.range_statement)}</RangeStatement>`,
    `<Amount>${gapMarker(`total budget amount: ${total.amount}`)}</Amount>`,
  ];
  return wrap("Total", lines.join("\n"));
}

function renderBudget(budget: AssembledPackage["budget"]): string {
  const parts = budget.line_items.map(renderLineItem);
  parts.push(renderTotal(budget.total));
  return wrap("Budget", parts.join("\n"));
}

/**
 * `GrantSubmissionFooter` — the attachment/gap summary. It enumerates every
 * `assembled.gaps` entry (the deduped you-to-provide list) in a visible
 * comment so the human AOR sees exactly what is unfilled. Binary attachment
 * content is out of G6's scope (the user attaches real files at the official
 * portal); G6 emits references only, so the mock attachment count is zero.
 */
function renderFooter(assembled: AssembledPackage): string {
  const lines: string[] = [];
  lines.push(
    xmlComment(
      "Attachment/gap summary for the human AOR. Nothing here was submitted to any federal system.",
    ),
  );
  if (assembled.gaps.length > 0) {
    const enumerated = assembled.gaps
      .map((g) => `  - ${g.replace(/-{2,}/g, "-")}`)
      .join("\n");
    lines.push(
      `<!--\nGAP SUMMARY (${assembled.gaps.length} you-to-provide blank(s) to complete before your AOR submits):\n${enumerated}\n-->`,
    );
  } else {
    lines.push(xmlComment("GAP SUMMARY: none recorded."));
  }
  lines.push(`<AttachmentCount>0</AttachmentCount>`);
  return wrap("GrantSubmissionFooter", lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The leading doc comment on the application XML (states the re-verify gate). */
const APPLICATION_DOC_BLOCK = `<!--
  UNVERIFIED grants.gov application-XML mapping.
  This reproduces the memo's Aug-2026 DOCUMENTED structure and is
  RE-VERIFY-REQUIRED against the current official grants.gov Forms Repository /
  S2S WSDLs before any live path is ever scheduled (memo §2). G6 emits this ONLY
  into the mock transport; nothing here is or ever was submitted to any federal
  system. Every unground-able value is a VISIBLE gap marker, never a fabricated
  or empty-but-plausible value.
  SchemaVersion: ${SCHEMA_VERSION}
-->`;

/**
 * Map an assembled, grounded `AssembledPackage` (+ the `SubmissionMeta` derived
 * from the `Opportunity`) to a deterministic, XML-escaped, gap-preserving
 * grant application XML string. Pure and model-free; no `<?xml?>` prolog so the
 * result can be embedded verbatim inside a SOAP body by {@link toSoapEnvelope}.
 */
export function toGrantApplicationXml(
  assembled: AssembledPackage,
  meta: SubmissionMeta,
): string {
  const sections = [
    renderHeader(meta),
    renderForms(assembled.forms.forms),
    renderNarratives(assembled.narratives),
    renderBudget(assembled.budget),
    renderFooter(assembled),
  ].join("\n");
  return `${APPLICATION_DOC_BLOCK}\n<GrantApplication${attr(
    "schemaVersion",
    SCHEMA_VERSION,
  )}>\n${indent(sections)}\n</GrantApplication>`;
}

/** The leading doc comment on the SOAP envelope (states the re-verify gate + NG-1). */
const ENVELOPE_DOC_BLOCK = `<!--
  UNVERIFIED SOAP wrapper. The SOAP namespace, the request element, and its
  target namespace are PLACEHOLDER names, RE-VERIFY-REQUIRED against the current
  official grants.gov S2S WSDLs (memo §2) before any live path. G6 emits this
  ONLY into the mock transport: no production endpoint/URL, and no authenticated
  or third-party-submitter branch is ever built (NG-1).
-->`;

/**
 * Wrap an application XML string in a SOAP envelope. The SOAP namespace, the
 * request element, and its target namespace are deliberately UNVERIFIED
 * placeholders (`urn:grants-gov:apply:UNVERIFIED`) — re-verify-required (memo
 * §2). Crucially this includes NO production grants.gov host/URL and NEVER an
 * authenticated or third-party-submitter operation (NG-1, HR-6); G6 only ever
 * emits into the mock transport.
 */
export function toSoapEnvelope(applicationXml: string, meta: SubmissionMeta): string {
  const requestBody = [
    `<SubmissionTitle>${escapeXml(meta.program_title)}</SubmissionTitle>`,
    `<OpportunityID>${escapeXml(meta.opportunity_id)}</OpportunityID>`,
    `<SourceLabel>${escapeXml(meta.source_label)}</SourceLabel>`,
    applicationXml,
  ].join("\n");
  const request = element(
    "SubmitApplicationRequest",
    ` xmlns="urn:grants-gov:apply:UNVERIFIED"`,
    requestBody,
  );
  const inner = [
    "<soap:Header>",
    indent(xmlComment("No authentication token: G6 builds no authenticated branch (NG-1).")),
    "</soap:Header>",
    wrap("soap:Body", request),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${ENVELOPE_DOC_BLOCK}\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n${indent(
    inner,
  )}\n</soap:Envelope>`;
}
