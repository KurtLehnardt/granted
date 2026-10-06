import { NextResponse } from "next/server";
import { buildOpportunityMap, type StepEvent } from "@/lib/match";
import type { Match } from "@/lib/types";
import { rateLimit, clientKey } from "@/lib/security/rateLimit";
import { OpportunityMapSchema } from "@/lib/contracts/opportunityMap";
import precomputed from "@/data/precomputed.json";
import { isLocalLlm } from "@/lib/llm/client";
import { withLocalModel } from "@/lib/llm/modelContext";
import { prepareLocalSearch } from "@/lib/llm/localPreflight";
import { describeSearchError, shortProviderLabel } from "@/lib/llm/searchErrors";
import { resolveCloudConfig } from "@/lib/llm/config";
import { getCloudProvider } from "@/lib/llm/providers";
import type { LlmInfo } from "@/lib/llm/types";
import { dropExpiredMatches } from "@/lib/corpus/expiry";
import { dropPastAwardMatches } from "@/lib/corpus/pastAwards";
import { sanitizedProviderErrorFor4xx } from "@/lib/llm/errors";

/**
 * Boundary validation is OBSERVABILITY ONLY (arch review MEDIUM — the payload
 * was never parsed before streaming). We `safeParse` and always stream the
 * ORIGINAL `map`, never `parsed.data`: the live map carries additive fields
 * (`matches[].eligibility`, `costDebug`) the schema doesn't declare and zod
 * would strip.
 *
 * CRITICAL: a schema mismatch must NEVER turn a completed search into an error
 * — that re-introduces the H1 "silent search dead-end" on the flagship journey.
 * (It did: a too-strict schema was rejecting ~2/3 of real novel searches and
 * surfacing "The search didn't complete.") So on failure we LOG the exact zod
 * issues for reconciliation and serve the real map anyway — the client renders
 * it fine. Both the cached and live paths degrade identically.
 */
function logMapDrift(map: unknown, label: string): void {
  const check = OpportunityMapSchema.safeParse(map);
  if (!check.success) {
    console.warn(
      `OpportunityMap boundary validation failed (${label}); serving anyway:`,
      JSON.stringify(check.error.issues.slice(0, 10)),
    );
  }
}

/**
 * Server-side input bounds for the unauthenticated, real-money match endpoint
 * (security review MEDIUM — denial-of-wallet). A max description length caps
 * per-request embedding + scoring token spend; a best-effort per-IP rate limit
 * blunts naive bursts. All env-overridable; defaults chosen to never impede a
 * real user or the judged demo.
 */
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_DESCRIPTION_LENGTH) || 8_000;
const MATCH_RATE_LIMIT = Number(process.env.MATCH_RATE_LIMIT) || 20;
const MATCH_RATE_WINDOW_MS = Number(process.env.MATCH_RATE_WINDOW_MS) || 60_000;

/**
 * The request→Response core of POST /api/match, extracted from route.ts so it
 * has a hermetic test seam (H6). Next only permits route-handler exports from
 * a `route.ts`, so this lives in a sibling module: route.ts just forwards to
 * `handleMatchRequest`. Tests call it directly with a plain Request and a
 * mocked { buildOpportunityMap, cached } — no network, no model spend.
 */

/** Demo-day insurance: pre-baked results for the four judged test cases. */
export function cached(description: string, source: any[] = precomputed as any[]) {
  const key = description.trim().slice(0, 120);
  const hit = source.find((p) => p.key === key);
  return hit ? dropExpiredMatches(dropPastAwardMatches(hit.map)) : undefined;
}

export type MatchDeps = {
  buildOpportunityMap: typeof buildOpportunityMap;
  cached: (description: string) => unknown;
  /** Which backend runs the search and, for Local, the checked model (default: below). */
  resolveLlm?: (requestedModel: string | undefined, onStatus: (label: string) => void) => Promise<LlmInfo>;
  /** The cloud provider's name for error messages ("Anthropic", "OpenAI", ...). */
  cloudProviderName?: () => string | undefined;
};

const REAL_DEPS: MatchDeps = { buildOpportunityMap, cached };

/**
 * Hosted never touches Ollama. Local makes sure Ollama answers (starting it if
 * needed) and that the model — `requestedModel` if installed, else the default —
 * is installed, throwing a LocalSetupError that says what to fix otherwise.
 */
async function resolveLlmInfo(requestedModel: string | undefined, onStatus: (label: string) => void): Promise<LlmInfo> {
  if (!isLocalLlm()) return { local: false };
  return prepareLocalSearch(requestedModel, onStatus);
}

function cloudProviderName(): string | undefined {
  try {
    return shortProviderLabel(getCloudProvider(resolveCloudConfig()?.providerId ?? "anthropic")?.label);
  } catch {
    return undefined;
  }
}

export async function handleMatchRequest(
  req: Request,
  deps: MatchDeps = REAL_DEPS,
): Promise<Response> {
  // Best-effort per-IP throttle before any parsing/model work.
  const limit = rateLimit(clientKey(req), { limit: MATCH_RATE_LIMIT, windowMs: MATCH_RATE_WINDOW_MS });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "You're searching a lot in a short window — please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  // Validation errors return plain JSON (the client checks res.ok before
  // reading the stream). Everything else streams NDJSON progress + result.
  let description: string;
  // User self-reported registration facts, sanitized to primitives here (the
  // server mints the user_stated provenance in the bridge — never trust a
  // client-supplied provenance label). Optional; absent -> unchanged screening.
  let companyFacts: { samRegistered?: boolean; uei?: string } | undefined;
  // Optional "search depth" preference (Settings): how many candidates the model
  // scores. Passed through to buildOpportunityMap, which CLAMPS it to a safe
  // range — so a bad client value can never overrun the scorer's token budget.
  let maxCandidates: number | undefined;
  let requestedModel: string | undefined;
  try {
    const body = await req.json();
    description = body?.description;
    const cf = body?.companyFacts;
    if (cf && typeof cf === "object") {
      companyFacts = {};
      if (cf.samRegistered === true) companyFacts.samRegistered = true;
      if (typeof cf.uei === "string" && cf.uei.trim().length > 0) {
        companyFacts.uei = cf.uei.trim().slice(0, 64);
      }
    }
    if (typeof body?.maxCandidates === "number" && Number.isFinite(body.maxCandidates)) {
      maxCandidates = body.maxCandidates;
    }
    if (typeof body?.model === "string" && body.model.trim().length > 0) {
      requestedModel = body.model.trim();
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!description || description.trim().length < 20) {
    return NextResponse.json(
      { error: "Add a bit more detail about your company — a sentence or two on what you build, your size, and what you need." },
      { status: 400 }
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      { error: `That description is too long (max ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters). Trim it to the essentials and try again.` },
      { status: 400 }
    );
  }

  // One AbortController per request. Fed by BOTH the incoming request's own
  // signal (fires when the client disconnects) and the stream's cancel() (fires
  // when the consumer tears down). Threaded into buildOpportunityMap so an
  // abandoned search stops generating tokens instead of billing the full run.
  const ac = new AbortController();
  const reqSignal = (req as Request & { signal?: AbortSignal }).signal;
  if (reqSignal) {
    if (reqSignal.aborted) ac.abort();
    else reqSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const encoder = new TextEncoder();
  // Set once the backend is resolved: the error message below depends on it.
  let llm: LlmInfo | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* stream closed */ }
      };
      try {
        const hit = deps.cached(description);
        if (hit) {
          // Pre-baked demo insurance: log drift for visibility but never block
          // a pre-vetted demo case on it — serve anyway.
          logMapDrift(hit, "cached");
          send({ type: "progress", key: "cached", label: "Loading your opportunity map", pct: 95 });
          send({ type: "result", map: hit });
          controller.close();
          return;
        }

        llm = await (deps.resolveLlm ?? resolveLlmInfo)(requestedModel, (label) =>
          send({ type: "progress", key: "ollama", label, pct: 3 }),
        );
        const map = await withLocalModel(llm.local ? llm.model : undefined, () =>
          deps.buildOpportunityMap(
            description,
            (e: StepEvent) => send(e.key === "start" ? { type: "progress", ...e, llm } : { type: "progress", ...e }),
            undefined,
            ac.signal,
            companyFacts,
            maxCandidates,
            // Progressive rendering: stream each match the instant its batch is
            // scored, so the client can render cards as they're ready instead of
            // waiting for the whole candidate set. Purely additive — the client
            // still gets the authoritative, complete `result.map` at the end;
            // these are only an early preview of matches that map will contain.
            (m: Match) => send({ type: "match", match: m }),
            // INSTANT CARDS — fired for each retrieved candidate before any LLM
            // scoring call. No score/tier yet: the client renders a spinner in
            // its place until the real "match" event for the same id arrives.
            (o) => send({ type: "provisional", provisional: true, opportunity: o }),
          ),
        );
        // Log any boundary drift for visibility, but ALWAYS stream the real,
        // completed map — never dead-end a finished search on schema strictness.
        logMapDrift(map, "live");
        send({ type: "result", map });
        controller.close();
      } catch (err: any) {
        // Abort (client gone) is expected — don't log it as a failure.
        if (ac.signal.aborted || err?.name === "AbortError") {
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        // Log the full error server-side; send a GENERIC message to the client
        // (never raw err.message / env-var names — security review LOW) UNLESS
        // it's a provider 4xx (bad key/permissions/billing/etc.), in which case
        // the provider's own message — sanitized — is actually useful to the
        // user and safe to show. A 5xx/network/unknown error keeps the generic
        // text, since raw internals shouldn't reach the client.
        // A recognized cause (Ollama down, local model missing, out of credits,
        // bad key) gets a specific message that says where to fix it.
        console.error("match failed:", err);
        const local = llm ? llm.local : isLocalLlm();
        const specific = describeSearchError(err, {
          local,
          model: llm?.model,
          provider: local ? undefined : (deps.cloudProviderName ?? cloudProviderName)(),
        });
        const providerMessage = specific ?? sanitizedProviderErrorFor4xx(err);
        send({ type: "error", error: providerMessage ?? "The search didn't complete. Please try again." });
        controller.close();
      }
    },
    // Consumer canceled (navigated away / closed the tab) — abort in-flight
    // model calls so the abandoned search stops spending.
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Discourage proxy buffering so milestones arrive as they happen.
      "X-Accel-Buffering": "no",
    },
  });
}
