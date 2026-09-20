import type { AssembledPackage } from "./package";

/**
 * Source marker for a value the USER typed into a gap field, as opposed to a
 * value grounded from data. It keeps the honesty contract intact: the field is
 * still structurally `prefilled` (value + source + non-placeholder display, so it
 * validates and the extension will fill it), but the source honestly names it as
 * the user's own input rather than a data citation — the UI renders it with a
 * distinct "you added" note, never the grounded chip.
 */
export const USER_PROVIDED_SOURCE = "you provided this";

/** Stable id for a form field across forms (form_name + field key). */
export function gapFieldId(formName: string, fieldKey: string): string {
  return `${formName}:${fieldKey}`;
}

/** The plain hint inside a `[you to provide: <hint>]` placeholder (else ""). */
export function gapHint(display: string): string {
  return /^\[you to provide: (.+)\]$/.exec(display)?.[1] ?? "";
}

/**
 * Return a copy of `pkg` with each FORM gap the user filled (a non-empty
 * `inputs[gapFieldId(...)]`) converted to a filled field sourced as
 * USER_PROVIDED_SOURCE, and both `forms.gaps` and the top-level `gaps` recomputed
 * so the package stays internally consistent (and schema-valid) for export.
 * Empty/absent inputs leave the gap untouched. Pure — no mutation of `pkg`.
 */
export function applyGapInputs(
  pkg: AssembledPackage,
  inputs: Record<string, string>,
): AssembledPackage {
  const filledDisplays = new Set<string>();
  const forms = pkg.forms.forms.map((form) => ({
    ...form,
    fields: form.fields.map((f) => {
      if (f.status !== "founder_to_provide") return f;
      const v = inputs[gapFieldId(form.form_name, f.key)]?.trim();
      if (!v) return f;
      filledDisplays.add(f.display);
      return { ...f, status: "prefilled" as const, value: v, display: v, source: USER_PROVIDED_SOURCE };
    }),
  }));
  return {
    ...pkg,
    forms: { ...pkg.forms, forms, gaps: pkg.forms.gaps.filter((g) => !filledDisplays.has(g)) },
    gaps: pkg.gaps.filter((g) => !filledDisplays.has(g)),
  };
}
