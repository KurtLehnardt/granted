"use client";
import { useMemo, useState } from "react";
import { TIER_LABEL, TIER_COLOR, type Match, type Opportunity, type StartupProfile } from "@/lib/types";
import { startupProfileToCompanyProfile } from "@/lib/apply/package";
import type { EligibilityBucket } from "@/lib/contracts/eligibilityDetermination";
import AutoFillModal from "@/components/AutoFillModal";
import AutoFillFlow from "@/components/AutoFillFlow";
import CompetitorAnalysisModal from "@/components/CompetitorAnalysisModal";
import { useSettingsPanel } from "@/components/AppMenu";
import { useBilling } from "@/components/BillingProvider";
import { isFlagEnabled } from "@/lib/flags";
import {
  opportunityAvailability,
  isClosingSoon,
  type OpportunityAvailabilityKind,
} from "@/lib/ui/opportunitySummary";

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;

/** Friendly labels so we never render "Rd". */
const KIND_LABEL: Record<string, string> = {
  grant: "Grant",
  rd: "R&D",
  assistance: "Assistance",
  procurement: "Procurement",
  loan: "Loan",
  scholarship: "Scholarship",
};

/**
 * ONE ELIGIBILITY VOICE (§1 #5). The deterministic `EligibilityDetermination`
 * (lib/eligibility/screen.ts) is the AUTHORITY on this card — rendered as a
 * labelled bucket with its plain meaning. The model `whyIneligible` narrative is
 * SUBORDINATE to it. Chip classes mirror EligibilityBuckets.tsx (the CON-02
 * token contract only guarantees AA contrast for these semantic tokens used as
 * FILLED chips, never as bare text/borders on canvas).
 */
const DETERMINATION_META: Record<EligibilityBucket, { label: string; meaning: string; chip: string }> = {
  eligible: {
    label: "Eligible",
    meaning: "Every eligibility gate we have a rule for is met.",
    chip: "bg-success text-on-semantic",
  },
  conditionally_eligible: {
    label: "Action needed",
    meaning: "Reachable — complete the required step below and this opens up.",
    chip: "bg-info text-on-semantic",
  },
  unknown: {
    label: "Needs info",
    meaning: "We won't guess — confirm the open items and we'll screen this.",
    chip: "bg-warning text-on-semantic",
  },
  excluded: {
    label: "Excluded",
    meaning: "A cited, reviewed rule rules this out — the named reason is shown below.",
    chip: "bg-error text-token-white",
  },
};

/**
 * Definitive (non-hedged) exclusion assertions the subordinate narrative may
 * make ONLY when the engine itself excluded. Mirrors the INVARIANT enforced by
 * `reconcileIneligibilityNarrative` in lib/claude.ts (the canonical, unit-tested
 * version). The card intentionally does NOT import that function: this component
 * is a client bundle and lib/claude.ts pulls in the server-only Anthropic SDK.
 * This conservative mirror detects a definitive over-assertion and, since the
 * authoritative determination is already rendered above, replaces it wholesale
 * with a determination-free caution rather than softening in place.
 */
const CARD_DEFINITIVE_EXCLUSION =
  /\b(?:you(?:'re| are)\s+(?:currently\s+)?(?:ineligible|not eligible|excluded|disqualified|barred)|you\s+(?:do|does)\s+not\s+qualify|you\s+don'?t\s+qualify|your\s+company\s+is\s+(?:ineligible|not eligible|excluded|disqualified)|(?:this|the)\s+(?:program|opportunity|solicitation)\s+(?:excludes|disqualifies|bars)\s+you|renders?\s+you\s+ineligible|makes?\s+you\s+ineligible)\b/i;

const CARD_RECONCILED_NARRATIVE =
  "These are concerns to verify with the program officer — not a determination that you are ruled out. Your eligibility status is the screening result shown above.";

/**
 * Reconcile the model narrative to the engine bucket. When the engine did NOT
 * exclude, a definitive-exclusion assertion is replaced with a determination-free
 * caution so the subordinate narrative can never assert a determination the
 * engine didn't make (R8.4). Hedged or non-definitive narratives pass through.
 */
function reconcileCardNarrative(raw: string, bucket: EligibilityBucket | undefined): string {
  if (bucket === "excluded") return raw; // the engine's own determination — may state it
  if (!bucket) {
    // No engine determination attached → still neutralize a bald exclusion claim.
    return CARD_DEFINITIVE_EXCLUSION.test(raw) ? CARD_RECONCILED_NARRATIVE : raw;
  }
  return CARD_DEFINITIVE_EXCLUSION.test(raw) ? CARD_RECONCILED_NARRATIVE : raw;
}

/**
 * Darker tier text for the small 11px label + score so they clear WCAG
 * contrast on white — v1 (r7_design OFF) look only. These are pre-existing,
 * hand-picked darkenings of the v1 `fit-*` palette (tailwind.config.ts), not
 * part of the CON-02 token contract (lib/design/tokens.ts) and out of FE-01's
 * file scope to relocate there. `fit-verify`/`fit-adjacent` measure 3.47:1 /
 * 4.38:1 on white — both fail the 4.5:1 AA text threshold — which is exactly
 * why this darker map exists; removing it would regress v1's contrast.
 * Marked `hex-ok` per scripts/design/check-hex.mjs's documented escape
 * hatch — this is its "rare legitimate exception" case, needed only to keep
 * the v1 fallback pixel-for-pixel (and contrast-for-contrast) when the flag
 * is off.
 */
const TIER_TEXT: Record<string, string> = {
  likely: "#1E7A4C", // hex-ok
  verify: "#8A6012", // hex-ok
  adjacent: "#A5451F", // hex-ok
  none: "#6B7280", // hex-ok
};

/**
 * v2 (r7_design ON) tier badge — a filled chip per CON-02: the reserved
 * semantic tokens are AA-safe only as filled chips/badges/banners with
 * adequate area (dark foreground text on the fill), never as a bare small
 * icon/border/inline-text color directly on canvas (see the `semantic` doc
 * comment in lib/design/tokens.ts — info/success/warning all measure well
 * under the 3:1 non-text threshold used that way). "verify" maps to warning
 * (the tier literally means "needs verification"); "likely" to success;
 * "adjacent" to info; "none" is neutral and never actually renders here
 * (OpportunityMap filters tier "none" out before cards are built).
 */
const TIER_BADGE: Record<string, string> = {
  likely: "bg-success text-on-semantic",
  verify: "bg-warning text-on-semantic",
  adjacent: "bg-info text-on-semantic",
  none: "bg-canvas-alt text-foreground",
};

/** FE-01: shared "eyebrow"-style mono label, token-driven when r7_design is on. */
function eyebrowClass(design: boolean, extra = "") {
  return design
    ? `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim()
    : `eyebrow ${extra}`.trim();
}

/** One-sided ranges must never read "$500K–$0". */
function fundingRange(o: Opportunity): string | null {
  const { fundingLow: low, fundingHigh: high } = o;
  const hasLow = typeof low === "number" && low > 0;
  const hasHigh = typeof high === "number" && high > 0;
  if (hasLow && hasHigh) return `${money(low!)}–${money(high!)}`;
  if (hasHigh) return `up to ${money(high!)}`;
  if (hasLow) return `${money(low!)}+`;
  return null;
}

export default function OpportunityCard({
  m,
  index,
  startupProfile,
}: {
  m: Match;
  index: number;
  /** G5: the founder's extracted v1 profile (from `map.profile`), bridged to a
   *  §3.1 CompanyProfile for the assisted-apply "Draft my application" flow.
   *  Optional/additive — absent leaves the pre-G5 behavior unchanged. */
  startupProfile?: StartupProfile;
}) {
  // Expand the first three cards so criteria / ineligibility / history read at a glance.
  const [open, setOpen] = useState(index < 3);
  // FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the
  // DEFAULT on this A/B branch (previously gated behind r7_design). v1 fallback
  // branches are retained but unreachable.
  const design = true;
  // FE-06: locked "Auto Fill" stub — opens the Pro-upsell modal, never submits anything.
  const [autoFillOpen, setAutoFillOpen] = useState(false);
  // R6: when on, "Auto Fill" opens the assisted-apply DEMO stepper instead of
  // the static upsell modal. Default OFF -> the FE-06 path below is unchanged.
  // Still a preview: it never submits anything and gates nothing server-side.
  const assistedApplyFlow = isFlagEnabled("r6_auto_fill");
  // G5: bridge the founder's extracted v1 profile to a §3.1 CompanyProfile once,
  // so the assisted-apply flow can assemble a grounded package. Undefined when no
  // profile was threaded down (the flow then simply doesn't offer "Draft my
  // application"); never fabricated.
  const companyProfile = useMemo(
    () => (startupProfile ? startupProfileToCompanyProfile(startupProfile) : undefined),
    [startupProfile],
  );
  // PRO-01: locked "Analyze competing companies" stub — opens a Pro-upsell
  // modal from the award-history section, never runs any analysis.
  const [competitorOpen, setCompetitorOpen] = useState(false);
  const { openSettings } = useSettingsPanel();

  // FE-07: the mock billing tier can unlock the padlocked previews — but only
  // when the left_sidebar flag is on (that's the only surface that can change
  // the tier). Gating the unlock behind the flag guarantees flag-OFF is
  // byte-for-byte today's behavior: `sidebar` is false, so both stay locked
  // regardless of any stored tier. Clicking still opens the SAME stub flow —
  // this only changes the lock glyph + hint copy, never what the buttons do.
  const sidebar = isFlagEnabled("left_sidebar");
  const { features } = useBilling();
  const autoFillUnlocked = sidebar && features.autoFill;
  const competitorUnlocked = sidebar && features.competitor;
  // Hide the paid framing (padlocks + "plan"/"Pro/Max" hint copy) unless
  // commercial_ui is on. The buttons + preview flows are unchanged.
  const commercial = isFlagEnabled("commercial_ui");

  const spine = TIER_COLOR[m.tier] ?? TIER_COLOR.none;
  const color = TIER_TEXT[m.tier] ?? TIER_TEXT.none;
  const badgeClass = TIER_BADGE[m.tier] ?? TIER_BADGE.none;
  const o = m.opportunity;
  const value = fundingRange(o);
  const kindLabel = KIND_LABEL[o.kind] ?? o.kind;

  // F1 — forecasted-vs-current (N3): the single honest availability read for
  // this card (lib/ui/opportunitySummary.ts). "open" renders no badge at all
  // (the Deadline field below already speaks for it, unchanged from before
  // this task) — only the notable, non-default states (forecasted / rolling /
  // closed) get an explicit label, so a forecasted or evergreen program is
  // never left to be misread as a normal dated listing.
  const availability = opportunityAvailability(o);
  // Evergreen-safe (F1): never true for a rolling/continuous/standing or
  // closed program, even if a stray deadline value is present on the record.
  const closingSoon = isClosingSoon(o);

  // AUTHORITY: the deterministic screening determination is the source of truth
  // for eligibility on this card (§1 #5). It may be absent (screening omitted /
  // errored for this match) — the card degrades to the narrative-only view.
  const determination = m.eligibility?.determination;
  const bucket = determination?.bucket;
  const detMeta = bucket ? DETERMINATION_META[bucket] : undefined;
  const freshnessCaveat = m.eligibility?.freshness?.caveat ?? null;

  // "What could make you ineligible" is spec-mandatory — never render it blank.
  // SUBORDINATE to the determination above: reconciled so it can never assert a
  // determination the engine didn't make (R8.4).
  const rawIneligible = m.whyIneligible?.trim()
    ? m.whyIneligible
    : "No disqualifying factors surfaced from your description, but eligibility still turns on the program's formal requirements. Confirm size standards, required registrations, and topic scope with the program officer before applying.";
  const ineligible = reconcileCardNarrative(rawIneligible, bucket);

  const nextSteps = m.whatToDoNext?.trim();

  // Polish: the card is an elevated surface (rounded + layered shadow, lifting
  // slightly on hover) rather than a hard navy border. overflow-hidden clips the
  // left tier spine to the rounded corners; the interior border-t dividers stay
  // as structural separators. transition-shadow names only the animated prop.
  const articleClass = design
    ? "relative overflow-hidden rounded-lg bg-canvas-alt text-foreground shadow-card transition-shadow duration-200 ease-out hover:shadow-card-hover"
    : "relative border border-rule bg-white";

  // v2: the spine is a neutral structural accent only — semantic tier color
  // is carried entirely by the filled badge below (see TIER_BADGE comment on
  // why a thin colored bar can't carry it and stay AA-safe).
  const spineClass = design ? "spine bg-structure-on-canvas" : "spine";

  const titleClass = design
    ? "mt-1.5 text-balance font-display text-[19px] font-medium leading-snug text-foreground"
    : "mt-1.5 font-display text-[19px] font-medium leading-snug";

  const agencyClass = design ? "mt-1 text-pretty font-mono text-[12px] text-foreground" : "mt-1 font-mono text-[12px] text-slate-550";

  const dtClass = design ? "inline text-foreground" : "inline text-slate-550";

  // C2: whyCare leads the card, ABOVE THE FOLD (in the always-visible header,
  // not behind the `open` toggle) — distinct from whyFit, which stays in the
  // collapsible details below. For a grant/rd candidate whyCare is "why you
  // may fit"; for a procurement/adjacent candidate it's "why this matters to
  // you" (government-as-customer strategic value) — see the explainMatches
  // v2 prompt (lib/prompts/registry.ts) rule 2.
  const whyCareClass = design
    ? "mt-2 text-pretty font-body text-[14px] leading-relaxed text-foreground"
    : "mt-2 font-body text-[14px] leading-relaxed";

  // F1 — availability badge per non-default kind. "forecasted" keeps the
  // pre-existing bg-info style byte-for-byte; "rolling" reuses the same
  // bordered-chip token pairing as the Auto Fill button (structure-on-canvas
  // is documented AA-safe as small text/borders directly on canvas — see
  // lib/design/tokens.ts); "closed" reuses the same filled error chip as the
  // "Excluded" eligibility bucket (DETERMINATION_META.excluded, above).
  const AVAILABILITY_BADGE: Record<
    Exclude<OpportunityAvailabilityKind, "open">,
    { text: string; className: string }
  > = design
    ? {
        forecasted: {
          text: "Forecasted",
          className: "rounded-sm bg-info px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-on-semantic",
        },
        rolling: {
          text: "Rolling",
          className:
            "rounded-sm border border-structure-on-canvas px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-structure-on-canvas",
        },
        closed: {
          text: "Closed",
          className: "rounded-sm bg-error px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-token-white",
        },
      }
    : {
        forecasted: {
          text: "Forecasted",
          className: "rounded-sm border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-slate-550",
        },
        rolling: {
          text: "Rolling",
          className: "rounded-sm border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-slate-550",
        },
        closed: {
          text: "Closed",
          className: "rounded-sm border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-slate-550",
        },
      };

  // F1 — evergreen-safe "closing soon" chip (never rendered for a rolling/
  // continuous/standing/closed program; see isClosingSoon above). Filled
  // warning chip — the same AA-safe pairing as the other semantic badges,
  // never a bare border/inline-text use of the token (lib/design/tokens.ts).
  const closingSoonClass = design
    ? "rounded-sm bg-warning px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-on-semantic"
    : "rounded-sm border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-slate-550";

  const detailsClass = design
    ? "reveal border-t border-structure-on-canvas px-4 pb-5 pt-4 sm:px-6 sm:pb-6 sm:pt-5"
    : "reveal border-t border-rule px-4 pb-5 pt-4 sm:px-6 sm:pb-6 sm:pt-5";

  const criterionMetClass = design ? "text-structure-on-canvas" : "text-fit-strong";
  const criterionMutedClass = design ? "text-foreground" : "text-slate-550";

  const historyBorderClass = design ? "mt-6 border-t border-structure-on-canvas pt-5" : "mt-6 border-t border-rule pt-5";

  const tableHeadRowClass = design
    ? "border-b border-structure-on-canvas text-left text-foreground"
    : "border-b border-rule text-left text-slate-550";

  const tableBodyRowClass = design ? "border-b border-structure-on-canvas" : "border-b border-rule/60";

  const tableMutedCellClass = design ? "py-1.5 pr-3 text-foreground" : "py-1.5 pr-3 text-slate-550";

  const nextStepsBorderClass = design ? "mt-6 border-t border-structure-on-canvas pt-5" : "mt-6 border-t border-rule pt-5";

  const linkClass = design
    ? "mt-3 inline-block font-mono text-[12px] text-structure-on-canvas underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "mt-3 inline-block font-mono text-[12px] text-federal underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  // A3-lite — recipient company cells link out to the row's verified
  // SBIR.gov sourceUrl. Same underline affordance as `linkClass` but sized
  // for the table's font-mono text-[11px] context (no `mt-3 inline-block`
  // block spacing, which is meant for a standalone link below a paragraph).
  const recipientLinkClass = design
    ? "underline underline-offset-2 hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-1"
    : "underline underline-offset-2 hover:text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-1";

  // Header toggle — the card's whole title row is one full-width <button>;
  // no existing dual-class const covered it before, so the focus ring is
  // added inline here, keyed off the same `design` flag as everything else.
  // ring-inset (not ring-offset) — this button is flush against the card's
  // own border on all sides, so an outside offset would bleed the ring past
  // the card edge.
  const headerToggleClass = design
    ? "w-full px-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-inset sm:px-6 sm:py-5"
    : "w-full px-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-inset sm:px-6 sm:py-5";

  // FE-06: the locked Auto Fill control is a secondary/structure affordance —
  // never bg-action (reserved for the primary CTA). Sits in its own row, own
  // <button>, outside the header's full-width toggle button (see below).
  const autoFillRowClass = design
    ? "flex flex-wrap items-center gap-2 border-t border-structure-on-canvas px-4 py-3 sm:px-6"
    : "flex flex-wrap items-center gap-2 border-t border-rule px-4 py-3 sm:px-6";

  // Polish: real hover + a 40px min hit target (dense-desktop control), plus
  // optical padding (icon side 2px tighter than the text side).
  const autoFillBtnClass = design
    ? "inline-flex min-h-[40px] items-center gap-1.5 rounded-sm border border-structure-on-canvas bg-canvas pl-2 pr-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "inline-flex items-center gap-1.5 rounded-sm border border-rule bg-white px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-slate-550 transition hover:border-federal hover:text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const autoFillHintClass = design
    ? "font-mono text-[10px] text-foreground"
    : "font-mono text-[10px] text-slate-550";

  // PRO-01: locked "Analyze competing companies" control — same
  // secondary/structure affordance as Auto Fill above, but lives inside
  // the "Similar companies funded" history section rather than its own row.
  const competitorBtnClass = design
    ? "inline-flex items-center gap-1.5 rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "inline-flex items-center gap-1.5 rounded-sm border border-rule bg-white px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-slate-550 transition hover:border-federal hover:text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const competitorHintClass = design
    ? "font-mono text-[10px] text-foreground"
    : "font-mono text-[10px] text-slate-550";

  return (
    <article className={articleClass}>
      <span className={spineClass} style={design ? undefined : { background: spine }} aria-hidden />

      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={headerToggleClass}
      >
        {/* Mobile pass (N4): flex-wrap lets the score/chevron block drop to
            its own line under the title on narrow widths instead of being
            squeezed into a shrink-0 column beside a long program title. */}
        <div className="flex flex-wrap items-start justify-between gap-4 sm:flex-nowrap sm:gap-6">
          <div className="min-w-0">
            {design ? (
              <span className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${badgeClass}`}>
                {TIER_LABEL[m.tier]}
              </span>
            ) : (
              <span className="font-mono text-[11px] uppercase tracking-eyebrow" style={{ color }}>
                {TIER_LABEL[m.tier]}
              </span>
            )}
            {/* DISC — advisory recommend/verify/do-not-recommend verdict (flag ON only).
                do_not_recommend gets the strongest treatment (bold foreground) so an
                honest "don't apply" reads at a glance; both others stay quiet. */}
            {m.recommendation && (
              <p
                className={`mt-1 font-mono text-[11px] uppercase tracking-eyebrow ${
                  m.recommendation.recommendation === "do_not_recommend"
                    ? "font-bold text-foreground"
                    : "text-structure-on-canvas"
                }`}
              >
                {m.recommendation.label}
              </p>
            )}
            <h3 className={titleClass}>{o.program}</h3>
            <p className={agencyClass}>{o.agency}</p>
            {m.whyCare?.trim() && <p className={whyCareClass}>{m.whyCare}</p>}
            {m.recommendation?.basis?.trim() && (
              <p className="mt-1 font-body text-[12px] leading-relaxed text-structure-on-canvas">
                {m.recommendation.basis}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div
                className={design ? "font-display text-[26px] font-bold leading-none tabular-nums text-foreground" : "font-display text-[26px] font-bold leading-none"}
                style={design ? undefined : { color }}
              >
                {m.score}
                <span className="text-[15px] font-medium">%</span>
              </div>
              <div className={eyebrowClass(design, "mt-1")}>match</div>
            </div>
            <ChevronIcon
              className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""} ${design ? "text-structure-on-canvas" : "text-slate-550"}`}
            />
          </div>
        </div>

        <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px] tabular-nums sm:gap-x-8">
          {value && (
            <div>
              <dt className={dtClass}>Value </dt>
              <dd className="inline">{value}</dd>
            </div>
          )}
          {o.deadline && (
            <div>
              <dt className={dtClass}>Deadline </dt>
              <dd className="inline">{o.deadline}</dd>
            </div>
          )}
          {/* F1 (N3) — forecasted-vs-current: the only non-default availability
              states get an explicit badge; "open" stays unbadged (the Deadline
              field above already implies it), unchanged from before this task. */}
          {availability && availability.kind !== "open" && (
            <span className={AVAILABILITY_BADGE[availability.kind].className}>
              {AVAILABILITY_BADGE[availability.kind].text}
            </span>
          )}
          {/* F1 — evergreen-safe closing-soon flag; never renders for a
              rolling/continuous/standing or closed program (isClosingSoon). */}
          {closingSoon && <span className={closingSoonClass}>Closing soon</span>}
          <div>
            <dt className={dtClass}>Type </dt>
            <dd className="inline">{kindLabel}</dd>
          </div>
          {detMeta && (
            <div className="flex items-center gap-1.5">
              <dt className={dtClass}>Eligibility </dt>
              <dd className="inline">
                <span className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${detMeta.chip}`}>
                  {detMeta.label}
                </span>
              </dd>
            </div>
          )}
        </dl>
      </button>

      {/*
        FE-06: rendered as its own row, its own <button>, OUTSIDE the header
        toggle button above (which is already a full-width <button> — nesting
        a second interactive button inside it would be invalid HTML). Visible
        on every card regardless of expand state. Locked stub only: clicking
        it never submits anything, it just opens the Pro-upsell modal.
      */}
      <div className={autoFillRowClass}>
        <button
          type="button"
          onClick={() => setAutoFillOpen(true)}
          aria-haspopup="dialog"
          className={autoFillBtnClass}
        >
          {!autoFillUnlocked && commercial && <LockIcon className="h-3 w-3" />}
          Auto Fill
        </button>
        <span className={autoFillHintClass}>
          {!commercial ? (
            // Commercial framing hidden: describe the feature state, no plan/Pro.
            assistedApplyFlow ? "Preview" : "Not live yet"
          ) : autoFillUnlocked ? (
            // The hint must match what clicking actually opens: the walkable
            // preview (r6 on) vs. the "not live yet" modal (r6 off). Claiming
            // "included in your plan" while the modal says "not available yet"
            // was the contradiction (frontend review MEDIUM).
            assistedApplyFlow ? "Included in your plan (preview)" : <>In your plan &middot; not live yet</>
          ) : (
            <>Pro feature &middot; not available yet</>
          )}
        </span>
      </div>

      {autoFillOpen &&
        (assistedApplyFlow ? (
          // R6 ON: the walkable assisted-apply demo stepper. G5: thread the
          // opportunity + bridged profile so "Draft my application" can assemble
          // the submission-ready package end-to-end.
          <AutoFillFlow
            onClose={() => setAutoFillOpen(false)}
            opportunity={o}
            profile={companyProfile}
          />
        ) : (
          // R6 OFF (default): the FE-06 static Pro-upsell modal, unchanged.
          <AutoFillModal
            onClose={() => setAutoFillOpen(false)}
            onOpenSettings={() => {
              setAutoFillOpen(false);
              openSettings();
            }}
          />
        ))}

      {competitorOpen && (
        <CompetitorAnalysisModal
          onClose={() => setCompetitorOpen(false)}
          // R5-deep: thread the founder's profile + this opportunity so a Max-tier
          // user (with the r5_deep_analysis flag on) can run a live, personalized
          // brief. Absent profile → the modal stays demo-only. Keywords prefer the
          // gov-vocabulary expandedTerms the retrieval is tuned for.
          profile={
            startupProfile
              ? {
                  description: startupProfile.description,
                  keywords:
                    startupProfile.expandedTerms && startupProfile.expandedTerms.length
                      ? startupProfile.expandedTerms
                      : startupProfile.naicsGuesses,
                  persona: startupProfile.industry,
                }
              : undefined
          }
          opportunity={{ program: o.program, agency: o.agency }}
        />
      )}

      {open && (
        <div className={detailsClass}>
          {m.criteria?.length > 0 && (
            <ul className="mb-6 grid gap-1.5 sm:grid-cols-2">
              {m.criteria.map((c, i) => (
                <li key={i} className="flex gap-2 font-body text-[13px]">
                  <span className={c.met ? criterionMetClass : criterionMutedClass} aria-hidden>
                    {c.met ? "✓" : "○"}
                  </span>
                  <span className={c.met ? (design ? "text-foreground" : "") : criterionMutedClass}>{c.label}</span>
                </li>
              ))}
            </ul>
          )}

          <Section design={design} title="Why we think you're a fit" body={m.whyFit} />

          {/*
            AUTHORITY (§1 #5): the deterministic screening determination is the
            source of truth for eligibility. It renders ABOVE the model
            "ineligible" narrative, which is subordinate to it.
          */}
          {detMeta && (
            <DeterminationAuthority
              design={design}
              meta={detMeta}
              steps={determination?.required_steps ?? []}
              caveat={freshnessCaveat}
            />
          )}

          <Section
            design={design}
            title="What could make you ineligible"
            body={ineligible}
            accent
            note={
              detMeta
                ? "Model assessment — a generated read on possible concerns. It is SUBORDINATE to the eligibility screening above (the authority) and can never state a determination the screening didn't make."
                : "Model assessment — a generated read on possible concerns, not a cited rule or a formal eligibility determination. Confirm requirements with the program officer."
            }
          />
          <Section design={design} title="What you should verify" body={m.whatToVerify} />

          {m.history && (
            <div className={historyBorderClass}>
              <p className={eyebrowClass(design, "mb-3")}>Similar companies funded</p>
              <div className="mb-4 flex flex-wrap gap-x-5 gap-y-3 sm:gap-x-8">
                <Stat design={design} n={m.history.similarCompanies} label="similar companies" />
                <Stat design={design} n={money(m.history.totalAwarded)} label="total awarded" />
                <Stat design={design} n={money(m.history.medianAward)} label="median award" />
                <Stat design={design} n={m.history.inState} label="in Utah" />
                <Stat design={design} n={m.history.inVertical} label="in your vertical" />
              </div>

              {/*
                PRO-01: locked stub only — clicking it never fetches or
                analyzes anything, it just opens the Pro-upsell modal.
              */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCompetitorOpen(true)}
                  aria-haspopup="dialog"
                  className={competitorBtnClass}
                >
                  {!competitorUnlocked && commercial && <LockIcon className="h-3 w-3" />}
                  Analyze competing companies
                </button>
                <span className={competitorHintClass}>
                  {/* Honest hint: with r5_deep_analysis ON, an unlocked (Max) tier
                      really can run a live brief; with it OFF the surface is the
                      saved example only. Locked tiers can still preview the example. */}
                  {!commercial ? (
                    isFlagEnabled("r5_deep_analysis") ? <>Live</> : <>Example</>
                  ) : competitorUnlocked ? (
                    isFlagEnabled("r5_deep_analysis") ? (
                      <>In your plan &middot; live</>
                    ) : (
                      <>In your plan &middot; example</>
                    )
                  ) : (
                    <>Max feature &middot; preview available</>
                  )}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] font-mono text-[11px] tabular-nums">
                  <thead>
                    <tr className={tableHeadRowClass}>
                      <th className="py-1.5 font-normal">Company</th>
                      <th className="py-1.5 font-normal">Program</th>
                      <th className="py-1.5 font-normal">Agency</th>
                      <th className="py-1.5 text-right font-normal">Amount</th>
                      <th className="py-1.5 text-right font-normal">Year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.history.recipients.map((r, i) => (
                      <tr key={i} className={tableBodyRowClass}>
                        <td className="py-1.5 pr-3">
                          {/* A3-lite: every recipient is provenance-gated (see
                              historyFromRows() in lib/match.ts) — link straight
                              to the real SBIR.gov awards record so the source
                              is one click away, not just implied. */}
                          <a href={r.sourceUrl} target="_blank" rel="noreferrer" className={recipientLinkClass}>
                            {r.company}
                          </a>
                        </td>
                        <td className={tableMutedCellClass}>{r.program}</td>
                        <td className={tableMutedCellClass}>{r.agency}</td>
                        <td className="py-1.5 pr-3 text-right">{money(r.amount)}</td>
                        <td className={design ? "py-1.5 text-right text-foreground" : "py-1.5 text-right text-slate-550"}>{r.year}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(nextSteps || o.url) && (
            <div className={nextStepsBorderClass}>
              <p className={eyebrowClass(design, "mb-2")}>What to do next</p>
              {nextSteps && <p className="text-pretty font-body text-[14px] leading-relaxed">{nextSteps}</p>}
              {o.url && (
                <a href={o.url} target="_blank" rel="noreferrer" className={linkClass}>
                  Open the official listing
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Section({ title, body, accent, design, note }: { title: string; body?: string; accent?: boolean; design: boolean; note?: string }) {
  if (!body || !body.trim()) return null;
  // Ineligibility factors are a blocking/cautionary signal -> `error`, used
  // here as a 2px left border (non-text, 3:1 threshold — passes; see the
  // TIER_BADGE comment for why the same tokens can't be bare small text).
  const accentClass = accent ? (design ? "border-l-2 border-error pl-4" : "border-l-2 border-fit-verify pl-4") : "";
  const bodyClass = design ? "text-pretty font-body text-[14px] leading-relaxed text-foreground" : "font-body text-[14px] leading-relaxed";
  // Provenance note (R8.4 spirit): mark uncited model-recall blocks as a model
  // assessment so a generated concern doesn't read as an authoritative,
  // rule-grounded determination — mirrors EligibilityBuckets' ProvenanceNote.
  const noteClass = design
    ? "mt-1.5 font-body text-[11px] italic leading-relaxed text-foreground"
    : "mt-1.5 font-body text-[11px] italic leading-relaxed text-slate-550";
  return (
    <div className={`mb-5 ${accentClass}`}>
      <p className={eyebrowClass(design, "mb-1.5")}>{title}</p>
      <p className={bodyClass}>{body}</p>
      {note && <p className={noteClass}>{note}</p>}
    </div>
  );
}

/**
 * The deterministic eligibility determination, rendered as the card's AUTHORITY
 * (§1 #5 / R8.4). A filled bucket chip + its plain-language meaning, the concrete
 * required steps for a conditional determination, and the freshness caveat when
 * the screen ran against stale data (§4.5/§11 — must be visibly flagged). This is
 * the source of truth the model "ineligible" narrative below is subordinate to.
 */
function DeterminationAuthority({
  design,
  meta,
  steps,
  caveat,
}: {
  design: boolean;
  meta: { label: string; meaning: string; chip: string };
  steps: { step: string; lead_time_days?: number; why?: string }[];
  caveat: string | null;
}) {
  const wrapClass = design ? "rounded-md bg-canvas px-4 py-3" : "border border-rule px-4 py-3";
  const headingClass = design
    ? "font-display text-[15px] font-semibold leading-snug text-foreground"
    : "font-display text-[15px] font-semibold leading-snug";
  const meaningClass = design
    ? "mt-1 text-pretty font-body text-[13px] leading-relaxed text-foreground"
    : "mt-1 font-body text-[13px] leading-relaxed text-slate-550";
  const stepTextClass = design
    ? "font-body text-[13px] font-medium leading-snug text-foreground"
    : "font-body text-[13px] font-medium leading-snug";
  const stepWhyClass = design
    ? "mt-0.5 font-body text-[12px] leading-relaxed text-foreground"
    : "mt-0.5 font-body text-[12px] leading-relaxed text-slate-550";
  const chipClass = `inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${meta.chip}`;
  const leadChipClass = design
    ? "inline-block shrink-0 rounded-sm bg-info px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow tabular-nums text-on-semantic"
    : "inline-block shrink-0 rounded-sm border border-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow text-slate-550";
  const caveatClass = design
    ? "mt-2 border-l-2 border-warning pl-3 font-body text-[12px] italic leading-relaxed text-foreground"
    : "mt-2 border-l-2 border-fit-adjacent pl-3 font-body text-[12px] italic leading-relaxed text-slate-550";

  return (
    <div className="mb-5">
      <p className={eyebrowClass(design, "mb-1.5")}>Eligibility screening &middot; the authority</p>
      <div className={wrapClass}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={chipClass}>{meta.label}</span>
          <span className={headingClass}>{meta.meaning}</span>
        </div>

        {steps.length > 0 && (
          <ul className="mt-3 space-y-2">
            {steps.map((s, i) => {
              const lead =
                typeof s.lead_time_days === "number"
                  ? `~${s.lead_time_days} day${s.lead_time_days === 1 ? "" : "s"}`
                  : null;
              return (
                <li key={`${s.step}-${i}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={stepTextClass}>{s.step}</span>
                    {lead && <span className={leadChipClass}>{lead}</span>}
                  </div>
                  {s.why && <p className={stepWhyClass}>{s.why}</p>}
                </li>
              );
            })}
          </ul>
        )}

        {caveat && (
          <p role="note" className={caveatClass}>
            <span className="font-mono uppercase tracking-eyebrow not-italic">Data freshness</span> — {caveat}
          </p>
        )}
      </div>
    </div>
  );
}

/** FE-06: closed-padlock glyph for the locked Auto Fill control. No external asset. */
function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Expand/collapse affordance for the collapsible card header. Points down when
 * collapsed, rotates 180deg (via the caller's `rotate-180` class) when expanded.
 * Decorative only — the header button already carries `aria-expanded`. */
function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function Stat({ n, label, design }: { n: number | string; label: string; design: boolean }) {
  const numberClass = design
    ? "font-display text-[20px] font-bold leading-none tabular-nums text-foreground"
    : "font-display text-[20px] font-bold leading-none";
  return (
    <div>
      <div className={numberClass}>{n}</div>
      <div className={eyebrowClass(design, "mt-1")}>{label}</div>
    </div>
  );
}
