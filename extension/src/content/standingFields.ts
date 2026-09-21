/**
 * Heuristic resolution for STANDING fields — the applicant details that are the
 * SAME on every grant (org identity + registration facts). The seed portal
 * configs ship every selector as a `TODO` placeholder, so without a captured
 * selector these never fill. But standing fields are semantically stable across
 * forms, so we can locate them by high-confidence signals — the HTML
 * `autocomplete` token, or a word-boundary keyword match in the field's
 * name/id/placeholder/label/aria-label.
 *
 * SAFETY: this fills ONLY on a single UNAMBIGUOUS match (0 or >1 candidates →
 * UNRESOLVED — never a guess), only text/textarea inputs (selects/radios are
 * left alone), and the caller (fillEngine) still routes every hit through the
 * unconditional gates: credential refusal, the idempotency/human-edit guard, and
 * the submit-guard on write. So a wrong or risky match degrades to "not filled",
 * never to a bad write.
 *
 * Per-grant fields (project title, amounts, dates) are deliberately NOT here —
 * those are unique to each application and are left as honest blanks.
 */
import { UNRESOLVED, type ResolveResult, isVisibleAndEnabled } from "./selectorResolver";

interface Heuristic {
  /** HTML `autocomplete` tokens (highest confidence) that identify this field. */
  autocomplete?: string[];
  /** Lowercased keywords matched as whole words against the field's signal text. */
  keywords: string[];
}

/** The standing fields the extension will heuristically fill (text inputs only). */
export const STANDING_FIELD_HEURISTICS: Record<string, Heuristic> = {
  uei: { keywords: ["uei", "unique entity identifier"] },
  authorized_representative_name: {
    keywords: ["authorized representative", "authorized organization representative", "aor name"],
  },
  organization_name: {
    autocomplete: ["organization"],
    keywords: [
      "organization legal name",
      "legal name of applicant",
      "organization name",
      "legal organization name",
      "applicant legal name",
      "name of organization",
    ],
  },
  applicant_street: {
    autocomplete: ["address-line1", "street-address"],
    keywords: ["street address", "address line 1", "mailing address"],
  },
  applicant_city: { autocomplete: ["address-level2"], keywords: ["city", "town"] },
  applicant_state: { autocomplete: ["address-level1"], keywords: ["state", "province"] },
  applicant_zip: { autocomplete: ["postal-code"], keywords: ["zip", "zip code", "postal code"] },
  applicant_congressional_district: { keywords: ["congressional district"] },
};

export function isStandingField(packageKey: string | null): boolean {
  return packageKey != null && Object.prototype.hasOwnProperty.call(STANDING_FIELD_HEURISTICS, packageKey);
}

const TEXT_INPUT_SELECTOR =
  'input:not([type]), input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="search"], input[type="url"], textarea';

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Text/textarea inputs that are visible, enabled, and not readonly. */
function candidateInputs(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TEXT_INPUT_SELECTOR)).filter(
    (el) => !el.hasAttribute("readonly") && isVisibleAndEnabled(el),
  );
}

/** The label text associated with an input (aria-label, `for=`, or wrapping <label>). */
function labelTextFor(el: HTMLElement, root: ParentNode): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return norm(aria);
  const id = el.getAttribute("id");
  if (id) {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
    let lbl: Element | null = null;
    try {
      lbl = root.querySelector(`label[for="${escaped}"]`);
    } catch {
      /* malformed id → no label */
    }
    if (lbl) return norm(lbl.textContent);
  }
  const wrapping = el.closest("label");
  if (wrapping) return norm(wrapping.textContent);
  return "";
}

/** Searchable signal text + autocomplete token(s) for an element. */
function signalsFor(el: HTMLElement, root: ParentNode): { text: string; autocomplete: string[] } {
  const text = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("placeholder"), labelTextFor(el, root)]
    .map(norm)
    .filter(Boolean)
    .join(" | ");
  return { text, autocomplete: norm(el.getAttribute("autocomplete")).split(/\s+/).filter(Boolean) };
}

/** Whole-word (non-alphanumeric-bounded) match, so "state" never matches "statement"/"estate". */
function wordMatch(haystack: string, needle: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function matches(sig: { text: string; autocomplete: string[] }, h: Heuristic): boolean {
  if (h.autocomplete && h.autocomplete.some((tok) => sig.autocomplete.includes(tok))) return true;
  return h.keywords.some((kw) => wordMatch(sig.text, kw));
}

/**
 * Resolve a standing field by heuristic. Returns the element ONLY when exactly
 * one candidate matches; otherwise UNRESOLVED (never guesses among multiple).
 */
export function resolveStandingField(packageKey: string, root: ParentNode): ResolveResult {
  const h = STANDING_FIELD_HEURISTICS[packageKey];
  if (!h) return UNRESOLVED;
  const hits = candidateInputs(root).filter((el) => matches(signalsFor(el, root), h));
  return hits.length === 1 ? hits[0]! : UNRESOLVED;
}
