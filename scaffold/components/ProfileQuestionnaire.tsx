"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  PROFILE_FIELD_META,
  PROFILE_FIELD_META_BY_KEY,
  MATERIAL_PROFILE_FIELDS,
  isFieldProvided,
  CompanyProfileSchema,
  type CompanyProfile,
  type ProfileFieldMeta,
} from "@/lib/contracts/companyProfile";
import type { Provenance, Provenanced } from "@/lib/contracts/primitives";
import type { StartupProfile } from "@/lib/types";
import { readJSON, writeJSON } from "@/lib/localStore";
import { summarizeDescription } from "@/lib/ui/formSummary";
import { ChevronIcon } from "@/components/OpportunityCard";

/**
 * B1b — ProfileQuestionnaire: the structured, gap-first intake form.
 *
 * Replaces the free-text box as the PRIMARY way users give FundFinder the
 * 13 B1a profile fields (`PROFILE_FIELD_META`, `lib/contracts/companyProfile.ts`)
 * — 5 required + 8 optional-but-material, required first, material fields
 * behind an opt-in toggle.
 *
 * Every field always renders as a directly-editable control, pre-filled with
 * its current value — no separate "Edit" step.
 *
 * PERSISTENCE (§5.3 — localStorage-only, no server retention): the whole
 * draft profile lives in `localStorage` via `lib/localStore.ts` and is never
 * sent anywhere except folded into the plain description string handed to
 * `/api/match` when the user submits — exactly like today's free-text flow.
 *
 * GAP-DETECTION NOTE: `computeGaps` below intentionally reimplements
 * `lib/interview/generateQuestions.ts`'s `detectGaps` (same two atoms:
 * `MATERIAL_PROFILE_FIELDS` + `isFieldProvided`) rather than importing it.
 * `generateQuestions.ts` imports the OpenAI SDK at module scope for its own
 * server-only call; a "use client" component must not pull a *runtime*
 * binding from that module or the SDK ships in the client bundle (see the
 * identical type-only-import guard in `components/IntakeForm.tsx`). The
 * reused logic is the two atoms themselves, both pure/client-safe.
 */

const STORAGE_KEY = "ff.questionnaire.profile.v1";

/** The in-progress draft: a subset of `CompanyProfile`'s provenanced cells. */
type ProfileDraft = Partial<CompanyProfile>;

const PROFILE_SHAPE = CompanyProfileSchema.shape as Record<string, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing — no React, no network).
// ---------------------------------------------------------------------------

/** The material fields (required + material) still missing from `profile`. */
export function computeGaps(profile: ProfileDraft): ProfileFieldMeta[] {
  return MATERIAL_PROFILE_FIELDS.filter((m) => !isFieldProvided(profile, m.field));
}

/**
 * Compile the filled fields into a plain description string: the user's
 * own `raw_text` verbatim, then one "Label: value" line per other provided
 * field. Mirrors `lib/interview/mergeAnswers.ts`'s `buildEnrichedDescription`
 * shape so the existing `/api/match` + gap-detection heuristics downstream see
 * the same kind of text they already handle.
 */
export function buildDescriptionFromProfile(profile: ProfileDraft): string {
  const rawText = (profile.raw_text?.value ?? "").trim();
  const bag = profile as Record<string, { value?: unknown } | undefined>;
  const lines: string[] = [];
  for (const m of PROFILE_FIELD_META) {
    if (m.field === "raw_text") continue;
    if (!isFieldProvided(profile, m.field)) continue;
    const raw = bag[m.field]?.value;
    const rendered = Array.isArray(raw) ? raw.join(", ") : String(raw);
    lines.push(`${m.label}: ${rendered}`);
  }
  if (lines.length === 0) return rawText;
  return [rawText, "", "Additional details:", ...lines].join("\n");
}

/** Map the v1 `StartupProfile` extraction result onto the 13 B1a field keys. */
export function mapStartupProfileToValues(sp: StartupProfile): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (field: string, v: string | number | undefined | null) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (s.length > 0) out[field] = s;
  };
  put("raw_text", sp.description);
  put("industry", sp.industry);
  put("technology", sp.technology);
  put("location", sp.location);
  put("use_of_funds", sp.useOfFunds);
  if (typeof sp.employees === "number" && Number.isFinite(sp.employees) && sp.employees >= 0) {
    put("employee_count", String(Math.round(sp.employees)));
  }
  put("revenue", sp.revenue);
  put("funding_stage", sp.fundingStage);
  put("capital_raised", sp.capitalRaised);
  put("rd_activities", sp.rdActivities);
  put("product_maturity", sp.productMaturity);
  put("target_customers", sp.targetCustomers);
  put("capital_requirement", sp.capitalRequirement);
  return out;
}

function coerceRaw(meta: ProfileFieldMeta, trimmed: string): unknown {
  if (meta.inputType === "integer") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }
  return trimmed;
}

/**
 * Whether an incoming write of `incoming` provenance may replace a field
 * currently holding `existing` provenance. Mirrors the never-overwrite guard
 * in `lib/interview/mergeAnswers.ts`: a `model_inferred` autofill guess may
 * never clobber a `user_stated`/`verified` fact the user already gave.
 */
function canWriteProvenance(existing: Provenance | undefined, incoming: Provenance): boolean {
  if (existing === undefined) return true;
  if (incoming === "user_stated" || incoming === "verified") return true;
  return existing === "model_inferred";
}

/**
 * Build the provenanced cell `field` should hold for a raw form value, or
 * `null` when the write is uncoercible, invalid against the real contract
 * schema, or blocked by `canWriteProvenance`. Pure — the caller decides what
 * to do with `null` (typically: leave the existing value alone).
 */
export function computeFieldCell(
  meta: ProfileFieldMeta,
  rawValue: string,
  provenance: Provenance,
  existing: { provenance: Provenance } | undefined,
): Provenanced<unknown> | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return null;
  if (!canWriteProvenance(existing?.provenance, provenance)) return null;
  const coerced = coerceRaw(meta, trimmed);
  if (coerced === undefined) return null;
  const shape = PROFILE_SHAPE[meta.field];
  if (!shape) return null;
  const candidate = {
    value: coerced,
    provenance,
    confidence: provenance === "user_stated" || provenance === "verified" ? 1 : 0.6,
  };
  const res = shape.safeParse(candidate);
  return res.success ? (res.data as Provenanced<unknown>) : null;
}

// ---------------------------------------------------------------------------
// UX-polish pure helpers (exported for testing — no React, no network).
// ---------------------------------------------------------------------------

/**
 * Fields that get a full-width cell in the responsive two-column field grid
 * (the big description box, and the two fields whose answers tend to run
 * long: the yes/no-plus-detail R&D field and free-text "target customers").
 * Every other field gets a half-width cell from the `sm:` breakpoint up and
 * always renders full-width below it. Purely presentational — it has no
 * bearing on `computeGaps`, validation, or what gets captured.
 */
const WIDE_FIELDS = new Set<string>(["raw_text", "rd_activities", "target_customers"]);

/** Whether `field` should span both columns of the responsive field grid. */
export function isWideField(field: string): boolean {
  return WIDE_FIELDS.has(field);
}

/**
 * Groups the 8 optional-but-material fields under two user-facing
 * headings so "A few more details" reads as organized sections instead of
 * one long list. Purely a presentation grouping — `MATERIAL_PROFILE_FIELDS`
 * (the actual required-ness contract gap-detection reads) is untouched; a
 * field's group membership here has no bearing on whether it's asked about.
 */
export const MATERIAL_FIELD_GROUPS: readonly { heading: string; fields: readonly string[] }[] = [
  {
    heading: "Company & product",
    fields: ["employee_count", "product_maturity", "target_customers", "rd_activities"],
  },
  {
    heading: "Financials",
    fields: ["revenue", "funding_stage", "capital_raised", "capital_requirement"],
  },
];

/** Split a "Yes — detail" / "Yes" / "No" / "" value into radio choice + detail text. */
export function splitBooleanText(draft: string): { choice: string; detail: string } {
  const trimmed = draft.trim();
  if (trimmed === "No") return { choice: "No", detail: "" };
  if (trimmed === "Yes") return { choice: "Yes", detail: "" };
  const prefix = "Yes — ";
  if (trimmed.startsWith(prefix)) return { choice: "Yes", detail: trimmed.slice(prefix.length) };
  return { choice: "", detail: "" };
}

function applyFieldEdit(prev: ProfileDraft, meta: ProfileFieldMeta, rawValue: string, provenance: Provenance): ProfileDraft {
  const bag = prev as Record<string, Provenanced<unknown> | undefined>;
  const existing = bag[meta.field];
  if (rawValue.trim().length === 0) {
    if (existing === undefined) return prev;
    const next = { ...bag };
    delete next[meta.field];
    return next as ProfileDraft;
  }
  const cell = computeFieldCell(meta, rawValue, provenance, existing);
  if (!cell) return prev;
  return { ...prev, [meta.field]: cell } as ProfileDraft;
}

/** `profile` with the uncommitted (not yet blurred) edits in `values` applied. */
export function computeLiveProfile(profile: ProfileDraft, values: Record<string, string>): ProfileDraft {
  return PROFILE_FIELD_META.reduce(
    (p, meta) => (meta.field in values ? applyFieldEdit(p, meta, values[meta.field] ?? "", "user_stated") : p),
    profile,
  );
}

/** Current display value for a plain field: live edit if any, else the saved profile value. */
export function draftValue(profile: ProfileDraft, values: Record<string, string>, field: string): string {
  if (field in values) return values[field] ?? "";
  const bag = profile as Record<string, { value?: unknown } | undefined>;
  const value = bag[field]?.value;
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Current radio choice + detail text for a boolean_text field: live edits win, else the saved value. */
export function resolveBooleanTextField(
  profile: ProfileDraft,
  values: Record<string, string>,
  field: string,
): { choice: string; detail: string } {
  const choiceKey = `${field}__choice`;
  const detailKey = `${field}__detail`;
  const saved = splitBooleanText(draftValue(profile, values, field));
  const choice = choiceKey in values ? values[choiceKey] ?? "" : saved.choice;
  const detail = detailKey in values ? values[detailKey] ?? "" : saved.detail;
  return { choice, detail };
}

/** User-facing progress copy for the required-fields section. */
export function requiredProgressText(totalRequired: number, remaining: number): string | null {
  const done = Math.max(0, totalRequired - remaining);
  if (remaining <= 0) return null;
  return `${done} of ${totalRequired} required field${totalRequired === 1 ? "" : "s"} complete`;
}

/**
 * Inline validation copy for a single field, or `null` when nothing should
 * render. Only `required`-tier fields ever produce a message — the 8
 * material fields are optional by definition, so they never get one — and
 * only once the user has actually left the field (`touched`), so a fresh
 * form never opens already showing a wall of errors.
 */
export function fieldValidationMessage(
  meta: ProfileFieldMeta,
  provided: boolean,
  touched: boolean,
): string | null {
  if (meta.requirement !== "required") return null;
  if (provided || !touched) return null;
  return `${meta.label} is required.`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ProfileQuestionnaireProps {
  /** Disables every input/button — e.g. while a search is already running. */
  disabled?: boolean;
  /** Seed/re-seed the description field from outside (e.g. the sidebar
   *  drawer's "Use this" action). Bump `externalNonce` to force a re-seed
   *  even when the text is identical to what's already there. */
  externalText?: string;
  externalNonce?: number;
  /** Fires whenever the compiled description changes, so the parent can
   *  mirror it for its own checks (sample-replace confirm, "Try again"). */
  onDescriptionChange?: (text: string) => void;
  /** Fires when the user submits. `complete` is true iff every required +
   *  material field (all 13) is provided — the parent uses this to skip the
   *  R1 AI interview entirely (a fully-filled form asks zero questions). */
  onSubmit: (description: string, meta: { complete: boolean }) => void;
  /** True once a real search has started for the current form contents — the
   *  form renders as a single summary bar instead of the full field set.
   *  Owned by the parent (IntakeForm), not this component: a sample search
   *  from the welcome guide bypasses `onSubmit` entirely and must NOT
   *  collapse the form, which this component alone has no way to tell apart
   *  from a real submit. Defaults to false (today's fully-expanded form). */
  collapsed?: boolean;
  /** Fires when the user clicks the collapsed summary bar to expand back to
   *  the full form. Required whenever `collapsed` can be true. */
  onExpand?: () => void;
}

export default function ProfileQuestionnaire({
  disabled = false,
  externalText,
  externalNonce,
  onDescriptionChange,
  onSubmit,
  collapsed = false,
  onExpand,
}: ProfileQuestionnaireProps) {
  const [profile, setProfile] = useState<ProfileDraft>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [showOptional, setShowOptional] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // UX polish: which fields the user has actually blurred at least once —
  // gates inline "required" validation so a fresh form never opens already
  // showing errors, only after a required field has been visited and left
  // empty (see `fieldValidationMessage` above).
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());

  // Focus management for the optional-details section: a manual click on "+ Add
  // optional details" should move focus into the newly-revealed heading, so
  // only a real click sets `manualOpenRef`.
  const materialHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const manualOpenRef = useRef(false);

  // Collapsed-summary focus management: expanding the form (clicking the
  // summary bar/chevron, or its Enter/Space keyboard equivalent) moves focus
  // into the description field, same as the material-fields reveal above
  // moves focus to its heading. Tracked via the previous `collapsed` value
  // (not a click-time flag) so it fires on ANY collapsed->expanded
  // transition, regardless of what triggered it.
  const rawTextRef = useRef<HTMLTextAreaElement | null>(null);
  const prevCollapsedRef = useRef(collapsed);
  useEffect(() => {
    if (prevCollapsedRef.current && !collapsed) {
      rawTextRef.current?.focus();
    }
    prevCollapsedRef.current = collapsed;
  }, [collapsed]);

  // Hydrate the draft from localStorage once, client-only (readJSON no-ops
  // during SSR and returns the fallback).
  useEffect(() => {
    const stored = readJSON<ProfileDraft>(STORAGE_KEY, {});
    if (stored && Object.keys(stored).length > 0) setProfile(stored);
    setHydrated(true);
  }, []);

  // Persist on every change — but only after hydration, so the initial empty
  // state never races the read above and clobbers a real stored draft.
  useEffect(() => {
    if (!hydrated) return;
    writeJSON(STORAGE_KEY, profile);
  }, [profile, hydrated]);

  function commitField(field: string, rawValue: string, provenance: Provenance) {
    setValues((v) => ({ ...v, [field]: rawValue }));
    const meta = PROFILE_FIELD_META_BY_KEY[field];
    if (!meta) return;
    setProfile((prev) => applyFieldEdit(prev, meta, rawValue, provenance));
  }

  // Bubble the compiled description up on every profile change so the parent
  // can mirror it (sample-replace confirm, "Try again" fallback).
  useEffect(() => {
    onDescriptionChange?.(buildDescriptionFromProfile(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // An explicit external action (e.g. "Use this" in the sidebar) always wins:
  // re-seed the description at user_stated provenance.
  useEffect(() => {
    if (externalNonce === undefined) return;
    if (externalText === undefined || externalText.trim().length === 0) return;
    commitField("raw_text", externalText, "user_stated");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalNonce]);

  const liveProfile = useMemo(() => computeLiveProfile(profile, values), [profile, values]);
  const gaps = useMemo(() => computeGaps(liveProfile), [liveProfile]);
  const requiredGaps = useMemo(() => gaps.filter((g) => g.requirement === "required"), [gaps]);
  const isComplete = gaps.length === 0;
  const canSubmit = requiredGaps.length === 0;

  // Focus the "A few more details" heading after a MANUAL reveal only — see
  // `manualOpenRef`'s comment.
  useEffect(() => {
    if (showOptional && manualOpenRef.current) {
      materialHeadingRef.current?.focus();
      manualOpenRef.current = false;
    }
  }, [showOptional]);

  function markTouched(field: string) {
    setTouchedFields((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  }

  function handleSubmit() {
    if (!canSubmit) return;
    setProfile(liveProfile);
    onSubmit(buildDescriptionFromProfile(liveProfile), { complete: isComplete });
  }

  const [clearedVisible, setClearedVisible] = useState(false);
  const clearedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearedTimerRef.current) clearTimeout(clearedTimerRef.current);
    };
  }, []);

  function clearSaved() {
    setProfile({});
    setValues({});
    setShowOptional(false);
    writeJSON(STORAGE_KEY, {});
    if (clearedTimerRef.current) clearTimeout(clearedTimerRef.current);
    setClearedVisible(true);
    clearedTimerRef.current = setTimeout(() => setClearedVisible(false), 2000);
  }

  // ---- styling: dual-class design-token / v1 pattern, matching
  // PreSearchInterview.tsx / IntakeForm.tsx exactly (same tokens, no new hex). ----

  const sectionHeadingClass = "block font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const introClass = "mt-1 text-pretty font-body text-[13px] leading-relaxed text-foreground";

  const fieldWrapClass = "flex flex-col";

  const fieldLabelClass = "mb-1 block font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const textareaBigClass =
    "w-full resize-none rounded-sm border border-structure-on-canvas bg-canvas-alt p-4 font-body text-[15px] leading-relaxed text-foreground outline-none focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas disabled:cursor-not-allowed disabled:opacity-60";

  const textareaSmallClass =
    "w-full resize-none rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2 font-body text-[14px] leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-structure-on-canvas disabled:cursor-not-allowed disabled:opacity-60";

  const textInputClass =
    "w-full rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2 font-body text-[14px] text-foreground outline-none focus:ring-2 focus:ring-structure-on-canvas disabled:cursor-not-allowed disabled:opacity-60";

  const selectClass = textInputClass;

  const radioLabelClass = "flex cursor-pointer items-center gap-2 font-body text-[14px] text-foreground";

  const radioInputClass = "h-4 w-4 shrink-0 accent-structure";

  const primaryButtonClass =
    "min-h-[44px] rounded-sm bg-action px-5 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-token-white shadow-sm transition hover:opacity-90 hover:shadow active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const secondaryButtonClass =
    "min-h-[44px] rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const hintTextClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  // A required-field marker, in words rather than a bare red asterisk: an
  // asterisk-only cue needs its own screen-reader affordance anyway, and a
  // small inline red glyph directly on canvas is exactly the pattern
  // scripts/design/contrast-check.mjs's advisory table flags "DO NOT USE"
  // (fails AA at this size/weight). "Required" in the existing safe
  // structure-on-canvas eyebrow token sidesteps both problems.
  const requiredMarkerClass = "ml-1 font-mono text-[10px] uppercase tracking-eyebrow text-structure-on-canvas";

  // Sub-group heading inside "A few more details" (Company & product /
  // Financials) — same eyebrow treatment as the top-level section headings.
  const groupHeadingClass = sectionHeadingClass;

  // Reset the browser's default fieldset/legend chrome (border, padding,
  // margin) so the boolean_text field's <fieldset> matches every other
  // field's plain flex-col wrapper exactly.
  const fieldsetResetClass = "m-0 min-w-0 border-0 p-0";

  // CON-02: `error` is a fill/border-only semantic role — never bare inline
  // text color (that pairing fails AA and is explicitly flagged "DO NOT USE"
  // in scripts/design/contrast-check.mjs's advisory table). The message text
  // stays `text-foreground` (AA-safe); the left border carries the "this is
  // an error" signal instead, same pattern as IntakeForm.tsx's errorClass.
  const errorTextClass =
    "border-l-2 border-error pl-2 text-pretty font-body text-[12px] leading-relaxed text-foreground";

  const clearLinkClass =
    "font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline decoration-dotted underline-offset-2 transition hover:text-structure-on-canvas disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";


  // ---- field rendering ----

  function renderField(meta: ProfileFieldMeta, spanClass = "") {
    const required = meta.requirement === "required";
    const wrapClass = spanClass ? `${fieldWrapClass} ${spanClass}` : fieldWrapClass;
    const requiredMarker = required ? <span className={requiredMarkerClass}>Required</span> : null;

    const value = draftValue(profile, values, meta.field);

    if (meta.inputType === "single_select" || meta.inputType === "range_select") {
      return (
        <div key={meta.field} className={wrapClass}>
          <label htmlFor={`pq-${meta.field}`} className={fieldLabelClass}>
            {meta.label}
            {requiredMarker}
          </label>
          <select
            id={`pq-${meta.field}`}
            value={value}
            disabled={disabled}
            aria-required={required}
            onChange={(e) => {
              commitField(meta.field, e.target.value, "user_stated");
              markTouched(meta.field);
            }}
            className={selectClass}
          >
            <option value="">Select…</option>
            {meta.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (meta.inputType === "integer") {
      return (
        <div key={meta.field} className={wrapClass}>
          <label htmlFor={`pq-${meta.field}`} className={fieldLabelClass}>
            {meta.label}
            {requiredMarker}
          </label>
          <input
            id={`pq-${meta.field}`}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={value}
            disabled={disabled}
            aria-required={required}
            onChange={(e) => setValues((v) => ({ ...v, [meta.field]: e.target.value }))}
            onBlur={(e) => {
              commitField(meta.field, e.target.value, "user_stated");
              markTouched(meta.field);
            }}
            className={textInputClass}
          />
        </div>
      );
    }

    if (meta.inputType === "boolean_text") {
      const choiceKey = `${meta.field}__choice`;
      const detailKey = `${meta.field}__detail`;
      const { choice, detail } = resolveBooleanTextField(profile, values, meta.field);
      const commitBooleanText = (nextChoice: string, nextDetail: string) => {
        const combined =
          nextChoice === "Yes" ? (nextDetail.trim() ? `Yes — ${nextDetail.trim()}` : "Yes") : nextChoice === "No" ? "No" : "";
        commitField(meta.field, combined, "user_stated");
        markTouched(meta.field);
      };
      return (
        <fieldset key={meta.field} className={`${wrapClass} ${fieldsetResetClass}`}>
          <legend className={`${fieldLabelClass} p-0`}>
            {meta.label}
            {requiredMarker}
          </legend>
          <div className="mt-1 flex gap-4">
            {["Yes", "No"].map((opt) => (
              <label key={opt} className={radioLabelClass}>
                <input
                  type="radio"
                  name={`pq-${meta.field}`}
                  checked={choice === opt}
                  disabled={disabled}
                  onChange={() => {
                    setValues((v) => ({ ...v, [choiceKey]: opt }));
                    commitBooleanText(opt, detail);
                  }}
                  className={radioInputClass}
                />
                {opt}
              </label>
            ))}
          </div>
          {choice === "Yes" && (
            <input
              type="text"
              placeholder="Briefly describe (optional)"
              aria-label={`${meta.label} — details`}
              value={detail}
              disabled={disabled}
              onChange={(e) => setValues((v) => ({ ...v, [detailKey]: e.target.value }))}
              onBlur={(e) => commitBooleanText("Yes", e.target.value)}
              className={`${textInputClass} mt-2`}
            />
          )}
        </fieldset>
      );
    }

    // free_text: raw_text, industry, technology, location, use_of_funds, target_customers
    const isBig = meta.field === "raw_text";
    const touched = touchedFields.has(meta.field);
    const provided = isFieldProvided(profile, meta.field);
    const errorMsg = fieldValidationMessage(meta, provided, touched);
    const errorId = `pq-${meta.field}-error`;
    return (
      <div key={meta.field} className={wrapClass}>
        <label htmlFor={`pq-${meta.field}`} className={fieldLabelClass}>
          {meta.label}
          {requiredMarker}
        </label>
        <textarea
          id={`pq-${meta.field}`}
          ref={meta.field === "raw_text" ? rawTextRef : undefined}
          rows={isBig ? 5 : 2}
          value={value}
          disabled={disabled}
          placeholder={isBig ? "What you build, who it's for, and how much you need." : undefined}
          aria-required={required}
          aria-invalid={Boolean(errorMsg)}
          aria-describedby={errorMsg ? errorId : undefined}
          onChange={(e) => setValues((v) => ({ ...v, [meta.field]: e.target.value }))}
          onBlur={(e) => {
            commitField(meta.field, e.target.value, "user_stated");
            markTouched(meta.field);
          }}
          className={isBig ? textareaBigClass : textareaSmallClass}
        />
        {errorMsg && (
          <p id={errorId} role="alert" className={`mt-1 ${errorTextClass}`}>
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  const requiredFields = PROFILE_FIELD_META.filter((m) => m.requirement === "required");

  // Collapsed summary bar — shown after a real search starts (parent-owned
  // `collapsed`), so results sit closer to the top instead of below the full
  // form. Same expand/collapse visual pattern (full-width button, chevron)
  // as OpportunityCard's card header, and the same `.reveal` entrance used
  // throughout the app — reduced-motion-safe via the global rule in
  // globals.css. The description shown is the exact text as typed (live
  // edit if any, else the saved value), trimmed to one line.
  if (collapsed) {
    const description = draftValue(profile, values, "raw_text");
    return (
      <div className="reveal mt-5">
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          aria-controls="pq-form-fields"
          className="flex w-full items-center justify-between gap-4 rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-3 text-left transition hover:bg-structure/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
        >
          <span className="min-w-0">
            <span className={sectionHeadingClass}>Your company</span>
            <span className="mt-0.5 block truncate text-pretty font-body text-[14px] text-foreground">
              {description ? summarizeDescription(description) : "No description yet"}
            </span>
          </span>
          <ChevronIcon className="h-5 w-5 shrink-0 text-structure-on-canvas" />
        </button>
      </div>
    );
  }

  return (
    <div id="pq-form-fields" className="reveal">
      {/* Required fields — the search needs these to route at all. Grid:
          single column on mobile (each field always full-width), two
          columns from `sm:` up, with the description box and any other
          "wide" field spanning both. */}
      <div className="mt-5">
        <h2 className={sectionHeadingClass}>Tell us about your company</h2>
        {requiredProgressText(requiredFields.length, requiredGaps.length) && (
          <p aria-live="polite" className={introClass}>
            {requiredProgressText(requiredFields.length, requiredGaps.length)}
          </p>
        )}
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {requiredFields.map((m) => renderField(m, isWideField(m.field) ? "sm:col-span-2" : ""))}
        </div>
      </div>

      {/* Optional-but-material fields — progressive disclosure: revealed on
          demand via the toggle. Grouped under two user-facing headings
          (Company & product / Financials) so the list reads as organized
          sections, not one long form. */}
      <div className="mt-5 border-t border-structure-on-canvas pt-4">
        {!showOptional ? (
          <button
            type="button"
            onClick={() => {
              manualOpenRef.current = true;
              setShowOptional(true);
            }}
            disabled={disabled}
            aria-expanded={false}
            aria-controls="pq-material-fields"
            className={secondaryButtonClass}
          >
            + Add optional details (improves matches)
          </button>
        ) : (
          <div id="pq-material-fields">
            <h2
              ref={materialHeadingRef}
              tabIndex={-1}
              className={`${sectionHeadingClass} rounded-sm focus:outline-none focus:ring-2 focus:ring-structure-on-canvas`}
            >
              A few more details (optional)
            </h2>
            <p className={introClass}>
              None of these are required — but each one changes which programs match.
            </p>
            <div className="mt-4 flex flex-col gap-5">
              {MATERIAL_FIELD_GROUPS.map((group) => {
                const fields = group.fields
                  .map((f) => PROFILE_FIELD_META_BY_KEY[f])
                  .filter((m): m is ProfileFieldMeta => Boolean(m));
                if (fields.length === 0) return null;
                return (
                  <div key={group.heading}>
                    <h3 className={groupHeadingClass}>{group.heading}</h3>
                    <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {fields.map((m) => renderField(m, isWideField(m.field) ? "sm:col-span-2" : ""))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleSubmit} disabled={disabled || !canSubmit} className={primaryButtonClass}>
          Find opportunities
        </button>
        {requiredGaps.length > 0 && (
          <span className={hintTextClass}>
            {requiredGaps.length} required field{requiredGaps.length === 1 ? "" : "s"} left
          </span>
        )}
        <button type="button" onClick={clearSaved} disabled={disabled} className={clearLinkClass}>
          Clear saved answers
        </button>
        <span className={hintTextClass} role="status" aria-live="polite">
          {clearedVisible ? "Cleared" : ""}
        </span>
      </div>
    </div>
  );
}
