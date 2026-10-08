import type { CompetitorAnalysis } from "@/lib/contracts/competitorAnalysis";

/**
 * Builds a text prompt the user can paste into any LLM (Claude, ChatGPT, or
 * their own tool of choice) to draft a grant proposal narrative, grounded
 * ONLY in an already-validated `CompetitorAnalysis` (lib/contracts/
 * competitorAnalysis.ts's schema is the real anti-fabrication boundary —
 * every record id this reads was already checked to exist before this
 * function ever runs). This function adds no new claims of its own: it only
 * reformats data that's already grounded into a structured brief + an
 * instruction. Granted never drafts the proposal itself or calls an LLM
 * here — the user takes this prompt elsewhere, by design (see
 * components/CompetitorResults.tsx's "Draft a grant-proposal prompt").
 *
 * Pure, no React, no network — directly unit-testable.
 */
export function buildGrantProposalPrompt(data: CompetitorAnalysis): string {
  const byId = new Map(data.records.map((r) => [r.id, r]));
  const lines: string[] = [];

  lines.push(
    "Draft a grant proposal narrative for the company described below, positioned the way real, " +
      "funded competitors in this space have succeeded.",
  );
  lines.push("");

  lines.push("## The company");
  lines.push(data.personaDescription);
  lines.push("");

  if (data.analysis.summary) {
    lines.push("## Competitive landscape");
    lines.push(data.analysis.summary);
    lines.push("");
  }

  if (data.awardStats && data.awardStats.withAmount > 0) {
    lines.push("## Typical award size in this space");
    lines.push(
      `Smallest ${money(data.awardStats.minAmount)}, median ${money(data.awardStats.medianAmount)}, ` +
        `largest ${money(data.awardStats.maxAmount)} — computed from ${data.awardStats.withAmount} of ` +
        `${data.awardStats.count} retrieved awards that disclosed an amount.`,
    );
    lines.push("");
  }

  if (data.analysis.competitors.length > 0) {
    lines.push("## Real, funded competitors to learn from");
    for (const c of data.analysis.competitors) {
      const rec = byId.get(c.recordId);
      if (!rec) continue; // unreachable: the schema guarantees every competitor cites a real record.
      const meta = [rec.agency, rec.program, rec.year ? String(rec.year) : undefined].filter(Boolean).join(", ");
      lines.push(`- ${rec.recipient} (${meta}) — ${money(rec.amount)}`);
      lines.push(`  How they positioned themselves: ${c.positioning}`);
      lines.push(`  Quoted from their own award record: "${c.quotedSnippet}"`);
      lines.push(`  Source: ${rec.sourceUrl}`);
    }
    lines.push("");
  }

  if (data.analysis.recommendations.length > 0) {
    lines.push("## Recommendations grounded in this data");
    for (const r of data.analysis.recommendations) lines.push(`- ${r.advice}`);
    lines.push("");
  }

  if (data.analysis.opportunities && data.analysis.opportunities.length > 0) {
    lines.push("## Gaps to exploit");
    for (const o of data.analysis.opportunities) lines.push(`- ${o.advice}`);
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push(
    "Using only the real positioning patterns above, draft a grant proposal narrative for this company. " +
      "Write it in the company's own voice, emphasize the angles that funded competitors emphasized, and " +
      "address the gaps above where they apply. Do not invent award amounts, agency names, or facts about " +
      "this company beyond what's given here — ask me for anything else you need.",
  );

  return lines.join("\n");
}

function money(n: number | null | undefined): string {
  if (n == null) return "undisclosed";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
