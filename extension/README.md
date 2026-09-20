# Granted Assisted Fill

A Chrome MV3 extension that fills a grant-portal application form **in your
own authenticated session** from a package exported by the Granted app. It
reads the imported package, fills the fields it can ground, flags the ones it
can't, and lets you step through the portal's own sections. **It never
submits, signs, certifies, attests, or files anything.** A human — your
organization's Authorized Organization Representative (AOR) — reviews
everything and clicks the portal's own final submit button, in their own
session, with their own credentials.

> **Nothing has been submitted.** This extension is an assistive form-filler,
> like a password manager — not a submission service.

This extension is the browser-side half of the "thin assisted-apply slice"
described in the architecture spec
(`docs/grant-autofill-extension-spec.md` in the parent repo) and the R6
feasibility memo. See §9 below for how it relates to the separate, legally
gated server-to-server (S2S) enterprise path.

---

## 1. Loading the unpacked extension

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
   This emits a loadable extension into `dist/`.
2. Open `chrome://extensions` in Chrome (or another Chromium browser).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this project's `dist/` directory.
5. The extension icon ("Granted Assisted Fill") appears in the toolbar. Pin
   it for easy access.
6. To pick up code changes: re-run `npm run build`, then click the reload
   icon on the extension's card at `chrome://extensions`.

For active development, `npm run dev` starts Vite in watch mode with HMR;
you'll still need to reload the unpacked extension in Chrome after the
initial load to pick up manifest/background changes (content scripts and the
popup hot-reload).

### What you'll see today (and why)

Every field selector shipped in `src/config/portals/*.ts` is a `TODO:`
placeholder — Phase-1 recon could not reach any of the four portals'
authenticated, form-filling surfaces (see §2 below). This means, out of the
box:

- Importing a valid `.granted.json` package works fully (all validation runs
  for real).
- Clicking **"Fill this page"** on any of the four portals will report
  **0 fields filled** and **every field flagged "couldn't locate"
  (unmapped)**. This is the *correct, honest* behavior (INV-9) — the
  extension never guesses at a selector it hasn't actually captured, and it
  loads and runs cleanly with nothing wired up yet.
- Section navigation similarly reports "couldn't confirm which section" until
  each portal's step landmarks are captured (grants_gov and research_gov and
  sbir_gov have placeholder steps; nih_assist ships with **no** steps at all,
  since its only public surface is a login screen — see §2).

Turning this into a working fill requires the in-session capture pass below.

---

## 2. In-session selector-capture procedure (turning `TODO`s into real selectors)

**Do this only in your own authenticated session, with your own
credentials.** Nobody else's account, ever.

1. **Log in** to the target portal (Grants.gov Workspace, Research.gov, NIH
   ASSIST, or SBIR.gov) in your own account, and navigate to the actual
   application-filling screen for a real or sandbox application.
2. **Open DevTools** (`Cmd+Option+I` / `F12`) on that page.
3. For each field you want to map (cross-reference
   `docs/grant-portal-field-map.md`'s SF-424 canonical table and this
   extension's `src/config/portals/<portal>.ts` `packageKey`s):
   - Use the element inspector (or `document.getElementById`,
     `document.getElementsByName`, etc. in the console) to find a **stable**
     selector for the field's `<input>`/`<select>`/`<textarea>`.
   - Prefer, in this order: a stable `id` → a stable `name` → an
     `aria-label`/`aria-labelledby` → the field's `<label>` text. This is the
     exact tier order the resolver (`src/content/selectorResolver.ts`) tries
     at runtime — pick the highest tier that's actually reliable on the real
     page (gov portals are known to rebuild forms without guaranteed stable
     `id`s across releases, so don't assume the first tier that resolves
     today will still resolve after the portal's next deploy).
   - **Do a private/incognito reload and re-check** the selector still
     resolves to exactly one element — the resolver refuses to guess on
     ambiguity (more than one match), so a selector that matches multiple
     elements is worse than useless.
4. **Replace the `TODO:` string** for that field's `selector` in the
   relevant `src/config/portals/<portal>.ts` file with the real value, e.g.:
   ```ts
   // before
   selector: { id: "TODO: in-session selector capture" },
   // after
   selector: { id: "applicantLegalName" },
   ```
5. Do the same for each `PortalStep.landmark` (a selector that's uniquely
   present when the user is actually on that step/page) and each entry in
   `advanceControls` (the Save/Continue/Next button for that step).
   - **Never** add a submit/sign/certify/attest/file control to
     `advanceControls`. It would be blocked at runtime regardless (see §3),
     but don't rely on that — keep the allowlist honestly scoped to
     non-terminal "advance" actions only.
6. Re-run the test suite (`npm test`) — the seed-config tests
   (`test/config.test.ts`) assert "every selector is `TODO`" for the CURRENT
   state; once you start filling in real selectors, update or relax those
   specific assertions for the fields you've captured (they exist to prove
   graceful degradation before capture, not to permanently forbid capture).
7. Rebuild (`npm run build`), reload the unpacked extension, and verify a
   real fill + read-back against the live portal page.

Capture NIH ASSIST last — of the four portals, only its login screen was
reachable publicly at all (the entire application flow is gated), so its
`steps`/`advanceControls` are currently empty; capturing it means first
recording the real post-login section flow before any field selectors are
useful.

---

## 3. Honesty & security invariants

Every row is a hard acceptance criterion backed by an automated test — not
just a design intention. A change that weakens one of these should fail its
test.

| ID | Invariant | Enforced by |
|---|---|---|
| **INV-1** | Never submits, signs, certifies, attests, or files. The hardcoded submit-guard denylist (`src/lib/submitGuard.ts`) always wins over any config allowlist. The final enumerated step is never auto-advanced. | `test/submitGuard.test.ts`, `test/navigator.test.ts` |
| **INV-2** | Gaps (`status: "founder_to_provide"`) are never written to the DOM — only visually flagged. | `test/fillEngine.test.ts` |
| **INV-3** | Only grounded (`status: "prefilled"`) fields carrying both `value` and `source` are ever written. | `test/fillEngine.test.ts`, `test/packageValidator.test.ts` |
| **INV-4** | SF-424 Box 21 signature/date block (and any `role ∈ {signature, date_signed, certification}`) is never auto-populated, checked before any write. | `test/fillEngine.test.ts`, `test/config.test.ts` |
| **INV-5** | No credentials, ever. Refuses `input[type="password"]` and any `role: "credential"` field; no IdP/credential origin in `host_permissions`. | `test/fillEngine.test.ts`, `test/manifestLint.test.ts`, `test/config.test.ts` |
| **INV-6** | Scoped `host_permissions` — only grants.gov, research.gov, public.era.nih.gov (path-scoped to `/assist/`), sbir.gov. No `<all_urls>`. | `test/manifestLint.test.ts` |
| **INV-7** | Client-side only — zero network egress in `src/background/**` and `src/content/**`. Manifest CSP `connect-src 'none'`. | ESLint rule (`eslint.config.js`) + `test/networkBan.test.ts` (static scan) + `test/manifestLint.test.ts` |
| **INV-8** | Imported package is inert DATA, never instructions. Size → JSON → envelope schema → digest → vendored Zod contracts → honesty guard, or refused, with no partial import. | `test/packageValidator.test.ts` |
| **INV-9** | Graceful degradation — seed configs (all-`TODO` selectors) load cleanly, import a valid package, fill 0 fields, flag everything "unmapped," never throw or guess. | `test/fillEngine.test.ts`, `test/config.test.ts` |
| **INV-10** | Read-back truthfulness — `filled_verified` only when a post-write DOM read-back equals the intended value. | `test/fillEngine.test.ts` |
| **INV-11** | Idempotent; never clobbers a human's edit (or any pre-existing content the engine didn't itself write). | `test/fillEngine.test.ts` |
| **INV-12** | Honest copy — "nothing has been submitted" is prominent; no submitted/filed/won/approved/guaranteed confirmation language; mirrors `AOR_HANDOFF`/`PACKAGE_INTRO` register. | `test/copyLint.test.ts` |

Run everything: `npm run typecheck && npm run lint && npm test && npm run build`.

---

## 4. The app→extension handoff

The Granted app exports a self-contained `.granted.json` file (or pastable
text) — an integrity-checked envelope wrapping the `AssembledPackage` your
package screen assembled. You import it here via a file picker or paste box;
there is **no** live channel between the app's web origin and this extension
(`externally_connectable` is deliberately not declared — see the spec §6.2).
Import validates, in order: size cap (512 KB) → JSON parse → envelope schema
→ canonical-JSON SHA-256 digest match → the vendored `PrefilledFormsSchema`
honesty contract → a final defense-in-depth honesty guard. Any failure
refuses the ENTIRE import (never a partial one) with a specific reason.

## 5. What this extension does, concretely

1. **Import** a package. The "nothing has been submitted" banner is always
   visible.
2. **Review** what will be filled (grounded value + where it came from),
   what's a gap (you fill it), and what's excluded (signature/date/credential
   — never auto-filled).
3. **Fill this page** — runs against the *current* portal tab, on your
   explicit click. Every field's true outcome is reported (filled &
   verified, filled but the portal shows something different, gap, couldn't
   locate, kept your edit, excluded, refused).
4. **Go to next section** — also your click. The extension detects the
   current step from the portal's own page structure, resolves the
   configured advance control, runs it through the hardcoded submit-guard,
   and only then clicks it.
5. At the last step (or if the only available control looks like a
   submit/sign/certify action), the popup shows a terminal panel: **"Review &
   submit via your authorized AOR."** Nothing beyond this point is automated.

## 6. Data lifecycle

The imported package and fill state live in `chrome.storage.session` — cleared
when the browser session ends. Nothing is ever written to `chrome.storage.local`
(no opt-in persistence is implemented in v0.1). Nothing is ever sent over the
network — there is no server component to this extension, and the manifest
CSP (`connect-src 'none'`) makes that structurally true, not just a promise.
"Clear package" removes the stored package immediately.

## 7. Adding a fifth portal

Adding a portal is a config + manifest change, not new code:

1. Add a `host_permissions` entry and a `content_scripts` entry (pointing at
   a new small entry file under `src/content/entries/`, per the pattern in
   `manifest.config.ts` — see the comment there about why each portal gets
   its own entry file rather than sharing `runtime.ts` directly) in
   `manifest.config.ts`.
2. Add `src/config/portals/<newPortal>.ts` (a `PortalFieldMap`, TODO
   selectors to start) and register it in `src/config/index.ts`.
3. Run the in-session capture procedure (§2) against that portal.

## 8. Project layout

```
extension/
  manifest.config.ts     # typed MV3 manifest (source of truth for manifest.json)
  vite.config.ts          # @crxjs/vite-plugin build
  vitest.config.ts        # separate config: plain TS/JSX + jsdom, no crx plugin
  src/
    background/service-worker.ts   # lifecycle + "clear package" relay; zero network
    content/
      runtime.ts            # per-portal message handler (fill/navigate/status)
      entries/*.ts           # one thin entry file per portal (see §7)
      selectorResolver.ts    # pure, tiered selector resolution
      fillEngine.ts           # the fill algorithm + FillResult/summary
      domIO.ts                 # writeValue/readValue (native setter + events)
      navigator.ts              # step detection + guarded advance
      flagOverlay.ts             # shadow-DOM gap/excluded/unmapped badges
    popup/                # import → review → fill → navigate → terminal UI
    lib/
      contracts/          # VENDORED copies of the app's Zod contracts (see §9.4 of the spec)
      envelope.ts          # canonical JSON + digest + envelope schema
      packageValidator.ts   # the full import pipeline
      transforms.ts          # pure value transforms
      submitGuard.ts          # the hardcoded denylist
    config/
      schema.ts            # PortalFieldMap types + zod
      portals/*.ts          # one seed config per portal
      index.ts                # URL → PortalFieldMap registry
  test/                  # Vitest specs (jsdom) for every module above
```

## 9. The S2S boundary — why this extension stops where it does

The R6 feasibility memo describes two apply paths. This extension is
**exclusively** the browser-side, human-submits one: it runs in the
user's own authenticated session, fills and navigates, and stops before
submit. No credentials, no network, no submission calls, no third-party
submitter designation. The separate server-to-server (S2S) enterprise path
(the gatekept SOAP `Authenticate AOR` + `Submit Application As Third Party`
integration) is an escalation-flagged future decision that Granted does not
pursue without a separate legal-review gate — and this extension must never
drift toward it. The shared invariant across both paths: **the human AOR
submits, in their own authenticated session, and Granted never holds the AOR
or E-Biz POC role.** This extension is the honest, shippable realization of
that invariant on the browser side.
