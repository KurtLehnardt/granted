"use client";
import { useEffect, useRef, useState } from "react";
import { TEST_CASES } from "@/lib/testCases";
import { isFlagEnabled } from "@/lib/flags";
import { useAuth } from "@/components/AuthProvider";
import { useAnalytics } from "@/components/AnalyticsProvider";
import { useSearchDraft } from "@/components/SearchDraftProvider";
import { clearAllLocalData, getAutoFillRequirements } from "@/lib/mockAuth";
import { BRAND } from "@/lib/brand";
import Swal from "sweetalert2";
import SearchProgress from "@/components/SearchProgress";
import PreSearchInterview from "@/components/PreSearchInterview";
import ProfileQuestionnaire from "@/components/ProfileQuestionnaire";
// Type-only: generateQuestions.ts imports the OpenAI SDK at runtime. A
// type-only import is erased at compile time, so no server-only runtime
// (or the OPENAI_API_KEY it reads) ever reaches this client bundle.
import type { InterviewQuestion } from "@/lib/interview/generateQuestions";

// FE-02 (R7.1): one honest, non-numeric one-liner per sample so the picker
// reads as "fictional example companies," not a filter on the user's own
// business. Keep these purely descriptive — no invented stats beyond what's
// already in TEST_CASES[].text.
const SAMPLE_BLURBS: Record<string, string> = {
  "ai-healthcare": "Fictional health-tech startup easing nurses' admin workload with AI.",
  manufacturing: "Fictional hardware startup scaling up lightweight aerospace component manufacturing.",
  water: "Fictional climate-tech startup using sensors and AI to cut municipal water loss.",
  cyber: "Fictional cybersecurity startup building AI-powered threat detection.",
  marketplace: "Fictional local marketplace startup — an intentionally hard case likely to return few or no strong matches.",
};

export default function IntakeForm({ onResult }: { onResult: (m: any) => void }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // H1: the exact description the last search actually ran on, so the error
  // state can offer a real "Try again" that re-runs it (independent of later
  // edits to `text`, and correct for the sample-pick / interview-enriched paths).
  const [lastSearched, setLastSearched] = useState("");
  // Real pipeline milestone streamed from /api/match (drives SearchProgress).
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  // FE-02 (R7.1): sample-company picker is collapsed by default; it's a
  // secondary affordance behind a real visual break, not an inline filter row.
  const [samplesOpen, setSamplesOpen] = useState(false);
  // FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the
  // DEFAULT on this A/B branch (previously gated behind r7_design). The v1
  // fallback branches below are retained but no longer reachable.
  const design = true;

  // FE-07: when the left sidebar is on, "Delete my data" moves into the drawer's
  // Account section, so it's dropped from here. Off (default) -> unchanged.
  const sidebar = isFlagEnabled("left_sidebar");

  // FE-07: the drawer's "Use this" (on a saved company-description version)
  // pushes text into ProfileQuestionnaire's description field via
  // SearchDraftProvider — passed straight through as externalText/
  // externalNonce below (B1b). No-op flag-off (nothing ever calls
  // requestSearchDraft then).
  const { pending } = useSearchDraft();

  // R1 (FE-03): pre-search interview. Off (default) = today's behavior
  // EXACTLY — beginSearch() below short-circuits straight to run(), and
  // interviewPhase never leaves "idle", so nothing new ever renders.
  const interviewOn = isFlagEnabled("r1_interview");
  const [interviewPhase, setInterviewPhase] = useState<"idle" | "generating" | "questions">("idle");
  const [interviewQuestions, setInterviewQuestions] = useState<InterviewQuestion[]>([]);
  // The exact description /api/interview generated questions for — captured
  // at beginSearch() time, independent of subsequent edits to `text`, so
  // PreSearchInterview's "Search anyway" always searches what the founder
  // actually asked the interview about.
  const [originalDescription, setOriginalDescription] = useState("");
  // Interview "generating" guard: a hung /api/interview must never strand the
  // user on a disabled box (frontend review MEDIUM — "never blocks the free
  // path"). An AbortController + timeout falls back to a direct search, and the
  // ref lets the "skip questions" button abort the in-flight call.
  const INTERVIEW_TIMEOUT_MS = 12_000;
  const interviewAbortRef = useRef<AbortController | null>(null);

  // r9_0_mockauth (CON-03): flag off -> no consent/delete UI, v1 path unchanged.
  // This control gates NOTHING server-side — the pipeline call below sends
  // `description` regardless of `consent.granted`. Consent only decides whether
  // a description may later be reused beyond the user's own run (§5.3); no such
  // reuse pipeline exists yet (out of scope for PLT-01), so today the checkbox
  // only produces a local, timestamped, revocable record.
  const mockAuthOn = isFlagEnabled("r9_0_mockauth");
  const { consent, setConsent, signOut } = useAuth();
  const [justCleared, setJustCleared] = useState(false);

  // H5 (R10.1) — funnel analytics. All emits no-op unless r10_analytics is on
  // (gating lives in track()); nothing here changes flag-off behavior.
  const analytics = useAnalytics();
  // run_abandoned ("the single most important event", R10.1): the epoch ms a
  // /api/match search started, or null when none is in flight. A ref (not
  // state) so the pagehide/unmount listener reads the live value without a
  // stale closure and without re-subscribing on every render.
  const searchStartRef = useRef<number | null>(null);
  const analyticsRef = useRef(analytics);
  analyticsRef.current = analytics;

  useEffect(() => {
    // If a search is still in flight when the user navigates away / closes the
    // tab (pagehide, incl. bfcache) or this form unmounts, that's an abandoned
    // run — emit it with elapsed time. Guarded to fire at most once per search.
    const abandonIfPending = () => {
      const start = searchStartRef.current;
      if (start != null) {
        searchStartRef.current = null;
        analyticsRef.current.runAbandoned(Date.now() - start);
      }
    };
    window.addEventListener("pagehide", abandonIfPending);
    return () => {
      window.removeEventListener("pagehide", abandonIfPending);
      abandonIfPending();
    };
  }, []);

  function handleDeleteMyData() {
    clearAllLocalData();
    // clearAllLocalData only touches localStorage — resync the in-memory auth
    // state too, or a signed-in user / granted consent would keep rendering
    // as if nothing happened until next reload.
    signOut();
    setConsent(false);
    setJustCleared(true);
    window.setTimeout(() => setJustCleared(false), 4000);
  }

  async function run(description: string) {
    setLoading(true);
    setError(null);
    setProgress(null);
    setLastSearched(description);
    // H5: search start + mark a run in flight (for run_abandoned). No description
    // content is sent — the event is a name + timestamp only.
    searchStartRef.current = Date.now();
    analytics.searchStarted();
    // Arch review: feed the founder's OWN self-reported SAM/UEI (from the local
    // Auto Fill form) into eligibility screening so a registered founder isn't
    // told to register. Empty when unfilled -> server no-ops it. Not analytics,
    // not the description; used transiently server-side for screening only.
    const reqs = getAutoFillRequirements();
    const companyFacts = { samRegistered: reqs.samRegistered, uei: reqs.uei };
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, companyFacts }),
      });

      // H1: ANY non-OK response is an error, regardless of content-type. A
      // proxy/edge 502/504 (or a gateway timeout) returns HTML, not our JSON
      // envelope — the old `!res.ok && ctype==json` guard let those fall through
      // into the stream loop and dead-end with no error shown.
      if (!res.ok) {
        const ctype = res.headers.get("content-type") ?? "";
        let message = "The search didn't complete — please try again.";
        if (ctype.includes("application/json")) {
          try {
            const j = await res.json();
            if (j?.error) message = j.error;
          } catch { /* non-JSON body — keep the generic message */ }
        }
        throw new Error(message);
      }
      // Fallback for environments without a readable stream: parse as one JSON blob.
      if (!res.body) {
        const j = await res.json();
        onResult(j);
        return;
      }

      // Stream: newline-delimited JSON of {type:"progress"|"result"|"error"}.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamDone = false;
      // H1: track whether the terminal `result` line ever arrived. A 200 stream
      // that closes after only `progress` lines (mid-stream server crash,
      // gateway idle-timeout, or a platform kill at maxDuration) otherwise
      // drains here with neither onResult nor setError — a silent dead-end.
      let gotResult = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        streamDone = done;
        if (value) buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "progress") {
            setProgress({ pct: msg.pct ?? 0, label: msg.label ?? "" });
          } else if (msg.type === "result") {
            gotResult = true;
            onResult(msg.map);
          } else if (msg.type === "error") {
            throw new Error(msg.error ?? "Matching failed.");
          }
        }
      }
      // H1: the stream ended without a result and without an explicit error —
      // treat it as a failure the user can retry, never a blank form.
      if (!gotResult) {
        throw new Error("The search didn't complete — please try again.");
      }
    } catch (e: any) {
      setError(e?.message ?? "The search didn't complete — please try again.");
    } finally {
      setLoading(false);
      setProgress(null);
      // The run finished (result or error) — it can no longer be "abandoned".
      searchStartRef.current = null;
    }
  }

  // R1 (FE-03): single entry point for both the CTA and the sample picker.
  // Flag off -> straight to run(), unchanged. Flag on -> ask INT-01 for a
  // cheap/fast set of routing questions first; any failure or an empty
  // interview (description already resolves cleanly) falls back to run()
  // directly so a broken interview never blocks the free path.
  async function beginSearch(description: string) {
    // Only interview when the description is TOO SHORT to route cleanly. A
    // detailed prompt (enough words, or 3+ sentences) skips straight to search
    // — no "preparing questions" flash when there's nothing worth asking.
    const words = description.trim().split(/\s+/).filter(Boolean).length;
    const sentences = (description.match(/[.!?]+/g) ?? []).length;
    const detailedEnough = words >= 25 || sentences >= 3;
    if (!interviewOn || detailedEnough) {
      run(description);
      return;
    }
    setError(null);
    setInterviewPhase("generating");
    // Timeout/skip guard: abort a hung interview and fall back to a direct search.
    const controller = new AbortController();
    interviewAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), INTERVIEW_TIMEOUT_MS);
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (!res.ok) {
        setInterviewPhase("idle");
        run(description);
        return;
      }
      const j = await res.json();
      const questions: InterviewQuestion[] = Array.isArray(j?.questions) ? j.questions : [];
      if (questions.length === 0) {
        setInterviewPhase("idle");
        run(description);
        return;
      }
      setInterviewQuestions(questions);
      setOriginalDescription(description);
      setInterviewPhase("questions");
      // H5: the pre-search interview was shown (count only, no content).
      analytics.interviewShown({ questions: questions.length });
    } catch {
      // Timeout, manual skip (abort), network error, or bad JSON — never block
      // the free path; fall straight through to the search.
      window.clearTimeout(timeout);
      setInterviewPhase("idle");
      run(description);
    } finally {
      interviewAbortRef.current = null;
    }
  }

  /** "Search now, skip questions" during the generating phase — aborts the
   *  in-flight interview so beginSearch()'s catch falls back to a direct run(). */
  function skipInterviewGenerating() {
    interviewAbortRef.current?.abort();
  }

  function handleInterviewComplete(enrichedDescription: string) {
    setInterviewPhase("idle");
    run(enrichedDescription);
  }

  function handleInterviewSkip() {
    setInterviewPhase("idle");
    run(originalDescription);
  }

  // B1b — ProfileQuestionnaire is the primary intake now. `complete` is true
  // iff every one of the 13 B1a fields (required + material) is provided:
  // when it is, we call run() directly and skip beginSearch()'s R1-interview
  // branch entirely — the "a fully-filled form runs with ZERO interview
  // questions" guarantee is structural, not just a side effect of the
  // description being long enough to trip the existing word-count heuristic.
  // A still-partial submission (required fields only) goes through
  // beginSearch() exactly as free-text always has, so the flag-gated R1
  // interview can still ask about whatever's left.
  function handleQuestionnaireSubmit(description: string, meta: { complete: boolean }) {
    if (meta.complete) {
      run(description);
    } else {
      beginSearch(description);
    }
  }

  // FE-02 (R7.1): picking a sample goes straight to run() (streaming,
  // SearchProgress, caching — all untouched/wired identically), bypassing
  // the R1 pre-search interview even when that flag is on: samples are
  // pre-written and the user has no refining answers to give, so there's
  // nothing for the interview to ask. Only confirm-before-overwrite is new,
  // and only when there's meaningful user text already in the box.
  async function selectSample(tc: (typeof TEST_CASES)[number]) {
    if (text.trim().length > 0) {
      const result = await Swal.fire({
        title: "Replace your description?",
        text: "This sample company will replace what you've written in the box.",
        icon: "question",
        showCancelButton: true,
        confirmButtonText: "Replace",
        cancelButtonText: "Keep mine",
        reverseButtons: true,
        // Token CSS vars → the modal adapts to light/dark like the rest of the app.
        background: "var(--color-canvas-alt)",
        color: "var(--color-foreground)",
        confirmButtonColor: "var(--color-action)",
        cancelButtonColor: "var(--color-structure-fill)",
      });
      if (!result.isConfirmed) return;
    }
    setText(tc.text);
    setSamplesOpen(false);
    run(tc.text);
  }

  // FE-02 (R7.1): the sample-company picker lives below a real visual break
  // (border-t + vertical space), not inline with the CTA. It's a secondary
  // affordance -> navy "structure" role, never green (`bg-action` is
  // reserved for the primary CTA only).
  const sampleSectionClass = design
    ? "mt-6 border-t border-structure-on-canvas pt-5"
    : "mt-6 border-t border-rule pt-5";

  const sampleTriggerClass = design
    ? "min-h-[44px] rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "min-h-[44px] rounded-sm border border-rule bg-white px-4 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-slate-550 transition hover:border-federal hover:text-federal disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  // Expanded picker panel reads as a distinct, optional area. Polish: depth
  // now comes from an elevation shadow (concentric rounded-lg outer / rounded-sm
  // items) rather than a hard navy border.
  const samplePanelClass = design
    ? "mt-3 rounded-lg bg-canvas-alt p-4 shadow-card"
    : "mt-3 rounded-sm border border-rule bg-white p-4";

  const samplePanelIntroClass = design
    ? "text-pretty font-body text-[13px] leading-relaxed text-foreground"
    : "font-body text-[13px] leading-relaxed text-slate-550";

  // List items, not chips: each is a full-width card with a label + one-line
  // description so it reads as "pick an example company," not a filter.
  // `group` + `group-hover:*` on the children lets the hover-fill state
  // (navy on r7_design, federal-blue text on v1) recolor both label and
  // blurb together, matching the required white-on-structure-fill pairing.
  const sampleItemClass = design
    ? "group flex min-h-[44px] w-full flex-col justify-center gap-0.5 rounded-sm border border-structure-on-canvas bg-canvas px-3.5 py-2.5 text-left transition hover:bg-structure hover:shadow-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "group flex min-h-[44px] w-full flex-col justify-center gap-0.5 rounded-sm border border-rule bg-paper px-3.5 py-2.5 text-left transition hover:border-federal disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  const sampleItemLabelClass = design
    ? "font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas group-hover:text-token-white"
    : "font-mono text-[12px] uppercase tracking-eyebrow text-ink group-hover:text-federal";

  const sampleItemBlurbClass = design
    ? "text-pretty font-body text-[13px] leading-relaxed text-foreground group-hover:text-token-white"
    : "font-body text-[13px] leading-relaxed text-slate-550 group-hover:text-federal";

  // Error state is a legitimate semantic role -> `error` token. As a 2px
  // border (non-text, 3:1 threshold) this passes AA against canvas-alt/canvas
  // (verified ~4.37:1 in the CON-02 report); avoid it as bare small text.
  const errorClass = design
    ? "mt-4 rounded-r-sm border-l-2 border-error bg-canvas-alt px-4 py-3 font-body text-sm text-pretty text-foreground"
    : "mt-4 border-l-2 border-fit-adjacent bg-white px-4 py-3 font-body text-sm text-ink";

  // R1 (FE-03): lightweight status while /api/interview is in flight — NOT
  // the big SearchProgress bar, which is reserved for the expensive
  // /api/match phase.
  const interviewStatusClass = design
    ? "mt-4 font-mono text-[12px] text-structure-on-canvas"
    : "mt-4 font-mono text-[12px] text-federal";

  return (
    <div>
      {/* B1b — ProfileQuestionnaire is the primary intake: a structured form
          driven by the B1a field metadata (required first, optional-material
          fields progressively disclosed), with free-text paste-to-autofill
          still available inside it. Hidden while an R1 interview phase is
          active so it never competes with PreSearchInterview's own UI;
          `disabled` covers the case where a search is already in flight
          (`loading`) while still idle, e.g. right after
          handleInterviewComplete() resets the phase and calls run(). */}
      {interviewPhase === "idle" && (
        <div data-tour="describe">
          <ProfileQuestionnaire
            disabled={loading}
            externalText={pending?.text}
            externalNonce={pending?.nonce}
            onDescriptionChange={setText}
            onSubmit={handleQuestionnaireSubmit}
            design={design}
          />
        </div>
      )}

      {mockAuthOn && (
        <div className="mt-3 rounded-r-sm border-l-2 border-structure-on-canvas bg-canvas-alt px-4 py-3">
          <label className="flex cursor-pointer items-start gap-2.5 text-pretty font-body text-[13px] leading-relaxed text-foreground">
            <input
              type="checkbox"
              checked={consent.granted}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-structure"
            />
            <span>Opt in to sharing anonymized usage data</span>
          </label>

          {/* FE-07: flag ON -> Delete my data lives in the drawer's Account
              section instead, so it's dropped here. The consent checkbox above
              stays at the input in both modes. */}
          {!sidebar && (
            <div className="mt-3 flex flex-wrap items-center gap-3 pl-[26px]">
              <button
                type="button"
                onClick={handleDeleteMyData}
                className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline decoration-dotted underline-offset-2 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
              >
                Delete my data
              </button>
              {justCleared && (
                <span className="font-mono text-[11px] text-foreground">
                  Local data cleared.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* R1 (FE-03): brief status while INT-01 generates routing questions.
          Not the SearchProgress bar — that's reserved for /api/match. */}
      {interviewPhase === "generating" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className={interviewStatusClass} role="status" aria-live="polite">
            Preparing a few quick questions…
          </p>
          <button
            type="button"
            onClick={skipInterviewGenerating}
            className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline decoration-dotted underline-offset-2 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
          >
            Search now, skip questions
          </button>
        </div>
      )}

      {/* R1 (FE-03): inline (non-modal) interview — questions phase, then an
          editable review of the enriched description, before the expensive
          /api/match search fires. "Search anyway" always available. */}
      {interviewPhase === "questions" && (
        <PreSearchInterview
          questions={interviewQuestions}
          originalDescription={originalDescription}
          design={design}
          onComplete={handleInterviewComplete}
          onSkip={handleInterviewSkip}
        />
      )}

      {loading && (
        <SearchProgress design={design} realPct={progress?.pct} realLabel={progress?.label} />
      )}

      {/* FE-02 (R7.1): sample-company picker — a real visual break (border-t
          + vertical space) separates this from the user's own description,
          so it reads as "try an example," not a filter on their business. */}
      {interviewPhase === "idle" && (
        <div className={sampleSectionClass}>
          <button
            type="button"
            data-tour="samples"
            onClick={() => setSamplesOpen((open) => !open)}
            aria-expanded={samplesOpen}
            disabled={loading}
            className={sampleTriggerClass}
          >
            {samplesOpen ? "Hide sample companies" : "See a sample company"}
          </button>

          {samplesOpen && (
            <div className={samplePanelClass}>
              <p className={samplePanelIntroClass}>
                These are fictional example companies — pick one to see how {BRAND} works.
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {TEST_CASES.map((tc) => (
                  <li key={tc.id}>
                    <button
                      type="button"
                      onClick={() => selectSample(tc)}
                      disabled={loading}
                      className={sampleItemClass}
                    >
                      <span className={sampleItemLabelClass}>{tc.label}</span>
                      <span className={sampleItemBlurbClass}>{SAMPLE_BLURBS[tc.id]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className={errorClass}>
          <p>{error}</p>
          {/* H1: an explicit retry so an error/timeout is never a dead-end.
              Re-runs the exact description the failed search used. */}
          <button
            type="button"
            onClick={() => run(lastSearched || text)}
            disabled={loading || (lastSearched || text).trim().length < 20}
            className="mt-2 font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline decoration-dotted underline-offset-2 transition hover:text-structure-on-canvas disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
