"use client";
// Explicit React import: needed under the plain `tsx`-run node:test runner
// (this repo's tsconfig `"jsx": "preserve"` falls back to the classic JSX
// runtime there) — see the same note in components/OpportunityCard.tsx.
import React, { useState } from "react";
import {
  parseCompetitorAnalysis,
  type AwardSource,
  type GroundedAwardRecord,
  type WebCompetitorProfile,
} from "@/lib/contracts/competitorAnalysis";
import { buildGrantProposalPrompt } from "@/lib/competitors/proposalPrompt";
import { printElement } from "@/lib/ui/printElement";

/**
 * R5 — Competitor & Grant Intelligence results renderer for a live
 * `/api/competitors` run: awardee cards (org · $amount · agency · a snippet of
 * the REAL abstract · a real, clickable source link), typical award-size
 * stats, optional private competitor web profiles (clearly labeled, never
 * awardees), tailored positioning recommendations, and gaps to exploit —
 * every insight with VISIBLE citations back to a real award record or web URL.
 *
 * ANTI-FABRICATION BOUNDARY: the payload is parsed through
 * `CompetitorAnalysisSchema` here at the component boundary. A competitor or a
 * cited claim that references an id not in the retrieved set THROWS at parse
 * time — so an ungrounded claim is impossible to render, not merely
 * discouraged.
 *
 * Two export actions, both client-only (no server round-trip, no new paid
 * calls): "Export as PDF" prints this whole view via the browser's own
 * print-to-PDF (lib/ui/printElement.ts); "Draft a grant-proposal prompt"
 * reformats the SAME already-grounded `data` this component renders from
 * into a text prompt (lib/competitors/proposalPrompt.ts) the user can copy
 * or print on its own — Granted hands over a prompt, it never drafts or
 * submits anything itself.
 */

const SOURCE_LABEL: Record<AwardSource, string> = {
  USAspending: "USAspending",
  "NIH RePORTER": "NIH RePORTER",
  NSF: "NSF",
  "Grants.gov": "Grants.gov",
};

function money(n: number | null): string {
  if (n == null) return "Amount not disclosed";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function snippet(text: string, max = 260): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/** A resolved citation target — either a real award record or a real web profile. */
type CitationTarget = { label: string; url: string; title: string };

export default function CompetitorResults({ raw }: { raw: unknown }) {
  // Boundary parse — an ungrounded/fabricated payload throws here and cannot render.
  const data = parseCompetitorAnalysis(raw);
  const byId = new Map<string, GroundedAwardRecord>(data.records.map((r) => [r.id, r]));
  const webById = new Map<string, WebCompetitorProfile>((data.webProfiles ?? []).map((p) => [p.id, p]));

  const [showPrompt, setShowPrompt] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  // Built from the SAME `data` already parsed above — no new fabrication
  // surface, just a reformat. Cheap (string concatenation over an already-
  // small payload), so computed inline rather than memoized.
  const proposalPrompt = buildGrantProposalPrompt(data);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(proposalPrompt);
      setCopyNote("Copied to clipboard.");
    } catch {
      setCopyNote("Couldn't copy — select the text above and copy it by hand.");
    }
  }

  const capturedDate = new Date(data.capturedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  /** Resolve a citation id to its clickable source (award record OR web profile). */
  function resolveCitation(id: string): CitationTarget | null {
    const rec = byId.get(id);
    if (rec) return { label: rec.recipient, url: rec.sourceUrl, title: `${rec.recipient} — ${SOURCE_LABEL[rec.source]}` };
    const web = webById.get(id);
    if (web) return { label: web.company, url: web.sourceUrl, title: `${web.company} — public web profile` };
    return null; // unreachable: the schema guarantees every citation resolves.
  }

  const chipClass =
    "inline-flex items-center rounded-sm border border-structure-on-canvas px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas";
  const sourceLinkClass =
    "inline-flex items-center gap-1 font-mono text-[11px] text-structure-on-canvas underline underline-offset-4 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const citationClass =
    "inline-flex items-center gap-1 rounded-sm border border-structure-on-canvas bg-canvas-alt px-1.5 py-0.5 font-mono text-[10px] text-structure-on-canvas underline underline-offset-2 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const stats = data.awardStats;

  const textBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <div className="print-section-competitor-analysis text-foreground">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => printElement("competitor-analysis")} className={textBtnClass}>
          Export as PDF
        </button>
        <button type="button" onClick={() => setShowPrompt((v) => !v)} className={textBtnClass}>
          {showPrompt ? "Hide grant-proposal prompt" : "Draft a grant-proposal prompt"}
        </button>
      </div>

      <div className="rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2 mt-4">
        <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
          Live analysis
        </p>
        <p className="mt-1 text-pretty font-body text-[12px] leading-relaxed text-foreground">
          Generated {capturedDate} from <strong>real public federal award data</strong> for your company.
          This is analysis — not a guarantee of funding — and every company below links to its official
          public award record so you can verify it.
        </p>
      </div>

      <p className="mt-4 font-body text-[13px] leading-relaxed text-foreground">
        <span className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
          Company
        </span>{" "}
        {data.persona} — {data.personaDescription}
      </p>

      {data.analysis.summary && (
        <p className="mt-4 text-pretty font-body text-[14px] leading-relaxed text-foreground">
          {data.analysis.summary}
        </p>
      )}

      {/* ── Typical award size ────────────────────────────────────────── */}
      {stats && stats.withAmount > 0 && (
        <section className="mt-6">
          <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
            Typical award size in your space
          </h3>
          <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
            Computed from {stats.withAmount} of {stats.count} retrieved award{stats.count === 1 ? "" : "s"} that
            disclosed a dollar amount.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="smallest" value={money(stats.minAmount)} />
            <Stat label="median" value={money(stats.medianAmount)} />
            <Stat label="largest" value={money(stats.maxAmount)} />
          </div>
        </section>
      )}

      {/* ── Awardee cards ─────────────────────────────────────────────── */}
      <section className="mt-6">
        <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
          Companies that won federal funding in your space
        </h3>
        <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
          How each positioned itself to win — grounded in a quote from its own public award record.
        </p>

        <ul className="mt-4 space-y-4">
          {data.analysis.competitors.map((c) => {
            const rec = byId.get(c.recordId);
            if (!rec) return null; // unreachable: the schema guarantees it exists.
            return (
              <li
                key={c.recordId}
                className="rounded-lg border border-structure-on-canvas bg-canvas-alt p-4 shadow-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-[15px] font-bold leading-snug text-foreground">
                      {rec.recipient}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-foreground">
                      {rec.agency}
                      {rec.year ? ` · ${rec.year}` : ""}
                      {rec.program ? ` · ${rec.program}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={chipClass}>{SOURCE_LABEL[rec.source]}</span>
                    <span className="font-mono text-[13px] font-bold tabular-nums text-foreground">
                      {money(rec.amount)}
                    </span>
                  </div>
                </div>

                <p className="mt-3 text-pretty font-body text-[13px] leading-relaxed text-foreground">
                  {c.positioning}
                </p>

                <blockquote className="mt-3 border-l-2 border-structure-on-canvas pl-3 font-body text-[12px] italic leading-relaxed text-foreground">
                  “{snippet(c.quotedSnippet, 320)}”
                </blockquote>

                <details className="mt-3 group">
                  <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2">
                    From the award abstract
                  </summary>
                  <p className="mt-2 text-pretty font-body text-[12px] leading-relaxed text-foreground">
                    {snippet(rec.abstract, 600)}
                  </p>
                </details>

                <div className="mt-3">
                  <a href={rec.sourceUrl} target="_blank" rel="noopener noreferrer" className={sourceLinkClass}>
                    View on {SOURCE_LABEL[rec.source]}
                    <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Private competitors (public web profiles — NOT awardees) ───── */}
      {data.webProfiles && data.webProfiles.length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
            Also in your space
          </h3>
          <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
            Private companies found via web search. These have <strong>no federal award on record</strong> —
            they are context, not awardees, and carry no dollar figure.
          </p>
          <ul className="mt-4 space-y-3">
            {data.webProfiles.map((p) => (
              <li key={p.id} className="rounded-lg border border-structure-on-canvas bg-canvas p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-display text-[14px] font-bold leading-snug text-foreground">{p.company}</p>
                  <span className={chipClass}>Public web profile · not a federal awardee</span>
                </div>
                <p className="mt-2 text-pretty font-body text-[12px] leading-relaxed text-foreground">
                  {snippet(p.snippet, 280)}
                </p>
                <div className="mt-3">
                  <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" className={sourceLinkClass}>
                    View source
                    <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Tailored positioning feedback with visible citations ──────── */}
      <section className="mt-8">
        <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
          What to emphasize
        </h3>
        <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
          Tailored to {data.persona}. Each recommendation cites the record(s) it draws from.
        </p>

        <ol className="mt-4 space-y-4">
          {data.analysis.recommendations.map((rec, i) => (
            <li key={i} className="rounded-lg border border-structure-on-canvas bg-canvas p-4">
              <p className="text-pretty font-body text-[13px] leading-relaxed text-foreground">{rec.advice}</p>
              <CitationRow citations={rec.citations} resolve={resolveCitation} className={citationClass} />
            </li>
          ))}
        </ol>
      </section>

      {/* ── Gaps / whitespace opportunities ───────────────────────────── */}
      {data.analysis.opportunities && data.analysis.opportunities.length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
            Gaps to exploit
          </h3>
          <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
            Whitespace the funded landscape suggests — each cites the evidence it draws from.
          </p>
          <ol className="mt-4 space-y-4">
            {data.analysis.opportunities.map((op, i) => (
              <li key={i} className="rounded-lg border border-structure-on-canvas bg-canvas-alt p-4">
                <p className="text-pretty font-body text-[13px] leading-relaxed text-foreground">{op.advice}</p>
                <CitationRow citations={op.citations} resolve={resolveCitation} className={citationClass} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── Honest-degradation note ────────────────────────────────────── */}
      {data.degraded && (data.degraded.notes.length > 0 || data.degraded.sources.length > 0) && (
        <div className="mt-6 rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas">Sources</p>
          <p className="mt-1 font-body text-[11px] leading-relaxed text-foreground">
            Retrieved from: {data.degraded.sources.length ? data.degraded.sources.join(", ") : "none"}.
            {data.degraded.notes.length > 0 && ` ${data.degraded.notes.join(" ")}`}
          </p>
        </div>
      )}

      <p className="mt-6 border-t border-structure-on-canvas pt-4 text-pretty font-body text-[11px] leading-relaxed text-foreground">
        This analysis never invents a company, an amount, or an award — every figure and
        quote above is copied from the linked public record. It is analysis to help you position, not a
        guarantee of funding.
      </p>

      {/* ── Grant-proposal prompt ──────────────────────────────────────── */}
      {showPrompt && (
        <section className="print-section-grant-proposal-prompt mt-6 rounded-sm border border-structure-on-canvas bg-canvas-alt p-4">
          <h3 className="font-display text-[16px] font-bold leading-snug text-foreground">
            Grant-proposal prompt
          </h3>
          <p className="mt-1 font-body text-[12px] leading-relaxed text-foreground">
            Built from the same grounded analysis above — paste this into Claude, ChatGPT, or any LLM to
            draft a proposal narrative. Granted doesn't draft or submit anything itself.
          </p>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-sm border border-structure-on-canvas bg-canvas p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {proposalPrompt}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={handleCopyPrompt} className={textBtnClass}>
              Copy to clipboard
            </button>
            <button type="button" onClick={() => printElement("grant-proposal-prompt")} className={textBtnClass}>
              Export as PDF
            </button>
            {copyNote && (
              <span role="status" aria-live="polite" className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                {copyNote}
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[15px] font-bold tabular-nums text-foreground">{value}</p>
      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas">{label}</p>
    </div>
  );
}

function CitationRow({
  citations,
  resolve,
  className,
}: {
  citations: string[];
  resolve: (id: string) => CitationTarget | null;
  className: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas">Based on</span>
      {citations.map((cid) => {
        const t = resolve(cid);
        if (!t) return null; // unreachable: schema-guaranteed.
        return (
          <a
            key={cid}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
            title={t.title}
          >
            {t.label}
            <span aria-hidden="true">↗</span>
          </a>
        );
      })}
    </div>
  );
}
