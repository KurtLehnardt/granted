// Explicit React import: this file's JSX must transpile correctly both under
// Next's own build (automatic JSX runtime, doesn't need this) AND under the
// plain `tsx`-run node:test runner used by components/__tests__ (which falls
// back to the classic runtime per this repo's tsconfig `"jsx": "preserve"`,
// and needs `React` in scope to call React.createElement).
import React from "react";
import type { Opportunity } from "@/lib/types";

/**
 * D6 — Application Assistant checklist (honest, per-opportunity).
 *
 * This is the on-ramp to WS-G's real auto-fill work, not auto-fill itself.
 * It NEVER submits anything, NEVER claims a submission happened or a program
 * was "won," and NEVER fabricates founder facts or an eligibility verdict
 * (R7.7 / §11). Everything below is either:
 *   (a) read straight off the selected `Opportunity` record (title, agency,
 *       dates, the agency's own eligibility prose, source URL), or
 *   (b) generic, clearly-labeled "typical for this kind of program" guidance
 *       that tells the founder to confirm specifics on the official listing —
 *       never presented as a fact about *this* opportunity that we don't
 *       actually have.
 * The four SAM.gov / UEI / AOR / E-Biz registration facts are self-reported by
 * the founder elsewhere (lib/mockAuth.ts, unchanged by this file) — this
 * component only reads the already-computed `satisfied` map, it never invents
 * registration status.
 */

export type RequirementKey = "sam" | "uei" | "aor" | "ebiz";

export const REQUIREMENTS: Array<{ key: RequirementKey; label: string; detail: string }> = [
  {
    key: "sam",
    label: "Active SAM.gov registration",
    detail:
      "The federal government's vendor registry. It must be completed and show status “Active” — not just started — before you can apply or be paid. A brand-new registration can take up to ~2 weeks to finish, and it must be renewed every year.",
  },
  {
    key: "uei",
    label: "UEI (Unique Entity Identifier)",
    detail:
      "Your organization's 12-character federal ID, assigned when you begin a SAM.gov registration. Having a UEI alone is not enough — grant portals will reject it (“no organization matches this UEI”) until your SAM.gov registration is Active.",
  },
  {
    key: "aor",
    label: "Authorized AOR (Authorized Organization Representative)",
    detail: "The person SAM.gov has on file as allowed to submit and sign applications for your organization.",
  },
  {
    key: "ebiz",
    label: "E-Biz POC delegation",
    detail:
      "Your Electronic Business Point of Contact has delegated AOR authority in SAM.gov — required before an AOR can act.",
  },
];

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

  if (items.length === 0) {
    items.push({ label: "Deadline", value: null });
  }

  return items;
}

const BASE_DOCUMENTS = [
  "SF-424 (Application for Federal Assistance) or the program's equivalent cover form",
  "Project or technical narrative describing what the funding would be used for",
  "Budget and budget narrative",
  "Organizational documents (EIN letter, formation documents, SAM.gov registration summary)",
];

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
  return [...BASE_DOCUMENTS, ...extra];
}

/**
 * Prompts for the founder to answer themselves — never an eligibility
 * verdict rendered by this app. When the opportunity record carries the
 * agency's own eligibility prose, we quote it back verbatim (real data, not
 * invented) and ask the founder to self-assess against it.
 */
export function buildQuestions(opportunity: Opportunity): string[] {
  const questions: string[] = [];
  if (opportunity.eligibility?.trim()) {
    questions.push(
      `The listing states: "${opportunity.eligibility.trim()}" — in your own honest assessment, does your organization satisfy this?`,
    );
  }
  questions.push(
    `Have you re-checked ${opportunity.agency}'s official eligibility requirements on the current listing? This checklist doesn't determine eligibility for you.`,
    "Who is your organization's AOR, and have they reviewed this specific opportunity?",
    "What outcome or deliverable would you propose, in one or two sentences?",
    "What budget request fits within the program's funding range and your actual project scope?",
  );
  return questions;
}

/**
 * Ordered next actions. The LAST step always restates the honesty boundary:
 * this tool never submits anything — a human AOR does, through the official
 * portal.
 */
export function buildNextSteps(opportunity: Opportunity, allRegistrationsSatisfied: boolean): string[] {
  const steps: string[] = [];
  steps.push(
    opportunity.url
      ? `Read the full opportunity listing at ${opportunity.url} before drafting anything.`
      : `Locate the full opportunity listing (source: ${opportunity.source}) and read it before drafting anything.`,
  );
  steps.push(
    allRegistrationsSatisfied
      ? "Registrations below are marked satisfied — confirm they're still active/current in SAM.gov."
      : "Complete the registrations checklist below — most federal portals block submission without them.",
  );
  steps.push("Draft answers to the questions below and gather the documents listed.");
  steps.push("Have your organization's AOR review the draft before anything is submitted.");
  steps.push(
    "Submit only through the opportunity's official portal (e.g., Grants.gov or SAM.gov) — this checklist never submits anything on your behalf.",
  );
  return steps;
}

export type ApplicationChecklistModel = {
  title: string;
  agency: string;
  keyDates: KeyDateItem[];
  documents: string[];
  questions: string[];
  nextSteps: string[];
};

export function buildApplicationChecklist(
  opportunity: Opportunity,
  allRegistrationsSatisfied: boolean,
): ApplicationChecklistModel {
  return {
    title: opportunity.title?.trim() || opportunity.program,
    agency: opportunity.agency,
    keyDates: buildKeyDates(opportunity),
    documents: buildDocumentChecklist(opportunity),
    questions: buildQuestions(opportunity),
    nextSteps: buildNextSteps(opportunity, allRegistrationsSatisfied),
  };
}

/* ---------------------------------------------------------------------------
 * Presentational component
 * ------------------------------------------------------------------------ */

export default function ApplicationChecklist({
  opportunity,
  allRegistrationsSatisfied,
}: {
  opportunity: Opportunity;
  allRegistrationsSatisfied: boolean;
}) {
  const model = buildApplicationChecklist(opportunity, allRegistrationsSatisfied);

  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-1 font-display text-[18px] font-bold leading-snug text-foreground";
  const agencyClass = "font-body text-[12px] text-foreground";
  const sectionHeadingClass = "mt-4 font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const itemClass = "font-body text-[13px] leading-relaxed text-foreground";
  const mutedItemClass = "font-body text-[13px] italic leading-relaxed text-foreground";
  const footnoteClass =
    "mt-4 border-t border-structure-on-canvas pt-3 font-body text-[11px] leading-relaxed text-foreground";

  return (
    <section aria-labelledby="application-checklist-heading" className="mt-4">
      <p className={eyebrowClass}>Preparation checklist &middot; not a submission</p>
      <h3 id="application-checklist-heading" className={titleClass}>
        {model.title}
      </h3>
      <p className={agencyClass}>{model.agency}</p>

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
        {model.nextSteps.map((step) => (
          <li key={step} className={itemClass}>
            {step}
          </li>
        ))}
      </ol>

      <p className={footnoteClass}>
        This is a preparation checklist, not a submission. Nothing above is sent to SAM.gov, Grants.gov, or any
        agency, and it never determines eligibility for you. Final submission requires your organization&rsquo;s
        Authorized Organization Representative (AOR), acting through the opportunity&rsquo;s official portal.
      </p>
    </section>
  );
}
