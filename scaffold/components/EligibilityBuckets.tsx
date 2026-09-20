"use client";
import type {
  EligibilityBucket,
  EligibilityDetermination,
  RequiredStep,
  RuleEvaluation,
} from "@/lib/contracts/eligibilityDetermination";
import type { Citation, Provenance } from "@/lib/contracts/primitives";

/**
 * FE-04 — the three-bucket eligibility DISPLAY (R8.2 / R7.3).
 *
 * Pure presentational component: it renders `EligibilityDetermination`
 * objects (already produced by lib/eligibility/screen.ts, the ELG-01 engine)
 * grouped into buckets. It does not screen anything itself.
 *
 * WIRING screen() into the live pipeline (lib/match.ts / OpportunityMap) so
 * real determinations reach this component is a later integration task — see
 * app/demo/eligibility/page.tsx, which renders this against fixture data only.
 */

export type EligibilityItem = {
  determination: EligibilityDetermination;
  title?: string;
  agency?: string;
  /**
   * ELG-02 freshness caveat (from annotateFreshness). Non-null when the
   * determination was made against stale/unverified data — §4.5/§11 require it
   * be VISIBLY FLAGGED, never presented as if current. Rendered per-card below.
   */
  caveat?: string | null;
};

const BUCKET_ORDER: EligibilityBucket[] = [
  "eligible",
  "conditionally_eligible",
  "unknown",
  "excluded",
];

const BUCKET_META: Record<EligibilityBucket, { heading: string; badgeLabel: string; intro: string }> = {
  eligible: {
    heading: "Eligible",
    badgeLabel: "Eligible",
    intro: "Every gate we have a rule for is met.",
  },
  conditionally_eligible: {
    heading: "Conditionally eligible",
    badgeLabel: "Action needed",
    intro: "Reachable — complete the step below and this opens up.",
  },
  unknown: {
    heading: "Needs more info",
    badgeLabel: "Needs info",
    intro: "We won't guess. Confirm these and we'll screen them.",
  },
  excluded: {
    heading: "Excluded",
    badgeLabel: "Excluded",
    intro: "Named reason, cited rule — never a silent drop.",
  },
};

/** Shared "eyebrow"-style mono label, token-driven when r7_design is on (matches OpportunityCard/Map). */
function eyebrowClass(design: boolean, extra = "") {
  return design
    ? `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim()
    : `eyebrow ${extra}`.trim();
}

export default function EligibilityBuckets({ items }: { items: EligibilityItem[] }) {
  // FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the DEFAULT
  // on this A/B branch (previously gated behind r7_design). v1 fallback branches
  // are retained but unreachable.
  const design = true;

  const groups = new Map<EligibilityBucket, EligibilityItem[]>();
  for (const item of items ?? []) {
    const bucket = item.determination.bucket;
    const list = groups.get(bucket) ?? [];
    list.push(item);
    groups.set(bucket, list);
  }

  const nonEmptyBuckets = BUCKET_ORDER.filter((b) => (groups.get(b) ?? []).length > 0);

  if (nonEmptyBuckets.length === 0) {
    const emptyClass = design
      ? "font-body text-[14px] text-foreground"
      : "font-body text-[14px] text-slate-550";
    return <p className={emptyClass}>No opportunities have been screened yet.</p>;
  }

  return (
    <div>
      {nonEmptyBuckets.map((bucket) => {
        const group = groups.get(bucket)!;
        const meta = BUCKET_META[bucket];
        const headingClass = design
          ? "text-balance font-display text-[22px] font-bold leading-tight text-foreground"
          : "font-display text-[22px] font-bold leading-tight text-ink";
        const countClass = design
          ? "ml-2 font-mono text-[13px] font-normal tabular-nums text-foreground"
          : "ml-2 font-mono text-[13px] font-normal text-slate-550";
        const introClass = design
          ? "mt-1 text-pretty font-body text-[13px] leading-relaxed text-foreground"
          : "mt-1 font-body text-[13px] leading-relaxed text-slate-550";

        return (
          <section key={bucket} className="mt-10 first:mt-0">
            <h2 className={headingClass}>
              {meta.heading}
              <span className={countClass}>({group.length})</span>
            </h2>
            <p className={introClass}>{meta.intro}</p>

            <div className="mt-4 space-y-4">
              {group.map((item, i) => (
                <BucketCard key={item.determination.opportunity_id ?? i} item={item} design={design} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-bucket card
// ---------------------------------------------------------------------------

function spineClass(design: boolean, bucket: EligibilityBucket): string {
  // v2: the spine is a neutral structural accent — the bucket's semantic color
  // is carried entirely by the filled badge below (see BucketBadge; the CON-02
  // token contract only guarantees AA contrast for semantic tokens used as
  // filled chips, never as a bare border/accent directly on canvas).
  if (design) return "absolute left-0 top-0 h-full w-[3px] bg-structure-on-canvas";
  switch (bucket) {
    case "eligible":
      return "absolute left-0 top-0 h-full w-[3px] bg-fit-strong";
    case "conditionally_eligible":
      return "absolute left-0 top-0 h-full w-[3px] bg-fit-verify";
    case "unknown":
      return "absolute left-0 top-0 h-full w-[3px] bg-fit-adjacent";
    case "excluded":
      // v1 has no red token (R7.2 deliberately drops decorative red) — excluded
      // reads as neutral/slate with a thicker accent, not a color, per CON-02.
      return "absolute left-0 top-0 h-full w-1.5 bg-slate-550";
  }
}

function BucketBadge({ design, bucket }: { design: boolean; bucket: EligibilityBucket }) {
  const label = BUCKET_META[bucket].badgeLabel;
  if (design) {
    const chip: Record<EligibilityBucket, string> = {
      eligible: "bg-success text-on-semantic",
      conditionally_eligible: "bg-info text-on-semantic",
      unknown: "bg-warning text-on-semantic",
      excluded: "bg-error text-token-white",
    };
    return (
      <span
        className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${chip[bucket]}`}
      >
        {label}
      </span>
    );
  }
  const textColor: Record<EligibilityBucket, string> = {
    eligible: "text-fit-strong",
    conditionally_eligible: "text-fit-verify",
    unknown: "text-fit-adjacent",
    excluded: "text-slate-550",
  };
  return (
    <span className={`font-mono text-[11px] uppercase tracking-eyebrow ${textColor[bucket]}`}>{label}</span>
  );
}

function BucketCard({ item, design }: { item: EligibilityItem; design: boolean }) {
  const { determination, title, agency, caveat } = item;
  const bucket = determination.bucket;

  const cardClass = design
    ? "relative overflow-hidden rounded-lg bg-canvas-alt px-6 py-5 text-foreground shadow-card"
    : "relative border border-rule bg-white px-6 py-5";

  const titleClass = design
    ? "mt-1.5 text-balance font-display text-[17px] font-medium leading-snug text-foreground"
    : "mt-1.5 font-display text-[17px] font-medium leading-snug";

  const agencyClass = design
    ? "mt-0.5 text-pretty font-mono text-[12px] text-foreground"
    : "mt-0.5 font-mono text-[12px] text-slate-550";

  return (
    <article className={cardClass}>
      <span className={spineClass(design, bucket)} aria-hidden />

      <BucketBadge design={design} bucket={bucket} />
      {title && <h3 className={titleClass}>{title}</h3>}
      {agency && <p className={agencyClass}>{agency}</p>}

      {caveat && (
        <p
          role="note"
          className={
            design
              ? "mt-2 border-l-2 border-warning pl-3 font-body text-[12px] italic leading-relaxed text-foreground"
              : "mt-2 border-l-2 border-fit-adjacent pl-3 font-body text-[12px] italic leading-relaxed text-slate-550"
          }
        >
          <span className="font-mono uppercase tracking-eyebrow not-italic">Data freshness</span>{" "}
          — {caveat}
        </p>
      )}

      <div className="mt-4">
        {bucket === "eligible" && <EligibleBody determination={determination} design={design} />}
        {bucket === "conditionally_eligible" && (
          <ConditionalBody determination={determination} design={design} />
        )}
        {bucket === "unknown" && <UnknownBody determination={determination} design={design} />}
        {bucket === "excluded" && <ExcludedBody determination={determination} design={design} />}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Eligible — positive/settled. Shows what's already met.
// ---------------------------------------------------------------------------

function EligibleBody({
  determination,
  design,
}: {
  determination: EligibilityDetermination;
  design: boolean;
}) {
  return <SatisfiedList rules={determination.satisfied_rules} design={design} />;
}

// ---------------------------------------------------------------------------
// Conditionally eligible — reads as an actionable next step, not a warning.
// ---------------------------------------------------------------------------

function ConditionalBody({
  determination,
  design,
}: {
  determination: EligibilityDetermination;
  design: boolean;
}) {
  const stepHeadingClass = eyebrowClass(design);
  return (
    <div>
      {determination.required_steps.length > 0 && (
        <div>
          <p className={stepHeadingClass}>What to do next</p>
          <ul className="mt-2 space-y-3">
            {determination.required_steps.map((step, i) => (
              <RequiredStepLine key={`${step.step}-${i}`} step={step} design={design} />
            ))}
          </ul>
        </div>
      )}
      <SatisfiedList
        rules={determination.satisfied_rules}
        design={design}
        heading="What's already met"
        extraClass="mt-5"
      />
    </div>
  );
}

function RequiredStepLine({ step, design }: { step: RequiredStep; design: boolean }) {
  const leadTime =
    typeof step.lead_time_days === "number"
      ? `~${step.lead_time_days} day${step.lead_time_days === 1 ? "" : "s"}`
      : null;

  const chipClass = design
    ? "inline-block shrink-0 rounded-sm bg-info px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow tabular-nums text-on-semantic"
    : "inline-block shrink-0 rounded-sm border border-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow text-slate-550";

  const stepTextClass = design
    ? "font-body text-[14px] font-medium leading-snug text-foreground"
    : "font-body text-[14px] font-medium leading-snug text-ink";

  const whyClass = design
    ? "mt-1 font-body text-[13px] leading-relaxed text-foreground"
    : "mt-1 font-body text-[13px] leading-relaxed text-slate-550";

  return (
    <li>
      <div className="flex flex-wrap items-center gap-2">
        <span className={stepTextClass}>{step.step}</span>
        {leadTime && <span className={chipClass}>{leadTime}</span>}
      </div>
      {step.why && <p className={whyClass}>{step.why}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Unknown — "eligibility depends on X — tell us and we'll screen this."
// Never a guess in either direction.
// ---------------------------------------------------------------------------

function UnknownBody({
  determination,
  design,
}: {
  determination: EligibilityDetermination;
  design: boolean;
}) {
  const itemClass = design
    ? "border-l-2 border-structure-on-canvas pl-4 py-0.5"
    : "border-l-2 border-rule pl-4 py-0.5";
  const bodyClass = design
    ? "font-body text-[14px] leading-relaxed text-foreground"
    : "font-body text-[14px] leading-relaxed text-ink";

  return (
    <div>
      <p className={eyebrowClass(design)}>Eligibility depends on</p>
      <ul className="mt-2 space-y-3">
        {determination.unknown_rules.map((rule, i) => (
          <li key={rule.rule_id ?? i} className={itemClass}>
            <p className={bodyClass}>{rule.description}</p>
            <ProvenanceNote provenance={rule.provenance} design={design} />
          </li>
        ))}
      </ul>
      <p
        className={
          design
            ? "mt-3 font-body text-[12px] italic leading-relaxed text-foreground"
            : "mt-3 font-body text-[12px] italic leading-relaxed text-slate-550"
        }
      >
        Tell us and we&rsquo;ll screen this — we never guess eligible or ineligible.
      </p>
      <SatisfiedList
        rules={determination.satisfied_rules}
        design={design}
        heading="What's already met"
        extraClass="mt-5"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Excluded — the reason, always shown. Collapsed detail is fine, the
// opportunity + its bucket are never hidden.
// ---------------------------------------------------------------------------

function ExcludedBody({
  determination,
  design,
}: {
  determination: EligibilityDetermination;
  design: boolean;
}) {
  const summaryClass = design
    ? "cursor-pointer font-body text-[14px] font-medium leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "cursor-pointer font-body text-[14px] font-medium leading-snug text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  return (
    <details>
      <summary className={summaryClass}>Why this is excluded</summary>
      <ul className="mt-3 space-y-4">
        {determination.failed_rules.map((rule, i) => (
          <RuleReasonLine key={rule.rule_id ?? i} rule={rule} design={design} />
        ))}
      </ul>
    </details>
  );
}

function RuleReasonLine({ rule, design }: { rule: RuleEvaluation; design: boolean }) {
  const bodyClass = design
    ? "font-body text-[14px] leading-relaxed text-foreground"
    : "font-body text-[14px] leading-relaxed text-ink";
  return (
    <li>
      <p className={bodyClass}>{rule.description}</p>
      <ProvenanceNote provenance={rule.provenance} design={design} verifiedNote />
      <CitationNote citation={rule.citation} design={design} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SatisfiedList({
  rules,
  design,
  heading = "What's already met",
  extraClass = "",
}: {
  rules: RuleEvaluation[];
  design: boolean;
  heading?: string;
  extraClass?: string;
}) {
  if (!rules || rules.length === 0) return null;
  const checkClass = design ? "text-foreground" : "text-fit-strong";
  const textClass = design ? "text-foreground" : "text-ink";
  return (
    <div className={extraClass}>
      <p className={eyebrowClass(design)}>{heading}</p>
      <ul className="mt-2 space-y-1.5">
        {rules.map((rule, i) => (
          <li key={rule.rule_id ?? i} className="flex gap-2 font-body text-[13px]">
            <span aria-hidden className={checkClass}>
              ✓
            </span>
            <span>
              <span className={textClass}>{rule.description}</span>
              <ProvenanceNote provenance={rule.provenance} design={design} inline />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Provenance honesty (R8.4's spirit): a `model_inferred` rule/evaluation is
 * never presented as a settled fact. `verifiedNote` additionally names
 * non-inferred provenance on excluded reasons, where the schema guarantees
 * it is always `verified` or `user_stated` — never model_inferred alone.
 */
function ProvenanceNote({
  provenance,
  design,
  inline = false,
  verifiedNote = false,
}: {
  provenance: Provenance;
  design: boolean;
  inline?: boolean;
  verifiedNote?: boolean;
}) {
  const mutedClass = design
    ? "font-body text-[11px] italic text-foreground"
    : "font-body text-[11px] italic text-slate-550";

  if (provenance === "model_inferred") {
    const text = "Model-inferred — needs review before this is treated as confirmed.";
    return inline ? (
      <span className={`ml-1.5 ${mutedClass}`}>({text})</span>
    ) : (
      <p className={`mt-0.5 ${mutedClass}`}>{text}</p>
    );
  }

  if (verifiedNote) {
    const text = provenance === "verified" ? "Verified against the source below." : "As stated by the user.";
    return <p className={`mt-0.5 ${mutedClass}`}>{text}</p>;
  }

  return null;
}

function CitationNote({ citation, design }: { citation?: Citation; design: boolean }) {
  if (!citation) return null;
  const label = citation.source_name ?? citation.source_url ?? "Source";
  const wrapClass = design
    ? "mt-1 font-mono text-[11px] text-foreground"
    : "mt-1 font-mono text-[11px] text-slate-550";
  const linkClass = design
    ? "text-structure-on-canvas underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "text-federal underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  return (
    <p className={wrapClass}>
      Source:{" "}
      {citation.source_url ? (
        <a href={citation.source_url} target="_blank" rel="noreferrer" className={linkClass}>
          {label}
        </a>
      ) : (
        label
      )}
      {citation.quote && <> — &ldquo;{citation.quote}&rdquo;</>}
    </p>
  );
}
