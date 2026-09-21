import type { FieldBinding, PortalFieldMap } from "../config/schema";
import type { AssembledPackage } from "../lib/contracts/package";
import type { PrefilledField } from "../lib/contracts/applicationForms";
import { resolve, UNRESOLVED } from "./selectorResolver";
import { isStandingField, resolveStandingField } from "./standingFields";
import { writeValue, readValue, normalizeForCompare } from "./domIO";
import { applyTransform } from "../lib/transforms";
import { flagField, clearAllFlags } from "./flagOverlay";

/**
 * The fill engine (spec §3.3). Deterministic mapping of the app's package →
 * visible form fields. Fills grounded fields, sets native input events so
 * the portal's own framework registers the value, skips + flags gaps, never
 * touches the signature block or credential fields, verifies via read-back,
 * and is idempotent.
 */

export type FillOutcome =
  | "filled_verified"
  | "filled_unverified"
  | "gap"
  | "unmapped"
  | "not_in_package"
  | "human_edit_kept"
  | "excluded"
  | "portal_only"
  | "refused_credential";

export interface FillResult {
  packageKey: string | null;
  label: string;
  boxRef?: string;
  outcome: FillOutcome;
  /** Only present for grounded fills; the value shown for the human's review. */
  intendedValue?: string;
  /** For gaps: the exact `[you to provide: …]` display, shown as the blank to complete. */
  gapDisplay?: string;
  /** Provenance from the package (PrefilledField.source), shown in the review list. */
  source?: string;
}

export interface FillSummary {
  filledVerified: number;
  filledUnverified: number;
  gaps: number;
  unmapped: number;
  humanEditKept: number;
  excluded: number;
  refused: number;
  portalOnly: number;
  notInPackage: number;
}

function emptySummary(): FillSummary {
  return {
    filledVerified: 0,
    filledUnverified: 0,
    gaps: 0,
    unmapped: 0,
    humanEditKept: 0,
    excluded: 0,
    refused: 0,
    portalOnly: 0,
    notInPackage: 0,
  };
}

const SUMMARY_KEY_BY_OUTCOME: Record<FillOutcome, keyof FillSummary> = {
  filled_verified: "filledVerified",
  filled_unverified: "filledUnverified",
  gap: "gaps",
  unmapped: "unmapped",
  not_in_package: "notInPackage",
  human_edit_kept: "humanEditKept",
  excluded: "excluded",
  portal_only: "portalOnly",
  refused_credential: "refused",
};

/** Roles that are ALWAYS excluded from filling, regardless of packageKey (INV-4/INV-5). */
const EXCLUDED_ROLES = new Set(["signature", "date_signed", "certification", "credential"]);

/** Flatten every `PrefilledField` across every form in the package for packageKey lookup. */
function flattenPackageFields(pkg: AssembledPackage): PrefilledField[] {
  return pkg.forms.forms.flatMap((f) => f.fields);
}

/** True iff `el` is a password input, or otherwise heuristically a credential control (INV-5). */
function isCredentialTarget(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return true;
    const signals = [el.name, el.id, el.getAttribute("autocomplete") ?? ""].join(" ").toLowerCase();
    if (/\b(password|passwd|pwd)\b/.test(signals)) return true;
  }
  return false;
}

export interface RunFillInput {
  fieldMap: PortalFieldMap;
  /** Only bindings whose `stepId` matches this are processed (the current visible step). */
  stepId: string;
  pkg: AssembledPackage;
  /** DOM root to resolve/write against. Defaults to `document`. */
  root?: ParentNode;
  /**
   * Values this engine has already written, keyed by `packageKey`, from a
   * prior run — the idempotency / human-edit guard (INV-11). The caller is
   * responsible for persisting this across invocations (e.g.
   * `chrome.storage.session`); this function is otherwise pure.
   */
  lastWritten?: Record<string, string>;
  /** Render shadow-DOM flag badges for gaps/excluded/unmapped fields. Defaults to true. */
  applyOverlay?: boolean;
}

export interface RunFillOutput {
  results: FillResult[];
  summary: FillSummary;
  /** Updated `lastWritten` map — persist this for the next run. */
  lastWritten: Record<string, string>;
}

/**
 * Run the fill algorithm for every `FieldBinding` on `input.stepId`, in
 * config order. See spec §3.3 for the full per-field algorithm this
 * implements exactly (exclusion gate → portal-only → lookup → gap →
 * grounded: resolve → credential refusal → idempotency guard → write →
 * read-back verify).
 */
export function runFill(input: RunFillInput): RunFillOutput {
  const root = input.root ?? document;
  const lastWritten: Record<string, string> = { ...(input.lastWritten ?? {}) };
  const applyOverlay = input.applyOverlay ?? true;
  const packageFields = flattenPackageFields(input.pkg);

  const results: FillResult[] = [];
  const summary = emptySummary();

  const record = (result: FillResult): void => {
    results.push(result);
    summary[SUMMARY_KEY_BY_OUTCOME[result.outcome]] += 1;
  };

  const bindings: FieldBinding[] = input.fieldMap.fields.filter((f) => f.stepId === input.stepId);

  if (applyOverlay) clearAllFlags(root);

  for (const binding of bindings) {
    // 1. Exclusion gate (INV-4/INV-5) — checked BEFORE anything else, cannot
    // be overridden by config.
    if (binding.neverFill === true || (binding.role && EXCLUDED_ROLES.has(binding.role))) {
      record({ packageKey: binding.packageKey, label: binding.label, boxRef: binding.boxRef, outcome: "excluded" });
      if (applyOverlay) {
        const el = resolve(binding.selector, root);
        if (el !== UNRESOLVED) flagField(el, "excluded", "left for you — never auto-filled");
      }
      continue;
    }

    // 2. Portal-only control.
    if (binding.packageKey === null) {
      record({ packageKey: null, label: binding.label, boxRef: binding.boxRef, outcome: "portal_only" });
      continue;
    }

    // 3. Lookup by packageKey.
    const field = packageFields.find((f) => f.key === binding.packageKey);
    if (!field) {
      record({
        packageKey: binding.packageKey,
        label: binding.label,
        boxRef: binding.boxRef,
        outcome: "not_in_package",
      });
      continue;
    }

    // 4. Gap (INV-2) — NEVER written to the DOM, only flagged.
    if (field.status === "founder_to_provide") {
      record({
        packageKey: binding.packageKey,
        label: binding.label,
        boxRef: binding.boxRef,
        outcome: "gap",
        gapDisplay: field.display,
      });
      if (applyOverlay) {
        const el = resolve(binding.selector, root);
        if (el !== UNRESOLVED) flagField(el, "gap", "you provide");
      }
      continue;
    }

    // 5. Grounded (INV-3).
    const intended = applyTransform(field.value ?? "", binding.transform);
    let el = resolve(binding.selector, root);
    // Heuristic fallback for STANDING fields (org identity + registration facts
    // that are the same on every grant): when the portal's exact selector isn't
    // captured, locate the field by its semantics (autocomplete / label keyword),
    // filling ONLY on a single unambiguous match. Everything below (credential
    // refusal, idempotency guard, read-back verification) still applies, so a
    // heuristic hit is held to the same safety bar as a configured selector.
    if (el === UNRESOLVED && isStandingField(binding.packageKey)) {
      el = resolveStandingField(binding.packageKey as string, root);
    }
    if (el === UNRESOLVED) {
      record({
        packageKey: binding.packageKey,
        label: binding.label,
        boxRef: binding.boxRef,
        outcome: "unmapped",
        intendedValue: intended,
        source: field.source,
      });
      continue;
    }

    // Credential refusal (INV-5) — hard-stop, never fill, regardless of config.
    if (isCredentialTarget(el)) {
      record({
        packageKey: binding.packageKey,
        label: binding.label,
        boxRef: binding.boxRef,
        outcome: "refused_credential",
      });
      continue;
    }

    // Idempotency / human-edit guard (INV-11) — never clobber a human's edit.
    // Per spec §3.3 step 5, this compares against `lastWritten[packageKey]`
    // literally (which is `undefined` on a field's first-ever fill): a
    // non-empty field the engine has NOT itself written before is treated the
    // same as a human edit and is left alone — the engine only ever
    // overwrites a field it can prove it wrote the current content of.
    const current = readValue(el, binding.elementType);
    const priorWrite = lastWritten[binding.packageKey];
    const matchesPriorWrite = priorWrite !== undefined && normalizeForCompare(current) === normalizeForCompare(priorWrite);
    if (current !== "" && !matchesPriorWrite) {
      record({
        packageKey: binding.packageKey,
        label: binding.label,
        boxRef: binding.boxRef,
        outcome: "human_edit_kept",
        intendedValue: intended,
        source: field.source,
      });
      continue;
    }

    // Write.
    writeValue(el, binding.elementType, intended, binding.selector.optionMatch);
    lastWritten[binding.packageKey] = intended;

    // Read-back (INV-10).
    const readback = readValue(el, binding.elementType);
    const verified = normalizeForCompare(readback) === normalizeForCompare(intended);
    record({
      packageKey: binding.packageKey,
      label: binding.label,
      boxRef: binding.boxRef,
      outcome: verified ? "filled_verified" : "filled_unverified",
      intendedValue: intended,
      source: field.source,
    });
  }

  return { results, summary, lastWritten };
}
