import { NextRequest, NextResponse } from "next/server";

import { rateLimit, clientKey } from "@/lib/security/rateLimit";
import { isLocalLlm } from "@/lib/llm/client";
import { extractApplicationRequirements } from "@/lib/apply/requirements";
import { draftApplication } from "@/lib/apply/draft";
import { prefillApplicationForms } from "@/lib/apply/forms";
import { buildBudget } from "@/lib/apply/budget";
import {
  assemblePackage,
  allRegistrationsSatisfied,
  packageProgramTitle,
  // Re-exported by lib/apply/package so this server route never imports the
  // client-only mock-auth module directly (R9.0 server-retention guard).
  EMPTY_AUTO_FILL_REQUIREMENTS,
  type AutoFillRequirements,
  type DraftableSection,
  type NarrativeStatus,
} from "@/lib/apply/package";
import { OpportunitySchema, type Opportunity } from "@/lib/contracts/opportunity";
import { CompanyProfileSchema, type CompanyProfile } from "@/lib/contracts/companyProfile";
import type { ApplicationRequirements } from "@/lib/contracts/applicationRequirements";
import type { ApplicationDraft } from "@/lib/contracts/applicationDraft";

/**
 * WS-G / G5 — application-package assembly ROUTE (POST /api/apply/package).
 *
 * Orchestrates the pipeline SERVER-SIDE so G1's + G2's server-only
 * `ANTHROPIC_API_KEY` never reaches the client bundle (same discipline as
 * `app/api/interview/route.ts` and `app/api/match/route.ts`). Receives
 * `{ opportunity, profile, autoFillReqs }` and returns the assembled package:
 *
 *   G1 extractApplicationRequirements(opp)         [model — timeout+retry]
 *   G2 draftApplication(profile, reqs, {sectionKeys:[first]})  [model — modest spend]
 *   G3 prefillApplicationForms(profile, reqs, opp) [deterministic]
 *   G4 buildBudget(profile, reqs, opp)             [deterministic]
 *
 * HONESTY / RESILIENCE CONTRACT:
 *   - The G3 forms + G4 budget + checklist inputs never need a model, so the
 *     package is ALWAYS at least partially useful. If G1 or G2 fails after a
 *     single retry, the route STILL returns 200 with those deterministic parts
 *     and `narrativeStatus: "unavailable"` + an honest retry affordance —
 *     never a 5xx (a broken model step must not dead-end the user).
 *   - Spend is kept modest: only the FIRST grounded narrative section is
 *     drafted; the rest are returned as `draftableSections` ("draftable on
 *     demand"), not drafted.
 */

export const maxDuration = 120;

/** Per-request model-call budget: modest, env-overridable, denial-of-wallet cap. */
const PACKAGE_RATE_LIMIT = Number(process.env.APPLY_PACKAGE_RATE_LIMIT) || 12;
const PACKAGE_RATE_WINDOW_MS = Number(process.env.APPLY_PACKAGE_RATE_WINDOW_MS) || 60_000;
/** Per model-call timeout for the timeout+retry helper (below the 120s function cap). */
const STEP_TIMEOUT_MS = Number(process.env.APPLY_PACKAGE_STEP_TIMEOUT_MS) || 45_000;

/**
 * Run one model step with a hard timeout and a single retry, then give up. A
 * shared-key overload degrades gracefully (the caller catches and returns the
 * deterministic package) instead of hanging until the function times out. The
 * step function receives an `AbortSignal` it threads into the Anthropic call
 * (G1/G2 both accept `opts.signal`).
 */
async function withTimeoutRetry<T>(
  step: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs: number; retries: number; externalSignal?: AbortSignal },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    // If the client already disconnected (re-clicked "Draft", left the screen),
    // don't start — or retry — another model call.
    if (opts.externalSignal?.aborted) throw opts.externalSignal.reason ?? new Error("client disconnected");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    // A client disconnect aborts the in-flight model call too, so a serial local
    // model stops working on an abandoned request instead of finishing it.
    const onExternalAbort = () => ac.abort(opts.externalSignal?.reason);
    opts.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      return await step(ac.signal);
    } catch (err) {
      lastErr = err;
      // Don't burn a retry on a client disconnect — the caller is gone.
      if (opts.externalSignal?.aborted) throw err;
    } finally {
      clearTimeout(timer);
      opts.externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
  throw lastErr;
}

const NARRATIVE_UNAVAILABLE_NOTE =
  "We couldn't draft the grounded narrative sections just now (the drafting model was busy or timed out). " +
  "Your pre-filled forms, budget, and checklist below are ready — retry to add the narrative drafts.";

// On a LOCAL model the narrative draft is slow enough (tens of seconds per call)
// to make the whole package screen feel hung on "Assembling…". So by default we
// SKIP the model steps for local and return the deterministic package (forms,
// budget, checklist — and the export button) instantly; the UI's "Draft the
// narrative section" button re-requests with `draftNarrative: true` to generate
// it on demand.
const LOCAL_SKIP_NOTE =
  "Narrative drafting is slow on a local model, so your forms, budget, and checklist are ready right away. " +
  "Use “Draft the narrative section” below to generate it now (it can take a minute or two on a local model).";

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req), { limit: PACKAGE_RATE_LIMIT, windowMs: PACKAGE_RATE_WINDOW_MS });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "You're assembling a lot of packages in a short window — please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let opportunity: Opportunity;
  let profile: CompanyProfile;
  let autoFillReqs: AutoFillRequirements;
  let draftNarrative = false;
  try {
    const body = await req.json();
    const oppParsed = OpportunitySchema.safeParse(body?.opportunity);
    if (!oppParsed.success) return badRequest("A valid opportunity is required to assemble a package.");
    const profileParsed = CompanyProfileSchema.safeParse(body?.profile);
    if (!profileParsed.success) return badRequest("A valid company profile is required to assemble a package.");
    opportunity = oppParsed.data;
    profile = profileParsed.data;
    // AutoFillRequirements is a plain client store; merge over the defaults so a
    // partial/absent value never yields undefined fields (the SF-424 pre-fill
    // reads every field). Never trusted for anything gated — it only shapes the
    // honest, self-reported registration facts on the forms.
    autoFillReqs = { ...EMPTY_AUTO_FILL_REQUIREMENTS, ...(body?.autoFillReqs ?? {}) };
    // Explicit opt-in to the (slow-on-local) narrative draft — the UI sets this
    // when the user clicks "Draft the narrative section".
    draftNarrative = body?.draftNarrative === true;
  } catch {
    return badRequest("Invalid request body.");
  }

  // Draft the narrative when explicitly requested, OR always on a hosted model
  // (fast). On local we skip it by default so the deterministic package returns
  // instantly instead of hanging on "Assembling…" for minutes.
  const shouldDraft = draftNarrative || !isLocalLlm();

  // --- Model steps (graceful): G1 requirements, then G2 draft of section 1 ---
  let requirements: ApplicationRequirements | null = null;
  let draft: ApplicationDraft | null = null;
  let narrativeStatus: NarrativeStatus = "unavailable";
  let narrativeNote: string | undefined = shouldDraft ? NARRATIVE_UNAVAILABLE_NOTE : LOCAL_SKIP_NOTE;

  if (shouldDraft) {
    try {
      requirements = await withTimeoutRetry(
        (signal) => extractApplicationRequirements(opportunity, { signal }),
        { timeoutMs: STEP_TIMEOUT_MS, retries: 1, externalSignal: req.signal },
      );

      const firstSection = requirements.narrative_sections.find((s) => s.specified);
      if (firstSection) {
        // Keep spend modest: draft ONLY the first grounded section. The rest are
        // returned as `draftableSections` below (draftable on demand).
        draft = await withTimeoutRetry(
          (signal) =>
            draftApplication(profile, requirements!, { sectionKeys: [firstSection.key], signal }),
          { timeoutMs: STEP_TIMEOUT_MS, retries: 1, externalSignal: req.signal },
        );
      }
      // Requirements available (with or without narrative sections) → not degraded.
      narrativeStatus = "drafted";
      narrativeNote = undefined;
    } catch (err) {
      // Any model failure (overload, timeout, bad/missing key, malformed output)
      // degrades to the deterministic package — never a 5xx. Log server-side.
      console.error("apply/package: model step failed, serving deterministic package:", err);
      requirements = null;
      draft = null;
      narrativeStatus = "unavailable";
      narrativeNote = NARRATIVE_UNAVAILABLE_NOTE;
    }
  }

  // --- Deterministic parts (never need a model) -----------------------------
  const forms = prefillApplicationForms(profile, autoFillReqs, opportunity);
  // Budget is sharpened by G1's budget_rules when we got requirements; falls
  // back to the profile-only budget when the model step degraded.
  const budget = buildBudget(profile, requirements ?? undefined, opportunity);
  const checklist = { allRegistrationsSatisfied: allRegistrationsSatisfied(autoFillReqs) };

  const narrativeSections: DraftableSection[] = (requirements?.narrative_sections ?? [])
    .filter((s) => s.specified)
    .map((s) => ({ key: s.key, title: s.title, prompt: s.prompt }));

  const pkg = assemblePackage({
    opportunity_id: opportunity.id,
    program_title: packageProgramTitle(opportunity),
    forms,
    budget,
    checklist,
    narrativeSections,
    draft,
    narrativeStatus,
    narrativeNote,
    requirementsAvailable: requirements !== null,
  });

  return NextResponse.json({ package: pkg });
}
