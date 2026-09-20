import { NextRequest, NextResponse } from "next/server";
import { createCostMeter } from "@/lib/metering/meter";
import { analyzeCompetitors, InsufficientEvidenceError } from "@/lib/competitors/analyze";
import type { CompetitorStreamEvent } from "@/lib/contracts/competitorAnalysis";

/**
 * R5-deep — live "competitor & grant intelligence" market brief.
 *
 * POST a user profile + (optionally) a target opportunity; get back a
 * GROUNDED brief: federal awardees in the space (with how they positioned to
 * win), typical award sizes, cited positioning recommendations, and gaps to
 * exploit — every point traceable to a real public award record or web URL, and
 * validated through `CompetitorAnalysisSchema` (which throws on any ungrounded
 * claim) before it can leave this route.
 *
 * Latency: keyless retrieval fan-out (~2-6s) + one sonnet synthesis (~5-15s),
 * comfortably under the 120s ceiling. A hard internal budget (below maxDuration)
 * guarantees we return an honest degradation rather than getting silently killed
 * by the platform mid-flight (see lib/claude.ts's timeout rationale).
 *
 * This route gates NOTHING server-side — consistent with the app's posture that
 * `useEntitlements`/flags are client framing only (feasibility §4). The Max-tier
 * gate + default-OFF `r5_deep_analysis` flag live in the UI.
 */
export const maxDuration = 120;

/** Hard budget below maxDuration so we always return before the platform kill. */
const BUDGET_MS = Number(process.env.COMPETITOR_BUDGET_MS) || 110_000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "our", "their", "who", "must",
  "company", "companies", "software", "platform", "based", "using", "customers", "which", "have", "has",
  "are", "was", "will", "they", "them", "its", "a", "an", "of", "to", "in", "on", "by", "or",
  // Generic business/product filler that carries little sector signal — dropping it
  // lets the more distinctive nouns survive into the 6 kept terms (see deriveKeywords).
  "builds", "build", "building", "provides", "provide", "providing", "offering", "offers",
  "solution", "solutions", "service", "services", "product", "products", "enables", "enabling",
  "system", "systems", "management", "help", "helps", "helping", "make", "makes", "making",
]);

/** Fallback keyword derivation when the client sends none (prefer profile expandedTerms). */
function deriveKeywords(description: string): string[] {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }

  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const persona = typeof body?.persona === "string" && body.persona.trim() ? body.persona.trim() : "Your company";
  if (description.length < 20) {
    return NextResponse.json(
      { ok: false, reason: "bad_request", message: "A company description (≥ 20 chars) is required." },
      { status: 400 },
    );
  }

  const providedKeywords: string[] = Array.isArray(body?.keywords)
    ? body.keywords.filter((k: unknown): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 8)
    : [];
  const keywords = providedKeywords.length ? providedKeywords : deriveKeywords(description);
  const opportunity =
    body?.opportunity && typeof body.opportunity === "object"
      ? { program: body.opportunity.program, agency: body.opportunity.agency }
      : undefined;

  const meter = createCostMeter();
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(new Error("budget")), BUDGET_MS);
  // Stop billing tokens if the client disconnects mid-stream.
  const reqSignal = (req as NextRequest & { signal?: AbortSignal }).signal;
  if (reqSignal) {
    if (reqSignal.aborted) controller.abort();
    else reqSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // Stream NDJSON (one JSON object per line, mirroring /api/match): `stage` +
  // `evidence` progress events flow as the pipeline runs, then a final `result`
  // (or an honest `error`). The synthesized brief only leaves here on `result`,
  // AFTER groundSynthesis + schema validation inside analyzeCompetitors — so the
  // anti-fabrication boundary is exactly as before; only progress got earlier.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (obj: CompetitorStreamEvent) => {
        try {
          streamController.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream already closed — ignore */
        }
      };
      try {
        const analysis = await analyzeCompetitors({
          persona,
          personaDescription: description,
          keywords,
          opportunity,
          meter,
          signal: controller.signal,
          onEvent: send,
        });
        const cost = meter.summary();
        send({
          type: "result",
          ok: true,
          analysis: {
            ...analysis,
            cost: { totalCostUsd: Number(cost.totalCostUsd.toFixed(4)), pricingAsOf: cost.pricingAsOf },
          },
        });
      } catch (err) {
        // Insufficient grounded evidence, or Anthropic/OpenAI unavailable → an HONEST
        // degradation the client renders as a fall-back-to-demo note (never fabricate).
        const insufficient = err instanceof InsufficientEvidenceError;
        send({
          type: "error",
          ok: false,
          reason: insufficient ? "insufficient_evidence" : "unavailable",
          message: insufficient
            ? "Not enough grounded public award data was found for a reliable live brief."
            : "Live analysis is temporarily unavailable.",
        });
      } finally {
        clearTimeout(budget);
        try {
          streamController.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // Consumer tore down (closed the modal / navigated away) — abort the run.
      controller.abort();
      clearTimeout(budget);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
