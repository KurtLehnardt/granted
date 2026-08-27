"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getAutoFillRequirements,
  setAutoFillRequirements,
  type AutoFillRequirements,
} from "@/lib/mockAuth";
import { useAuth } from "@/components/AuthProvider";
import { useBilling } from "@/components/BillingProvider";
import { useDialogA11y } from "@/components/useDialogA11y";
import { useEntitlements } from "@/lib/entitlements/useEntitlements";
import ApplicationChecklist, { REQUIREMENTS, type RequirementKey } from "@/components/ApplicationChecklist";
import ApplicationPackage from "@/components/ApplicationPackage";
import type { Opportunity } from "@/lib/types";
import type { CompanyProfile } from "@/lib/contracts/companyProfile";

/**
 * R6 / D6 — assisted-apply Application Assistant (behind the default-off
 * `r6_auto_fill` flag).
 *
 * A single, walkable modal stepper that shows founders what pre-approval for
 * assisted application actually requires, plus (D6) an honest, per-opportunity
 * PREPARATION CHECKLIST when a specific `opportunity` is passed in:
 *   1. Sign in (R9)      — the same sign-in gate the rest of the app uses.
 *   2. Requirements      — record the four SAM.gov facts + a satisfied/not
 *                          checklist; "Submit for approval" is disabled until
 *                          all four are satisfied. When `opportunity` is
 *                          provided, this step ALSO renders that opportunity's
 *                          key dates / documents / questions / next steps
 *                          (see components/ApplicationChecklist.tsx) above the
 *                          registration checklist.
 *   3. Admin review      — an honest "pending" screen. Nothing was submitted.
 *
 * This is a PREVIEW / STUB, and it is honest about it (R7.7 / §11):
 *   - It NEVER submits an application, and says so on every step.
 *   - It NEVER claims to have submitted anything or won an award.
 *   - It NEVER fabricates founder facts or an eligibility verdict — the
 *     per-opportunity checklist only reflects data already on the
 *     `Opportunity` record (title, agency, dates, the agency's own
 *     eligibility prose) or generic, clearly-labeled "typical" guidance that
 *     tells the founder to confirm specifics on the official listing.
 *   - No payment is taken, no stats are invented, no guarantee or federal
 *     affiliation is implied.
 *   - "Pro" is framing only, via the client-only `useEntitlements` stub, which
 *     gates NOTHING server-side. The walkthrough proceeds regardless.
 *
 * `opportunity` is OPTIONAL and additive: when the caller doesn't pass one
 * (today's only call site, components/OpportunityCard.tsx, doesn't — wiring
 * that up is out of D6's file scope), this component renders exactly as it
 * did before D6 — the per-opportunity checklist section simply doesn't
 * render. Passing `opportunity={m.opportunity}` from OpportunityCard is the
 * trivial follow-up that lights this up end-to-end.
 *
 * Reuse note: the four-fact editor is the SAME form as SettingsPanel, reused
 * INLINE here rather than by rendering <SettingsPanel/> nested. SettingsPanel
 * is itself a full dialog with its own `useDialogA11y` focus-trap + `aria-modal`
 * backdrop; mounting it inside this dialog would put two simultaneous focus
 * traps and two `aria-modal` dialogs over the same document (Esc/Tab handlers
 * would fight, and Esc in Settings would tear down the whole flow). The app
 * never stacks two dialogs — AutoFillModal closes itself before opening
 * Settings. So per the task's sanctioned escape hatch we keep ONE dialog and
 * one focus trap, reading/writing the same `getAutoFillRequirements` /
 * `setAutoFillRequirements` from lib/mockAuth.ts that SettingsPanel uses.
 */

type Step = "signin" | "requirements" | "review";

const STEP_ORDER: Step[] = ["signin", "requirements", "review"];

export default function AutoFillFlow({
  onClose,
  opportunity,
  profile,
}: {
  onClose: () => void;
  /** D6: the selected opportunity to build a per-opportunity checklist for.
   *  Optional — omit for the pre-D6 generic registration-only flow. */
  opportunity?: Opportunity;
  /** G5: the founder's §3.1 CompanyProfile. When BOTH this and `opportunity` are
   *  present, a "Draft my application" action assembles the submission-ready
   *  package (components/ApplicationPackage.tsx). Absent → the pre-G5 flow is
   *  unchanged; an absent profile is never fabricated. */
  profile?: CompanyProfile;
}) {
  // Design revamp: USWDS 60/30/10 restyle is the DEFAULT on this A/B branch
  // (previously gated behind r7_design).
  const design = true;
  const { user, signIn } = useAuth();
  // Pro *framing* only — this gates nothing and entitles nothing (see the stub).
  // Source the tier from the reactive BillingProvider context (single source of
  // truth) so this framing stays in lockstep with the OpportunityCard padlocks.
  const { tier: billingTier } = useBilling();
  const entitlements = useEntitlements(billingTier);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogA11y(dialogRef, onClose, closeBtnRef);

  // Already-signed-in users skip straight to the requirements step.
  const [step, setStep] = useState<Step>(user ? "requirements" : "signin");
  const [form, setForm] = useState<AutoFillRequirements>(() => getAutoFillRequirements());
  const [saved, setSaved] = useState(false);

  // G5: "Draft my application" is offered only when we have BOTH the selected
  // opportunity and the founder's CompanyProfile. When shown, the assembled
  // package renders INSIDE this same dialog (replacing the stepper body) so
  // there is only ever one focus-trap / aria-modal over the document — the same
  // single-dialog rule the header note documents for Settings.
  const canDraft = Boolean(opportunity && profile);
  const [showPackage, setShowPackage] = useState(false);

  // Auto-advance past sign-in as soon as a user is present. For the mock this
  // is instant (signIn resolves synchronously); for real Supabase auth the
  // browser leaves for Google and returns via /auth/callback — on return a
  // signed-in user resumes past this step.
  useEffect(() => {
    if (user && step === "signin") setStep("requirements");
  }, [user, step]);

  const satisfied: Record<RequirementKey, boolean> = {
    sam: form.samRegistered,
    uei: form.uei.trim().length > 0,
    aor: form.aorOnFile || form.aorName.trim().length > 0,
    ebiz: form.eBizPocOnFile,
  };
  const allSatisfied = satisfied.sam && satisfied.uei && satisfied.aor && satisfied.ebiz;

  function update<K extends keyof AutoFillRequirements>(key: K, value: AutoFillRequirements[K]) {
    setSaved(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSaveRequirements(e: React.FormEvent) {
    e.preventDefault();
    // Device-local only (lib/mockAuth.ts) — never sent to a server.
    setAutoFillRequirements(form);
    setSaved(true);
  }

  function handleSubmitForApproval() {
    // Persist the self-reported facts locally, then show the honest "pending"
    // screen. This DOES NOT submit an application anywhere.
    setAutoFillRequirements(form);
    setStep("review");
  }

  const stepIndex = STEP_ORDER.indexOf(step);

  /* ---- Shared dual-className tokens (mirrors AutoFillModal / SettingsPanel) ---- */

  const panelClass = design
    ? "relative max-h-[85vh] w-full max-w-lg overflow-y-auto border border-structure-on-canvas bg-canvas p-6 text-foreground"
    : "relative max-h-[85vh] w-full max-w-lg overflow-y-auto border border-rule bg-white p-6 text-ink";

  const eyebrowClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas"
    : "eyebrow";

  const titleClass = design
    ? "mt-2 font-display text-[24px] font-bold leading-snug text-foreground"
    : "mt-2 font-display text-[24px] font-bold leading-snug";

  const bodyClass = design
    ? "mt-3 font-body text-[14px] leading-relaxed text-foreground"
    : "mt-3 font-body text-[14px] leading-relaxed text-slate-550";

  const metClass = design ? "text-structure-on-canvas" : "text-fit-strong";
  const mutedClass = design ? "text-foreground" : "text-slate-550";

  const reqLabelClass = design
    ? "font-body text-[13px] font-medium text-foreground"
    : "font-body text-[13px] font-medium text-ink";
  const reqStatusClass = design
    ? "font-body text-[13px] font-normal text-foreground"
    : "font-body text-[13px] font-normal text-slate-550";
  const reqDetailClass = design
    ? "mt-0.5 font-body text-[12px] leading-relaxed text-foreground"
    : "mt-0.5 font-body text-[12px] leading-relaxed text-slate-550";

  const stepDotClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-foreground"
    : "font-mono text-[11px] uppercase tracking-eyebrow text-slate-550";
  const stepDotActiveClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas"
    : "font-mono text-[11px] uppercase tracking-eyebrow text-federal";

  const legendClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-foreground"
    : "font-mono text-[11px] uppercase tracking-eyebrow text-slate-550";

  const fieldWrapClass = design
    ? "mt-5 border-t border-structure-on-canvas pt-4 first:mt-4 first:border-t-0 first:pt-0"
    : "mt-5 border-t border-rule pt-4 first:mt-4 first:border-t-0 first:pt-0";

  const inputClass = design
    ? "mt-1.5 w-full rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-body text-[13px] text-foreground"
    : "mt-1.5 w-full rounded-sm border border-rule bg-white px-2.5 py-1.5 font-body text-[13px] text-ink";

  const labelTextClass = design ? "font-body text-[13px] text-foreground" : "font-body text-[13px] text-ink";

  const primaryBtnClass = design
    ? "rounded-sm bg-action px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-token-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "rounded-sm bg-ink px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-paper transition hover:bg-federal disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const secondaryBtnClass = design
    ? "rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "rounded-sm border border-federal px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const closeTextBtnClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "font-mono text-[11px] uppercase tracking-eyebrow text-slate-550 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const closeIconBtnClass = design
    ? "absolute right-4 top-4 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "absolute right-4 top-4 text-slate-550 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const savedMsgClass = design
    ? "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas"
    : "font-mono text-[11px] uppercase tracking-eyebrow text-fit-strong";

  const footnoteClass = design
    ? "mt-6 border-t border-structure-on-canvas pt-4 font-body text-[11px] leading-relaxed text-foreground"
    : "mt-6 border-t border-rule pt-4 font-body text-[11px] leading-relaxed text-slate-550";

  // Rendered through a portal to document.body so the fixed overlay is a
  // sibling of the app root, not a descendant of the opportunity card. This
  // detaches it from the card's stacking/overflow context and guarantees the
  // dialog opens as a viewport overlay (near the top), not "inside" the grant.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-fill-flow-title"
        aria-describedby="auto-fill-flow-desc"
        className={panelClass}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close" className={closeIconBtnClass}>
          <XIcon className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <LockIcon className="h-3.5 w-3.5" design={design} />
          <p className={eyebrowClass}>
            {entitlements.isPro ? "Pro feature" : "Pro feature preview"} &middot; nothing is submitted
          </p>
        </div>

        <h2 id="auto-fill-flow-title" className={titleClass}>
          Assisted application
        </h2>

        {/* Step indicator — three labelled steps; the current one is emphasized.
            Hidden while the assembled package is shown (it replaces the stepper). */}
        {!showPackage && (
        <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          {STEP_ORDER.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={i === stepIndex ? stepDotActiveClass : stepDotClass}
                aria-current={i === stepIndex ? "step" : undefined}
              >
                {i + 1}. {STEP_LABEL[s]}
              </span>
              {i < STEP_ORDER.length - 1 && (
                <span className={stepDotClass} aria-hidden="true">
                  &rarr;
                </span>
              )}
            </li>
          ))}
        </ol>
        )}

        {/* G5: the assembled submission-ready package, rendered in-dialog. When
            shown it replaces the stepper body so there's only one focus trap. */}
        {showPackage && opportunity && profile && (
          <div>
            <button
              type="button"
              onClick={() => setShowPackage(false)}
              className={closeTextBtnClass + " mt-3"}
            >
              &larr; Back to requirements
            </button>
            <ApplicationPackage
              opportunity={opportunity}
              profile={profile}
              autoFillReqs={form}
              onClose={() => setShowPackage(false)}
            />
          </div>
        )}

        {!showPackage && step === "signin" && (
          <div>
            <p id="auto-fill-flow-desc" className={bodyClass}>
              Assisted application is a Pro feature we&rsquo;re building toward. This is a preview so
              you can see what it would need before it could act on your behalf — starting with
              signing in. Nothing is submitted anywhere, and no payment is collected.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button type="button" onClick={() => signIn()} className={primaryBtnClass}>
                Continue with Google
              </button>
              <button type="button" onClick={onClose} className={closeTextBtnClass}>
                Close
              </button>
            </div>
          </div>
        )}

        {!showPackage && step === "requirements" && (
          <div>
            <p id="auto-fill-flow-desc" className={bodyClass}>
              Here&rsquo;s what assisted application would need on file before it could act for you.
              Record what&rsquo;s true below (stored on this device only) — everything has to be in
              place before you can submit for approval. Nothing here submits an application.
            </p>

            {/* D6: per-opportunity preparation checklist — only renders when the
                caller passes a selected opportunity (see the `opportunity` prop
                doc above). Registration status feeds in from the same
                `satisfied` map the list below renders, so the two sections never
                disagree about what's on file. */}
            {opportunity && (
              <ApplicationChecklist opportunity={opportunity} allRegistrationsSatisfied={allSatisfied} />
            )}

            {/* G5: assemble a submission-ready package (G1→G2→G3→G4→D6). Only
                offered when we have both the opportunity and the founder's
                profile — an absent profile is never fabricated. Nothing is
                submitted; the package ends in an honest AOR hand-off. */}
            {canDraft && (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setShowPackage(true)}
                  className={primaryBtnClass}
                >
                  Draft my application
                </button>
                <p className={`mt-2 ${reqDetailClass}`}>
                  Pre-fills your forms and budget and drafts a grounded narrative section. Nothing is
                  submitted — you review and submit through your authorized AOR.
                </p>
              </div>
            )}

            <h4 className={legendClass + " mt-6"}>Registrations on file</h4>
            <ul className="mt-2 space-y-3">
              {REQUIREMENTS.map((r) => (
                <li key={r.key} className="flex gap-3">
                  <span className={satisfied[r.key] ? metClass : mutedClass} aria-hidden="true">
                    {satisfied[r.key] ? "✓" : "○"}
                  </span>
                  <span className="min-w-0">
                    <span className={reqLabelClass}>
                      {r.label}{" "}
                      <span className={reqStatusClass}>
                        {satisfied[r.key] ? "(satisfied)" : "(not yet)"}
                      </span>
                    </span>
                    <span className={`block ${reqDetailClass}`}>{r.detail}</span>
                  </span>
                </li>
              ))}
            </ul>

            {/* Same four facts as SettingsPanel, reused inline (see header note). */}
            <form onSubmit={handleSaveRequirements}>
              <fieldset className={fieldWrapClass}>
                <legend className={legendClass}>Active SAM.gov registration</legend>
                <div className="mt-2 flex items-center gap-4">
                  <label className={`flex items-center gap-1.5 ${labelTextClass}`}>
                    <input
                      type="radio"
                      name="flow-samRegistered"
                      checked={form.samRegistered === true}
                      onChange={() => update("samRegistered", true)}
                    />
                    Yes
                  </label>
                  <label className={`flex items-center gap-1.5 ${labelTextClass}`}>
                    <input
                      type="radio"
                      name="flow-samRegistered"
                      checked={form.samRegistered === false}
                      onChange={() => update("samRegistered", false)}
                    />
                    No
                  </label>
                </div>
                {form.samRegistered && (
                  <label className={`mt-2 block ${labelTextClass}`}>
                    Registration date (optional)
                    <input
                      type="date"
                      value={form.samRegisteredDate}
                      onChange={(e) => update("samRegisteredDate", e.target.value)}
                      className={inputClass}
                    />
                  </label>
                )}
              </fieldset>

              <div className={fieldWrapClass}>
                <label className={legendClass} htmlFor="flow-uei">
                  UEI (Unique Entity Identifier)
                </label>
                <input
                  id="flow-uei"
                  type="text"
                  value={form.uei}
                  onChange={(e) => update("uei", e.target.value)}
                  placeholder="e.g. ABC123DEF456"
                  className={inputClass}
                />
              </div>

              <fieldset className={fieldWrapClass}>
                <legend className={legendClass}>Authorized AOR</legend>
                <label className={`mt-2 block ${labelTextClass}`} htmlFor="flow-aor-name">
                  Name
                  <input
                    id="flow-aor-name"
                    type="text"
                    value={form.aorName}
                    onChange={(e) => update("aorName", e.target.value)}
                    placeholder="Who's authorized to sign for your org"
                    className={inputClass}
                  />
                </label>
                <label className={`mt-2 flex items-center gap-2 ${labelTextClass}`}>
                  <input
                    type="checkbox"
                    checked={form.aorOnFile}
                    onChange={(e) => update("aorOnFile", e.target.checked)}
                  />
                  Confirm on file with SAM.gov
                </label>
              </fieldset>

              <fieldset className={fieldWrapClass}>
                <legend className={legendClass}>E-Biz POC delegation</legend>
                <label className={`mt-2 flex items-center gap-2 ${labelTextClass}`}>
                  <input
                    type="checkbox"
                    checked={form.eBizPocOnFile}
                    onChange={(e) => update("eBizPocOnFile", e.target.checked)}
                  />
                  Confirm the Electronic Business POC has delegated AOR authority
                </label>
              </fieldset>

              <div className="mt-6 flex flex-wrap items-center gap-4">
                <button type="submit" className={secondaryBtnClass}>
                  Save
                </button>
                <span aria-live="polite" className={savedMsgClass}>
                  {saved ? "Saved" : ""}
                </span>
              </div>
            </form>

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={!allSatisfied}
                aria-disabled={!allSatisfied}
                className={primaryBtnClass}
              >
                Submit for approval
              </button>
              <button type="button" onClick={onClose} className={closeTextBtnClass}>
                Close
              </button>
            </div>
            {!allSatisfied && (
              <p className={`mt-2 ${reqDetailClass}`}>
                All four requirements must be satisfied before you can submit for approval.
              </p>
            )}
          </div>
        )}

        {!showPackage && step === "review" && (
          <div>
            <p className={`mt-4 font-display text-[18px] font-bold leading-snug ${design ? "text-foreground" : "text-ink"}`}>
              Admin review required prior to granting auto-fill approval.
            </p>
            <p id="auto-fill-flow-desc" className={bodyClass}>
              That&rsquo;s the end of this preview. To be clear about what just happened: nothing was
              submitted to SAM.gov or any grant portal, no application was filed, and no payment was
              taken. Your answers stayed on this device. Assisted application isn&rsquo;t live yet —
              when it is, approval would still be reviewed by a person first.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button type="button" onClick={onClose} className={secondaryBtnClass}>
                Close
              </button>
            </div>
          </div>
        )}

        <p className={footnoteClass}>
          This is a preview of a Pro feature, not a purchase — no payment is collected, no
          application is ever submitted, and nothing here implies a guarantee or any federal
          government affiliation.
        </p>
      </div>
    </div>,
    document.body,
  );
}

const STEP_LABEL: Record<Step, string> = {
  signin: "Sign in",
  requirements: "Requirements",
  review: "Admin review",
};

function LockIcon({ className, design }: { className?: string; design: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className ?? ""} ${design ? "text-structure-on-canvas" : "text-slate-550"}`.trim()}
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
