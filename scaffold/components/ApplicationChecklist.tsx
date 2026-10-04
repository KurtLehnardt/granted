// Explicit React import: this file's JSX must transpile correctly both under
// Next's own build (automatic JSX runtime, doesn't need this) AND under the
// plain `tsx`-run node:test runner used by components/__tests__ (which falls
// back to the classic runtime per this repo's tsconfig `"jsx": "preserve"`,
// and needs `React` in scope to call React.createElement).
import React from "react";
import type { Match, Opportunity } from "@/lib/types";
import { FEDERAL_SOURCES } from "@/lib/contracts/opportunity";
import { isDeadlinePassed, isForecasted } from "@/lib/ui/opportunitySummary";

/**
 * D6 — Application Assistant checklist (honest, per-opportunity).
 *
 * This is the on-ramp to WS-G's real auto-fill work, not auto-fill itself.
 * It NEVER submits anything, NEVER claims a submission happened or a program
 * was "won," and NEVER fabricates user facts or an eligibility verdict
 * (R7.7 / §11). Everything below is either:
 *   (a) read straight off the selected `Opportunity` record (title, agency,
 *       dates, the agency's own eligibility prose, source URL), or
 *   (b) generic, clearly-labeled "typical for this kind of program" guidance
 *       that tells the user to confirm specifics on the official listing —
 *       never presented as a fact about *this* opportunity that we don't
 *       actually have, or
 *   (c) the match's own already-computed AI assessment (`whatToVerify` /
 *       `whatToDoNext`), labeled as coming from that assessment.
 */

/* ---------------------------------------------------------------------------
 * Pure data builders — no React, no DOM. Kept framework-agnostic and
 * exported individually so they're directly unit-testable (matching the
 * rest of this repo's test convention: plain node:test over pure functions).
 * ------------------------------------------------------------------------ */

export type KeyDateItem = { label: string; value: string | null };

/** Formats an ISO-ish date string for display; falls back to the raw string
 *  if it doesn't parse, and never fabricates a date that wasn't provided. */
function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Prefers the richer §3.4 `key_dates` (open/close/response) when present;
 * falls back to the legacy v1 `deadline` (+ `forecasted` flag) field so
 * cached/precomputed opportunities still show something. If neither is
 * present, returns a single honestly-empty "Deadline" row rather than
 * inventing one.
 */
export function buildKeyDates(opportunity: Opportunity): KeyDateItem[] {
  const items: KeyDateItem[] = [];
  const kd = opportunity.key_dates;
  if (kd?.open_date) items.push({ label: "Opens", value: formatDate(kd.open_date) });
  if (kd?.close_date) items.push({ label: "Closes", value: formatDate(kd.close_date) });
  if (kd?.response_date) items.push({ label: "Response due", value: formatDate(kd.response_date) });

  if (items.length === 0 && opportunity.deadline) {
    items.push({
      label: opportunity.forecasted ? "Forecasted deadline" : "Deadline",
      value: formatDate(opportunity.deadline) ?? opportunity.deadline,
    });
  }

  // No explicit deadline — say so honestly rather than inventing one.
  if (items.length === 0) {
    if (isForecasted(opportunity)) {
      items.push({ label: "Deadline", value: "Forecasted — not yet open for applications" });
    } else {
      items.push({ label: "Deadline", value: null });
    }
  }

  return items;
}

export const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);

/** This program's award/funding range, never fabricated when absent. */
export function buildFundingRange(opportunity: Opportunity): string | null {
  const low = opportunity.award_range?.floor ?? opportunity.fundingLow;
  const high = opportunity.award_range?.ceiling ?? opportunity.fundingHigh;
  const hasLow = typeof low === "number" && low > 0;
  const hasHigh = typeof high === "number" && high > 0;
  if (hasLow && hasHigh) return `${money(low!)}–${money(high!)}`;
  if (hasHigh) return `up to ${money(high!)}`;
  if (hasLow) return `${money(low!)}+`;
  return null;
}

// FEDERAL_SOURCES (imported above, from lib/contracts/opportunity.ts): sources
// whose apply path genuinely runs through SAM.gov/grants.gov-style federal
// registration (UEI, AOR, E-Biz POC) — state-grant portals (CA/IL CSFA/NC)
// have their own, different registration requirements (or none centrally at
// all, per their own listing), so this terminology would be actively wrong
// there, not just generic. Shared by the document checklist, the questions,
// and the next-steps below — every place in this file that otherwise
// assumed every opportunity is federal — AND by lib/eligibility/
// universalRules.ts's eligibility-screening engine, a sibling surface that
// independently had the same federal-only assumption baked in (see that
// file's own comment for the bug this single source of truth fixed).

const BASE_DOCUMENTS = [
  "SF-424 (Application for Federal Assistance) or the program's equivalent cover form",
  "Project or technical narrative describing what the funding would be used for",
  "Budget and budget narrative",
];

/** The organizational-documents line is the one BASE_DOCUMENTS item that
 *  names a specific registration system -- SAM.gov doesn't exist for a
 *  state grant, so this needs a source-aware alternative rather than one
 *  shared string. */
function registrationDocument(source: Opportunity["source"]): string {
  return FEDERAL_SOURCES.has(source)
    ? "Organizational documents (EIN letter, formation documents, SAM.gov registration summary)"
    : "Organizational documents (EIN letter, formation documents, state registration/incorporation summary)";
}

const KIND_DOCUMENTS: Partial<Record<Opportunity["kind"], string[]>> = {
  rd: [
    "Technical volume / research plan",
    "Commercialization or transition plan",
    "Key personnel bios and letters of commitment",
  ],
  procurement: ["Technical proposal", "Past performance references", "Pricing/cost proposal"],
  loan: ["Financial statements (2-3 years)", "Business plan", "Personal financial statement (if required)"],
  scholarship: ["Transcript or proof of enrollment", "Personal statement", "Letters of recommendation"],
  assistance: ["Statement of need", "Community or partner support letters"],
};

/**
 * Typical documents for this opportunity's `kind` — labeled as typical, not
 * asserted as this specific posting's actual requirements (we don't have
 * that granular a field on `Opportunity`). Always paired in the UI with a
 * "confirm on the official listing" instruction.
 */
export function buildDocumentChecklist(opportunity: Opportunity): string[] {
  const extra = KIND_DOCUMENTS[opportunity.kind] ?? [];
  return [...BASE_DOCUMENTS, registrationDocument(opportunity.source), ...extra];
}

/**
 * Prompts for the user to answer themselves — never an eligibility
 * verdict rendered by this app. When the opportunity record carries the
 * agency's own eligibility prose, we quote it back verbatim (real data, not
 * invented) and ask the user to self-assess against it.
 */
export function buildQuestions(opportunity: Opportunity): string[] {
  const questions: string[] = [];
  if (opportunity.eligibility?.trim()) {
    questions.push(
      `The listing states: "${opportunity.eligibility.trim()}" — in your own honest assessment, does your organization satisfy this?`,
    );
  }
  const fundingRange = buildFundingRange(opportunity);
  questions.push(
    `Have you re-checked ${opportunity.agency}'s official eligibility requirements on the current listing? This checklist doesn't determine eligibility for you.`,
    FEDERAL_SOURCES.has(opportunity.source)
      ? "Who is your organization's AOR, and have they reviewed this specific opportunity?"
      : "Who is authorized to sign and submit on your organization's behalf, and have they reviewed this specific opportunity?",
    "What outcome or deliverable would you propose, in one or two sentences?",
    fundingRange
      ? `What budget request fits within this program's funding range (${fundingRange}) and your actual project scope?`
      : "What budget request fits within the program's funding range and your actual project scope?",
  );
  return questions;
}

/** A next-step is rendered as parts: plain text interleaved with real links. */
export type StepPart = string | { text: string; href: string };
export type Step = StepPart[];

/** Textual content of a step, for tests and anywhere plain text is needed. */
export function stepText(step: Step): string {
  return step.map((p) => (typeof p === "string" ? p : p.text)).join("");
}

const isHttpUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/** A clickable link at the URL if it's http(s), else a plain-text fallback naming the source. */
function sourcePointer(opportunity: Opportunity, label: string): StepPart {
  return isHttpUrl(opportunity.url)
    ? { text: label, href: opportunity.url }
    : `the full listing (source: ${opportunity.source})`;
}

/** The apply-path step differs by *source*, not just kind. */
function sourceApplyStep(opportunity: Opportunity, now?: number): Step {
  switch (opportunity.source) {
    case "grants.gov": {
      const pointer = sourcePointer(opportunity, "this opportunity's page");
      const register = "Register on grants.gov (an Active SAM.gov registration + UEI are required)";
      if (isForecasted(opportunity)) {
        return [`${register}, then watch `, pointer, ` — it's forecasted and not yet open for applications.`];
      }
      if (opportunity.status === "closed") {
        return [`This listing is marked closed on grants.gov — check `, pointer, ` for a reissue or renewed solicitation before assuming it's still open.`];
      }
      if (isDeadlinePassed(opportunity, { now })) {
        const deadline = formatDate(opportunity.deadline);
        return [`Its listed deadline of ${deadline} has already passed — check `, pointer, ` for a reissue or renewed solicitation before assuming it's still open.`];
      }
      const deadline = formatDate(opportunity.deadline);
      return deadline
        ? [`${register}, then read and apply through `, pointer, ` before its deadline of ${deadline}.`]
        : [`${register}, then read and apply through `, pointer, `. No deadline is listed — confirm the application window on the listing.`];
    }
    case "sbir":
    case "sbir.gov": {
      const pointer = sourcePointer(opportunity, "the agency's solicitation page");
      const register = "Register in SAM.gov and on sbir.gov (most agencies require both before you can submit)";
      const deadline = formatDate(opportunity.deadline);
      return deadline
        ? [`${register}, then read and apply through `, pointer, ` before its deadline of ${deadline}.`]
        : [`${register}, then read and apply through `, pointer, `. No deadline is listed — confirm the submission window on the agency page.`];
    }
    case "assistance-listings":
    case "sam.gov": {
      // Many assistance listings are reached through a NOFO posted on grants.gov.
      const pointer = sourcePointer(opportunity, "this opportunity's page");
      return [
        `An assistance listing describes a program, not one fixed application — check for a current funding notice (often posted on grants.gov), or contact the program office at ${opportunity.agency} to ask how to apply. Details: `,
        pointer,
        `.`,
      ];
    }
    case "sam-contracts": {
      const pointer = sourcePointer(opportunity, "this opportunity's page");
      return [`Respond through SAM.gov Contract Opportunities, following ${opportunity.agency}'s solicitation instructions. Details: `, pointer, `.`];
    }
    case "ca-grants": {
      const pointer = sourcePointer(opportunity, "the official California Grants Portal listing");
      const deadline = formatDate(opportunity.deadline);
      return deadline
        ? [`Read the full program details on `, pointer, ` and apply directly with ${opportunity.agency} before its deadline of ${deadline}.`]
        : [`Read the full program details on `, pointer, ` and apply directly with ${opportunity.agency}. No deadline is listed — confirm the application window on the listing.`];
    }
    case "il-grants": {
      const pointer = sourcePointer(opportunity, "the official Illinois CSFA opportunity listing");
      return [`Read the full program details on `, pointer, ` and apply directly with ${opportunity.agency} (Illinois state grants are administered per-agency, often through AmpliFund).`];
    }
    case "nc-grants": {
      const pointer = sourcePointer(opportunity, "the program's official page");
      return [`This is a directory listing, not an application page — read the full program details on `, pointer, ` and contact ${opportunity.agency} directly to ask how to apply (North Carolina's grant directory doesn't list deadlines or amounts centrally).`];
    }
    case "agency-feed":
    default: {
      const pointer = sourcePointer(opportunity, "this opportunity's page");
      return [`Read the full opportunity listing at `, pointer, ` before drafting anything.`];
    }
  }
}

/** Ordered next actions. The LAST step always points to the opportunity's
 *  official portal, after the org's authorized signer (AOR, for a federal
 *  source) has reviewed the draft. */
export function buildNextSteps(match: Match, now?: number): Step[] {
  const opportunity = match.opportunity;
  const steps: Step[] = [];
  steps.push(sourceApplyStep(opportunity, now));
  if (match.whatToVerify?.trim()) {
    steps.push([`From your match assessment, before applying verify: ${match.whatToVerify.trim()}`]);
  }
  if (FEDERAL_SOURCES.has(opportunity.source)) {
    steps.push([
      "Make sure your SAM.gov registration is Active and your UEI, AOR, and E-Biz POC delegation are in place — most federal portals block submission without them.",
    ]);
  }
  steps.push(["Draft answers to the questions below and gather the documents listed."]);
  if (match.whatToDoNext?.trim()) {
    steps.push([`From your match assessment: ${match.whatToDoNext.trim()}`]);
  }
  steps.push([
    FEDERAL_SOURCES.has(opportunity.source)
      ? "Have your organization's AOR review the draft before anything is submitted."
      : "Have your organization's authorized signer review the draft before anything is submitted.",
  ]);
  steps.push([
    FEDERAL_SOURCES.has(opportunity.source)
      ? "Submit only through the opportunity's official portal (e.g., Grants.gov or SAM.gov)."
      : "Submit only through the opportunity's official portal, as named on the listing above.",
  ]);
  return steps;
}

/** Wraps a bare `Opportunity` as a placeholder `Match` for callers with no real scored match. */
export function opportunityOnlyMatch(opportunity: Opportunity): Match {
  return {
    opportunity,
    tier: "verify",
    score: 0,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
  };
}

export type ApplicationChecklistModel = {
  title: string;
  agency: string;
  fundingRange: string | null;
  keyDates: KeyDateItem[];
  documents: string[];
  questions: string[];
  nextSteps: Step[];
};

export function buildApplicationChecklist(match: Match, now?: number): ApplicationChecklistModel {
  const opportunity = match.opportunity;
  return {
    title: opportunity.title?.trim() || opportunity.program,
    agency: opportunity.agency,
    fundingRange: buildFundingRange(opportunity),
    keyDates: buildKeyDates(opportunity),
    documents: buildDocumentChecklist(opportunity),
    questions: buildQuestions(opportunity),
    nextSteps: buildNextSteps(match, now),
  };
}

/* ---------------------------------------------------------------------------
 * Presentational component
 * ------------------------------------------------------------------------ */

export default function ApplicationChecklist({ match }: { match: Match }) {
  const model = buildApplicationChecklist(match);

  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-1 font-display text-[18px] font-bold leading-snug text-foreground";
  const agencyClass = "font-body text-[12px] text-foreground";
  const sectionHeadingClass = "mt-4 font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const itemClass = "font-body text-[13px] leading-relaxed text-foreground";
  const mutedItemClass = "font-body text-[13px] italic leading-relaxed text-foreground";
  const linkClass =
    "text-structure-on-canvas underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <section aria-labelledby="application-checklist-heading" className="mt-4">
      <p className={eyebrowClass}>Preparation checklist</p>
      <h3 id="application-checklist-heading" className={titleClass}>
        {model.title}
      </h3>
      <p className={agencyClass}>
        {model.agency}
        {model.fundingRange && <> &middot; {model.fundingRange}</>}
      </p>

      <h4 className={sectionHeadingClass}>Key dates</h4>
      <ul className="mt-2 space-y-1">
        {model.keyDates.map((d) => (
          <li key={d.label} className={d.value ? itemClass : mutedItemClass}>
            {d.label}: {d.value ?? "Not listed — confirm on the official posting"}
          </li>
        ))}
      </ul>

      <h4 className={sectionHeadingClass}>Documents to prepare</h4>
      <p className={mutedItemClass}>Typical for this kind of opportunity — confirm exact requirements on the official listing.</p>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {model.documents.map((doc) => (
          <li key={doc} className={itemClass}>
            {doc}
          </li>
        ))}
      </ul>

      <h4 className={sectionHeadingClass}>Questions to answer</h4>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {model.questions.map((q) => (
          <li key={q} className={itemClass}>
            {q}
          </li>
        ))}
      </ul>

      <h4 className={sectionHeadingClass}>Next steps</h4>
      <ol className="mt-2 list-decimal space-y-1 pl-4">
        {model.nextSteps.map((step, i) => (
          <li key={i} className={itemClass}>
            {step.map((part, j) =>
              typeof part === "string" ? (
                <React.Fragment key={j}>{part}</React.Fragment>
              ) : (
                <a key={j} href={part.href} target="_blank" rel="noreferrer" className={linkClass}>
                  {part.text}
                </a>
              ),
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
