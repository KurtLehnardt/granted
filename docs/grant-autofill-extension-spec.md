# Grant Auto-Fill Extension — Phase-2 Architecture Spec (MV3)

**Status:** Implementation-ready architecture. No code in this document.
**Audience:** Phase-3 worker subagents, each building one part in an isolated worktree → separate PR.
**Author:** Phase-2 Architect.
**Date:** 2026-08-16.

This spec makes concrete the R6 memo's §7 recommendation — *"the thin assisted-apply slice: package builder, human review-and-attest screen, human logs in and submits themselves, in their own session, with their own credentials."* The extension is the **browser-side "fill it out on their behalf" path**: an assistive form-filler (like a password manager) that runs in the founder's **own authenticated portal session**, fills the visible form fields from the Granted app's generated package, navigates between sections, and **stops dead before any submit/sign control**. A human — the organization's Authorized Organization Representative (AOR) — reviews everything and clicks the final SUBMIT.

Inputs this spec is built on (absolute paths):
- Field map / Phase-1 recon: `<repo-root>/.claude/worktrees/ext-docs/docs/grant-portal-field-map.md`
- Product vision: the project's founding product principles (say no plainly, ground everything, translate government, ship risky things dark)
- Legal / honesty boundary + S2S path: `<repo-root>/.claude/worktrees/ext-docs/docs/R6-s2s-feasibility-memo.md`
- App→extension contract (source of truth for payload shapes):
  - `scaffold/lib/contracts/applicationForms.ts`
  - `scaffold/lib/apply/forms.ts`
  - `scaffold/lib/apply/package.ts`
  - `scaffold/lib/contracts/applicationDraft.ts` (`FOUNDER_TODO_PATTERN`)

---

## 0. Enforced invariants (acceptance criteria — not prose)

Every invariant below is a hard acceptance criterion with a named test surface. A Phase-3 PR that weakens or removes one of these is rejected. They are restated inline throughout the spec but collected here as the contract.

| ID | Invariant | Enforced by (test surface) |
|---|---|---|
| **INV-1** | **Never submits, signs, certifies, attests, or files.** No code path clicks any control matching the submit-guard denylist. The denylist **always wins** over any config allowlist. The final enumerated step is never auto-advanced. | `submitGuard` unit tests; `navigator` refusal tests; config-authoring test proving a submit control cannot be opted into the allowlist. |
| **INV-2** | **Gaps are never filled.** A field with `status: "founder_to_provide"` is never written to the DOM — only visually flagged "you provide". | Fill-engine test: gap field ⇒ zero DOM writes + flag present. |
| **INV-3** | **Grounded-only fills.** Only `status: "prefilled"` fields carrying both `value` and `source` are ever written. | Fill-engine test; package-validator honesty test. |
| **INV-4** | **Signature block never auto-populated.** Any field with `role ∈ {signature, date_signed, certification}` (e.g. SF-424 Box 21 signature + Date Signed) is excluded regardless of `packageKey`. | Config-schema test; fill-engine exclusion test. |
| **INV-5** | **No credentials, ever.** No field binds to a credential input; the runtime refuses any `input[type="password"]` and any field flagged `role: "credential"`. No IdP/credential origin (login.gov, sam.gov, era.nih.gov login endpoints beyond ASSIST content) is in `host_permissions`. | Manifest-lint test (banned hosts absent); runtime credential-refusal test. |
| **INV-6** | **Scoped host permissions.** `host_permissions ⊆` the enumerated portal hosts. No `<all_urls>`. Content scripts are path-scoped to the fill surfaces. | Manifest-lint test. |
| **INV-7** | **Client-side only (§5.3).** No `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`/`navigator.sendBeacon` in `src/background/**` or `src/content/**`. Nothing the extension holds is sent to any fundFinder server or any network endpoint. | ESLint `no-restricted-globals`/`no-restricted-syntax` rule + a static-scan test. |
| **INV-8** | **Imported package is inert DATA, never instructions.** Payload passes size cap → JSON parse → envelope schema → integrity digest → vendored Zod contracts → honesty invariants, or it is refused. It is never used to derive selectors, URLs, or actions. | Package-validator tests over malformed/oversized/tampered/invalid-honesty fixtures. |
| **INV-9** | **Graceful degradation with unmapped selectors.** With the seed configs (every selector a `TODO` placeholder), the extension loads cleanly, imports a valid package, fills **0** fields, flags all as "unmapped", and never throws or guesses. | Fill-engine test against seed configs; unpacked-load smoke check. |
| **INV-10** | **Read-back truthfulness.** A field is reported `filled_verified` only when a post-write DOM read-back equals the intended value. Otherwise it is `filled_unverified` / `unmapped`. The popup never claims a value the portal does not actually hold. | Fill-engine read-back tests (jsdom). |
| **INV-11** | **Idempotent; respects human edits.** Re-running fill is deterministic and never clobbers a field the human edited since the last fill. | Fill-engine re-run tests. |
| **INV-12** | **Honest copy.** Popup and export copy contain no "submitted / filed / won / approved" confirmation and prominently state "nothing has been submitted." Register mirrors `AOR_HANDOFF` / `PACKAGE_INTRO`. | Copy-lint test (banned-phrase list), mirroring scaffold's discipline. |

---

## 1. MV3 manifest

Manifest V3, service-worker background, **no** `<all_urls>`, host permissions scoped to exactly the four in-scope portals. The manifest is generated from a typed config (`manifest.config.ts`) via `@crxjs/vite-plugin` (see §9) so it stays in sync with the build; the shape below is the emitted `manifest.json`.

```jsonc
{
  "manifest_version": 3,
  "name": "Granted Assisted Fill",
  "version": "0.1.0",
  "description": "Fills a grant-portal form in your own session from your Granted package. You review; your AOR submits. It never submits.",
  "minimum_chrome_version": "116",

  // Least-privilege permissions. Each justified below.
  "permissions": ["storage", "scripting", "activeTab"],

  // Scoped to the four in-scope portals ONLY. No <all_urls>. No login.gov, no sam.gov.
  // NOTE: exact Grants.gov Workspace host is TODO (in-session capture) — see §1.3.
  "host_permissions": [
    "https://www.grants.gov/*",
    "https://grants.gov/*",
    "https://apply07.grants.gov/*",     // legacy Workspace host — CONFIRM in in-session pass
    "https://www.research.gov/*",
    "https://research.gov/*",
    "https://public.era.nih.gov/*",     // NIH ASSIST; content script path-scoped to /assist/
    "https://www.sbir.gov/*",
    "https://sbir.gov/*"
  ],

  "background": { "service_worker": "src/background/service-worker.ts", "type": "module" },

  // Declarative content scripts — passive presence on the exact fill surfaces only.
  // Path-scoped so injection is tighter than the host_permissions grant.
  "content_scripts": [
    {
      "matches": ["https://www.grants.gov/*", "https://grants.gov/*", "https://apply07.grants.gov/*"],
      "js": ["src/content/runtime.ts"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://www.research.gov/*", "https://research.gov/*"],
      "js": ["src/content/runtime.ts"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://public.era.nih.gov/assist/*"],  // path-scoped: ASSIST only
      "js": ["src/content/runtime.ts"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://www.sbir.gov/*", "https://sbir.gov/*"],
      "js": ["src/content/runtime.ts"],
      "run_at": "document_idle"
    }
  ],

  "action": { "default_popup": "src/popup/index.html", "default_title": "Granted Assisted Fill" },

  // Strict CSP: no remote code, everything bundled. (MV3 default already forbids remote code;
  // stated explicitly for the review gate.)
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'none'"
  }

  // externally_connectable: DELIBERATELY OMITTED. See §6 for why the handoff is user-mediated
  // import, not a web-origin message channel. No web page ever gets a standing channel into this
  // extension.
}
```

### 1.1 Permission justification (minimal set)

- **`storage`** — persist the imported package + the (static, shipped) field-map configs client-side. Default store is `chrome.storage.session` (cleared at session end); `chrome.storage.local` is opt-in only (§7.3). Required; there is no lighter store for a structured package.
- **`scripting`** — programmatic `executeScript` for **user-gesture-scoped** guaranteed injection when the popup's "Fill this page" is clicked (covers cases where the declarative content script hasn't attached, e.g. a SPA route change). Paired with `activeTab` so it only ever targets the tab the user is acting on.
- **`activeTab`** — grants ephemeral access to the **currently active tab on a user gesture** (popup click), rather than a broad `tabs` permission. We deliberately do **not** request `tabs`, `webNavigation`, `cookies`, `webRequest`, or `<all_urls>`.

`connect-src 'none'` in the CSP is the manifest-level partner to **INV-7**: extension pages cannot open network connections at all.

### 1.2 `connect-src 'none'` / no network

The service worker and content scripts perform **zero** network I/O (**INV-7**). All data arrives via user-mediated import (§6). This is enforced three ways: manifest CSP `connect-src 'none'`, an ESLint rule banning network globals in `src/content/**` and `src/background/**`, and a static-scan test.

### 1.3 Host-permission tradeoff (least-privilege vs. unknown Workspace host)

The field map (`<repo-root>/.claude/worktrees/ext-docs/docs/grant-portal-field-map.md`) could not reach the authenticated Grants.gov Workspace, so the **exact Workspace host is unconfirmed**. Two options:
- **Enumerate specific hosts** (chosen): tightest least-privilege, but risks missing the real Workspace host until the in-session capture pass pins it. We include the known `apply07.grants.gov` as the current best guess, explicitly flagged `CONFIRM`.
- **`https://*.grants.gov/*` wildcard** (rejected as the default): covers host uncertainty but broadens the grant. Allowed **only** as an interim during the in-session capture pass, and must be narrowed to specific hosts before any store submission. Documented so a worker does not silently ship the wildcard.

DSIP (`www.dodsbirsttr.mil`) is **out of scope for v0.1** — R6 escalation **E5** flags its auth/role model as unverified from a primary source. Adding it later = adding one host pattern + one config (§2), no code change.

---

## 2. Declarative per-portal field-map config

**Design goal: adding a new portal = adding a new config file, not new code.** The content-script runtime, fill engine, selector resolver, and navigator are all portal-agnostic; every portal-specific fact lives in a declarative `PortalFieldMap` under `src/config/portals/`. A registry (`src/config/index.ts`) maps a URL to its `PortalFieldMap`.

Crucially, because the Phase-1 recon captured **zero live selectors**, every seed config ships with `TODO` placeholder selectors. The resolver treats a `TODO:` value as *absent* (§2.2), so the seed configs produce the correct graceful-degradation behavior (**INV-9**): import works, nothing is filled, everything is flagged "unmapped", until a future **in-session capture pass** replaces the `TODO`s with real selector strings. **Selector strings are data, filled in later — never code.**

### 2.1 Config schema

```ts
// src/config/schema.ts  (also mirrored as a zod schema for load-time validation)

export type PortalId = "grants_gov" | "research_gov" | "nih_assist" | "sbir_gov";

export type ElementType = "text" | "textarea" | "select" | "radio" | "checkbox" | "date";

/** Field semantic role. Anything not "data" is structurally excluded from filling. */
export type FieldRole = "data" | "signature" | "date_signed" | "certification" | "credential";

export type ValueTransformId =
  | "identity"
  | "date_iso_to_mmddyyyy"
  | "state_name_to_code"
  | "entity_type_to_sf424_option"
  | "currency_plain";

/**
 * Tiered selector strategy. Tiers are tried in order (id → name → aria → labelText);
 * the FIRST tier that resolves to exactly one visible, enabled element wins.
 * A tier whose string begins with "TODO" is treated as ABSENT (not-yet-captured).
 * If no tier resolves, the field is SKIPPED and flagged "unmapped" — never guessed.
 */
export interface SelectorStrategy {
  id?: string;                                   // e.g. "#applicantLegalName"  | "TODO: in-session"
  name?: string;                                 // e.g. "[name='LegalName']"   | "TODO: in-session"
  aria?: { label?: string; labelledby?: string };// e.g. aria-label / aria-labelledby target
  labelText?: string;                            // last resort: <label> text → for/control walk
  /** For radio groups / selects: the option value or visible text to choose once located. */
  optionMatch?: { byValue?: string; byText?: string };
}

/** A single bindable field. */
export interface FieldBinding {
  /** PrefilledField.key from the app package, or null for a portal-only control (never filled). */
  packageKey: string | null;
  /** Which form this belongs to (documentation + grouping), e.g. "SF-424". */
  formName?: string;
  /** SF-424 box reference for traceability, e.g. "8c". Documentation only. */
  boxRef?: string;
  /** Human label shown in the popup review list. */
  label: string;
  elementType: ElementType;
  /** Which step/section this field lives on (must match a PortalStep.stepId). */
  stepId: string;
  selector: SelectorStrategy;
  /** Optional deterministic value transform. Defaults to "identity". */
  transform?: ValueTransformId;
  /** Semantic role. Defaults to "data". Non-"data" ⇒ NEVER filled (INV-4/INV-5). */
  role?: FieldRole;
  /** Belt-and-suspenders hard exclusion even if role/packageKey were mis-set. */
  neverFill?: boolean;
}

/** An ordered section/step in the portal's flow. */
export interface PortalStep {
  stepId: string;      // stable, e.g. "sf424_page1"
  title: string;       // human label
  order: number;       // 0-based flow order (drives navigation)
  /** Landmark selector used to recognize the runtime is currently ON this step. */
  landmark?: SelectorStrategy;
}

export interface PortalFieldMap {
  portalId: PortalId;
  displayName: string;
  /** Content-script match patterns this map applies to (path-scoped where possible). */
  urlMatch: string[];
  /** Ordered flow of sections/steps (navigation uses `order`). */
  steps: PortalStep[];
  /**
   * ALLOWLIST of controls the navigator may click to ADVANCE (Save/Continue/Next).
   * The submit-guard denylist (§4) still runs on each and ALWAYS wins.
   */
  advanceControls: SelectorStrategy[];
  /**
   * Documented forbidden controls (submit/sign/certify) for this portal. INFORMATIONAL:
   * the runtime denylist is hardcoded and unconditional; this documents portal-specific
   * labels for clarity and logging. The config CANNOT whitelist any of these.
   */
  forbiddenControls?: SelectorStrategy[];
  fields: FieldBinding[];
}
```

### 2.2 Selector resolution algorithm (runtime)

`resolve(strategy, root): Element | "UNRESOLVED"` — **pure given a DOM root**, so it is unit-testable in jsdom without a browser.

1. **Normalize tiers.** Drop any tier whose string starts with `TODO` (case-insensitive) — treat as not-yet-captured. (This is what makes the all-`TODO` seed configs degrade gracefully — **INV-9**.)
2. **Tier order, first exact hit wins:**
   1. `id` → `root.querySelectorAll('#' + id)` — accept iff exactly one match.
   2. `name` → `[name="…"]` — accept iff exactly one.
   3. `aria.labelledby` → element referenced by that id, or `aria.label` → `[aria-label="…"]` — accept iff exactly one.
   4. `labelText` → find a `<label>` whose normalized text equals `labelText`; resolve its `for` target, else the control nested inside the label, else the next form control in document order. Accept iff exactly one control results.
3. **Visibility/enabled gate.** The resolved element must be visible (has layout box) and not `disabled`/`readonly`. If it fails, treat as **UNRESOLVED**.
4. **Ambiguity ⇒ UNRESOLVED.** More than one match at a tier is never disambiguated by guessing; fall through to the next tier, then to UNRESOLVED.
5. Return the element or `"UNRESOLVED"`. The fill engine translates UNRESOLVED into **skip + flag "unmapped"** (never a guess, never a throw).

### 2.3 Worked example config (SF-424 subset, `grants_gov`, selectors left as `TODO`)

This mirrors the SF-424 canonical table from the field map. Selector strings are `TODO: in-session selector capture`, exactly as recon left them. Note Box 21's signature/date rows are present as **excluded** roles, never as fillable data.

```ts
// src/config/portals/grants_gov.ts
import type { PortalFieldMap } from "../schema";

export const grantsGov: PortalFieldMap = {
  portalId: "grants_gov",
  displayName: "Grants.gov Workspace",
  urlMatch: ["https://www.grants.gov/*", "https://grants.gov/*", "https://apply07.grants.gov/*"],

  steps: [
    { stepId: "sf424_page1", title: "SF-424 — Applicant & Program", order: 0,
      landmark: { labelText: "Application for Federal Assistance" } },
    { stepId: "sf424_page2", title: "SF-424 — Funding & Representative", order: 1,
      landmark: { labelText: "Estimated Funding" } },
  ],

  // Allowlist of advance controls. Submit-guard (§4) still screens each; it always wins.
  advanceControls: [
    { labelText: "Save" },
    { labelText: "Save & Continue" },
    { labelText: "Next" },
  ],
  // Documented only — the runtime denylist blocks these unconditionally.
  forbiddenControls: [
    { labelText: "Sign and Submit" },
    { labelText: "Check Package for Errors" }, // not submit, but do not auto-click; human-driven
  ],

  fields: [
    // --- Program / agency identifiers (grounded from Opportunity in the package) ---
    { packageKey: "funding_opportunity_number", formName: "SF-424", boxRef: "12",
      label: "Funding Opportunity Number", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "funding_opportunity_title", formName: "SF-424", boxRef: "12",
      label: "Funding Opportunity Title", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "awarding_agency", formName: "SF-424", boxRef: "10",
      label: "Name of Federal Agency", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },

    // --- Applicant identity ---
    { packageKey: "organization_name", formName: "SF-424", boxRef: "8a",
      label: "Legal Name (Applicant)", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "uei", formName: "SF-424", boxRef: "8c",
      label: "Unique Entity Identifier (UEI)", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "entity_type", formName: "SF-424", boxRef: "9",
      label: "Type of Applicant", elementType: "select", stepId: "sf424_page1",
      transform: "entity_type_to_sf424_option",
      selector: { id: "TODO: in-session selector capture" } },

    // --- Address ---
    { packageKey: "applicant_street", formName: "SF-424", boxRef: "8d",
      label: "Address — Street", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "applicant_city", formName: "SF-424", boxRef: "8d",
      label: "Address — City", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "applicant_state", formName: "SF-424", boxRef: "8d",
      label: "Address — State", elementType: "select", stepId: "sf424_page1",
      transform: "state_name_to_code",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "applicant_zip", formName: "SF-424", boxRef: "8d",
      label: "Address — ZIP", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "applicant_congressional_district", formName: "SF-424", boxRef: "16",
      label: "Congressional District (Applicant)", elementType: "text", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },

    // --- Project ---
    { packageKey: "project_title", formName: "SF-424", boxRef: "15",
      label: "Descriptive Title of Applicant's Project", elementType: "textarea", stepId: "sf424_page1",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "project_start_date", formName: "SF-424", boxRef: "17",
      label: "Proposed Project Start Date", elementType: "date", stepId: "sf424_page2",
      transform: "date_iso_to_mmddyyyy",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "project_end_date", formName: "SF-424", boxRef: "17",
      label: "Proposed Project End Date", elementType: "date", stepId: "sf424_page2",
      transform: "date_iso_to_mmddyyyy",
      selector: { id: "TODO: in-session selector capture" } },

    // --- Amounts ---
    { packageKey: "federal_funding_requested", formName: "SF-424", boxRef: "18a",
      label: "Estimated Funding — Federal", elementType: "text", stepId: "sf424_page2",
      transform: "currency_plain",
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: "total_project_cost", formName: "SF-424", boxRef: "18",
      label: "Estimated Funding — Total", elementType: "text", stepId: "sf424_page2",
      transform: "currency_plain",
      selector: { id: "TODO: in-session selector capture" } },

    // --- Authorized Representative (Box 21) — IDENTITY fields only ---
    { packageKey: "authorized_representative_name", formName: "SF-424", boxRef: "21",
      label: "Authorized Representative — Name", elementType: "text", stepId: "sf424_page2",
      role: "data",  // identity field: allowed
      selector: { id: "TODO: in-session selector capture" } },

    // --- Box 21 signature + date: STRUCTURALLY EXCLUDED (INV-1/INV-4). Present so the config
    //     documents them as never-fill; the engine refuses them even if a packageKey were set. ---
    { packageKey: null, formName: "SF-424", boxRef: "21",
      label: "Signature of Authorized Representative", elementType: "text", stepId: "sf424_page2",
      role: "signature", neverFill: true,
      selector: { id: "TODO: in-session selector capture" } },
    { packageKey: null, formName: "SF-424", boxRef: "21",
      label: "Date Signed", elementType: "date", stepId: "sf424_page2",
      role: "date_signed", neverFill: true,
      selector: { id: "TODO: in-session selector capture" } },
  ],
};
```

The other three seed configs (`research_gov.ts`, `nih_assist.ts`, `sbir_gov.ts`) follow the same shape. Per the field map, NIH ASSIST is **fully auth-gated** (its only public surface is a login screen), so its seed config carries the SF-424-family key→box mapping with all-`TODO` selectors and an empty `steps`/`advanceControls` set until the in-session pass; `nih_assist` must never bind any field to the login form's username/password inputs (**INV-5**).

---

## 3. The fill engine

Deterministic mapping of the app's package → visible form fields. Fills grounded fields, sets native input events so the portal's own framework registers the value, **skips + flags gaps**, **never touches the signature block or credential fields**, verifies via read-back, and is idempotent.

### 3.1 Content-script isolation (foundation)

MV3 content scripts run in an **isolated world**: a separate JS heap from the portal page, but a **shared DOM**. The extension reads/writes DOM nodes; the portal's own JS cannot read the extension's variables, the imported package, or any extension state. The engine's only interaction with the page is: read DOM, write DOM values, dispatch DOM events, read back DOM values. It never evaluates page-supplied strings and never exfiltrates (**INV-7**).

### 3.2 Native value-set (so the portal's framework registers the value)

Government portals run their own JS (React/Angular/legacy). Setting `element.value = x` alone can leave the framework's internal state stale. The engine therefore, per `elementType`:

- **text / textarea / date:** call the **native value setter** (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`) to bypass framework value-tracking, then dispatch `new Event("input", {bubbles:true})` and `new Event("change", {bubbles:true})`.
- **select:** set `selectedIndex`/`value` to the option resolved by `optionMatch`/transform, then dispatch `change`. If no option matches ⇒ skip + flag "no matching option".
- **radio:** locate the option in the group by `optionMatch`, `.click()` it (or set `checked` + dispatch `change`).
- **checkbox:** only ever set from an explicit grounded boolean; never used for certification/attestation checkboxes (those are `role: certification` ⇒ excluded).

All writes go through one `writeValue(el, elementType, value)` helper so the event-dispatch discipline is centralized and testable.

### 3.3 Fill algorithm (per step)

Input: the validated `AssembledPackage` (`payload`), the resolved `PortalFieldMap` for the current URL, and the detected current `stepId`. For each `FieldBinding` on the current step, in config order:

1. **Exclusion gate (INV-4/INV-5).** If `neverFill === true` **or** `role ∈ {signature, date_signed, certification, credential}` ⇒ **SKIP**, record `excluded`. This is checked **before** anything else and cannot be overridden by config.
2. **Portal-only control.** If `packageKey === null` ⇒ SKIP (`portal_only`).
3. **Lookup.** Find the package field by `packageKey` across `payload.forms[].fields`. If absent ⇒ SKIP + flag `not_in_package`.
4. **Gap (INV-2).** If `field.status === "founder_to_provide"` ⇒ **do not write**; visually flag the resolved target (if it resolves) as "gap — you provide"; record `gap`. Never fill.
5. **Grounded (INV-3).** If `field.status === "prefilled"`:
   - `intended = transform(field.value, transformId)`.
   - `el = resolve(binding.selector, document)`. If `UNRESOLVED` ⇒ SKIP + flag `unmapped`.
   - **Credential refusal (INV-5).** If `el` is `input[type="password"]` or matches the credential heuristic ⇒ **REFUSE**, record `refused_credential` (hard-stop log). Never fill.
   - **Idempotency / human-edit guard (INV-11).** Read `current = readValue(el)`. If `current !== "" && current !== lastWritten[packageKey]` ⇒ the human edited it since our last write ⇒ SKIP + flag `human_edit_kept`. Never clobber.
   - **Write.** `writeValue(el, elementType, intended)`; set `lastWritten[packageKey] = intended`.
   - **Read-back (INV-10).** `readback = readValue(el)`. `verified = normalize(readback) === normalize(intended)`. Record `filled_verified` or `filled_unverified`.

Output: `FillResult[]` (one per binding) + a summary counter `{ filledVerified, filledUnverified, gaps, unmapped, humanEditKept, excluded, refused }`. The popup renders this truthfully (§5).

```ts
export type FillOutcome =
  | "filled_verified" | "filled_unverified"
  | "gap" | "unmapped" | "not_in_package"
  | "human_edit_kept" | "excluded" | "portal_only" | "refused_credential";

export interface FillResult {
  packageKey: string | null;
  label: string;
  boxRef?: string;
  outcome: FillOutcome;
  /** Only present for grounded fills; the value shown for the human's review. */
  intendedValue?: string;
  /** For gaps: the exact `[founder to provide: …]` display, shown as the blank to complete. */
  gapDisplay?: string;
  /** Provenance from the package (PrefilledField.source), shown in the review list. */
  source?: string;
}
```

### 3.4 Determinism, purity, testability

`resolve`, every `ValueTransform`, `writeValue`/`readValue` (given a jsdom element), the submit-guard matcher, the package validator, and the envelope verifier are **pure functions of their inputs** and are unit-tested in Vitest (jsdom for the DOM-touching ones) with static fixtures — no live browser needed. The only non-hermetic surface is the thin `document`-querying glue, exercised by jsdom-rendered fixtures.

---

## 4. Step-through navigation + submit-guard

### 4.1 Flow order

Section order comes **only** from the config (`PortalStep.order`). The navigator never infers flow from page content. Current-step detection uses the step's `landmark` selector (resolved via the same tiered resolver); if no landmark resolves, the navigator reports "step unknown" and does not advance.

### 4.2 Advancing (Save / Continue / Next)

Advancing is **user-initiated**: the founder reviews the current step's fill result in the popup and clicks "Go to next section." Only then does the navigator:
1. Resolve the current step's advance control from the config `advanceControls` **allowlist**.
2. Run the resolved control through the **submit-guard denylist** (§4.3). If it matches ⇒ **abort**, surface the terminal boundary (§4.4).
3. If clean ⇒ click it, then re-detect the step via landmark.

The extension never advances automatically and never clicks a control that is not in the config allowlist.

### 4.3 Submit-guard (hard stop — INV-1)

Before *any* programmatic click, `isForbiddenControl(el)` matches — case-insensitively, against the element's **visible text, `value`, `name`, `id`, and `aria-label`** — this denylist:

```
/\b(submit|sign|e[-\s]?sign|certif(y|ication)|attest|finali[sz]e|
   file\s+application|sign\s*&?\s*(and\s*)?submit|submit\s+application|
   complete\s+submission)\b/i
```

If it matches, the control is **never clicked**, a hard-stop is logged, and the navigator hands to the human. **The denylist is hardcoded in `src/lib/submitGuard.ts` and unconditionally wins over the config allowlist.** A config-authoring test proves that even if an author places a submit-labeled control in `advanceControls`, `isForbiddenControl` blocks it (INV-1). The `superRefine`-style guarantee is: *there is no config that lets the extension click a submit/sign/certify control.*

### 4.4 Terminal boundary

The navigator stops — and shows the "You review & submit" terminal state — when **either**: the current step is the last enumerated `order`, **or** the only available forward control matches the submit-guard denylist. The final control is never auto-clicked even if it were (erroneously) enumerated. This is the concrete realization of R6 escalation **E1/E2**: the "human clicks submit" boundary is enforced in code, not left to policy.

---

## 5. Popup UI

A single popup (`src/popup/`) that is honest by construction. Copy mirrors the register of `AOR_HANDOFF` and `PACKAGE_INTRO` from `scaffold/lib/apply/package.ts`.

### 5.1 Screens / states

1. **Import.** "Nothing has been submitted" banner is persistent and prominent (**INV-12**). A file picker (`.granted.json`) and a paste box accept the export envelope (§6). On import: size/JSON/envelope/digest/Zod/honesty validation (§6.3); on any failure, a clear "This package couldn't be verified — re-export from Granted" message with the specific reason, and **no** partial import.
2. **Review (pre-fill).** For the chosen opportunity/package, a per-field list showing **exactly what will be filled vs. what is a gap**:
   - Grounded fields: label, value-to-be-filled, and **provenance** (`source`, e.g. `sam.uei`, `opportunity.agency`).
   - Gaps: label + the exact `[founder to provide: …]` display, styled as a blank the human completes in the portal — never a value.
   - Excluded (signature/date/credential): shown as "left for you / never auto-filled."
3. **Fill + progress.** "Fill this page" runs the engine on the active portal tab (user gesture → `activeTab`/`scripting`). Progress shows the summary counters and per-field `FillOutcome` truthfully (**INV-10**): *filled & verified*, *filled (portal shows different — check)*, *gap (you provide)*, *couldn't locate (unmapped)*, *kept your edit*, *excluded*.
4. **Navigate.** "Go to next section" (§4). At the terminal boundary, the **"Review & submit via your authorized AOR"** panel (verbatim register from `AOR_HANDOFF`) with the explicit statement that nothing was submitted and the human AOR submits in the portal.

### 5.2 Per-field and whole-form "review — YOU submit" boundary

Every field row and the form footer carry the same boundary: the extension filled/flagged; **the human reviews and the AOR submits**. No control in the popup can trigger a portal submit — the popup can only import, fill, flag, navigate-to-next (guarded), and clear.

### 5.3 Honest-copy rules (INV-12)

A copy-lint test asserts the popup/README/export strings:
- **Contain** a prominent "nothing has been submitted" statement.
- **Never contain** "submitted", "filed", "won", "approved", "guaranteed", or any phrasing implying fundFinder is the AOR / E-Biz POC or that it "files for you" (R6 **E3**).
- Mirror `AOR_HANDOFF.headline` ("Review & submit via your authorized AOR") and `PACKAGE_INTRO` framing.

---

## 6. The app→extension handoff

### 6.1 Options considered

- **(a) User-mediated signed export/import** — the Granted app produces a self-contained, integrity-checked export envelope the user downloads (`.granted.json`) or copies, and imports into the extension popup via file picker / paste. `externally_connectable` is **omitted**.
- **(b) `externally_connectable` from the app origin(s) with a handshake/nonce** — the app page calls `chrome.runtime.sendMessage(extensionId, …)` directly.

### 6.2 Decision: **(a) user-mediated signed export/import.** `externally_connectable` is deliberately NOT declared.

**Justification (attack surface, no-server, tamper-evidence, user-mediated flow):**
- **No standing web-reachable channel into the extension.** `externally_connectable` would let *any* JS on the app origin — including any XSS on the app, any third-party/CDN script it loads, or a supply-chain-compromised dependency — push a package into the extension. A nonce/handshake does not fix this: the nonce lives in the app's JS, reachable by the same XSS. Option (a) removes that entry point entirely; the manifest surface shrinks by one privileged channel.
- **No-server constraint (§5.3).** The flow is fully offline and client-side. Nothing transits a fundFinder server; the user carries the bytes.
- **Human-mediated data flow.** Import requires an explicit human action (pick a file / paste), matching the product's human-in-the-loop ethos and the AOR-review boundary. Data never enters the extension without a person choosing it.
- **Payload is inert data (INV-8).** The envelope is validated (size → JSON → schema → integrity digest → vendored Zod contracts → honesty invariants) and treated strictly as data — never as selectors, URLs, or instructions.

**Honest limitation, stated plainly:** under the current pure-client, no-server-key constraint there is no hidden private key in the browser, so the envelope's **integrity digest is tamper-*evident* (it catches corruption and silent edits) but is not, by itself, cryptographic proof of origin.** The real trust anchors are (1) the human choosing what to import and (2) strict client-side re-validation against the same Zod contracts the app used to produce the package. The envelope **reserves an optional detached `signature` field** so a later phase — if an app-side signing key is introduced (a server can sign at export time without *retaining* any user data, staying within §5.3) and the extension pins the public key — can add true authenticity **without a format change**. This is called out rather than overclaimed.

### 6.3 Envelope schema + import validation

```ts
// src/lib/envelope.ts  (zod-validated on import)
export interface GrantedExportEnvelope {
  format: "granted.autofill.package";     // exact literal; anything else refused
  version: 1;                             // envelope format version; unknown ⇒ refused
  generated_at: string;                   // ISO-8601
  opportunity_id: string;                 // binds payload to an opportunity
  program_title: string;
  /** Canonical-JSON SHA-256 of `payload`, hex. Integrity / tamper-evidence. */
  digest: { alg: "SHA-256"; value: string };
  /** RESERVED for a future app-signing key; omitted under current no-server-key constraint. */
  signature?: { alg: string; value: string; keyId: string };
  /** The WS-G / G5 AssembledPackage, re-validated on import against the vendored contracts. */
  payload: AssembledPackage;
}
```

**Import pipeline (each step refuses, never partially imports — INV-8):**
1. **Size cap.** Reject before parse if the raw string exceeds **512 KB** (bounds memory; the package is small structured JSON).
2. **JSON parse** in `try/catch`; reject on error.
3. **Envelope schema.** Zod-validate the envelope; reject on unknown `format`/`version` or shape mismatch.
4. **Integrity digest.** Recompute canonical-JSON SHA-256 of `payload` via `crypto.subtle.digest`; reject on mismatch. **Canonical JSON** = deterministic serialization (recursively sorted object keys, minimal separators, UTF-8), spec'd once and implemented **identically** in the app (T7) and the extension (T3), covered by a shared test vector so both sides agree byte-for-byte.
5. **Contract re-validation.** Re-parse `payload.forms` through the **vendored** `PrefilledFormsSchema` (§9.3) — this re-runs the honesty `superRefine`s: grounded ⇒ `value`+`source`; gap ⇒ placeholder-only matching `FOUNDER_TODO_PATTERN`; `gaps` exactly equals the set of gap displays. Reject on any failure.
6. **Honesty invariants (defense-in-depth).** Explicit final guard: no `prefilled` field lacking `value`/`source`; no gap carrying a value; and (cross-checked against the resolved config at fill time) no `packageKey` ever routes to a `signature`/`credential` role.
7. On all-pass only: store in `chrome.storage.session`; enable fill.

The payload is stored and used **only as data**. No field of it is ever interpreted as a selector, URL, script, or command.

---

## 7. Security model + §5.3 client-side lifecycle

### 7.1 Threat model

| Threat | Vector | Mitigation |
|---|---|---|
| **Malicious / hostile portal page** | Portal DOM tries to trick the engine into filling a credential/submit control, or to read extension state. | Content script runs in an **isolated world** (page JS can't read extension state); credential inputs are **refused** (INV-5); submit/sign controls are **never clicked** (INV-1); resolver never guesses on ambiguity (§2.2); engine only reads/writes DOM, never evals page strings. |
| **XSS on the portal page** | Injected script manipulates the DOM the engine reads/writes. | Read-back truthfulness (INV-10): a value is only reported filled/verified if the DOM actually holds it. The engine never submits, so injected DOM cannot cause a submission. Human review is the backstop. |
| **Oversized / hostile imported package** | A crafted `.granted.json` tries to blow memory or smuggle instructions. | Size cap → JSON → envelope schema → digest → Zod honesty → invariant guard (INV-8). Payload is inert data; refused on any failure with no partial import. |
| **Compromised app origin (supply chain / XSS on the app)** | An attacker on the app origin tries to push a package into the extension. | `externally_connectable` **omitted** (§6.2): the app origin has **no** channel into the extension. Import is human-mediated and re-validated. |
| **Extension-store supply chain** | Tampered build or dependency. | Bundled, no remote code (CSP `script-src 'self'`, `connect-src 'none'`); pinned deps + lockfile; `dist/` is reproducible from source; manifest-lint test asserts scoped hosts and no banned permissions. |
| **Credential capture (the hard line)** | Any path that reads/stores/transmits AOR/SAM.gov/eRA/Login.gov/Research.gov credentials. | **Structurally impossible by design:** no field binds to credential inputs; runtime refuses `input[type=password]`; no IdP/credential origin in `host_permissions`; no network egress at all (INV-5/INV-7). |

### 7.2 Why host permissions are minimal

Host permissions are the extension's blast radius. They are enumerated to exactly the four in-scope portals (§1), path-scoped for content-script injection (ASSIST only under `/assist/`), and exclude every credential/IdP origin. No `<all_urls>`. Adding a portal is a reviewed manifest + config change, not a silent widening.

### 7.3 Data lifecycle (§5.3 — client-side only, no server retention)

- **Where it lives:** the imported package + fill state live in `chrome.storage.session` by default (in-memory, cleared when the browser session ends). Persistence across restarts is **opt-in** to `chrome.storage.local` only if the user asks.
- **When it's cleared:** on "Clear package," on session end (session store), and auto-expired past the package's own staleness window (using `generated_at`).
- **Where it never goes:** nowhere on the network. No `fetch`/XHR/WS/beacon in content or background (INV-7); CSP `connect-src 'none'`. Nothing the extension holds is sent to any fundFinder server (northstar §5.3).
- **Credentials:** never requested, stored, transmitted, or handled, in any form, ever (R6 **E1/E2**; INV-5).

### 7.4 Restated hard-line invariants (not policy — enforced)

- **Never submit / sign / certify / attest / file** (INV-1) — enforced by the hardcoded submit-guard that wins over all config.
- **Never fill the SF-424 Box 21 signature/date block** (INV-4) — enforced by role-based exclusion checked before any write.
- **Never touch credentials** (INV-5) — enforced by input-type refusal + host-permission exclusion + zero network.
- **Never fabricate; gaps stay blank + flagged** (INV-2/INV-3) — enforced by the grounded-only write path and the honesty re-validation on import.

---

## 8. Consistency with the S2S enterprise path

The R6 memo (`<repo-root>/.claude/worktrees/ext-docs/docs/R6-s2s-feasibility-memo.md`) describes **two** apply paths. This extension is exclusively the **browser-side, human-submits** one:

- **This extension (browser-side assisted apply):** the §7 "thin assisted-apply slice" made concrete on the client. Runs in the founder's own authenticated session, fills + navigates, and stops before submit. **No credentials, no network, no submission calls, no PMO Third-Party-Submitter designation.** Low-liability, honest, shippable now.
- **S2S enterprise path (R6 §2.3):** the gatekept SOAP `Authenticate AOR` + `Submit Application As Third Party` integration. It is an **escalation-flagged future decision** (E1/E2) that fundFinder does **not** pursue without a separate legal-review gate. The extension must **never drift toward it** — no credential handling, no submission web-service calls, no headless automation.

**Shared invariant across both paths:** the **human AOR submits** in their own authenticated session, and **fundFinder never holds the AOR or E-Biz POC role** (SAM.gov ToS; R6 **E3**). The extension is the honest realization of that invariant on the browser side; the S2S path is the one that would test it and therefore stays behind legal review.

---

## 9. Extension toolchain + repo layout

### 9.1 Location

New directory, sibling to `scaffold/`:
`<repo-root>/extension/`

### 9.2 Toolchain (recommended)

- **Language:** TypeScript (pin to the same major as scaffold, TS `^5.6`).
- **Build:** **Vite + `@crxjs/vite-plugin`.** Rationale: it is the de-facto MV3 toolchain — generates/validates the MV3 manifest from `manifest.config.ts`, handles content-script/popup bundling and asset hashing, gives HMR during dev, and emits a `dist/` that **loads cleanly as an unpacked extension**. It keeps the extension in the same TS/npm/Vite family as the app's tooling. *Fallback if `@crxjs` MV3 churn bites:* `esbuild` + `tsc` with a hand-authored `public/manifest.json` (more manual, fewer moving parts).
- **Tests:** **Vitest** (native to Vite), `jsdom` environment for DOM-touching units. The pure logic — selector resolver, transforms, submit-guard, package validator, envelope verifier — is unit-testable **without a browser**.
- **Lint:** ESLint (with the `no-restricted-globals`/`no-restricted-syntax` network-ban rule for INV-7) + `tsc --noEmit`.
- **Deps:** `zod ^4` (same major as scaffold, so the vendored contracts parse identically), pinned lockfile.

### 9.3 Directory structure

```
<repo-root>/extension/
  package.json            # scripts: dev · build · lint · test · typecheck
  vite.config.ts          # @crxjs/vite-plugin
  manifest.config.ts      # typed MV3 manifest (emits manifest.json per §1)
  tsconfig.json
  .eslintrc.cjs           # includes the network-ban rule (INV-7)
  src/
    background/
      service-worker.ts   # message router; lifecycle; NO network
    content/
      runtime.ts          # per-portal content-script entry (declared per portal)
      selectorResolver.ts # tiered resolution — PURE given a root Element (§2.2)
      fillEngine.ts       # fill + read-back (§3); writeValue/readValue helpers
      navigator.ts        # step-through + submit-guard call sites (§4)
      flagOverlay.ts      # shadow-DOM overlay to flag gaps/excluded fields
    popup/
      index.html
      main.tsx / Popup.tsx# import · review · fill · progress · navigate (§5)
      copy.ts             # UI copy mirroring AOR_HANDOFF / PACKAGE_INTRO
    lib/
      contracts/          # VENDORED zod schemas + drift-guard (§9.4)
      envelope.ts         # envelope schema + canonical-JSON digest verify (§6.3)
      packageValidator.ts # size→JSON→envelope→digest→Zod→honesty pipeline (§6.3)
      transforms.ts       # ValueTransform implementations — PURE (§3.2)
      submitGuard.ts      # denylist matcher — PURE, unconditional (§4.3)
    config/
      schema.ts           # PortalFieldMap types + zod (§2.1)
      portals/
        grants_gov.ts      # seed config, TODO selectors (§2.3)
        research_gov.ts
        nih_assist.ts
        sbir_gov.ts
      index.ts            # registry: url → PortalFieldMap
  test/                   # vitest specs for each pure module + jsdom fill-engine
  dist/                   # build output — loadable unpacked MV3
```

### 9.4 Contract sharing (no drift)

The extension **vendors** copies of the relevant scaffold contracts (`applicationForms.ts`, the `FOUNDER_TODO_PATTERN` from `applicationDraft.ts`, and the `AssembledPackage` type from `package.ts`) into `extension/src/lib/contracts/`. A **drift-guard Vitest test** reads the scaffold originals from the sibling package in the SAME worktree — `../scaffold/lib/contracts/applicationForms.ts` (and siblings), relative to the `extension/` dir — and asserts the vendored copies match (normalized-hash equality), failing if scaffold's contract changes without the extension updating. (Because `extension/` and `scaffold/` are siblings in the repo, any worktree off `origin/main` has both on disk; the test must **skip with a clear warning** rather than hard-fail if `../scaffold` is absent, so the extension still builds standalone.) This keeps the two Zod definitions provably identical without a cross-package build dependency. `zod` is pinned to the same major so `superRefine` semantics match.

### 9.5 Scripts + the app-side five gates

Extension scripts: `npm run build` (⇒ loadable `dist/`), `npm run lint` (ESLint + `tsc --noEmit`), `npm test` (Vitest), `npm run typecheck`.

Any **app-side** change in `scaffold/` (the T7 export button) must pass the app's **five gates**, verified in the worker's own worktree off `origin/main` (NOT the feslice worktree — that is reserved for :3001 and must not be touched):
- `npm run typecheck` → `tsc --noEmit`
- `npm test` → `tsx --test …`
- `npm run build` → `next build`
- `npm run check:hex` → `node scripts/design/check-hex.mjs`
- `npm run check:contrast` → `node scripts/design/contrast-check.mjs`

---

## 10. Phase-3 build decomposition

Each task is one worktree → one PR. Dependencies noted. **T1 blocks everything; T2 and T3 run in parallel after T1; T4/T5/T6/T7 fan out after their inputs land; T8 finalizes.**

| # | Task | Scope / deliverable | Depends on | Parallel with | Key acceptance criteria |
|---|---|---|---|---|---|
| **T1** | **Project scaffold + manifest + tooling** | `extension/` created; Vite + `@crxjs` build; TS; Vitest; ESLint (incl. INV-7 network-ban rule); `manifest.config.ts` emitting the §1 manifest; `dist/` **loads cleanly as unpacked MV3**. | — | — | INV-6, INV-7 (manifest-lint + network-ban); unpacked-load smoke check passes. |
| **T2** | **Field-map config schema + seed configs** | `src/config/schema.ts` (+ zod); `selectorResolver.ts` (pure, tiered, `TODO`⇒absent); four seed `portals/*.ts` with all-`TODO` selectors; registry `index.ts`. | T1 | T3 | §2.2 resolver tests; INV-9 (all-`TODO` ⇒ resolves nothing, no throw); config-authoring test that a submit control can't be whitelisted (feeds INV-1). |
| **T3** | **Package contract types + validator + import** | Vendored contracts + drift-guard (§9.4); `envelope.ts` (schema + canonical-JSON SHA-256 verify); `packageValidator.ts` (size→JSON→envelope→digest→Zod→honesty). | T1 | T2 | INV-8 over malformed/oversized/tampered/invalid-honesty fixtures; drift-guard test; canonical-JSON test vector shared with T7. |
| **T4** | **Fill engine + read-back** | `fillEngine.ts`, `writeValue`/`readValue`, `transforms.ts`, `flagOverlay.ts`; per-field `FillResult` + summary. | T2, T3 | T5, T6, T7 | INV-2, INV-3, INV-4, INV-5, INV-10, INV-11 (jsdom fill tests). |
| **T5** | **Navigation + submit-guard** | `navigator.ts` (config-ordered step flow, landmark detection, user-initiated advance) + `submitGuard.ts` (hardcoded denylist, unconditional). | T2 | T4, T6, T7 | INV-1 (denylist wins over allowlist; terminal boundary; final step never auto-advanced). |
| **T6** | **Popup UI** | `src/popup/*` import → review (grounded vs. gap + provenance) → fill/progress → navigate → AOR terminal panel; `copy.ts`. Build against mocks first, integrate after T4/T5. | T3 (import); integrates T4/T5 | T4, T5, T7 | INV-12 (copy-lint); truthful per-field outcomes (INV-10 surfaced); "nothing has been submitted" prominent. |
| **T7** | **App-side signed export (in `scaffold/`)** | "Export for the browser autofill extension" button on the package screen; serialize `AssembledPackage` → envelope (canonical-JSON SHA-256); download `.granted.json` / copy; honest copy. Lives in `scaffold/` in its own worktree off `origin/main`. | T3 (envelope schema + canonical-JSON spec) | T4, T5, T6 | Passes all **five gates**; envelope round-trips through T3's validator; copy has no banned confirmation phrasing (INV-12). |
| **T8** | **Docs / README / load instructions** | `extension/README.md`: unpacked-load steps, the in-session selector-capture procedure to replace `TODO`s, the honesty/security invariants, the S2S boundary. | all (finalize) | can start early | Invariant table matches §0; load instructions verified against T1's `dist/`. |

**Dependency graph (text):**
```
T1 ──▶ T2 ─┐
      └▶ T3 ┼─▶ T4 ─┐
             │       ├─▶ T6 (integrate)
             └─▶ T5 ─┘
             └─▶ T7 (scaffold; parallel)
all ─▶ T8 (finalize; may start early)
```
Parallelizable after T1: **{T2, T3}**, then **{T4, T5, T7}** (T6 builds against mocks in parallel and integrates last). Critical path: **T1 → T3 → T4 → T6**.

---

## Appendix A — Package key → SF-424 box → transform (reference)

Derived from the SF-424 canonical table in the field map and the package keys in `scaffold/lib/apply/forms.ts`. Selectors are captured later (in-session); this table is the stable key↔box↔transform mapping the seed configs encode.

| packageKey | SF-424 box | elementType | transform |
|---|---|---|---|
| funding_opportunity_number | 12 | text | identity |
| funding_opportunity_title | 12 | text | identity |
| awarding_agency | 10 | text | identity |
| organization_name | 8a | text | identity |
| uei | 8c | text | identity |
| entity_type | 9 | select | entity_type_to_sf424_option |
| applicant_location | 8d (note) | text | identity |
| applicant_street | 8d | text | identity |
| applicant_city | 8d | text | identity |
| applicant_state | 8d | select | state_name_to_code |
| applicant_zip | 8d | text | identity |
| applicant_congressional_district | 16 | text | identity |
| naics_code | (supplement) | text | identity |
| project_title | 15 | textarea | identity |
| project_start_date | 17 | date | date_iso_to_mmddyyyy |
| project_end_date | 17 | date | date_iso_to_mmddyyyy |
| federal_funding_requested | 18a | text | currency_plain |
| total_project_cost | 18 (sum) | text | currency_plain |
| authorized_representative_name | 21 (identity) | text | identity |
| sam_registration_status | 20 (adjacent) | text | identity |
| capital_requirement_range | (non-SF-424) | text | identity |
| **Box 21 signature / Date Signed** | 21 | — | **NEVER FILLED (role: signature / date_signed)** |

*Note:* `applicant_location` is a coarse profile value ("City, State") and is often a package gap; the structured `applicant_street/city/state/zip` sub-fields are the real SF-424 targets. Where the package carries only the coarse value, those sub-fields stay gaps (blank + flagged), never fabricated.
