"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * B1b — ProfileQuestionnaire: the structured, gap-first intake form.
 *
 * Replaces the free-text box as the PRIMARY way users give FundFinder the
 * 13 B1a profile fields (`PROFILE_FIELD_META`, `lib/contracts/companyProfile.ts`)
 * — 5 required + 8 optional-but-material, required first, then progressive
 * disclosure of the material fields once required is complete (or the user
 * opts in early).
 *
 * THE CORE GUARANTEE ("never re-ask a provided field"): a field the profile
 * already provides (`isFieldProvided`) NEVER renders as an input — it renders
 * as a read-only summary row with an explicit "Edit" affordance. This is true
 * whether the value came from the user typing it, from a restored
 * localStorage draft, or from the free-text AUTOFILL below. A fully-filled
 * profile therefore has ZERO gaps left to ask about; the caller uses the
 * `complete` flag on `onSubmit` to skip the R1 AI interview entirely for that
 * case (see components/IntakeForm.tsx).
 *
 * AUTOFILL: a user can still paste free text. It POSTs to
 * `/api/extract-profile` (a thin wrapper around the live pipeline's
 * `extractProfile`, `lib/claude.ts`) and maps the result onto these same 13
 * fields at `model_inferred` provenance — never silently overwriting a
 * `user_stated`/`verified` fact already on the form (mirrors the
 * never-overwrite guard in `lib/interview/mergeAnswers.ts`). The user then
 * confirms/edits each pre-filled field like any other.
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

/** User-facing progress copy for the required-fields section. */
export function requiredProgressText(totalRequired: number, remaining: number): string {
  const done = Math.max(0, totalRequired - remaining);
  if (remaining <= 0) return `All ${totalRequired} required fields complete.`;
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
}

export default function ProfileQuestionnaire({
  disabled = false,
  externalText,
  externalNonce,
  onDescriptionChange,
  onSubmit,
}: ProfileQuestionnaireProps) {
  const [profile, setProfile] = useState<ProfileDraft>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingFields, setEditingFields] = useState<Set<string>>(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // UX polish: which fields the user has actually blurred at least once —
  // gates inline "required" validation so a fresh form never opens already
  // showing errors, only after a required field has been visited and left
  // empty (see `fieldValidationMessage` above).
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());

  // UX polish: keyboard focus management. Clicking "Edit" on a provided-field
  // summary row swaps it for the real input; a mouse user sees exactly where
  // to click next, but a keyboard/screen-reader user is stranded unless focus
  // follows. `pendingFocusFieldRef` records which field's input should
  // receive focus on the next render where that input actually exists.
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const pendingFocusFieldRef = useRef<string | null>(null);

  // Same idea for the optional-details section: a manual click on "+ Add
  // optional details" should move focus into the newly-revealed heading. The
  // automatic reveal-on-required-complete effect below must NOT steal focus
  // the same way (it can fire mid-keystroke in a required field), so only a
  // real click sets `manualOpenRef`.
  const materialHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const manualOpenRef = useRef(false);

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
    setProfile((prev) => {
      const bag = prev as Record<string, Provenanced<unknown> | undefined>;
      const existing = bag[field];
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        if (existing === undefined) return prev;
        const next = { ...bag };
        delete next[field];
        return next as ProfileDraft;
      }
      const cell = computeFieldCell(meta, rawValue, provenance, existing);
      if (!cell) return prev;
      return { ...prev, [field]: cell } as ProfileDraft;
    });
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

  const gaps = useMemo(() => computeGaps(profile), [profile]);
  const requiredGaps = useMemo(() => gaps.filter((g) => g.requirement === "required"), [gaps]);
  const isComplete = gaps.length === 0;
  const canSubmit = requiredGaps.length === 0;

  // Progressive disclosure: once every required field is in, open the
  // optional section automatically (still opt-out-able via the toggle below
  // isn't needed — nothing forces the user to fill it; "Find opportunities"
  // is already enabled at this point).
  useEffect(() => {
    if (requiredGaps.length === 0) setShowOptional(true);
  }, [requiredGaps.length]);

  // Focus the newly-revealed input after an "Edit" click (see
  // `pendingFocusFieldRef` above) — fires once per edit, right after the
  // field's editable markup actually lands in the DOM.
  useEffect(() => {
    const field = pendingFocusFieldRef.current;
    if (field && editingFields.has(field)) {
      fieldRefs.current[field]?.focus();
      pendingFocusFieldRef.current = null;
    }
  }, [editingFields]);

  // Focus the "A few more details" heading after a MANUAL reveal only (never
  // on the automatic reveal-on-required-complete above) — see
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

  function draftFor(field: string): string {
    if (field in values) return values[field] ?? "";
    const bag = profile as Record<string, { value?: unknown } | undefined>;
    const value = bag[field]?.value;
    if (value === undefined || value === null) return "";
    return Array.isArray(value) ? value.join(", ") : String(value);
  }

  function startEdit(field: string) {
    pendingFocusFieldRef.current = field;
    setEditingFields((prev) => {
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }
  function stopEdit(field: string) {
    setEditingFields((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  async function runAutofill() {
    const text = pasteText.trim();
    if (text.length < 20) {
      setExtractError("Add a bit more detail before autofilling — a sentence or two is enough.");
      return;
    }
    setExtracting(true);
    setExtractError(null);
    try {
      const res = await fetch("/api/extract-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: text }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setExtractError(j?.error ?? "Autofill didn't work — you can still fill the form by hand.");
        return;
      }
      // The pasted text itself is user_stated (they wrote it); everything the
      // extractor derived from it is model_inferred until confirmed/edited.
      commitField("raw_text", text, "user_stated");
      const sp = j?.profile as StartupProfile | null | undefined;
      if (sp) {
        const mapped = mapStartupProfileToValues(sp);
        for (const [field, value] of Object.entries(mapped)) {
          if (field === "raw_text") continue;
          commitField(field, value, "model_inferred");
        }
      }
      setPasteOpen(false);
      setPasteText("");
    } catch {
      setExtractError("Autofill didn't work — you can still fill the form by hand.");
    } finally {
      setExtracting(false);
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(buildDescriptionFromProfile(profile), { complete: isComplete });
  }

  function clearSaved() {
    setProfile({});
    setValues({});
    setEditingFields(new Set());
    setShowOptional(false);
    writeJSON(STORAGE_KEY, {});
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

  const providedRowClass = "flex items-start justify-between gap-3 rounded-sm bg-canvas-alt px-3 py-2";

  const providedLabelClass = "block font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const providedValueClass = "mt-0.5 text-pretty font-body text-[14px] leading-relaxed text-foreground";

  const editButtonClass =
    "shrink-0 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas underline decoration-dotted underline-offset-2 transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

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

  const pasteTriggerClass = secondaryButtonClass;

  const pastePanelClass = "mt-3 rounded-lg bg-canvas-alt p-4 shadow-card";

  // ---- field rendering ----

  function renderField(meta: ProfileFieldMeta, spanClass = "") {
    const provided = isFieldProvided(profile, meta.field) && !editingFields.has(meta.field);
    const required = meta.requirement === "required";
    const wrapClass = spanClass ? `${fieldWrapClass} ${spanClass}` : fieldWrapClass;
    const requiredMarker = required ? <span className={requiredMarkerClass}>Required</span> : null;

    if (provided) {
      const bag = profile as Record<string, { value: unknown }>;
      const raw = bag[meta.field].value;
      // For option-backed fields (single_select / range_select) the stored value
      // is the enum value (e.g. "in_market"), so the read-only summary must map
      // it back to the SAME human label the dropdown shows ("In market") — never
      // print the underscored raw value. Free-text/number fields have no options
      // and pass through unchanged.
      const optionLabelFor = (v: string) => meta.options?.find((o) => o.value === v)?.label ?? v;
      const display = Array.isArray(raw)
        ? raw.map((v) => optionLabelFor(String(v))).join(", ")
        : optionLabelFor(String(raw));
      return (
        <div key={meta.field} className={`${providedRowClass} ${spanClass}`.trim()}>
          <div className="min-w-0">
            <span className={providedLabelClass}>{meta.label}</span>
            <p className={providedValueClass}>{display}</p>
          </div>
          <button
            type="button"
            onClick={() => startEdit(meta.field)}
            className={editButtonClass}
            disabled={disabled}
            aria-label={`Edit ${meta.label}`}
          >
            Edit
          </button>
        </div>
      );
    }

    const value = draftFor(meta.field);

    if (meta.inputType === "single_select" || meta.inputType === "range_select") {
      return (
        <div key={meta.field} className={wrapClass}>
          <label htmlFor={`pq-${meta.field}`} className={fieldLabelClass}>
            {meta.label}
            {requiredMarker}
          </label>
          <select
            id={`pq-${meta.field}`}
            ref={(el) => {
              fieldRefs.current[meta.field] = el;
            }}
            value={value}
            disabled={disabled}
            aria-required={required}
            onChange={(e) => {
              commitField(meta.field, e.target.value, "user_stated");
              markTouched(meta.field);
              stopEdit(meta.field);
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
            ref={(el) => {
              fieldRefs.current[meta.field] = el;
            }}
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
              stopEdit(meta.field);
            }}
            className={textInputClass}
          />
        </div>
      );
    }

    if (meta.inputType === "boolean_text") {
      const choiceKey = `${meta.field}__choice`;
      const detailKey = `${meta.field}__detail`;
      const choice = values[choiceKey] ?? "";
      const detail = values[detailKey] ?? "";
      const commitBooleanText = (nextChoice: string, nextDetail: string) => {
        const combined =
          nextChoice === "Yes" ? (nextDetail.trim() ? `Yes — ${nextDetail.trim()}` : "Yes") : nextChoice === "No" ? "No" : "";
        commitField(meta.field, combined, "user_stated");
        markTouched(meta.field);
        if (combined.length > 0) stopEdit(meta.field);
      };
      return (
        <fieldset key={meta.field} className={`${wrapClass} ${fieldsetResetClass}`}>
          <legend className={`${fieldLabelClass} p-0`}>
            {meta.label}
            {requiredMarker}
          </legend>
          <div className="mt-1 flex gap-4">
            {["Yes", "No"].map((opt, i) => (
              <label key={opt} className={radioLabelClass}>
                <input
                  type="radio"
                  name={`pq-${meta.field}`}
                  ref={
                    i === 0
                      ? (el) => {
                          fieldRefs.current[meta.field] = el;
                        }
                      : undefined
                  }
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
    const errorMsg = fieldValidationMessage(meta, false, touched);
    const errorId = `pq-${meta.field}-error`;
    return (
      <div key={meta.field} className={wrapClass}>
        <label htmlFor={`pq-${meta.field}`} className={fieldLabelClass}>
          {meta.label}
          {requiredMarker}
        </label>
        <textarea
          id={`pq-${meta.field}`}
          ref={(el) => {
            fieldRefs.current[meta.field] = el;
          }}
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
            if (e.target.value.trim().length > 0) stopEdit(meta.field);
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

  return (
    <div>
      {/* Free-text AUTOFILL — a secondary affordance behind a visual break,
          same posture as IntakeForm's sample-company picker. */}
      <div>
        <button
          type="button"
          onClick={() => setPasteOpen((o) => !o)}
          aria-expanded={pasteOpen}
          aria-controls="pq-paste-panel"
          disabled={disabled}
          className={pasteTriggerClass}
        >
          {pasteOpen ? "Hide paste box" : "Paste a description to autofill"}
        </button>

        {pasteOpen && (
          <div id="pq-paste-panel" className={pastePanelClass}>
            <label htmlFor="pq-paste" className={fieldLabelClass}>
              Paste your company description
            </label>
            <textarea
              id="pq-paste"
              rows={4}
              value={pasteText}
              disabled={disabled || extracting}
              onChange={(e) => setPasteText(e.target.value)}
              className={`${textareaBigClass} mt-1`}
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={runAutofill}
                disabled={disabled || extracting || pasteText.trim().length < 20}
                className={secondaryButtonClass}
              >
                {extracting ? "Reading…" : "Autofill fields"}
              </button>
              {extractError && (
                <span role="alert" className={errorTextClass}>
                  {extractError}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Required fields — the search needs these to route at all. Grid:
          single column on mobile (each field always full-width), two
          columns from `sm:` up, with the description box and any other
          "wide" field spanning both. */}
      <div className="mt-5">
        <h2 className={sectionHeadingClass}>Tell us about your company</h2>
        <p aria-live="polite" className={introClass}>
          {requiredProgressText(requiredFields.length, requiredGaps.length)}
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {requiredFields.map((m) => renderField(m, isWideField(m.field) ? "sm:col-span-2" : ""))}
        </div>
      </div>

      {/* Optional-but-material fields — progressive disclosure: revealed once
          the required set is complete, or on demand via the toggle. Grouped
          under two user-facing headings (Company & product / Financials)
          so the list reads as organized sections, not one long form. */}
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
      </div>
    </div>
  );
}
