import { NextRequest, NextResponse } from "next/server";
import { isLocalLlm } from "@/lib/llm/client";
import { createCostMeter } from "@/lib/metering/meter";
import { analyzeCompetitors, InsufficientEvidenceError } from "@/lib/competitors/analyze";
import type { CompetitorStreamEvent } from "@/lib/contracts/competitorAnalysis";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";
import { logError } from "@/lib/errorLog/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { rateLimit, clientKey } from "@/lib/security/rateLimit";

/**
 * Input bounds for this unauthenticated route (security review MEDIUM —
 * denial-of-wallet). Env-overridable. The rate limit is deliberately tighter
 * than /api/interview's (40/min): this is the most expensive and slowest
 * route in the app — a keyless retrieval fan-out plus one cloud synthesis,
 * with a budget of 110s for cloud and 1,800s for local.
 */
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_DESCRIPTION_LENGTH) || 8_000;
const COMPETITOR_RATE_LIMIT = Number(process.env.COMPETITOR_RATE_LIMIT) || 10;
const COMPETITOR_RATE_WINDOW_MS = Number(process.env.COMPETITOR_RATE_WINDOW_MS) || 60_000;

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
 * Latency: keyless retrieval fan-out (~2-6s) + one cloud synthesis (~5-15s). A
 * hard internal budget still guarantees we return an honest degradation rather
 * than hanging forever on a wedged call (see lib/claude.ts's timeout rationale);
 * local models get a far larger one, since they are legitimately much slower.
 *
 * This route gates NOTHING server-side — consistent with the app's posture that
 * `useEntitlements`/flags are client framing only (feasibility §4). The Max-tier
 * gate + default-OFF `r5_deep_analysis` flag live in the UI.
 */
/**
 * Hard wall-clock budget so a wedged call degrades honestly instead of hanging.
 * Granted runs locally with no platform execution ceiling, so this is sized to
 * the model instead: local inference is far slower than a cloud API, and the
 * cloud-sized budget would abort a legitimately-slow local synthesis mid-flight.
 * Override either with COMPETITOR_BUDGET_MS.
 *
 * Resolved PER REQUEST, not once at module load: the Settings Local/Cloud switch
 * rewrites the on-disk LLM config while the server is running, and
 * `resolveProvider()` picks that up on the next call. A module-scope constant
 * would freeze whichever provider happened to be selected at import time, so
 * switching to a local model mid-session would still abort its synthesis at the
 * cloud budget — the exact failure this sizing exists to prevent.
 */
function budgetMs(): number {
  return Number(process.env.COMPETITOR_BUDGET_MS) || (isLocalLlm() ? 1_800_000 : 110_000);
}

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

async function postCompetitors(req: NextRequest) {
  // This is the most expensive, slowest route in the app (a cloud synthesis
  // call) — restrict it to this computer before any other work.
  if (!isLoopbackRequest(req)) {
    return NextResponse.json(
      { ok: false, reason: "forbidden", message: "Only available from this computer." },
      { status: 403 },
    );
  }

  const limit = rateLimit(clientKey(req), { limit: COMPETITOR_RATE_LIMIT, windowMs: COMPETITOR_RATE_WINDOW_MS });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited", message: "You're requesting a lot in a short window — please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

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
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        reason: "bad_request",
        message: `That description is too long (max ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters). Trim it to the essentials and try again.`,
      },
      { status: 400 },
    );
  }

  const providedKeywords: string[] = Array.isArray(body?.keywords)
    ? body.keywords.filter((k: unknown): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 8)
    : [];
  const keywords = providedKeywords.length ? providedKeywords : deriveKeywords(description);
  const opportunity =
    body?.opportunity && typeof body.opportunity === "object"
      ? {
          ...(typeof body.opportunity.program === "string" ? { program: body.opportunity.program.trim().slice(0, 500) } : {}),
          ...(typeof body.opportunity.agency === "string" ? { agency: body.opportunity.agency.trim().slice(0, 500) } : {}),
        }
      : undefined;

  const meter = createCostMeter();
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(new Error("budget")), budgetMs());
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
        // "unavailable" state the client renders (never fabricate).
        const insufficient = err instanceof InsufficientEvidenceError;
        // Too little public data is an honest answer, and a closed modal isn't a failure; anything
        // else (including running out of time budget) goes to the error log.
        const reason: unknown = controller.signal.reason;
        const clientGone = controller.signal.aborted && !(reason instanceof Error && reason.message === "budget");
        const errorId = insufficient || clientGone ? undefined : logError("competitors", err);
        send({
          type: "error",
          ok: false,
          ...(errorId ? { errorId } : {}),
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

export const POST = withErrorLogging("competitors", postCompetitors);
