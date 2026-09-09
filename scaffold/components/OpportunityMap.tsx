"use client";
import { Component, type ReactNode } from "react";
import OpportunityCard from "./OpportunityCard";
import EligibilityBuckets, { type EligibilityItem } from "./EligibilityBuckets";
import SimilarCompanies from "./SimilarCompanies";
import AgencyMap from "./AgencyMap";
import OpportunityGroups from "./OpportunityGroups";
import OpportunityGraph from "./OpportunityGraph";
import FundingStrategy from "./FundingStrategy";
import OpportunityAlerts from "./OpportunityAlerts";
import type { OpportunityMap as MapT, Match } from "@/lib/types";
import { isFlagEnabled } from "@/lib/flags";
import { aggregateSimilarCompanies } from "@/lib/similar/aggregate";
import { fundingCell, closingSoonCount, expiredCount } from "@/lib/ui/opportunitySummary";
import { corpusAsOf } from "@/lib/corpus/meta";

/** Cards to render. We never wall the founder with the 20+ "none" rows. */
const CARD_CAP = 8;

/** FE-01: shared "eyebrow"-style mono label, token-driven when r7_design is on. */
function eyebrowClass(design: boolean, extra = "") {
  return design
    ? `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim()
    : `eyebrow ${extra}`.trim();
}

/** Small boundary so a malformed match can't white-screen the whole demo. */
class Boundary extends Component<{ children: ReactNode; design: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      const cls = this.props.design
        ? "mt-8 border-l-2 border-error bg-canvas-alt px-4 py-3 font-body text-sm text-foreground"
        : "mt-8 border-l-2 border-fit-adjacent bg-white px-4 py-3 font-body text-sm text-ink";
      return (
        <p className={cls}>
          We hit a snag rendering these results. Try rephrasing your description and running it again.
        </p>
      );
    }
    return this.props.children;
  }
}

export default function OpportunityMap({ map }: { map: MapT }) {
  if (!map || typeof map !== "object") return null;

  // FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the
  // DEFAULT on this A/B branch (previously gated behind r7_design). v1 fallback
  // branches are retained but unreachable.
  const design = true;

  // R8 / ELG-04: gates the three-bucket eligibility DISPLAY. Off = today's
  // results unchanged; the determinations still ride on each match, just unshown.
  const r8 = isFlagEnabled("r8_eligibility");

  const matches: Match[] = Array.isArray(map.matches) ? map.matches : [];
  const followUps: string[] = Array.isArray(map.followUps) ? map.followUps : [];
  const agencyIntelligence = Array.isArray(map.agencyIntelligence) ? map.agencyIntelligence : [];
  const w = map.weakFieldFinding;

  // D1 — free aggregate "Similar companies funded" panel. Pure/hermetic:
  // dedupes provenance-verified award recipients across the strong matches
  // (falling back to all matches if none of the strong ones have verified
  // recipients), independent of the paid, Max-gated CompetitorAnalysisModal /
  // CompetitorResults deep-analysis flow, which this never reads or affects.
  const similarRecipients = aggregateSimilarCompanies(matches, { limit: 10 });

  // Cards: real fits only (likely / verify / adjacent), best first, capped.
  const shown = matches
    .filter((m) => m && m.tier !== "none")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, CARD_CAP);

  // Header stats derived from what we render — keeps them honest and consistent.
  const highPotential = shown.filter((m) => m.tier === "likely" || m.tier === "verify").length;
  // Evergreen-safe (F1): a rolling/continuous/standing program is never
  // counted here, even if a stray deadline-shaped value is present on the
  // record — see closingSoonCount/isClosingSoon in lib/ui/opportunitySummary.
  const closingSoon = closingSoonCount(shown);
  const funding = fundingCell(shown);
  // Data-freshness: how many of the shown cards have a deadline now in the past
  // (evergreen/forecasted-safe). The committed corpus is a point-in-time
  // snapshot; when it has aged, say so plainly instead of presenting stale
  // deadlines as current. Works on cached/precomputed maps too — it reads only
  // `m.opportunity.deadline`, which every map shape carries.
  const expired = expiredCount(shown);
  // The corpus "as of" stamp (from data/corpus-meta.json). `null` when the
  // stamp is absent/invalid — the footer then degrades to a date-free caveat.
  const asOf = corpusAsOf();

  // R8 / ELG-04: map the REAL determinations attached by buildOpportunityMap
  // (screen() + freshness) into the FE-04 three-bucket display's item shape.
  // Only the shown opportunities are screened here — the same set the founder
  // sees as cards. Empty when the flag is off, or on cached maps that predate
  // the field (their matches simply carry no `eligibility`).
  const eligibilityItems: EligibilityItem[] = r8
    ? shown
        .filter((m) => m.eligibility)
        .map((m) => ({
          determination: m.eligibility!.determination,
          title: m.opportunity?.title ?? m.opportunity?.program,
          agency: m.opportunity?.agency,
          // ELG-02: carry the freshness caveat through so a stale/unverified
          // determination is visibly flagged rather than dropped (§4.5/§11).
          // `caveat` is null when the determination is fresh.
          caveat: m.eligibility!.freshness?.caveat ?? null,
        }))
    : [];

  // The stat band keeps its hairline grid (gap-px over a navy fill = structural
  // cell separators), now clipped to a rounded, softly-elevated card.
  const statGridClass = design
    ? "grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-structure-on-canvas bg-structure-on-canvas shadow-card sm:grid-cols-4"
    : "grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4";

  // "A finding, not a dead end" is the honest-no hero panel — navy structure
  // fill (white content on top), same pairing as the header/nav per R7.2.
  // Polish: rounded + elevation instead of a same-color border.
  const weakFieldClass = design
    ? "mt-8 rounded-lg bg-structure px-5 py-6 text-token-white shadow-card sm:px-7 sm:py-7"
    : "mt-8 border border-ink bg-ink px-5 py-6 text-paper sm:px-7 sm:py-7";

  const weakFieldBodyClass = design
    ? "mt-3 max-w-2xl text-pretty font-body text-[15px] leading-relaxed text-token-white"
    : "mt-3 max-w-2xl font-body text-[15px] leading-relaxed text-paper/85";

  // Full-opacity token.white throughout the panel rather than opacity
  // modifiers: Tailwind can't precompute alpha for CON-02's CSS-var-backed
  // colors at build time (only for v1's literal-hex theme colors), so an
  // opacity slash on these tokens silently doesn't apply. De-emphasis in v2
  // comes from type hierarchy, not color-fade.
  const redirectItemClass = design ? "border-l-2 border-token-white pl-4" : "border-l-2 border-paper/25 pl-4";

  const redirectWhyClass = design
    ? "mt-1 text-pretty font-body text-[13px] leading-relaxed text-token-white"
    : "mt-1 font-body text-[13px] leading-relaxed text-paper/70";

  const followUpsSectionClass = design
    ? "mt-8 rounded-lg bg-canvas-alt px-4 py-5 shadow-card sm:px-6"
    : "mt-8 border border-rule bg-white px-4 py-5 sm:px-6";

  const followUpItemClass = design
    ? "text-pretty font-body text-[14px] text-foreground"
    : "font-body text-[14px] text-slate-550";

  const agenciesSectionClass = design
    ? "mt-10 border-t border-structure-on-canvas pt-7"
    : "mt-10 border-t border-rule pt-7";

  // D1 — same section rhythm as "Agencies most relevant to you" above it.
  const similarCompaniesCaptionClass = design
    ? "mt-1.5 max-w-2xl text-pretty font-body text-[13px] leading-relaxed text-foreground"
    : "mt-1.5 max-w-2xl font-body text-[13px] leading-relaxed text-slate-550";

  const footerClass = design
    ? "mt-10 border-t border-structure-on-canvas pt-5 text-pretty font-body text-[12px] leading-relaxed text-foreground"
    : "mt-10 border-t border-rule pt-5 font-body text-[12px] leading-relaxed text-slate-550";

  return (
    <Boundary design={design}>
      <div className="reveal">
        {/* On a weak-field finding the honest panel is the hero — an empty
            "0 / $0" band above it would read as a failed query, so we drop it. */}
        {!w && (
          <div className={statGridClass}>
            <Cell design={design} n={String(highPotential)} label="high-potential opportunities" />
            {funding && <Cell design={design} n={funding.n} label={funding.label} />}
            <Cell design={design} n={String(agencyIntelligence.length)} label="relevant agencies" />
            <Cell design={design} n={String(closingSoon)} label="closing within 90 days" />
          </div>
        )}

        {/* Data-freshness: when any shown match has a passed deadline, say so
            once, plainly, up front — "verify," never "these are dead." The
            committed corpus is a point-in-time snapshot, so a stale deadline is
            expected on an aging clone; this caveat plus the per-card badge keep
            it honest instead of letting it read as current. */}
        {expired > 0 && (
          <p
            role="note"
            className={
              design
                ? "mt-4 border-l-2 border-warning pl-3 font-body text-[13px] leading-relaxed text-foreground"
                : "mt-4 border-l-2 border-fit-adjacent pl-3 font-body text-[13px] leading-relaxed text-slate-550"
            }
          >
            {expired === 1 ? "1 of these has a passed deadline" : `${expired} of these have passed deadlines`} —
            verify current status on the official source before applying.
          </p>
        )}

        {/* The honest no. Deliberate, not an error state. */}
        {w && (
          <section className={weakFieldClass}>
            <p className={eyebrowClass(design)}>A finding, not a dead end</p>
            <h2 className="mt-3 text-balance font-display text-[20px] font-medium leading-snug sm:text-[24px]">{w.headline}</h2>
            <p className={weakFieldBodyClass}>{w.reasoning}</p>

            {w.redirects?.length > 0 && (
              <>
                <p className={eyebrowClass(design, "mt-7")}>Where to look instead</p>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2">
                  {w.redirects.map((r, i) => (
                    <li key={i} className={redirectItemClass}>
                      <p className="text-balance font-display text-[15px] font-medium">{r.label}</p>
                      <p className={redirectWhyClass}>{r.why}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {/* D5 — "Since your last visit" alerts: new matches / tier upgrades /
            newly closing-soon, diffed client-only against a localStorage
            snapshot of the founder's last run. Default-off; all logic lives
            in OpportunityAlerts.tsx + lib/alerts/*. */}
        {isFlagEnabled("d5_alerts") && <OpportunityAlerts map={map} />}

        {followUps.length > 0 && (
          <section className={followUpsSectionClass}>
            <p className={eyebrowClass(design, "mb-3")}>A few things would sharpen this</p>
            <ul className="space-y-2">
              {followUps.map((q, i) => (
                <li key={i} className={followUpItemClass}>{q}</li>
              ))}
            </ul>
          </section>
        )}

        {shown.length > 0 && (
          <section className="mt-8">
            <p className={eyebrowClass(design, "mb-4")}>
              {w ? "Adjacent and partial matches" : "Your opportunity map"}
            </p>
            {/* C1b — founder-facing type filters + grouping by kind, flag-gated
                (default off). All logic lives in OpportunityGroups + lib/
                opportunities/group.ts; the flat list stays the baseline. */}
            {isFlagEnabled("c1b_type_groups") ? (
              <OpportunityGroups matches={shown} startupProfile={map.profile} />
            ) : (
              <div className="space-y-3">
                {shown.map((m, i) => (
                  // G5: thread the founder's extracted v1 profile down so the
                  // assisted-apply "Draft my application" flow can assemble a
                  // grounded package from real data (bridged to a §3.1
                  // CompanyProfile inside OpportunityCard). Absent → honest gaps.
                  <OpportunityCard key={m.opportunity?.id ?? i} m={m} index={i} startupProfile={map.profile} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* R8 / ELG-04: real three-bucket eligibility screening for the shown
            opportunities, gated behind r8_eligibility (default off). */}
        {r8 && eligibilityItems.length > 0 && (
          <section className={agenciesSectionClass}>
            <p className={eyebrowClass(design, "mb-4")}>Eligibility screening</p>
            <EligibilityBuckets items={eligibilityItems} />
          </section>
        )}

        {/* D2 — "Agencies most relevant to you": presentation-layer only, reads
            the EXISTING agencyIntelligence + matches already computed by
            buildOpportunityMap (lib/match.ts). See components/AgencyMap.tsx. */}
        <AgencyMap agencyIntelligence={agencyIntelligence} matches={matches} />

        {/* D3 — "Your 12-month funding strategy": presentation-only, derived from
            the EXISTING map by the pure lib/strategy/fundingStrategy.ts. Gated
            behind the default-off d3_funding_strategy flag. */}
        {isFlagEnabled("d3_funding_strategy") && <FundingStrategy map={map} />}

        {/* D1 — free aggregate panel, NEVER Max-gated (no useBilling / useEntitlements
            read here or in SimilarCompanies). Honestly labeled: a rollup of verified
            public federal award records, not a personalized/live competitor analysis —
            that stays the separate Maximum-gated CompetitorAnalysisModal /
            CompetitorResults flow, untouched by this section. */}
        {similarRecipients.length > 0 && (
          <section className={agenciesSectionClass}>
            <p className={eyebrowClass(design, "mb-1")}>Companies like yours that received federal funding</p>
            <p className={similarCompaniesCaptionClass}>
              Verified public federal award records, deduped across your strongest matches — each row links to
              its official source record. Not a personalized competitor analysis.
            </p>
            <div className="mt-4">
              <SimilarCompanies recipients={similarRecipients} />
            </div>
          </section>
        )}

        {/* D4 — compact Startup -> Technology -> Agency -> Program -> Award
            node-link graph over the SAME map data rendered above. Default
            OFF behind d4_opportunity_graph; see components/OpportunityGraph.tsx. */}
        {isFlagEnabled("d4_opportunity_graph") && <OpportunityGraph map={map} />}

        <div className={footerClass}>
          {/* Data-freshness "as of" surface: the corpus ships committed and is a
              point-in-time snapshot, so we stamp WHEN it was built and always
              route the founder to the official source for the live deadline —
              never presenting the snapshot as if it were current. Safe fallback:
              a date-free caveat when the corpus-meta stamp is absent/invalid. */}
          <p>
            {asOf
              ? `Opportunities as of ${asOf.label} — always verify current deadlines on the official source.`
              : "Always verify current deadlines on the official source — this opportunity data is a point-in-time snapshot."}
          </p>
          <p className="mt-2">
            These are assessments, not eligibility determinations. Confirm requirements with the
            program officer before you invest time in an application.
          </p>
        </div>
      </div>
    </Boundary>
  );
}

function Cell({ design, n, label }: { design: boolean; n: string; label: string }) {
  // Mobile pass (N4): tighter padding + a smaller number size at phone
  // widths so a 2-up stat grid (grid-cols-2 below sm) doesn't crowd or wrap
  // longer figures like "$1.2M+ potential funding identified".
  const cellClass = design
    ? "bg-canvas-alt px-3 py-4 text-foreground sm:px-5 sm:py-6"
    : "bg-paper px-3 py-4 sm:px-5 sm:py-6";
  return (
    <div className={cellClass}>
      <div className="font-display text-[22px] font-bold leading-none tabular-nums sm:text-[30px]">{n}</div>
      <div className={eyebrowClass(design, "mt-2 leading-snug")}>{label}</div>
    </div>
  );
}
