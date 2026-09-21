"use client";
import { useState } from "react";
import type { InterviewQuestion } from "@/lib/interview/generateQuestions";
import { mergeAnswers } from "@/lib/interview/mergeAnswers";
import { CompanyProfileSchema, type InterviewAnswer } from "@/lib/contracts/companyProfile";

/**
 * FE-03 — R1 pre-search interview UI.
 *
 * Renders the INT-01-generated questions INLINE (not a modal — R7.4 requires
 * a structured multi-select without a modal trap), lets the user answer or
 * skip via an always-visible "Search anyway", then (R1: "answers merge into
 * an enriched description that the user can see and edit before the search
 * fires") shows the INT-02-merged enriched description in an editable
 * textarea before the final search fires.
 *
 * Two internal phases: "questions" -> "review". "Search anyway" is available
 * in both. Nothing here calls the network — question generation (INT-01) and
 * the merge (INT-02) are the caller's / a pure library's job respectively;
 * this component only orchestrates local form state and the phase switch.
 */

export interface PreSearchInterviewProps {
  questions: InterviewQuestion[];
  originalDescription: string;
  onComplete: (enrichedDescription: string) => void;
  onSkip: () => void;
}

type QuestionAnswerState = { values: string[]; freeText: string };

function isOtherValue(value: string): boolean {
  return value.trim().toLowerCase() === "other";
}

export default function PreSearchInterview({
  questions,
  originalDescription,
  onComplete,
  onSkip,
}: PreSearchInterviewProps) {
  const [phase, setPhase] = useState<"questions" | "review">("questions");
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerState>>({});
  const [reviewText, setReviewText] = useState("");

  function stateFor(id: string): QuestionAnswerState {
    return answers[id] ?? { values: [], freeText: "" };
  }

  function setSingle(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: { values: [value], freeText: prev[id]?.freeText ?? "" } }));
  }

  function toggleMulti(id: string, value: string) {
    setAnswers((prev) => {
      const cur = prev[id]?.values ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [id]: { values: next, freeText: prev[id]?.freeText ?? "" } };
    });
  }

  function setFreeText(id: string, text: string) {
    setAnswers((prev) => ({ ...prev, [id]: { values: prev[id]?.values ?? [], freeText: text } }));
  }

  // Build InterviewAnswer[] from currently-answered questions only. An
  // unanswered question (no selection, empty free text, or an unresolved
  // "Other" with nothing typed in) is simply omitted — mergeAnswers treats a
  // missing answer the same as a skipped one (no field write, nothing folded
  // into the enriched description).
  function buildAnswers(): InterviewAnswer[] {
    const result: InterviewAnswer[] = [];
    for (const q of questions) {
      const state = stateFor(q.id);

      if (q.answer_kind === "free_text") {
        const text = state.freeText.trim();
        if (!text) continue;
        result.push({
          question_id: q.id,
          question: q.question,
          answer: { value: text, provenance: "user_stated", confidence: 1 },
          skipped: false,
        });
        continue;
      }

      if (q.answer_kind === "single_select") {
        const raw = state.values[0];
        if (!raw) continue;
        const value = isOtherValue(raw) ? state.freeText.trim() : raw;
        if (!value) continue;
        result.push({
          question_id: q.id,
          question: q.question,
          answer: { value, provenance: "user_stated", confidence: 1 },
          skipped: false,
        });
        continue;
      }

      // multi_select
      const resolved = state.values
        .map((v) => (isOtherValue(v) ? state.freeText.trim() : v))
        .filter((v) => v.length > 0);
      if (resolved.length === 0) continue;
      result.push({
        question_id: q.id,
        question: q.question,
        answer: { value: resolved, provenance: "user_stated", confidence: 1 },
        skipped: false,
      });
    }
    return result;
  }

  function handleContinue() {
    const interviewAnswers = buildAnswers();
    const baseProfile = CompanyProfileSchema.parse({
      id: `profile_${Date.now()}`,
      raw_text: { value: originalDescription, provenance: "user_stated", confidence: 1 },
    });
    const { enrichedDescription } = mergeAnswers(baseProfile, questions, interviewAnswers);
    setReviewText(enrichedDescription);
    setPhase("review");
  }

  // ---- styling: dual-class design-token / v1 pattern, mirroring IntakeForm ----
  // Interview structure is neutral (navy/structure); bg-action / bg-ink is
  // reserved for the single primary "Find opportunities" action below.

  // Polish: elevation shadows replace the broken /30 and /20 alpha borders
  // (Tailwind can't compute alpha on CSS-var-backed token colors). Concentric
  // radii: card (rounded-lg) → fieldset (rounded-md) → inputs (rounded-sm).
  const cardClass = "mt-4 rounded-lg bg-canvas-alt px-4 py-4 shadow-card";

  const headingClass = "block mb-3 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const introClass = "text-pretty font-body text-[13px] leading-relaxed text-foreground";

  const fieldsetClass = "rounded-md bg-canvas p-4 shadow-card";

  const legendClass = "text-balance px-1 font-body text-[15px] leading-relaxed text-foreground";

  const rationaleClass = "mt-1 text-pretty font-body text-[12px] leading-relaxed text-structure-on-canvas";

  const optionLabelClass = "flex cursor-pointer items-center gap-2 font-body text-[14px] text-foreground";

  const optionInputClass = "h-4 w-4 shrink-0 accent-structure";

  const smallLabelClass = "mb-1 block font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const textInputClass =
    "w-full rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2 font-body text-[14px] text-foreground outline-none focus:ring-2 focus:ring-structure-on-canvas";

  const secondaryButtonClass =
    "min-h-[44px] rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  // The ONLY green/primary-fill surface in this component — mirrors
  // IntakeForm's primaryButtonClass exactly, reserved for the single final
  // search action.
  const primaryButtonClass =
    "min-h-[44px] rounded-sm bg-action px-5 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-token-white shadow-sm transition hover:opacity-90 hover:shadow active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const reviewTextareaClass =
    "w-full resize-y rounded-sm border border-structure-on-canvas bg-canvas-alt p-4 font-body text-[15px] leading-relaxed text-foreground outline-none focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas";

  if (phase === "review") {
    return (
      <div className={cardClass}>
        <span className={headingClass}>Review before searching</span>
        <p className={introClass}>
          Here&rsquo;s your description with your answers folded in. Edit anything before we search.
        </p>
        <label htmlFor="interview-review" className={smallLabelClass}>
          Enriched description
        </label>
        <textarea
          id="interview-review"
          value={reviewText}
          onChange={(e) => setReviewText(e.target.value)}
          rows={8}
          className={reviewTextareaClass}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => onComplete(reviewText)} className={primaryButtonClass}>
            Find opportunities
          </button>
          <button type="button" onClick={() => setPhase("questions")} className={secondaryButtonClass}>
            Edit answers
          </button>
          <button type="button" onClick={onSkip} className={secondaryButtonClass}>
            Search anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <span className={headingClass}>A few quick questions</span>
      <p className={introClass}>
        Answering these helps us route to the right programs — or skip straight to results any time.
      </p>

      <div className="mt-4 flex flex-col gap-4">
        {questions.map((q) => {
          const state = stateFor(q.id);
          const showOtherText =
            q.answer_kind === "single_select"
              ? isOtherValue(state.values[0] ?? "")
              : q.answer_kind === "multi_select"
              ? state.values.some(isOtherValue)
              : false;

          return (
            <fieldset key={q.id} className={fieldsetClass}>
              <legend className={legendClass}>{q.question}</legend>
              {q.rationale && <p className={rationaleClass}>{q.rationale}</p>}

              {q.answer_kind === "free_text" && (
                <div className="mt-3">
                  <label htmlFor={`${q.id}-freetext`} className={smallLabelClass}>
                    Your answer
                  </label>
                  <textarea
                    id={`${q.id}-freetext`}
                    value={state.freeText}
                    onChange={(e) => setFreeText(q.id, e.target.value)}
                    rows={2}
                    className={textInputClass}
                  />
                </div>
              )}

              {q.answer_kind === "single_select" && (
                <div className="mt-3 flex flex-col gap-2">
                  {q.options.map((opt) => (
                    <label key={opt.value} htmlFor={`${q.id}-${opt.value}`} className={optionLabelClass}>
                      <input
                        type="radio"
                        id={`${q.id}-${opt.value}`}
                        name={q.id}
                        value={opt.value}
                        checked={state.values[0] === opt.value}
                        onChange={() => setSingle(q.id, opt.value)}
                        className={optionInputClass}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}

              {q.answer_kind === "multi_select" && (
                <div className="mt-3 flex flex-col gap-2">
                  {q.options.map((opt) => (
                    <label key={opt.value} htmlFor={`${q.id}-${opt.value}`} className={optionLabelClass}>
                      <input
                        type="checkbox"
                        id={`${q.id}-${opt.value}`}
                        value={opt.value}
                        checked={state.values.includes(opt.value)}
                        onChange={() => toggleMulti(q.id, opt.value)}
                        className={optionInputClass}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}

              {showOtherText && (
                <div className="mt-2">
                  <label htmlFor={`${q.id}-other`} className={smallLabelClass}>
                    Other — please specify
                  </label>
                  <input
                    type="text"
                    id={`${q.id}-other`}
                    value={state.freeText}
                    onChange={(e) => setFreeText(q.id, e.target.value)}
                    className={textInputClass}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleContinue} className={secondaryButtonClass}>
          Continue
        </button>
        <button type="button" onClick={onSkip} className={secondaryButtonClass}>
          Search anyway
        </button>
      </div>
    </div>
  );
}
