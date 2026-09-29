"use client";
// Explicit React import: needed under the plain `tsx`-run node:test runner
// (this repo's tsconfig `"jsx": "preserve"` falls back to the classic JSX
// runtime there) — see the same note in components/ApplicationChecklist.tsx.
import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { TIER_LABEL, type Match, type StartupProfile } from "@/lib/types";
import { isProvisional, type PreviewItem } from "@/lib/ui/previewReducer";
import type { EligibilityBucket } from "@/lib/contracts/eligibilityDetermination";
import HowToApplyModal from "@/components/HowToApplyModal";
import { buildFundingRange, money } from "@/components/ApplicationChecklist";
import CompetitorAnalysisModal from "@/components/CompetitorAnalysisModal";
import ScrollFadeContainer from "@/components/ScrollFadeContainer";
import { isFlagEnabled } from "@/lib/flags";
import {
  opportunityAvailability,
  isClosingSoon,
  isDeadlinePassed,
  type OpportunityAvailabilityKind,
} from "@/lib/ui/opportunitySummary";

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
 * Tier badge — a filled chip per CON-02: the reserved
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

/** FE-01: shared "eyebrow"-style mono label, token-driven. */
function eyebrowClass(extra = "") {
  return `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim();
}

/**
 * ANALYZING ring (§5) — wraps the match-score badge while a candidate's score
 * may still change: not yet scored (`ProvisionalCard`), or Pass-A scored but
 * Pass-B narrative pending for a promoted candidate (`ScoredOpportunityCard`
 * with `m.final === false`). A slowly rotating ring of repeated "ANALYZING"
 * text around the number/placeholder — inline SVG `textPath` on a circle, CSS
 * rotation (`.analyzing-ring` in globals.css). Rotation is disabled under
 * `prefers-reduced-motion` by the existing global rule (a static ring
 * remains). Ring text is `aria-hidden`; the caller supplies the accessible
 * label on the badge itself so a screen reader hears it once, not the raw
 * repeated ring text.
 *
 * Fixed footprint (not sized off the badge it wraps): the wrapper `span` has
 * an explicit height/width and the SVG fills it exactly (`inset-0`), so the
 * ring is a normal, sized flex item — it takes real space in the card's
 * layout instead of overflowing past it, and the badge column, `flex-wrap`,
 * and the article's own padding all just work around it. `textLength` +
 * `spacingAndGlyphs` stretches the label to the exact circumference so it
 * wraps the full ring instead of covering a partial arc.
 */
function AnalyzingRing({ children, fading }: { children: ReactNode; fading?: boolean }) {
  const pathId = useId();
  const r = 42;
  const circumference = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex h-20 w-20 items-center justify-center sm:h-24 sm:w-24">
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        className={`analyzing-ring pointer-events-none absolute inset-0 h-full w-full text-structure-on-canvas transition-opacity duration-300 ${
          fading ? "opacity-0" : "opacity-100"
        }`}
      >
        <defs>
          <path id={pathId} d={`M 50,50 m -${r},0 a ${r},${r} 0 1,1 ${2 * r},0 a ${r},${r} 0 1,1 -${2 * r},0`} fill="none" />
        </defs>
        <text className="fill-current font-mono uppercase" style={{ fontSize: "7px", letterSpacing: "1px" }}>
          <textPath href={`#${pathId}`} textLength={circumference} lengthAdjust="spacingAndGlyphs">
            ANALYZING &middot; ANALYZING &middot; ANALYZING &middot;{" "}
          </textPath>
        </text>
      </svg>
      {children}
    </span>
  );
}

/**
 * ANALYZING ring fade-out (§5) — pure state-transition rule, kept separate
 * from the component so "the fade starts in the SAME render `final` flips
 * true" is unit-testable without a DOM: `true` exactly when the previous
 * render was still analyzing (`prevFinal === false`) and this one no longer
 * is. Called during render (not from an effect), which runs it before React
 * commits the render that would otherwise unmount the ring outright.
 */
export function nextRingFading(prevFinal: boolean | undefined, nextFinal: boolean | undefined): boolean {
  return prevFinal === false && nextFinal !== false;
}

export default function OpportunityCard({
  m,
  index,
  startupProfile,
}: {
  m: PreviewItem;
  index: number;
  /** The user's extracted v1 profile (from `map.profile`), threaded into the
   *  competitor-analysis modal below. Only read when r5_deep_analysis is on. */
  startupProfile?: StartupProfile;
}) {
  // ANALYZING ring fade-out (§5) across the provisional→scored swap: the ring
  // unmounts with ProvisionalCard and a fresh one mounts inside
  // ScoredOpportunityCard, so there's no single DOM node to CSS-transition —
  // track the swap here (the component instance that persists across it) and
  // pass it down so the newly-mounted ring can run its own fade-in-then-out.
  const wasProvisional = useRef(isProvisional(m));
  const justPromoted = wasProvisional.current && !isProvisional(m);
  wasProvisional.current = isProvisional(m);

  if (isProvisional(m)) return <ProvisionalCard opportunity={m.opportunity} index={index} />;
  return <ScoredOpportunityCard m={m} index={index} startupProfile={startupProfile} justPromoted={justPromoted} />;
}

/**
 * Instant cards — a retrieved-but-unscored candidate. No score, no tier, no
 * narrative yet: just the program identity plus an em dash and an
 * "Analyzing, score may change" accessible label (role="status") in place of
 * the match percentage. Deliberately shows no number — a fake or placeholder
 * score would be worse than an honest "not yet".
 */
function ProvisionalCard({ opportunity, index }: { opportunity: Match["opportunity"]; index: number }) {
  const articleClass =
    "relative overflow-hidden rounded-lg bg-canvas-alt text-foreground shadow-card transition-shadow duration-200 ease-out";
  return (
    <article className={articleClass}>
      <span className="spine bg-structure-on-canvas" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h3 className="mt-1.5 text-balance font-display text-[19px] font-medium leading-snug text-foreground">
            {opportunity.program}
          </h3>
          <p className="mt-1 text-pretty font-mono text-[12px] text-foreground">{opportunity.agency}</p>
        </div>
        <div className="shrink-0 text-right">
          <AnalyzingRing>
            <div
              role="status"
              aria-label="Analyzing, score may change"
              className="font-display text-[26px] font-bold leading-none tabular-nums text-structure-on-canvas"
            >
              &mdash;
            </div>
          </AnalyzingRing>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
            scoring
          </div>
        </div>
      </div>
    </article>
  );
}

function ScoredOpportunityCard({
  m,
  index,
  startupProfile,
  justPromoted,
}: {
  m: Match;
  index: number;
  startupProfile?: StartupProfile;
  /** True on the one render where this card replaced a ProvisionalCard for
   *  the same id (see OpportunityCard above). */
  justPromoted?: boolean;
}) {
  // Expand the first three cards so criteria / ineligibility / history read at a glance.
  const [open, setOpen] = useState(index < 3);
  const isFinal = m.final ?? true;
  // ANALYZING ring fade-out (§5): once `final` flips true, keep the ring
  // mounted for one short CSS transition instead of yanking it away. Adjusted
  // during render (React's "derive state from a prop change" pattern) so the
  // fade starts on the very same commit `final` flips, before the ring would
  // otherwise unmount.
  const [prevFinal, setPrevFinal] = useState(isFinal);
  const [ringFading, setRingFading] = useState(false);
  if (prevFinal !== isFinal) {
    setPrevFinal(isFinal);
    setRingFading(nextRingFading(prevFinal, isFinal));
  }
  useEffect(() => {
    if (!ringFading) return;
    const t = setTimeout(() => setRingFading(false), 300);
    return () => clearTimeout(t);
  }, [ringFading]);
  // A card that just replaced a ProvisionalCard with an already-final score
  // (single-pass, or Pass A final for a non-promoted candidate) mounts a
  // brand-new ring with nothing to transition from. `enterFading` renders it
  // visible on mount, then flips to fading a frame later so the browser
  // actually animates the opacity change instead of skipping straight to 0.
  const [enterFading, setEnterFading] = useState(false);
  const [enterFadingActive, setEnterFadingActive] = useState(!!justPromoted && isFinal);
  useEffect(() => {
    if (!enterFadingActive) return;
    const raf = requestAnimationFrame(() => setEnterFading(true));
    const t = setTimeout(() => setEnterFadingActive(false), 300);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const showRing = isFinal === false || ringFading || enterFadingActive;
  const fading = ringFading || (enterFadingActive && enterFading);
  // The assisted-apply flow (sign-in / requirements form / package assembly)
  // was unreliable, so it's been pulled from the UI for now (code stays in
  // place: AutoFillFlow.tsx, AutoFillModal.tsx, ApplicationPackage.tsx). This
  // control is now a plain, read-only "how do I apply?" reference instead —
  // nothing to submit, nothing that can break.
  const [howToApplyOpen, setHowToApplyOpen] = useState(false);
  // PRO-01: locked "Analyze competing companies" stub — opens a Pro-upsell
  // modal from the award-history section, never runs any analysis.
  const [competitorOpen, setCompetitorOpen] = useState(false);


  const badgeClass = TIER_BADGE[m.tier] ?? TIER_BADGE.none;
  const o = m.opportunity;
  const value = buildFundingRange(o);
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
  // Data-freshness: the committed corpus is a point-in-time snapshot, so a
  // deadline that parses to a date strictly BEFORE now is stale — badge it
  // honestly ("verify," never assert) instead of rendering it as if current.
  // Evergreen-safe (never true for rolling/continuous/standing or forecasted),
  // and mutually exclusive with `closingSoon` above (which requires a FUTURE
  // deadline), so the two badges can never both show.
  const deadlinePassed = isDeadlinePassed(o);

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
  const articleClass =
    "relative overflow-hidden rounded-lg bg-canvas-alt text-foreground shadow-card transition-shadow duration-200 ease-out hover:shadow-card-hover";

  // v2: the spine is a neutral structural accent only — semantic tier color
  // is carried entirely by the filled badge below (see TIER_BADGE comment on
  // why a thin colored bar can't carry it and stay AA-safe).
  const spineClass = "spine bg-structure-on-canvas";

  const titleClass =
    "mt-1.5 text-balance font-display text-[19px] font-medium leading-snug text-foreground";

  const agencyClass = "mt-1 text-pretty font-mono text-[12px] text-foreground";

  const dtClass = "inline text-foreground";

  // C2: whyCare leads the card, ABOVE THE FOLD (in the always-visible header,
  // not behind the `open` toggle) — distinct from whyFit, which stays in the
  // collapsible details below. For a grant/rd candidate whyCare is "why you
  // may fit"; for a procurement/adjacent candidate it's "why this matters to
  // you" (government-as-customer strategic value) — see the explainMatches
  // v2 prompt (lib/prompts/registry.ts) rule 2.
  const whyCareClass =
    "mt-2 text-pretty font-body text-[14px] leading-relaxed text-foreground";

  // F1 — availability badge per non-default kind. "forecasted" keeps the
  // pre-existing bg-info style byte-for-byte; "rolling" reuses the same
  // bordered-chip token pairing as the Auto Fill button (structure-on-canvas
  // is documented AA-safe as small text/borders directly on canvas — see
  // lib/design/tokens.ts); "closed" reuses the same filled error chip as the
  // "Excluded" eligibility bucket (DETERMINATION_META.excluded, above).
  const AVAILABILITY_BADGE: Record<
    Exclude<OpportunityAvailabilityKind, "open">,
    { text: string; className: string }
  > = {
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
  };

  // F1 — evergreen-safe "closing soon" chip (never rendered for a rolling/
  // continuous/standing/closed program; see isClosingSoon above). Filled
  // warning chip — the same AA-safe pairing as the other semantic badges,
  // never a bare border/inline-text use of the token (lib/design/tokens.ts).
  const closingSoonClass =
    "rounded-sm bg-warning px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-on-semantic";

  // Data-freshness — "Deadline passed" badge. Same filled-error chip as the
  // "Closed" availability badge / "Excluded" bucket (an AA-safe filled pairing,
  // never a bare border/inline-text use of the token). The copy says "verify,"
  // never asserts the program is gone: a self-hoster's stale snapshot may lag
  // the official source, so we flag honestly and send them to check.
  const deadlinePassedClass =
    "rounded-sm bg-error px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-token-white";

  const detailsClass =
    "reveal border-t border-structure-on-canvas px-4 pb-5 pt-4 sm:px-6 sm:pb-6 sm:pt-5";

  const criterionMetClass = "text-structure-on-canvas";
  const criterionMutedClass = "text-foreground";

  const historyBorderClass = "mt-6 border-t border-structure-on-canvas pt-5";

  const tableHeadRowClass = "border-b border-structure-on-canvas text-left text-foreground";

  const tableBodyRowClass = "border-b border-structure-on-canvas";

  const tableMutedCellClass = "py-1.5 pr-3 text-foreground";

  const nextStepsBorderClass = "mt-6 border-t border-structure-on-canvas pt-5";

  // The primary action on a match: a prominent green CTA so opening the official
  // listing (where you actually apply) is the obvious next step, not a quiet text
  // link. Uses the shared `success` token so it reads as a positive action in
  // both themes.
  const officialCtaClass =
    "mt-4 inline-flex items-center gap-2 rounded-lg bg-success px-5 py-3 font-display text-[15px] font-bold text-on-semantic shadow-sm transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2";

  // A3-lite — recipient company cells link out to the row's verified
  // SBIR.gov sourceUrl. Same underline affordance as `linkClass` but sized
  // for the table's font-mono text-[11px] context (no `mt-3 inline-block`
  // block spacing, which is meant for a standalone link below a paragraph).
  const recipientLinkClass =
    "underline underline-offset-2 hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-1";

  // Header toggle — the card's whole title row is one full-width <button>;
  // no existing dual-class const covered it before, so the focus ring is
  // added inline here.
  // ring-inset (not ring-offset) — this button is flush against the card's
  // own border on all sides, so an outside offset would bleed the ring past
  // the card edge.
  const headerToggleClass =
    "w-full px-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-inset sm:px-6 sm:py-5";

  // The "How can I apply?" control is a secondary/structure affordance — never
  // bg-action (reserved for the primary CTA). Sits in its own row, own
  // <button>, outside the header's full-width toggle button (see below).
  const howToApplyRowClass =
    "flex flex-wrap items-center gap-2 border-t border-structure-on-canvas px-4 py-3 sm:px-6";

  // Polish: real hover + a 40px min hit target (dense-desktop control), plus
  // optical padding (icon side 2px tighter than the text side).
  const howToApplyBtnClass =
    "inline-flex min-h-[40px] items-center gap-1.5 rounded-sm border border-structure-on-canvas bg-canvas pl-2 pr-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  // PRO-01: "Analyze competing companies" control — a light tint of the same
  // structure-on-canvas blue used for text/links throughout, so it reads as an
  // inviting, distinct action rather than blending into the plain bordered
  // secondary buttons ("How can I apply?") beside it.
  //
  // NOTE: structure-on-canvas resolves through a CSS custom property to a bare
  // hex string (see app/globals.css), which Tailwind's `/opacity` modifier
  // can't parse at build time -- `bg-structure-on-canvas/10` silently compiles
  // to NO rule at all (confirmed via a real production build; the same
  // silent-no-op already affects AppSidebar.tsx's `/opacity` usage of this
  // token). `color-mix()` as an arbitrary value sidesteps that: it's real,
  // themeable CSS (mixes whatever the variable resolves to, light or dark,
  // against transparent) instead of a Tailwind-parsed modifier.
  const competitorBtnClass =
    "inline-flex items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--color-structure-on-canvas)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-structure-on-canvas)_10%,transparent)] px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-[color-mix(in_srgb,var(--color-structure-on-canvas)_20%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <article className={articleClass}>
      <span className={spineClass} aria-hidden />

      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={headerToggleClass}
      >
        {/* Mobile pass (N4): flex-wrap lets the score block drop to its own
            line under the title on narrow widths instead of being squeezed
            into a shrink-0 column beside a long program title. */}
        <div className="flex flex-wrap items-start justify-between gap-4 sm:flex-nowrap sm:gap-6">
          <div className="min-w-0">
            <span className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${badgeClass}`}>
              {TIER_LABEL[m.tier]}
            </span>
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

          <div className="shrink-0 text-right">
            {/* ANALYZING ring (§5) — `final === false` means Pass A scored this
                candidate but it's promoted for Pass B, which may still change
                its score. Once the final score lands, the ring fades out
                (see the state above) before it stops rendering. */}
            {showRing ? (
              <AnalyzingRing fading={fading}>
                <div
                  role="status"
                  aria-label={`Analyzing, ${m.score}%, score may change`}
                  className="font-display text-[26px] font-bold leading-none tabular-nums text-foreground"
                >
                  {m.score}
                  <span className="text-[15px] font-medium">%</span>
                </div>
              </AnalyzingRing>
            ) : (
              <div className="font-display text-[26px] font-bold leading-none tabular-nums text-foreground">
                {m.score}
                <span className="text-[15px] font-medium">%</span>
              </div>
            )}
            <div className={eyebrowClass("mt-1")}>match</div>
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
          {/* Data-freshness — the committed corpus is a point-in-time snapshot;
              a deadline now in the past is flagged honestly rather than shown
              as if current. Evergreen-safe, and mutually exclusive with the
              "closing soon" chip above (that requires a future deadline). */}
          {deadlinePassed && (
            <span className={deadlinePassedClass}>Deadline passed — verify current status</span>
          )}
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

        {/* A dedicated, unmistakable expand/collapse row — the header used to
            rely on a small 16px chevron floating next to the score, easy to
            miss among the badge/title/score/dl above. This is deliberately its
            OWN visually separated strip (border + text label + a bigger
            chevron) so it reads as "click here to see more," not just a
            decorative arrow. Still inside the same full-width toggle button —
            clicking anywhere in the header still works exactly as before. */}
        <div className={eyebrowClass("mt-4 flex items-center gap-1.5 border-t border-structure-on-canvas pt-3")}>
          {open ? "Hide details" : "Show details"}
          <ChevronIcon className={`h-5 w-5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/*
        Rendered as its own row, its own <button>, OUTSIDE the header toggle
        button above (which is already a full-width <button> — nesting a
        second interactive button inside it would be invalid HTML). Visible on
        every card regardless of expand state. Read-only: opens a reference
        modal, never submits anything.
      */}
      <div className={howToApplyRowClass}>
        <button
          type="button"
          onClick={() => setHowToApplyOpen(true)}
          aria-haspopup="dialog"
          className={howToApplyBtnClass}
        >
          How can I apply?
        </button>
      </div>

      {howToApplyOpen && (
        <HowToApplyModal match={m} onClose={() => setHowToApplyOpen(false)} />
      )}

      {competitorOpen && (
        <CompetitorAnalysisModal
          onClose={() => setCompetitorOpen(false)}
          // R5-deep: thread the user's profile + this opportunity so a Max-tier
          // user (with the r5_deep_analysis flag on) can run a live, personalized
          // brief. Keywords prefer the gov-vocabulary expandedTerms the
          // retrieval is tuned for.
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
                  <span className={c.met ? "text-foreground" : criterionMutedClass}>{c.label}</span>
                </li>
              ))}
            </ul>
          )}

          <Section title="Why we think you're a fit" body={m.whyFit} />

          {/*
            AUTHORITY (§1 #5): the deterministic screening determination is the
            source of truth for eligibility. It renders ABOVE the model
            "ineligible" narrative, which is subordinate to it.
          */}
          {detMeta && (
            <DeterminationAuthority
              meta={detMeta}
              steps={determination?.required_steps ?? []}
              caveat={freshnessCaveat}
            />
          )}

          <Section
            title="What could make you ineligible"
            body={ineligible}
            accent
            note={
              detMeta
                ? "Model assessment — a generated read on possible concerns. It is SUBORDINATE to the eligibility screening above (the authority) and can never state a determination the screening didn't make."
                : "Model assessment — a generated read on possible concerns, not a cited rule or a formal eligibility determination. Confirm requirements with the program officer."
            }
          />
          <Section title="What you should verify" body={m.whatToVerify} />

          {m.history && (
            <div className={historyBorderClass}>
              <p className={eyebrowClass("mb-3")}>Similar companies funded</p>
              <div className="mb-4 flex flex-wrap gap-x-5 gap-y-3 sm:gap-x-8">
                <Stat n={m.history.similarCompanies} label="similar companies" />
                <Stat n={money(m.history.totalAwarded)} label="total awarded" />
                <Stat n={money(m.history.medianAward)} label="median award" />
                <Stat n={m.history.inState} label="in Utah" />
                <Stat n={m.history.inVertical} label="in your vertical" />
              </div>

              {isFlagEnabled("r5_deep_analysis") && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCompetitorOpen(true)}
                    aria-haspopup="dialog"
                    className={competitorBtnClass}
                  >
                    Analyze competing companies
                  </button>
                </div>
              )}

              <ScrollFadeContainer fadeBg="canvas-alt" ariaLabel="Scroll to see amount and year">
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
                        <td className="py-1.5 text-right text-foreground">{r.year}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollFadeContainer>
            </div>
          )}

          {(nextSteps || o.url) && (
            <div className={nextStepsBorderClass}>
              <p className={eyebrowClass("mb-2")}>What to do next</p>
              {nextSteps && <p className="text-pretty font-body text-[14px] leading-relaxed">{nextSteps}</p>}
              {o.url && (
                <a href={o.url} target="_blank" rel="noreferrer" className={officialCtaClass}>
                  Open the official listing
                  <span aria-hidden="true">&rarr;</span>
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Section({ title, body, accent, note }: { title: string; body?: string; accent?: boolean; note?: string }) {
  if (!body || !body.trim()) return null;
  // Ineligibility factors are a blocking/cautionary signal -> `error`, used
  // here as a 2px left border (non-text, 3:1 threshold — passes; see the
  // TIER_BADGE comment for why the same tokens can't be bare small text).
  const accentClass = accent ? "border-l-2 border-error pl-4" : "";
  const bodyClass = "text-pretty font-body text-[14px] leading-relaxed text-foreground";
  // Provenance note (R8.4 spirit): mark uncited model-recall blocks as a model
  // assessment so a generated concern doesn't read as an authoritative,
  // rule-grounded determination — mirrors EligibilityBuckets' ProvenanceNote.
  const noteClass =
    "mt-1.5 font-body text-[11px] italic leading-relaxed text-foreground";
  return (
    <div className={`mb-5 ${accentClass}`}>
      <p className={eyebrowClass("mb-1.5")}>{title}</p>
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
  meta,
  steps,
  caveat,
}: {
  meta: { label: string; meaning: string; chip: string };
  steps: { step: string; lead_time_days?: number; why?: string }[];
  caveat: string | null;
}) {
  const wrapClass = "rounded-md bg-canvas px-4 py-3";
  const headingClass = "font-display text-[15px] font-semibold leading-snug text-foreground";
  const meaningClass = "mt-1 text-pretty font-body text-[13px] leading-relaxed text-foreground";
  const stepTextClass = "font-body text-[13px] font-medium leading-snug text-foreground";
  const stepWhyClass = "mt-0.5 font-body text-[12px] leading-relaxed text-foreground";
  const chipClass = `inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${meta.chip}`;
  const leadChipClass =
    "inline-block shrink-0 rounded-sm bg-info px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow tabular-nums text-on-semantic";
  const caveatClass =
    "mt-2 border-l-2 border-warning pl-3 font-body text-[12px] italic leading-relaxed text-foreground";

  return (
    <div className="mb-5">
      <p className={eyebrowClass("mb-1.5")}>Eligibility screening &middot; the authority</p>
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

/** Expand/collapse chevron; caller applies `rotate-180` when expanded. */
export function ChevronIcon({ className }: { className?: string }) {
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

function Stat({ n, label }: { n: number | string; label: string }) {
  const numberClass = "font-display text-[20px] font-bold leading-none tabular-nums text-foreground";
  return (
    <div>
      <div className={numberClass}>{n}</div>
      <div className={eyebrowClass("mt-1")}>{label}</div>
    </div>
  );
}
