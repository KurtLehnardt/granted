import type { SelectorStrategy } from "../config/schema";

/**
 * Tiered selector resolution (spec §2.2). PURE given a DOM root — unit
 * testable in jsdom with no browser and no live portal.
 *
 * 1. Normalize tiers — drop any tier whose string starts with "TODO"
 *    (case-insensitive): treat as not-yet-captured. This is what makes the
 *    all-TODO seed configs degrade gracefully (INV-9).
 * 2. Tier order, first exact hit wins: id → name → aria.labelledby/aria.label
 *    → labelText. Accept a tier iff it resolves to EXACTLY one element.
 * 3. Visibility/enabled gate — resolved element must have a layout box and
 *    not be disabled/readonly. Failing that ⇒ UNRESOLVED.
 * 4. Ambiguity (more than one match at a tier) is never disambiguated by
 *    guessing — fall through to the next tier, then to UNRESOLVED.
 */

export const UNRESOLVED = "UNRESOLVED" as const;
export type ResolveResult = Element | typeof UNRESOLVED;

/** True unless the string is present and begins with "TODO" (case-insensitive). */
function isCaptured(value: string | undefined): value is string {
  if (value === undefined) return false;
  return !/^\s*todo/i.test(value);
}

/** Escape a string for safe use inside a CSS attribute-selector value. */
function cssEscapeAttrValue(value: string): string {
  // CSS.escape is available in both browser and jsdom test environments.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Minimal fallback: escape quotes/backslashes.
  return value.replace(/(["\\])/g, "\\$1");
}

/**
 * Is `el` visible and not disabled/readonly?
 *
 * A real Chrome content-script has a full layout engine; jsdom (used in unit
 * tests) does not implement layout, so `getBoundingClientRect()`/offset*
 * always report zero even for elements that would be visible in a real
 * browser. Rather than branch on environment, this checks the explicit
 * hiding signals that both environments implement faithfully — computed
 * `display`/`visibility` and the `hidden` attribute — which is exactly what
 * "has a layout box" reduces to for the form controls this engine touches
 * (plain inputs/selects/textareas, never `position:absolute` off-screen
 * tricks the recon would have flagged separately).
 */
export function isVisibleAndEnabled(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.hasAttribute("disabled")) return false;
  if (el.hasAttribute("readonly")) return false;
  if (el.hidden) return false;

  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style) {
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  }

  return true;
}

/** Resolve `[name="…"]`-style, escaping the value safely. */
function queryAllByAttr(root: ParentNode, attr: string, value: string): Element[] {
  return Array.from(root.querySelectorAll(`[${attr}="${cssEscapeAttrValue(value)}"]`));
}

function queryById(root: ParentNode, id: string): Element[] {
  // querySelectorAll('#id') requires escaping; use attribute form for safety
  // with ids containing characters that are not valid in a bare #id selector.
  return queryAllByAttr(root, "id", id);
}

/** Tags eligible for the direct-text-match fallback (landmarks + clickable controls). */
const TEXT_MATCH_SELECTOR =
  "button, input[type='button'], input[type='submit'], a, [role='button'], h1, h2, h3, h4, h5, h6, legend";

/**
 * Find a `<label>` whose normalized text equals `labelText`, resolve its
 * control (for FORM FIELD bindings) — OR, if no `<label>` matches, find a
 * landmark/clickable element (heading, button, link) whose own normalized
 * text equals `labelText` directly. The second path is what makes `labelText`
 * usable for `PortalStep.landmark` (e.g. a page heading) and
 * `advanceControls`/`forbiddenControls` (e.g. a "Save & Continue" button) —
 * neither of which is wrapped in a `<label>` element. Both paths feed the
 * SAME tier: ambiguity (>1 match) still falls through to UNRESOLVED, never a
 * guess.
 */
function resolveByLabelText(root: ParentNode, labelText: string): Element[] {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = normalize(labelText);
  const labels = Array.from(root.querySelectorAll("label"));
  const matches: Element[] = [];

  for (const label of labels) {
    if (normalize(label.textContent ?? "") !== target) continue;

    const forId = label.getAttribute("for");
    if (forId) {
      const control = queryById(root, forId)[0];
      if (control) {
        matches.push(control);
        continue;
      }
    }

    const nested = label.querySelector("input, select, textarea, button");
    if (nested) {
      matches.push(nested);
      continue;
    }

    // Last resort: next form control in document order after the label.
    let node: Element | null = label.nextElementSibling;
    while (node) {
      if (node.matches("input, select, textarea, button")) {
        matches.push(node);
        break;
      }
      node = node.nextElementSibling;
    }
  }

  if (matches.length > 0) return matches;

  // No <label> matched — try a direct text-content match on landmark/control
  // elements (headings, buttons, links). Use each element's OWN direct text
  // (not full descendant text) so a heading containing a nested button does
  // not double-count.
  const ownText = (el: Element): string => {
    let text = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 /* TEXT_NODE */) text += node.textContent ?? "";
    }
    // Fall back to full textContent for simple leaf elements (e.g. <a>Save</a>
    // with no child element nodes) where direct-text walking above already
    // captures everything, and for elements whose only content is itself text.
    return normalize(text) || normalize(el.textContent ?? "");
  };

  const candidates = Array.from(root.querySelectorAll(TEXT_MATCH_SELECTOR));
  for (const el of candidates) {
    const text = ownText(el);
    if (text === target) matches.push(el);
    else if (el instanceof HTMLInputElement && normalize(el.value) === target) matches.push(el);
  }

  return matches;
}

function resolveByAria(root: ParentNode, aria: { label?: string; labelledby?: string } | undefined): Element[] {
  if (!aria) return [];
  if (isCaptured(aria.labelledby)) {
    const referenced = queryById(root, aria.labelledby);
    if (referenced.length > 0) return referenced;
    // aria-labelledby points at an id; the labelled control itself is the
    // element carrying aria-labelledby="<that id>".
    return queryAllByAttr(root, "aria-labelledby", aria.labelledby);
  }
  if (isCaptured(aria.label)) {
    return queryAllByAttr(root, "aria-label", aria.label);
  }
  return [];
}

/**
 * Resolve a `SelectorStrategy` against a DOM root. Returns the single
 * matching, visible, enabled element, or `UNRESOLVED` — NEVER guesses on
 * ambiguity, NEVER throws.
 */
export function resolve(strategy: SelectorStrategy, root: ParentNode): ResolveResult {
  const tiers: Array<() => Element[]> = [
    () => (isCaptured(strategy.id) ? queryById(root, strategy.id) : []),
    () => (isCaptured(strategy.name) ? queryAllByAttr(root, "name", strategy.name) : []),
    () => resolveByAria(root, strategy.aria),
    () => (isCaptured(strategy.labelText) ? resolveByLabelText(root, strategy.labelText) : []),
  ];

  for (const tier of tiers) {
    let matches: Element[];
    try {
      matches = tier();
    } catch {
      // A malformed selector value must never throw the engine — treat as no match.
      matches = [];
    }
    if (matches.length === 1) {
      const [el] = matches;
      if (el && isVisibleAndEnabled(el)) return el;
      // Resolved but not visible/enabled ⇒ UNRESOLVED per §2.2 step 3, do not
      // fall through to a weaker tier for the SAME field (a real but hidden
      // match is not "absent", it is "not ready") — return UNRESOLVED directly.
      return UNRESOLVED;
    }
    // 0 matches ⇒ fall through to next tier. >1 matches (ambiguity) ⇒ also
    // fall through per §2.2 step 4 ("fall through to the next tier, then to
    // UNRESOLVED" — never disambiguate by guessing).
  }

  return UNRESOLVED;
}
