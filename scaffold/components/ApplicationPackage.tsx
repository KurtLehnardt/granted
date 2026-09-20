"use client";

// Explicit React import: this file's JSX must transpile under BOTH Next's build
// (automatic runtime) AND the plain `tsx`-run node:test runner used by
// components/__tests__ (classic runtime per this repo's tsconfig
// `"jsx": "preserve"`, which needs `React` in scope). Mirrors ApplicationChecklist.tsx.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyGapInputs, gapFieldId, gapHint, USER_PROVIDED_SOURCE } from "@/lib/apply/fillGaps";
import { FIELD_HELP } from "@/lib/apply/fieldHelp";

import ApplicationChecklist from "@/components/ApplicationChecklist";
import type { Opportunity } from "@/lib/types";
import type { CompanyProfile } from "@/lib/contracts/companyProfile";
import type { AutoFillRequirements } from "@/lib/mockAuth";
import {
  AOR_HANDOFF,
  PACKAGE_INTRO,
  FOUNDER_TODO_SCAN,
  type AssembledPackage,
} from "@/lib/apply/package";
import { buildEnvelope, exportFileName, EXTENSION_EXPORT_COPY } from "@/lib/apply/export";
import { isFlagEnabled } from "@/lib/flags";
import type { DraftSection } from "@/lib/contracts/applicationDraft";
import type { PrefilledField } from "@/lib/contracts/applicationForms";
import type { BudgetLineItem } from "@/lib/contracts/applicationBudget";

/**
 * WS-G / G5 — the submission-READY application package view + hand-to-AOR flow.
 *
 * `<ApplicationPackage/>` (default, "use client") orchestrates the assembly by
 * POSTing to `/api/apply/package` (which runs G1→G2 server-side with the
 * server-only ANTHROPIC key, and G3→G4 deterministically) and renders the
 * result. `<ApplicationPackageView/>` (named) is the PURE presentational split
 * so the honesty invariants can be tested with a static fixture and no network.
 *
 * HONESTY (R7.7, consistent with AutoFillFlow.tsx): the tool drafted a
 * submission-ready DRAFT — nothing was submitted, no application was filed, and
 * final legal submission is the user's authorized AOR's. Every
 * `[you to provide: …]` blank is highlighted for the user to complete.
 * This view NEVER renders a "submitted"/"filed"/"won"/"approved" confirmation
 * and never asserts a definitive eligibility determination.
 */

// ---------------------------------------------------------------------------
// Shared token classes (60/30/10 design tokens — never raw hex, per check:hex)
// ---------------------------------------------------------------------------

const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
const sectionHeadingClass = "mt-6 font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
const titleClass = "font-display text-[20px] font-bold leading-snug text-foreground";
const subtitleClass = "mt-1 font-mono text-[12px] text-foreground";
const bodyClass = "font-body text-[14px] leading-relaxed text-foreground";
const mutedClass = "font-body text-[13px] italic leading-relaxed text-foreground";
const sourceNoteClass = "font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas";

/**
 * A highlighted `[you to provide: …]` blank. `warning` used as a FILLED chip
 * (dark `on-semantic` text on the fill) — the one AA-safe way to use a semantic
 * token per lib/design/tokens.ts. This is the single visual convention for every
 * gap across narratives, forms, and budget.
 */
function GapPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline rounded-sm bg-warning px-1.5 py-0.5 font-mono text-[12px] text-on-semantic">
      {children}
    </span>
  );
}

/**
 * An "ⓘ" tooltip explaining a field and where to find its value (native title +
 * aria-label, so it's discoverable on hover and to screen readers).
 */
function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="ml-1 inline-flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-structure-on-canvas align-middle font-mono text-[9px] lowercase text-structure-on-canvas"
      title={text}
      aria-label={text}
      role="img"
    >
      i
    </span>
  );
}

/**
 * Plain-English provenance for an auto-filled value — where it came from, not
 * the internal source key. Keeps the trust signal (this value wasn't invented)
 * without the "grounded · sam.uei" jargon a user filling a grant form would hit.
 */
function humanizeSource(source: string): string {
  if (source === USER_PROVIDED_SOURCE) return "you added this";
  if (source.startsWith("sam.")) return "from your SAM.gov details";
  if (source.startsWith("profile.")) return "from your profile";
  if (source.startsWith("opportunity.")) return "from this opportunity";
  return `from ${source}`;
}

function SourceNote({ source }: { source: string }) {
  return <span className={`ml-2 ${sourceNoteClass}`}>{humanizeSource(source)}</span>;
}

/**
 * Render prose with every inline `[you to provide: …]` occurrence wrapped in
 * a `<GapPill>`. A fresh RegExp is built per call so the shared global scanner's
 * `lastIndex` is never carried across renders.
 */
function renderWithGaps(text: string): React.ReactNode[] {
  const re = new RegExp(FOUNDER_TODO_SCAN.source, "g");
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<span key={`t${i}`}>{text.slice(last, m.index)}</span>);
    nodes.push(<GapPill key={`g${i}`}>{m[0]}</GapPill>);
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(<span key={`t${i}`}>{text.slice(last)}</span>);
  return nodes;
}

// ---------------------------------------------------------------------------
// (1) Grounded narratives
// ---------------------------------------------------------------------------

function NarrativeSectionView({ section }: { section: DraftSection }) {
  return (
    <article className="mt-4 rounded-md bg-canvas px-4 py-4">
      <h4 className="font-display text-[15px] font-semibold leading-snug text-foreground">{section.title}</h4>
      {section.prompt?.trim() && <p className={`mt-0.5 ${mutedClass}`}>{section.prompt}</p>}
      <p className={`mt-2 whitespace-pre-wrap ${bodyClass}`}>{renderWithGaps(section.draft_text)}</p>
      {section.claims.length > 0 && (
        <div className="mt-3">
          <p className={sourceNoteClass}>Sources</p>
          <ul className="mt-1 space-y-1">
            {section.claims.map((c, i) => (
              <li key={i} className="font-body text-[12px] leading-relaxed text-foreground">
                &ldquo;{c.text}&rdquo;
                <SourceNote source={`profile.${c.profile_field}`} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function NarrativesSection({
  pkg,
  onRetry,
}: {
  pkg: AssembledPackage;
  onRetry?: () => void;
}) {
  return (
    <section>
      <h3 className={sectionHeadingClass}>1 · Narrative drafts</h3>

      {pkg.narrativeStatus === "unavailable" ? (
        <div className="mt-3 rounded-md bg-canvas px-4 py-4">
          <p className={bodyClass}>
            {pkg.narrativeNote ??
              "The narrative drafts aren't available right now. Your forms, budget, and checklist below are ready."}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
            >
              Draft the narrative section
            </button>
          )}
        </div>
      ) : pkg.narratives.length > 0 ? (
        pkg.narratives.map((s) => <NarrativeSectionView key={s.key} section={s} />)
      ) : (
        <p className={`mt-3 ${mutedClass}`}>
          This program&rsquo;s announcement didn&rsquo;t specify distinct narrative sections to draft.
        </p>
      )}

      {pkg.draftableSections.length > 0 && (
        <p className={`mt-3 ${mutedClass}`}>
          {pkg.draftableSections.length} more required section
          {pkg.draftableSections.length === 1 ? "" : "s"} ({pkg.draftableSections.map((s) => s.title).join(", ")})
          {" "}are draftable on demand — kept undrafted here to keep model spend modest.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// (2) Pre-filled forms
// ---------------------------------------------------------------------------

function FormFieldView({
  field,
  inputValue,
  onInput,
}: {
  field: PrefilledField;
  inputValue?: string;
  onInput?: (value: string) => void;
}) {
  const isGap = field.status === "founder_to_provide";
  const filled = (inputValue ?? "").trim().length > 0;
  return (
    <li className="flex flex-col gap-0.5 border-t border-structure-on-canvas py-2 first:border-t-0">
      <span className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground">
        {field.label}
        {FIELD_HELP[field.key] && <InfoTip text={FIELD_HELP[field.key]} />}
      </span>
      {isGap ? (
        // A blank you fill in yourself. Your value flows into the exported
        // package (and the extension) clearly marked as YOUR input — never
        // presented as grounded data.
        <span className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={inputValue ?? ""}
            onChange={(e) => onInput?.(e.target.value)}
            placeholder={gapHint(field.display) || "your answer"}
            aria-label={field.label}
            className="min-w-0 flex-1 rounded-sm border border-structure-on-canvas bg-canvas px-2 py-1 font-body text-[13px] text-foreground outline-none focus:ring-2 focus:ring-structure-on-canvas"
          />
          <span className={sourceNoteClass}>{filled ? "you added" : "you provide"}</span>
        </span>
      ) : (
        <span className="font-body text-[13px] leading-relaxed text-foreground">
          {field.display}
          {field.source && <SourceNote source={field.source} />}
        </span>
      )}
    </li>
  );
}

function FormsSection({
  pkg,
  inputs,
  onInput,
}: {
  pkg: AssembledPackage;
  inputs: Record<string, string>;
  onInput: (id: string, value: string) => void;
}) {
  return (
    <section>
      <h3 className={sectionHeadingClass}>2 · Pre-filled forms</h3>
      <p className={`mt-1 ${mutedClass}`}>
        Pre-filled from your profile and this program&rsquo;s record — auto-filled values show where they
        came from; fill in any blank yourself and it&rsquo;s included in your export.
      </p>
      {pkg.forms.forms.map((form) => (
        <div key={form.form_name} className="mt-3 rounded-md bg-canvas px-4 py-2">
          <p className={sourceNoteClass}>{form.form_name}</p>
          <ul className="mt-1">
            {form.fields.map((f) => {
              const id = gapFieldId(form.form_name, f.key);
              return (
                <FormFieldView
                  key={f.key}
                  field={f}
                  inputValue={inputs[id]}
                  onInput={(v) => onInput(id, v)}
                />
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// (3) Budget
// ---------------------------------------------------------------------------

function BudgetLineItemView({ item }: { item: BudgetLineItem }) {
  return (
    <li className="border-t border-structure-on-canvas py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground">{item.label}</span>
        <GapPill>{item.amount}</GapPill>
      </div>
      <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
        {renderWithGaps(item.justification)}
      </p>
      {item.source_quote?.trim() && (
        <p className={`mt-0.5 ${mutedClass}`}>&ldquo;{item.source_quote}&rdquo;</p>
      )}
    </li>
  );
}

function BudgetSection({ pkg }: { pkg: AssembledPackage }) {
  const b = pkg.budget;
  return (
    <section>
      <h3 className={sectionHeadingClass}>3 · Budget</h3>
      <div className="mt-3 rounded-md bg-canvas px-4 py-2">
        <ul>
          {b.line_items.map((item) => (
            <BudgetLineItemView key={item.category} item={item} />
          ))}
        </ul>
      </div>

      <div className="mt-3 rounded-md bg-canvas px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground">Total</span>
          <GapPill>{b.total.amount}</GapPill>
        </div>
        <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
          {renderWithGaps(b.total.range_statement)}
        </p>
      </div>

      {b.constraints.length > 0 && (
        <div className="mt-3">
          <p className={sourceNoteClass}>Program budget rules to confirm</p>
          <ul className="mt-1 space-y-2">
            {b.constraints.map((c, i) => (
              <li key={i} className="border-l-2 border-structure-on-canvas pl-3">
                <p className="font-body text-[13px] leading-relaxed text-foreground">{c.rule}</p>
                {c.source_quote?.trim() && <p className={mutedClass}>&ldquo;{c.source_quote}&rdquo;</p>}
                <p className="mt-0.5 font-body text-[12px] leading-relaxed text-foreground">{c.note}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {b.advisories.length > 0 && (
        <ul className="mt-3 space-y-1">
          {b.advisories.map((a, i) => (
            <li key={i} className="border-l-2 border-warning pl-3 font-body text-[12px] italic leading-relaxed text-foreground">
              {a}
            </li>
          ))}
        </ul>
      )}

      {b.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {b.notes.map((n, i) => (
            <li key={i} className={mutedClass}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// (5) Gap summary
// ---------------------------------------------------------------------------

function GapSummarySection({ pkg }: { pkg: AssembledPackage }) {
  return (
    <section>
      <h3 className={sectionHeadingClass}>5 · What you need to provide</h3>
      {pkg.gaps.length > 0 ? (
        <>
          <p className={`mt-1 ${mutedClass}`}>
            {pkg.gaps.length} blank{pkg.gaps.length === 1 ? "" : "s"} across the narratives, forms, and budget —
            complete each before your AOR submits.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {pkg.gaps.map((g, i) => (
              <li key={i}>
                <GapPill>{g}</GapPill>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={`mt-1 ${bodyClass}`}>No outstanding blanks were detected in the deterministic parts.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// (6) Honest AOR hand-off
// ---------------------------------------------------------------------------

function AorHandoffSection() {
  return (
    <section className="mt-6 rounded-lg bg-structure px-5 py-5 text-token-white">
      <p className="font-mono text-[11px] uppercase tracking-eyebrow text-token-white">{AOR_HANDOFF.eyebrow}</p>
      <h3 className="mt-2 font-display text-[18px] font-bold leading-snug text-token-white">{AOR_HANDOFF.headline}</h3>
      <p className="mt-2 font-body text-[14px] leading-relaxed text-token-white">{AOR_HANDOFF.body}</p>
      <p className="mt-4 border-t border-token-white pt-3 font-mono text-[12px] uppercase tracking-eyebrow text-token-white">
        {AOR_HANDOFF.cta}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// (7) Export for the browser autofill extension (T7) — gated behind
// r6_export_autofill (default OFF). Client-side ONLY: re-serializes the
// AssembledPackage already rendered above into a signed .granted.json
// envelope (see lib/apply/export.ts). No fetch, no server route, nothing
// retained (northstar §5.3) — it is exactly the data already on this screen,
// repackaged for the user to hand to the browser extension themselves.
// ---------------------------------------------------------------------------

type ExportStatus = "idle" | "working" | "downloaded" | "error";
type CopyStatus = "idle" | "copied" | "error";

function ExportForExtensionSection({ pkg }: { pkg: AssembledPackage }) {
  const [downloadStatus, setDownloadStatus] = useState<ExportStatus>("idle");
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  const handleDownload = useCallback(async () => {
    setDownloadStatus("working");
    try {
      const envelope = await buildEnvelope(pkg);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = exportFileName(pkg);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } finally {
        URL.revokeObjectURL(url);
      }
      setDownloadStatus("downloaded");
    } catch {
      setDownloadStatus("error");
    }
  }, [pkg]);

  const handleCopy = useCallback(async () => {
    try {
      const envelope = await buildEnvelope(pkg);
      await navigator.clipboard.writeText(JSON.stringify(envelope));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }, [pkg]);

  return (
    <section className="mt-6 rounded-lg bg-canvas px-5 py-5">
      <p className={eyebrowClass}>{EXTENSION_EXPORT_COPY.eyebrow}</p>
      <h3 className="mt-1 font-display text-[16px] font-bold leading-snug text-foreground">
        {EXTENSION_EXPORT_COPY.headline}
      </h3>
      <p className={`mt-2 ${bodyClass}`}>{EXTENSION_EXPORT_COPY.body}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleDownload}
          className="rounded-sm bg-action px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-token-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
        >
          {downloadStatus === "working" ? "Preparing…" : EXTENSION_EXPORT_COPY.downloadCta}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
        >
          {copyStatus === "copied" ? "Copied" : EXTENSION_EXPORT_COPY.copyCta}
        </button>
        {downloadStatus === "downloaded" && (
          <span className={sourceNoteClass} aria-live="polite">
            Saved to your browser&rsquo;s Downloads folder. Next: open the Granted extension &rarr;
            &ldquo;Choose a .granted.json file&rdquo; and pick it. Nothing was submitted or sent anywhere.
          </span>
        )}
        {downloadStatus === "error" && (
          <span className={sourceNoteClass} aria-live="polite">
            Couldn&rsquo;t prepare the export — please try again.
          </span>
        )}
        {copyStatus === "error" && (
          <span className={sourceNoteClass} aria-live="polite">
            Couldn&rsquo;t copy to clipboard — please try again.
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pure view
// ---------------------------------------------------------------------------

export function ApplicationPackageView({
  pkg,
  opportunity,
  onRetry,
  onClose,
}: {
  pkg: AssembledPackage;
  opportunity: Opportunity;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  // In-app fills for the FORM gaps (id → value). `editedPkg` folds them into the
  // package — as user-sourced prefilled fields, with the gap lists recomputed —
  // for the gap summary and the export, while FormsSection renders the ORIGINAL
  // gaps as inputs so they stay editable.
  const [gapInputs, setGapInputs] = useState<Record<string, string>>({});
  const onGapInput = useCallback(
    (id: string, value: string) => setGapInputs((prev) => ({ ...prev, [id]: value })),
    [],
  );
  const editedPkg = useMemo(() => applyGapInputs(pkg, gapInputs), [pkg, gapInputs]);

  return (
    <div className="mt-4">
      <p className={eyebrowClass}>{PACKAGE_INTRO.eyebrow}</p>
      <h2 className={`mt-1 ${titleClass}`}>{pkg.program_title}</h2>
      <p className={subtitleClass}>{opportunity.agency}</p>
      <p className={`mt-2 ${mutedClass}`}>{PACKAGE_INTRO.note}</p>

      <NarrativesSection pkg={pkg} onRetry={onRetry} />
      <FormsSection pkg={pkg} inputs={gapInputs} onInput={onGapInput} />
      <BudgetSection pkg={pkg} />

      <section>
        <h3 className={sectionHeadingClass}>4 · Preparation checklist</h3>
        <ApplicationChecklist
          opportunity={opportunity}
          allRegistrationsSatisfied={pkg.checklist.allRegistrationsSatisfied}
        />
      </section>

      <GapSummarySection pkg={editedPkg} />
      <AorHandoffSection />
      {isFlagEnabled("r6_export_autofill") && <ExportForExtensionSection pkg={editedPkg} />}

      {onClose && (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch container
// ---------------------------------------------------------------------------

type FetchState =
  | { status: "loading"; drafting?: boolean }
  | { status: "ready"; pkg: AssembledPackage }
  | { status: "error"; message: string };

/**
 * Client container: assembles the package by POSTing to the server route (which
 * holds the ANTHROPIC key) and renders `<ApplicationPackageView/>`. On a fetch
 * failure it shows an honest error + retry; the server itself already degrades
 * gracefully (deterministic parts + `narrativeStatus: "unavailable"`) rather
 * than erroring on a model overload, so a "ready" package is always renderable.
 */
export default function ApplicationPackage({
  opportunity,
  profile,
  autoFillReqs,
  onClose,
}: {
  opportunity: Opportunity;
  profile: CompanyProfile;
  autoFillReqs: AutoFillRequirements;
  onClose?: () => void;
}) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Tracks the in-flight assembly so a re-click ("Draft the narrative section"
  // again) or leaving the screen ("back to requirements") CANCELS it. Without
  // this, a serial local model queues duplicate/abandoned draft jobs and the new
  // request waits behind work nobody is looking at anymore.
  const abortRef = useRef<AbortController | null>(null);

  const assemble = useCallback(async (opts?: { draftNarrative?: boolean }) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ status: "loading", drafting: opts?.draftNarrative === true });
    try {
      const res = await fetch("/api/apply/package", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // draftNarrative is opt-in: the initial assemble omits it (instant on a
        // local model — the slow narrative step is skipped server-side), and the
        // "Draft the narrative section" button sets it to run the draft on demand.
        body: JSON.stringify({ opportunity, profile, autoFillReqs, draftNarrative: opts?.draftNarrative === true }),
        signal: ac.signal,
      });
      if (!res.ok) {
        setState({
          status: "error",
          message: "We couldn't assemble your package just now. Please try again.",
        });
        return;
      }
      const data = await res.json();
      if (!data?.package) {
        setState({ status: "error", message: "The package came back empty. Please try again." });
        return;
      }
      setState({ status: "ready", pkg: data.package as AssembledPackage });
    } catch {
      // A superseded/abandoned request (aborted by a new assemble or by unmount)
      // is intentional — leave the state to whoever aborted it. Only a real
      // failure surfaces an error.
      if (ac.signal.aborted) return;
      setState({ status: "error", message: "We couldn't reach the assembly service. Please try again." });
    }
  }, [opportunity, profile, autoFillReqs]);

  useEffect(() => {
    assemble();
    // Cancel the in-flight assembly if the user leaves this screen (e.g.
    // "back to requirements") so the local model isn't left drafting for a view
    // that's gone.
    return () => abortRef.current?.abort();
  }, [assemble]);

  if (state.status === "loading") {
    return (
      <div className="mt-4">
        <p className={eyebrowClass}>{PACKAGE_INTRO.eyebrow}</p>
        <p className={`mt-2 ${bodyClass}`} aria-live="polite">
          {state.drafting
            ? "Drafting the narrative section with your model — this can take a minute or two on a local model. The page updates on its own when it's done, so you can leave it open. Nothing is submitted."
            : "Assembling your submission-ready draft — pre-filling forms, building the budget, and preparing the checklist… Nothing is submitted."}
        </p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-4">
        <p className={eyebrowClass}>{PACKAGE_INTRO.eyebrow}</p>
        <p className={`mt-2 ${bodyClass}`}>{state.message}</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => assemble()}
            className="rounded-sm bg-action px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-token-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
          >
            Try again
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <ApplicationPackageView
      pkg={state.pkg}
      opportunity={opportunity}
      onRetry={() => assemble({ draftNarrative: true })}
      onClose={onClose}
    />
  );
}
