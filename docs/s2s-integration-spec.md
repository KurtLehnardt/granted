# G6 — grants.gov System-to-System (S2S) Submission Integration Spec

<!--
SPEC-DRIVEN-DEVELOPMENT DOCUMENT · WS-G / G6 ("Option B")
Author role: Architect (spec only — no app code, no worktrees, no agents, no PRs).
-->

- **Status:** v4 (converged v3 + the post-merge alignment & scope-boundary addendum in **§0**, which is AUTHORITATIVE and supersedes any conflicting text below). See §16 Revision log.
- **Workstream:** WS-G · G6 — "Submission integration (feasibility-gated)" (`docs/gap-closure-plan.md` §3, WS-G).
- **Scope name:** Option B — *the deterministic integration layer + a mock/sandbox submission path*, NOT live production submission.
- **Baseline:** `origin/main`. Worktree for this spec: `.claude/worktrees/g6-s2s-spec`. All build tasks below branch fresh worktrees off `origin/main` and merge centrally.
- **Spec-generation skill note (per task method step 3):** No *pure spec-generation* skill is installed. `agentic-tools:build` is an implementation-orchestration pipeline (plan → workers → merge) and was deliberately **not** run — running it would spawn workers and merge code, which is Phase 2, not this deliverable. `plan`/`blueprint` were consulted for *structure conventions only* (self-contained per-task context briefs, explicit dependency graph, parallel-vs-stack marking). This document was therefore **hand-written**, which the task explicitly sanctions.
- **Binding prior art (MUST reconcile, MUST NOT contradict):** `docs/R6-s2s-feasibility-memo.md` (on `origin/main`). This spec is a *design that stays inside* that memo's recommended thin slice and keeps its escalations **E1–E6 open** — it resolves none of them.
- **Re-verification gate (memo §2, restated):** Federal system requirements change. Every concrete WSDL/schema/namespace/host detail below is **subject to re-verification against current official grants.gov docs immediately before any live path is ever scheduled** — it is *not* assumed still-current. G6 as specified here **never** reaches a live federal endpoint, so re-verification is a precondition on a *future, separately-gated* phase, not on G6.

---

## 0 · v4 Addendum — post-merge alignment & ownership boundary (AUTHORITATIVE)

Written after G1–G5 all merged to `origin/main` and after the coordinator fixed G6's
ownership boundary. **Where this section conflicts with anything below, this section wins.**
The rest of the doc (its honesty/legal analysis, the AOR gate, the mock/sandbox design, the
flag pattern, the memo reconciliation) stands unchanged — only the input shape, the file
locations, and the task list are corrected here.

### 0.1 · Consume the ONE merged shared package — do NOT define a parallel shape
G3 (`scaffold/lib/apply/forms.ts`, `PrefilledForms`), G4 (`scaffold/lib/apply/budget.ts`,
`ApplicationBudget`), and **G5 (`scaffold/lib/apply/package.ts`, `AssembledPackage` +
`components/ApplicationPackage.tsx` + `app/api/apply/package/route.ts`)** are now on
`origin/main`. **`AssembledPackage` is the single shared WS-G source of truth** (it already
folds G2 narratives + G3 `forms` + G4 `budget` + a deduped `gaps: string[]`, with the honest
`AOR_HANDOFF` / `PACKAGE_INTRO` copy). Therefore:

- **G6 CONSUMES `AssembledPackage` (imported read-only from `lib/apply/package.ts`); it does
  NOT define, assemble, or re-derive any package.** The self-contained `SubmissionPackage`
  contract and the `assembleSubmissionPackage(...)` assembler described in §8.1/§8.3 and the
  old task **T2 (assembler) are DROPPED** — that work already exists in G3/G4/G5 and must not
  be duplicated (coordinator: "it must not define a parallel package shape").
- **Org identity for the XML comes from `AssembledPackage.forms` (the G3 SF-424
  `PrefilledField`s: `key`/`value`/`source`/`status`, e.g. `uei`, `project_title`, org name).**
  Grounded fields carry a `source`; ungrounded ones are `status:"founder_to_provide"` with a
  `[founder to provide: …]` `display`. G6 renders each as a value or a **visible gap marker** —
  never invents one. Budget line-item amounts are ALWAYS gaps by G4's contract; preserve that.
- **Submission metadata not present on `AssembledPackage`** (`cfda_number`, `competition_id`,
  `source_label`, `agency`) is derived from the `Opportunity` record via a thin, pure
  `SubmissionMeta` (T1). Absent identifiers → gap markers in the XML, never fabricated numbers.
- The honesty machinery is **inherited, not rebuilt**: `AssembledPackage` and its parts are
  already Zod-validated and grounding-enforced upstream (G2/G3/G4/G5). G6 consumes validated
  output and adds only mapping/transport/gate — so §4.2 HR-1/HR-2/HR-3 hold by construction; G6
  re-asserts them in tests over the real shape (§0.4 T-D).

### 0.2 · Ownership boundary (coordinator-set — hard)
G6 **owns and may only create/modify**:
- `scaffold/lib/s2s/*` — ALL G6 code lives here (types, meta, xml, transport, config, authorize,
  client, barrel) + `scaffold/lib/s2s/__tests__/*`. (Note: `lib/s2s/`, **not** the doc's earlier
  `lib/apply/s2s/` — every `lib/apply/s2s/...` path below is relocated to `lib/s2s/...`.)
- The **S2S flag** `g6_s2s_submission` via the three-place `lib/flags` pattern:
  `lib/flags/registry.ts`, `lib/flags/env.ts`, `lib/flags/__tests__/registry.test.ts` (§11.1).

G6 **must NOT touch** (other teams own these): `scaffold/components/*` and `scaffold/lib/match.ts`
(matching/UI team), `scaffold/extension/*` (extension team), and `scaffold/lib/apply/*`,
`scaffold/lib/contracts/*`, `scaffold/app/*` (import read-only only — no edits). New G6 types go
under `lib/s2s/`, **not** `lib/contracts/`.

### 0.3 · The UI task is OUT OF G6's scope (seam handed to the components team)
Old **task T5 (UI: `S2SSubmissionPanel.tsx` + editing `AutoApplyFlow.tsx`) is DROPPED from
G6** — it lives in `components/*`, owned by another team. G6 instead exposes a clean seam the
components team wires behind the `g6_s2s_submission` flag:
`submitPackage(assembled, meta, { transportKind: "mock", authorization, legalGate })`
→ `SubmissionReceipt { is_mock: true, submitted_to: "MOCK", human_note }`. The existing honest
copy (`AOR_HANDOFF`, `PACKAGE_INTRO` in `lib/apply/package.ts`) is reused by that UI. G6 proves
the whole flow end-to-end in tests (§0.4 T-D), so it is fully demoable/testable without any UI.

### 0.4 · Revised task stack (linear; base each worktree off the prior task's branch)
Four PR-sized tasks, one worktree + one PR each (base `main`), five gates each, stacked so gates
stay green without central merges in between (merge order = task order):

- **T-A** — `lib/s2s/` core types + `SubmissionMeta` (from `Opportunity`) + the
  `g6_s2s_submission` flag (three-place) + tests. Owns: `lib/s2s/{types,meta,index}.ts`,
  `lib/s2s/__tests__/{types,meta}.test.ts`, the three flag files. Consumes `AssembledPackage`
  (type import). Acceptance: `AorAuthorization` requires `attested:true`; `SubmissionReceipt`
  requires `is_mock:true`+`submitted_to:"MOCK"`; `toSubmissionMeta` derives ids from an
  `Opportunity`, missing `cfda_number`/`competition_id` → gap markers; flag defaults OFF and the
  exhaustive `registry.test.ts` `FlagName[]` array is updated. Model: opus. **Off `origin/main`.**
- **T-B** — `lib/s2s/xml.ts`: `toGrantApplicationXml(assembled, meta)` + `toSoapEnvelope`,
  version-pinned (`SCHEMA_VERSION` + re-verify doc block, memo §2), deterministic, XML-escaped,
  **gap-preserving** (every `AssembledPackage.gaps[i]`, every `founder_to_provide` form field,
  and every budget-amount gap → a visible `<!-- GAP: … -->` marker, never an empty plausible
  value) + tests. Acceptance = old §12/T3 (c)–(g) over the real `AssembledPackage`. Model: opus.
  **Stacks on T-A.**
- **T-C** — `lib/s2s/{transport,authorize,config,client}.ts`: `MockTransport`, `selectTransport`
  (mock only; sandbox/live throw), `assertNonProductionEndpoint` (default-deny), `OrgS2SConfig` +
  `loadOrgS2SConfig` (server-only, null-by-default, cert *reference* not secret),
  `assertSubmissionAuthorized` (AOR gate), and `submitPackage(assembled, meta, opts)` wired
  mock-only + tests. Acceptance = old §12/T4 (a)–(g). Model: opus. **Stacks on T-B.**
- **T-D** — `lib/s2s/__tests__/integration.honesty.test.ts` (+ fixtures): the HR-4 honesty
  invariant (only non-throwing path is `{flag on, authorized, mock}`; no cell makes a network
  call), grounding preserved e2e over a real `AssembledPackage` fixture, `is_mock` on every
  receipt, and a source-scan asserting no production `grants.gov` host / no third-party-submit
  operation name in the wired `lib/s2s` path. Model: sonnet. **Stacks on T-C.**

Everything else in this document (the memo reconciliation §3, honesty/legal §10, the flag +
labeling intent §11.1, risks §13, test strategy §14, traceability §15) remains in force, read
with the file-path relocation (`lib/apply/s2s/` → `lib/s2s/`) and the "consume `AssembledPackage`,
don't assemble" correction applied throughout.

---

## 1 · Overview

For a high-match opportunity, WS-G already gets a founder to a *submission-ready application package*: G1 (`lib/apply/requirements.ts`) extracts grounded program requirements, G2 (`lib/apply/draft.ts`) drafts grounded narrative sections. **G6 adds the deterministic "plumbing" that a package would travel through to reach grants.gov** — an input contract, an assembled-package → grants.gov application-XML mapping, a typed submission client with a *pluggable transport*, a per-org config/credential model, an AOR-authorization gate, and honest UI — **and exercises the whole thing end-to-end against a MOCK transport only.**

G6 does **not** submit anything to any federal system. It builds the rails and drives a mock train on them. The live rail is *designed for* (a documented transport seam) but **left unwired**, gated behind a default-OFF flag **plus** a server-only legal-review gate **plus** a recorded per-org AOR authorization **plus** a non-production-endpoint guard — a combination no G6 task satisfies. This is the memo's central finding made structural: *"a human must click submit" is a product/policy choice fundFinder imposes on itself, not a technical wall* (memo §1, E1). G6 encodes that choice in code.

The value G6 ships now: the integration layer is real, typed, tested, and demoable (mock), so that (a) the "prepare a submission package and hand it to your AOR" workflow is complete and honest, and (b) the day a live path is ever legally cleared, the mapping/transport/gate are already built, reviewed, and covered — only a vetted `LiveTransport` and the legal sign-off remain, both out of G6.

### 1.1 · Modalities & positioning (two complementary WS-G filing paths, one shared package)

"Fill out the application on the founder's behalf" ships in **two complementary WS-G modalities that consume the SAME assembled package** — the grounded WS-G `SubmissionPackage` is the single source of truth, and each modality is just a *renderer* of it:

- **(a) Browser extension — the PRIMARY / DEFAULT browser-side path.** An MV3 Chrome extension (owned and built by a **dedicated separate team**) auto-fills the *live portal forms* inside the **founder's own authenticated browser session**, and the founder **submits themselves**. This is the default "on their behalf" experience for the typical founder who applies through the grants.gov web UI. **Its internals are out of scope here** — this spec references the effort and consumes the shared package contract; it does not design the extension.
- **(b) S2S — the ENTERPRISE / programmatic modality (this spec).** For organizations that actually enroll in grants.gov System-to-System (active SAM.gov + UEI, Grants.gov org registration, **S2S enrollment**, an approved commercial **PKI cert**, the **AOR** role, and — for third-party submission — the PMO's **"Third Party Submitter"** designation). This is the SOAP/XML programmatic path for enrolled orgs, not the everyday browser flow.

Both modalities **end at a human-authorized submission** and **neither "submits on its own."** The **shared seam** is deliberate: T1's `SubmissionPackage` contract (§8.1) is the common, grounded source of truth; the extension's autofill and G6's S2S XML mapping (§9) are **two renderers of the one package**. That is what keeps founder facts grounded once (in the assembler, T2) and reused honestly by whichever modality fills the actual forms. G6 owns *only* modality (b)'s SOAP/XML client, credential/enrollment model, and mock/sandbox transport — see NG-10 for the hard line against building any browser-autofill logic here.

---

## 2 · Goals / Non-goals

### 2.1 Goals

- **G-1.** A **self-contained** `SubmissionPackage` Zod contract, populable from what is on `origin/main` today (`CompanyProfile` + G1 `ApplicationRequirements` + G2 `ApplicationDraft` + `Opportunity`) — with an adapter seam for G3/G5 when they land.
- **G-2.** A deterministic, pure `SubmissionPackage` → **grants.gov application XML + SOAP envelope** mapping, version-pinned and gap-preserving (never fabricates a missing field).
- **G-3.** A **typed S2S client/adapter with a pluggable `SubmissionTransport`**, whose only *wired* transport is a hermetic `MockTransport`; the live/sandbox transports are documented, guarded seams.
- **G-4.** A **per-org credential/config model** that (a) is env/config-based, (b) represents the org's OWN credentials only, never fundFinder's, never hardcoded, (c) is sandbox/training-host only in anything executed, and (d) is `null`/absent on the default path (mock needs no credentials).
- **G-5.** An **AOR-authorization gate** that structurally refuses to submit without a recorded per-org AOR attestation, and refuses any non-mock transport without the legal-review gate + a non-production endpoint.
- **G-6.** Everything behind a **default-OFF `g6_s2s_submission` flag**, wired via the exact `lib/flags` three-place pattern, plus honest UI labeling that never claims submission/eligibility/award.
- **G-7.** A test suite proving: schema round-trips, XML gap-preservation, the AOR gate refusing without authorization, the mock transport labeling, and the honesty invariant *no submit path fires without flag + gate*.

### 2.2 Non-goals (hard — see §11 and the memo's §7 out-of-scope list)

- **NG-1.** Any call to `Authenticate AOR`, `Authenticate AOR [Expanded]`, `Submit Application As Third Party`, or `…[Expanded]` (memo §2.3, §7). G6 ships **no** `LiveTransport`.
- **NG-2.** Pursuing grants.gov PMO's "Third Party Submitter" designation (memo §2.3, §7, E1).
- **NG-3.** Requesting, storing, transmitting, or prompting for any real SAM.gov / Grants.gov / eRA Commons / Login.gov / DSIP / Research.gov **credentials**, in any form, "even just for this session" (memo §7, E2).
- **NG-4.** Headless-browser automation, MFA/PIV-CAC bypass, or any automated *production* submission (memo §7).
- **NG-5.** fundFinder acting as AOR / E-Biz POC for a customer (memo §3, E3) — structurally barred by SAM.gov ToS. G6 never models fundFinder as the submitter.
- **NG-6.** Depending on unmerged G3 (`lib/apply/forms.ts`) or G5 (`components/ApplicationPackage.tsx`). G6 defines its own input contract and notes the seam.
- **NG-7.** "Resolving" memo escalations E1–E6. They stay open; §11 restates them.
- **NG-8.** Auto-submission of any kind, live or mock-that-looks-live. The mock transport is *labeled as a mock on every surface*.
- **NG-9.** Guaranteeing eligibility or building "a complete application system" — the hackathon brief marks both **out of scope**; live S2S submission is a **post-hackathon "bigger vision"** item (§3.2).
- **NG-10.** **Any browser-autofill / portal-DOM / content-script / MV3-extension logic.** That is the browser-extension team's scope (§1.1, modality (a)). G6 stays strictly on the SOAP/XML S2S client + credential/enrollment model + mock/sandbox transport (modality (b)). G6 produces the shared `SubmissionPackage`; it does not fill any live portal form.

---

## 3 · Context & prior-art reconciliation

### 3.1 The R6 feasibility memo (`docs/R6-s2s-feasibility-memo.md`) — binding

The memo is the authoritative legal/technical grounding. G6 sits *entirely inside* its recommended thin slice and contradicts nothing in it:

| Memo finding / constraint | Where it lands in G6 |
|---|---|
| §1 / E1 — the "human clicks submit" boundary is a *self-imposed policy*, not a Grants.gov wall (NIH ASSIST submits with no human click via the third-party services). | G6 encodes the policy in code: the AOR gate (§7) + the "no `LiveTransport` shipped" rule (§6). The boundary is enforced by *our* code, honestly labeled. |
| §2.1 — public unauthenticated REST (`search2`, `fetchOpportunity`) is safe today; **submission REST is not generally available** (Simpler.Grants.gov pilot, 2027 target) — a **moving target**. | G6 does not assume REST submission exists. Opportunity-detail prefill may use `fetchOpportunity` (out of G6's file scope; noted as a seam). The submission *format* G6 maps to is the legacy S2S application XML, version-pinned + re-verify-required (§10). |
| §2.2 — legacy SOAP S2S needs Expanded AOR role + a **commercial PKI cert** (approved CA only) + WSDLs + a `training.grants.gov` sandbox. | The `OrgS2SConfig` model (§6) *represents* (org-supplied, sandbox-only) cert/endpoint config but G6 wires no transport that consumes it against a real host. The sandbox host is the *only* non-mock host the endpoint guard would ever allow. |
| §2.3 / E1, E2 — third-party submission needs the AOR's **username/password** inside the third-party system + PMO designation; **not self-service**. | **Never built.** `AorAuthorization` (§7) is an *attestation record*, not credentials — it holds no password. NG-1/NG-2/NG-3 forbid the rest. |
| §3 / E3 — fundFinder **cannot** be AOR / E-Biz POC (SAM.gov ToS). | The package models the *founder's org* as submitter; fundFinder is never the actor. UI copy (§12) says "hand to your AOR," never "we file for you." |
| §6 — submission is a legal attestation; **18 U.S.C. §1001** + False Claims Act exposure attaches to the AOR. | The review-and-attest UI (§12) and the AOR gate (§7) make the human attestation explicit and recorded before any (mock) submit. |
| §7 — recommended scope: **package builder → human review-and-attest → human submits themselves, own session, own credentials.** | This *is* G6's default posture. The mock path lets the whole flow be demoed without ever leaving that posture. |
| §6 E4 — product-liability of a wrong prefilled value with a provenance tag. | Every package field carries provenance or is a `[founder to provide]` gap (§5.3, §9); nothing is asserted the founder did not supply. Open — not resolved. |

**Escalations E1–E6 remain open.** G6 does not adopt any of them silently; §11 restates each and marks the future decisions they gate.

### 3.2 The hackathon brief (`https://startupstate-hackathon-brief.lovable.app/`) — reconciled

The brief's differentiator is **honesty**: *"We will reward systems that can say 'there probably isn't a strong match' rather than hallucinating one."* Its explicit **out-of-scope** list includes **"Build a complete application system"** and **"Guarantee eligibility."**

Reconciliation:
- G6 does **not** build "a complete application system" *for the hackathon*. G6 is positioned in this spec as a **post-hackathon "bigger vision" increment** (WS-G is "the END-GOAL," gap-closure-plan §3/§5 Wave 4), shipped **default-OFF**, demoable only in mock. It never becomes the judged build's default surface.
- G6 **guarantees nothing** — not eligibility, not award, not submission. The `findBannedPhrases` guard (`scripts/check-prompt-registry.mjs` — bans "you qualify", "you are eligible", "guaranteed", "you will receive", "you will be awarded") is reused to lint G6's own generated/derived text and UI copy (§5.2, §12, §15).
- The brief's north-star honesty differentiator is *preserved and extended*: the package builder refuses to invent founder facts exactly as G2 does.

### 3.3 The north star (product principles) — honored

*"A personal government-funding intelligence analyst… build workflows first… ground the AI… never bad advice."* G6 is workflow-first (it completes the apply workflow), grounded (every package value traces to a profile field / draft or is flagged), and honest (never a definitive eligibility/award/submission claim). It is deterministic plumbing — no new model calls — so it adds no fabrication surface; TACA (Transparency/Accuracy/Calibration/Alignment) is served by provenance-per-field + the mock label.

### 3.4 Repo reality (what G6 builds on, all on `origin/main`)

- **Stack:** Next.js 14 App Router · TypeScript · **Zod v4** · `tsx --test` runner · tests in `__tests__/` dirs · gates run from `scaffold/`.
- **Flags:** `lib/flags/{registry,env,accessor,index}.ts` — default-OFF, three-place add pattern (§12.1). `registry.test.ts` asserts an **exhaustive** `expected: FlagName[]` via `deepEqual` (line ~49) — adding a flag **requires** updating that array (T1 acceptance).
- **Contracts:** `lib/contracts/opportunity.ts` (`Opportunity`, `OpportunityKind`, `KeyDates`, `AwardRange`), `lib/contracts/companyProfile.ts` (`CompanyProfile`, `provenanced(...)` wrapper, `isFieldProvided`, `PROFILE_FIELD_META`, `sam_registered`, `uei`, `naics_codes`, `entity_type`, `certifications`…), `lib/contracts/primitives.ts` (`provenanced`, `Provenanced`, `ProvenanceSchema`).
- **G1/G2 (the package sources):** `lib/contracts/applicationRequirements.ts` (`ApplicationRequirements`, `NOT_SPECIFIED`, grounded atoms), `lib/contracts/applicationDraft.ts` (`ApplicationDraft`, `FOUNDER_TODO_PATTERN`, `DraftSection`, `DraftClaim`, `DraftGap`), and their pure enforcers in `lib/apply/{requirements,draft}.ts` (`annotateGrounding`, `validateGrounding`, `enforceGrounding`, `validateDraftGrounding`, `DraftGroundingError`). **G6 mirrors this exact pattern:** a permissive shape → a pure model-free grounding enforcer → schema `.parse()` as defense-in-depth.
- **R6 apply UI / model:** `components/AutoApplyFlow.tsx` (behind `r6_auto_apply`; steps signin → requirements → review; *"NEVER submits", honest STUB*), `components/ApplicationChecklist.tsx` (`REQUIREMENTS`, `RequirementKey`), `lib/mockAuth.ts` (`AutoApplyRequirements` = `{samRegistered, samRegisteredDate, uei, aorName, aorOnFile, eBizPocOnFile}`, `getAutoApplyRequirements`, `setAutoApplyRequirements`, `clearAllLocalData`, `STORAGE_KEYS`). G6 extends this flow; it does not fork it.
- **Gates (`package.json`):** `typecheck` (`tsc --noEmit`) · `test` (`tsx --test "lib/**/__tests__/**/*.test.ts" "app/**/…" "scripts/**/…" "components/**/…"`) · `build` (`next build`) · `check:hex` · `check:contrast` · `check:prompts` (AST scan for inline `system:` strings in `.messages.create` calls + `BANNED_PHRASES` in registered templates). **G6 makes no model calls and registers no prompts**, so `check:prompts` is a trivial pass for every deterministic task; it is only *materially* relevant to the UI task if that task adds copy near banned phrasings (it must not).

---

## 4 · Requirements (each testable)

### 4.1 Functional (FR)

- **FR-1** `SubmissionPackageSchema` validates a package assembled purely from `{CompanyProfile, ApplicationRequirements, ApplicationDraft, Opportunity}`; `SubmissionPackageSchema.parse` throws on a malformed package. *Test:* schema accept/reject round-trip (mirror `applicationRequirements` tests).
- **FR-2** `assembleSubmissionPackage(...)` is **pure** (no network, no model call, no `Date.now` in the mapped body except a stamped `assembled_at`) and deterministic given identical inputs. *Test:* same inputs → deep-equal output (modulo the stamped timestamp, which is injectable).
- **FR-3** `toGrantApplicationXml(pkg)` produces a deterministic, well-formed, XML-escaped application-XML string; `toSoapEnvelope(xml, meta)` wraps it in the S2S `SubmitApplication`-shaped envelope. *Test:* stable structure snapshot + XML-escaping of `< > & " '` + parseability.
- **FR-4** The `SubmissionTransport` interface has exactly one wired implementation, `MockTransport`, returning a `SubmissionReceipt` with `is_mock: true`. *Test:* mock returns a receipt whose `is_mock === true` and `tracking_id` matches the mock format.
- **FR-5** `selectTransport(kind, cfg)` returns `MockTransport` for `kind: "mock"` (default) and **throws `TransportNotAvailableError`** for `"sandbox"`/`"live"` in G6 (not implemented). *Test:* mock returns; sandbox/live throw.
- **FR-6** `assertNonProductionEndpoint(url)` **throws `ProductionEndpointRefusedError`** for any host on the production denylist (`grants.gov`, `www.grants.gov`, `api.grants.gov`, and any host not on the sandbox allowlist `training.grants.gov`, `api.staging.grants.gov`). *Test:* production hosts throw; sandbox hosts pass; unknown hosts throw (default-deny).
- **FR-7** `assertSubmissionAuthorized(pkg, authorization, transportKind, gate)` throws `SubmissionNotAuthorizedError` unless a structurally-valid `AorAuthorization` for the package's org is present; for any `transportKind !== "mock"` it *additionally* requires `gate.legalReviewApproved === true`. *Test:* §7.4.
- **FR-8** `submitPackage(pkg, opts)` (the client) runs the full chain — flag check → authorization → XML map → transport → receipt — and returns a `SubmissionReceipt`. With the default (mock) transport it is fully exercisable without any credentials. *Test:* mock end-to-end returns a labeled receipt.
- **FR-9** The `g6_s2s_submission` flag defaults OFF; `isFlagEnabled("g6_s2s_submission")` is `false` with no env set. *Test:* flags accessor test.
- **FR-10** Adapter seam: `assembleSubmissionPackage` accepts an optional `formsOverride?` and `orgOverride?` so G3/G5 data can enrich the package later **without a contract change**. *Test:* override merges over, absent override is a no-op.

### 4.2 Honesty / legal (HR — each testable)

- **HR-1 (grounding / anti-fabrication).** Every factual value in a `SubmissionPackage` is either (a) traced to a provided profile field / a G2 grounded claim, or (b) a `[founder to provide: …]` gap (reusing `FOUNDER_TODO_PATTERN`). A value with no source is **never** emitted — the assembler neutralizes it to a gap, exactly as `enforceGrounding` does. *Test:* a profile missing `uei` yields a `uei` gap, never a fabricated identifier.
- **HR-2 (no eligibility/award/guarantee claim).** No package text and no UI copy contains a `BANNED_PHRASES` phrase; `findBannedPhrases` over derived text returns `[]`. Refuse (throw) rather than hedge, mirroring G2's `DraftGroundingError`. *Test:* banned phrase in an input narrative is refused.
- **HR-3 (never claims submission).** No receipt, status, or UI string asserts a *real* submission occurred; mock receipts carry `is_mock: true` and a human-readable "MOCK — nothing was submitted to any federal system" note. *Test:* asserts the mock note + `is_mock` on every receipt.
- **HR-4 (no live submit without flag + gate + authorization + non-prod endpoint).** There exists **no code path** by which `submitPackage` reaches a non-mock transport in G6. Even with the flag on and a valid authorization, `selectTransport("live"|"sandbox")` throws. *Test:* the "honesty invariant" test (§15) drives every combination and asserts a mock-or-refuse outcome — never a live call.
- **HR-5 (no credential handling on the default path).** `OrgS2SConfig` is `null` on the default path; `MockTransport` reads no credentials; no schema field stores a password/secret in plaintext beyond an org-supplied, sandbox-only reference the mock never reads. *Test:* asserts the mock flow touches no `OrgS2SConfig` and stores no secret.
- **HR-6 (escalations preserved).** No G6 code pursues PMO designation, calls a third-party-submit web service, or stores real AOR/SAM credentials. *Enforced by review + the absence of any such symbol; asserted by a grep-style test that no forbidden endpoint constant exists in the wired path (§15).*

---

## 5 · The credential / auth / enrollment model

### 5.1 Principle: credentials are the org's own, sandbox-only, and absent by default

The default and only demoable path (`MockTransport`) needs **no credentials at all**. The model below exists so the *shape* of a future sandbox path is typed and reviewed — but nothing in G6 consumes it against a real host.

### 5.2 `OrgS2SConfig` (per-org, env/config-sourced, never fundFinder's)

`lib/apply/s2s/config.ts`:

```ts
// Read ONLY from per-org env/config supplied by the org itself. NEVER hardcoded,
// NEVER fundFinder's credentials, NEVER a production host. Returns null on the
// default path (the mock transport ignores this entirely).
export interface OrgS2SConfig {
  orgUei: string;                 // the org's OWN UEI (matches the package)
  endpointUrl: string;            // MUST pass assertNonProductionEndpoint(...)
  // A REFERENCE to the org's own commercial PKI client cert, supplied by the org
  // via its own env/secret store — NOT a secret value inlined here. G6 wires no
  // transport that reads it; it is typed for the future sandbox seam only.
  clientCertRef?: string;         // e.g. an env var NAME the org sets, resolved out-of-band
  transportKind: "sandbox";       // "mock" needs no config; "live" is never produced by G6
}

// Returns null unless a *complete* per-org sandbox config is present in env AND
// its endpoint passes the non-production guard. Any production host → throw.
export function loadOrgS2SConfig(env?: NodeJS.ProcessEnv): OrgS2SConfig | null;
```

- **Never** a `NEXT_PUBLIC_*` var — org config is server-only, so it can never be inlined into the client bundle. (Contrast the `g6_s2s_submission` flag, which *is* `NEXT_PUBLIC_` because it only gates UI visibility, not credentials.)
- The env var **names** are documented in the spec, not the values. No secret is committed. The default path never sets them, so `loadOrgS2SConfig` returns `null`.
- `assertNonProductionEndpoint` (§6) runs at config-read time *and* at transport-select time (defense-in-depth): a production URL can never survive into a config object.

### 5.3 Enrollment model (documentation, not automation)

Per memo §3, the org (not fundFinder) must independently hold: active SAM.gov registration + UEI, Grants.gov org registration, S2S enrollment, an approved commercial PKI cert, the AOR role, and — for third-party submission — the PMO's "Third Party Submitter" designation. **G6 automates none of this.** The existing `AutoApplyRequirements` (`lib/mockAuth.ts`: `samRegistered`, `uei`, `aorName`/`aorOnFile`, `eBizPocOnFile`) already lets a founder *record* these facts locally; G6's UI (§12) surfaces them as the honest precondition checklist and links to the official portals. The enrollment steps remain a human, org-side responsibility the UI *explains*, never performs.

---

## 6 · The AOR-authorization gate design

### 6.1 What it is (and is not)

The gate is the code embodiment of the memo's "human review-and-attest, human is the AOR" boundary. It is **not** authentication and holds **no credentials**. `AorAuthorization` records *that a named human AOR of the org reviewed the package and attested* — analogous to `AutoApplyRequirements.aorOnFile`, but scoped to one package and timestamped.

`lib/contracts/s2sSubmission.ts`:

```ts
export const AorAuthorizationSchema = z.object({
  org_uei: z.string(),                 // MUST equal pkg.org.uei.value (or the gate refuses)
  aor_name: z.string(),                // self-reported; provenance is user_stated by construction
  attested: z.literal(true),           // an unchecked box is simply the absence of an authorization
  attested_at: z.string().datetime(),
  scope: z.object({ opportunity_id: z.string() }),
  // TRUE only for the mock/demo path. A live/sandbox authorization would carry
  // additional legal-gate provenance out of G6's scope.
  is_demo: z.boolean().default(true),
});
export type AorAuthorization = z.infer<typeof AorAuthorizationSchema>;
```

### 6.2 The gate function (pure, model-free)

`lib/apply/s2s/authorize.ts`:

```ts
export class SubmissionNotAuthorizedError extends Error {}

export interface LegalGate { legalReviewApproved: boolean } // server-only, from a NON-public env var

// Throws unless:
//  (1) authorization parses and authorization.org_uei === pkg.org.uei?.value, and
//  (2) authorization.scope.opportunity_id === pkg.opportunity_id, and
//  (3) authorization.attested === true, and
//  (4) for transportKind !== "mock": gate.legalReviewApproved === true (server-only).
// Returns void on success.
export function assertSubmissionAuthorized(
  pkg: SubmissionPackage,
  authorization: AorAuthorization | null,
  transportKind: TransportKind,
  gate: LegalGate,
): void;
```

- For the **mock** path, clauses (1)–(3) are the whole gate: a demo attestation is required, but no legal gate. This makes the demo honest — you still click "I, the AOR, have reviewed and attest" — without pretending a legal review happened.
- For any **non-mock** path, clause (4) adds the server-only legal gate. Because G6 ships no non-mock transport (FR-5), clause (4) is only reachable via tests with a fake transport — which is exactly how HR-4 is proven.

### 6.3 Where it runs

`submitPackage` (§8) calls `assertSubmissionAuthorized` **before** touching any transport. The UI (§12) will not surface the mock-submit affordance until the attest box is checked, but the gate is the *server-trustable* enforcement — the UI is a courtesy, the gate is the guarantee (mirrors `mockAuth.ts`'s "never gate anything that matters on the UI").

---

## 7 · Data flow (assembled package → XML → transport → response/status)

```
  CompanyProfile ─┐
  ApplicationReqs ─┤   assembleSubmissionPackage()        SubmissionPackage
  ApplicationDraft ┼──▶ (pure; grounding-enforced; ──────▶ (Zod-validated;
  Opportunity     ─┘    gaps not fabrication)              provenance + gaps)
     [G3 formsOverride? / orgOverride?  ── optional seam ─┘]
                                                              │
                                        assertSubmissionAuthorized(pkg, auth, kind, gate)
                                                              │  (throws if unauthorized)
                                                              ▼
                            toGrantApplicationXml(pkg) ──▶ application XML (deterministic)
                                                              │
                              toSoapEnvelope(xml, meta) ──▶ SubmitApplication SOAP envelope
                                                              │
                                        selectTransport(kind) ──▶ MockTransport (only wired)
                                                              │      (sandbox/live → throw)
                                                              ▼
                                               transport.submit(envelope, cfg?)
                                                              │
                                                              ▼
                                    SubmissionReceipt { is_mock:true, tracking_id, status,
                                                        submitted_to:"MOCK", human_note }
                                                              │
                                          (optional) transport.status(tracking_id) ──▶ SubmissionStatus
```

- **One direction, no side effects on the default path** beyond returning the receipt. Nothing is persisted to a federal system; the mock may keep an in-memory record for the demo only.
- **Status** is a mock-only convenience (`RECEIVED` → `VALIDATED` → `MOCK_COMPLETE`), clearly labeled; it never polls a real endpoint.

---

## 8 · Interfaces & Zod contracts

New files (names are normative for the task breakdown):

```
scaffold/lib/contracts/submissionPackage.ts   # SubmissionPackage (the self-contained input)
scaffold/lib/contracts/s2sSubmission.ts        # AorAuthorization, SubmissionReceipt, SubmissionStatus
scaffold/lib/apply/s2s/assemblePackage.ts      # (profile, reqs, draft, opp, opts?) -> SubmissionPackage (pure)
scaffold/lib/apply/s2s/xml.ts                  # toGrantApplicationXml, toSoapEnvelope, escaping, SCHEMA_VERSION
scaffold/lib/apply/s2s/transport.ts            # SubmissionTransport, MockTransport, selectTransport, endpoint guard
scaffold/lib/apply/s2s/authorize.ts            # assertSubmissionAuthorized, SubmissionNotAuthorizedError
scaffold/lib/apply/s2s/config.ts               # OrgS2SConfig, loadOrgS2SConfig (server-only)
scaffold/lib/apply/s2s/client.ts               # submitPackage (the orchestrating adapter)
scaffold/lib/apply/s2s/index.ts                # public barrel for lib/apply/s2s
scaffold/components/S2SSubmissionPanel.tsx     # honest UI (or an extension step inside AutoApplyFlow)
# tests under each dir's __tests__/  (see §15)
```

### 8.1 `SubmissionPackage` (`lib/contracts/submissionPackage.ts`)

**Shared source of truth for both WS-G filing modalities (§1.1).** This one grounded contract is what the browser extension's autofill (modality (a), separate team) *and* G6's S2S XML mapping (modality (b), §9) both consume — the founder's facts are grounded once (in the assembler, T2) and rendered by whichever modality fills the actual forms. Keep it renderer-agnostic: it carries the grounded package + gaps, not any portal-DOM or SOAP detail. Reuses `provenanced(...)` from `lib/contracts/primitives.ts` and the `[founder to provide]` gap idiom from `applicationDraft.ts`.

```ts
import { z } from "zod";
import { provenanced } from "./primitives";
import { FOUNDER_TODO_PATTERN } from "./applicationDraft";

// A gap = a field the package could not ground. Mirrors DraftGap.
export const PackageGapSchema = z.object({
  field_path: z.string(),                              // e.g. "org.uei", "narratives.project_summary"
  field_hint: z.string(),                              // human hint, e.g. "your UEI"
  placeholder: z.string().regex(FOUNDER_TODO_PATTERN), // "[founder to provide: your UEI]"
});

// Org / applicant block — the SUBMITTER is the founder's org, never fundFinder.
// Every value provenanced; anything absent becomes a gap, never a guess.
export const PackageOrgSchema = z.object({
  uei: provenanced(z.string()).optional(),             // from profile.uei
  legal_name: provenanced(z.string()).optional(),      // NOT on the profile today -> typically a gap (see §9 note)
  naics_codes: provenanced(z.array(z.string())).optional(),
  entity_type: provenanced(z.string()).optional(),
  sam_registered: provenanced(z.boolean()).optional(),
  aor_name: provenanced(z.string()).optional(),        // self-reported; used only for the attest record
});

// One narrative carried from a G2 DraftSection (draft_text + claims + gaps preserved).
export const PackageNarrativeSchema = z.object({
  key: z.string(), title: z.string(),
  draft_text: z.string(),                              // may contain inline [founder to provide: …]
  grounded: z.boolean(),                               // true iff the G2 section validated grounded
});

export const SubmissionPackageSchema = z.object({
  opportunity_id: z.string(),
  program_title: z.string(),
  source_label: z.string(),                            // "grants.gov" | "SBIR/STTR" | …
  cfda_number: z.string().optional(),
  competition_id: z.string().optional(),
  org: PackageOrgSchema,
  narratives: z.array(PackageNarrativeSchema).default([]),
  forms: z.array(z.object({ name: z.string(), specified: z.boolean() })).default([]),       // from G1 forms (seam for G3)
  attachments: z.array(z.object({ name: z.string(), specified: z.boolean() })).default([]), // from G1 attachments
  key_dates: z.array(z.object({ label: z.string(), date: z.string() })).default([]),         // from G1 key_dates
  gaps: z.array(PackageGapSchema).default([]),         // THE honesty ledger — everything unground-able lands here
  assembled_at: z.string().datetime(),
});
export type SubmissionPackage = z.infer<typeof SubmissionPackageSchema>;
```

### 8.2 Transport + receipt (`transport.ts`, `s2sSubmission.ts`)

```ts
export type TransportKind = "mock" | "sandbox" | "live";

export const SubmissionReceiptSchema = z.object({
  tracking_id: z.string(),          // MOCK-XXXX format for the mock
  status: z.enum(["RECEIVED", "VALIDATED", "MOCK_COMPLETE", "REJECTED"]),
  is_mock: z.literal(true),         // G6 only ever produces mock receipts
  submitted_to: z.literal("MOCK"),  // never a real system label in G6
  human_note: z.string(),           // "MOCK — nothing was submitted to any federal system."
  received_at: z.string().datetime(),
});
export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

export interface SubmissionTransport {
  readonly kind: TransportKind;
  submit(envelope: string, cfg?: OrgS2SConfig | null): Promise<SubmissionReceipt>;
  status?(trackingId: string): Promise<SubmissionStatus>;
}

export class MockTransport implements SubmissionTransport { readonly kind = "mock"; /* …in-memory… */ }
export class TransportNotAvailableError extends Error {}
export class ProductionEndpointRefusedError extends Error {}

export function assertNonProductionEndpoint(url: string): void; // default-deny; only sandbox hosts pass
export function selectTransport(kind: TransportKind, cfg?: OrgS2SConfig | null): SubmissionTransport; // mock only; else throw
```

### 8.3 The assembler and client (signatures)

```ts
// lib/apply/s2s/assemblePackage.ts  (PURE, model-free; the analogue of enforceGrounding)
export interface AssembleOptions {
  now?: () => string;                 // injectable clock for deterministic tests
  formsOverride?: { name: string; specified: boolean }[];        // G3 seam
  orgOverride?: Partial<z.infer<typeof PackageOrgSchema>>;       // G3/G5 seam
}
export function assembleSubmissionPackage(
  profile: CompanyProfile,
  requirements: ApplicationRequirements,
  draft: ApplicationDraft,
  opportunity: Opportunity,
  opts?: AssembleOptions,
): SubmissionPackage;   // throws only on a banned-phrase (HR-2); missing facts -> gaps (HR-1)

// lib/apply/s2s/client.ts  (the orchestrating adapter)
export interface SubmitOptions {
  transportKind?: TransportKind;      // default "mock"
  authorization: AorAuthorization | null;
  legalGate?: LegalGate;              // default { legalReviewApproved: false }
  configOverride?: Partial<Record<FlagName, string | undefined>>; // test seam for the flag
}
export async function submitPackage(pkg: SubmissionPackage, opts: SubmitOptions): Promise<SubmissionReceipt>;
// Order: 1) isFlagEnabled("g6_s2s_submission") else throw;
//        2) assertSubmissionAuthorized(...) else throw;
//        3) toGrantApplicationXml -> toSoapEnvelope;
//        4) selectTransport(kind) (mock only) -> submit; return receipt.
```

---

## 9 · The grants.gov submission-format (XML) mapping approach

**Framing (memo §2, re-verify gate):** grants.gov submission is a *legacy SOAP/XML* interface. The structure below is the **documented shape as of the memo's Aug-2026 retrieval window, treated as re-verify-required** — it is pinned behind a `SCHEMA_VERSION` constant and a versioned mapper so a schema change is contained, and **no live path may use it until it is re-verified against the current official grants.gov Forms Repository / S2S WSDLs.** G6 emits it only into the mock transport, so a stale schema has zero live consequence.

### 9.1 High-level structure

The `SubmitApplication` (and third-party `Submit Application As Third Party [Expanded]`) operation carries a **grant application XML** inside a SOAP envelope, with attachments as MTOM/XOP binary parts:

- **SOAP envelope** — `soap:Envelope` › `soap:Body` › `SubmitApplicationRequest` (namespace + operation names are re-verify-required). For the third-party variants an `AuthenticateAOR`-derived token would precede it — **G6 never builds this branch** (NG-1).
- **Grant application XML** (the payload G6 maps to):
  - `header:GrantSubmissionHeader` — `Grants.gov` tracking metadata: `OpportunityID` (`opportunity_id`), `CFDANumber` (`cfda_number`), `CompetitionID` (`competition_id`), `SubmissionTitle` (`program_title`), schema version.
  - **Forms** — each required form in its own namespace/version (SF-424 family, program forms). G6 maps only what it *has*: from G1 `forms` it emits a **form manifest** (form name + `specified`), and from the org block + narratives it fills the fields it can ground. **Fields it cannot ground are emitted as gap markers, never fabricated** (HR-1). Full SF-424 field-level population is the **G3 seam** (`formsOverride`).
  - `footer:GrantSubmissionFooter` — attachment hash/count summary (over the *mock* attachment set in G6).
  - **Attachments** — from G1 `attachments`, referenced by name; binary content is out of G6's scope (the founder attaches real files at their portal). G6 emits attachment *references/placeholders* only.

### 9.2 Determinism, escaping, gap-preservation

- Pure string construction (no XML lib dependency required; a tiny escaper handles `& < > " '`). Deterministic field ordering (stable object-key iteration) so snapshots are stable.
- Every `SubmissionPackage.gaps[i]` and every inline `[founder to provide: …]` in a narrative is rendered as an **explicit, visible XML comment/marker** (e.g. `<!-- GAP: founder to provide your UEI -->`) rather than an empty-but-plausible value — so a human reviewer (the AOR) sees exactly what is unfilled. This is the XML-layer expression of HR-1.
- `SCHEMA_VERSION = "grants.gov-apply/UNVERIFIED-2026-08"` (a deliberately honest, non-authoritative tag) plus a header doc block naming the memo's re-verify requirement.

### 9.3 Note on the record's available text

`Opportunity` carries `source_id`, `title`, `program`, `agency`, `key_dates`, `award_range`, and (via G1) the extracted requirements. **`cfda_number`/`competition_id` are not guaranteed on the record** — when absent they become gaps, not invented numbers. `PackageOrg.legal_name` is **not** a `CompanyProfile` field today, so it is *typically a gap* — flagged for the founder, never guessed (documented in §5.3 and asserted in tests).

---

## 10 · Honesty / legal boundaries (non-negotiable — enforced, not aspirational)

1. **Never a tool that "submits on its own."** Default posture = the memo's thin slice: build the package, human review-and-attest, human AOR submits in their own session. Encoded as: no `LiveTransport` (FR-5), the AOR gate (§6), the mock-only receipt (§8.2). *(HR-3, HR-4.)*
2. **Any automated live-submission capability ships OFF** behind **all four** of: default-OFF `g6_s2s_submission` flag **+** server-only legal-review gate **+** recorded per-org `AorAuthorization` **+** non-production endpoint. In G6 the first three are wired but the fourth plus a live transport are absent, so the capability *cannot* fire. *(HR-4.)*
3. **Never handle real credentials on the default path.** Mock needs none. `OrgS2SConfig` is org-supplied, sandbox-host-only, server-only, and `null` by default; it holds a cert *reference*, never a secret value, and the mock never reads it. *(HR-5, NG-3, E2.)*
4. **Preserve grounding/anti-fabrication.** Every value traces to a profile field / G2 draft or is a `[founder to provide]` gap; never a definitive eligibility/award claim (`findBannedPhrases`); never claims to have submitted or won. *(HR-1, HR-2, HR-3.)*
5. **fundFinder is never the AOR/E-Biz POC.** The submitter modeled in the package is the founder's org; UI says "hand to your AOR." *(NG-5, E3.)*
6. **Escalations E1–E6 stay open.** No G6 task pursues PMO designation (E1), stores AOR credentials (E2), makes fundFinder the AOR (E3), resolves the prefill-liability question (E4), assumes DSIP's model (E5), or assumes an NSF/DSIP submission API (E6). G6 is grants.gov-shaped and mock-only. *(HR-6.)*
7. **Untrusted input discipline.** NOFO/form/opportunity text is DATA, never instructions; it may fill a gap-marked field, never drive an action (memo §7 last bullet). G1/G2 already wrap untrusted input; G6 consumes their *validated* output, so it inherits this.

---

## 11 · Default-OFF flag + honest UI labeling plan

### 11.1 The flag (exact three-place pattern)

Add `g6_s2s_submission` in **three** places, matching the existing convention:

1. **`lib/flags/registry.ts`** — add `"g6_s2s_submission"` to the `FlagName` union **and** a `FLAG_REGISTRY` entry:
   ```ts
   g6_s2s_submission: {
     name: "g6_s2s_submission",
     requirement: "G6",
     description:
       "S2S submission integration (package builder → grants.gov XML mapping → " +
       "MOCK transport). Demo/preview only; never submits to any federal system, " +
       "gates nothing server-side, handles no credentials.",
     envVar: "NEXT_PUBLIC_FLAG_G6_S2S_SUBMISSION",
   },
   ```
2. **`lib/flags/env.ts`** — add the **static** line to `readRawOverrides`:
   `g6_s2s_submission: process.env.NEXT_PUBLIC_FLAG_G6_S2S_SUBMISSION,` (static member expression — never a computed lookup, per the file's own warning).
3. **`lib/flags/__tests__/registry.test.ts`** — add `"g6_s2s_submission"` to the exhaustive `expected: FlagName[]` array (the `deepEqual` assertion fails otherwise).

Default OFF holds by construction (`FLAG_DEFAULT = false`). The env var is `NEXT_PUBLIC_` (UI-visibility gate only — it never gates credentials, which are server-only per §5.2).

### 11.2 Honest UI labeling

Extend the existing R6 flow rather than fork it. `S2SSubmissionPanel.tsx` (rendered as an added step in `AutoApplyFlow.tsx`, itself behind `r6_auto_apply`, and the new step additionally behind `g6_s2s_submission`):

- **Step: "Prepare submission package."** Builds the package from the founder's profile + the selected opportunity's G1/G2 output. Renders **every field with its provenance** and **every gap** (`[founder to provide: …]`) prominently. Honest empty-state when G1/G2 haven't run.
- **Step: "Review & attest (you are the AOR)."** The human checks *"I am the Authorized Organization Representative for this organization, I have reviewed every field above, and I attest to its accuracy."* This produces the `AorAuthorization` (`is_demo: true`). Copy names 18 U.S.C. §1001 in plain language (memo §6) — attestation is a legal act.
- **Step: "Submit (MOCK)."** Only enabled after attest. Runs `submitPackage` with the **mock** transport. Shows the receipt with a **bold, unmissable "MOCK — nothing was submitted to any federal system. To actually apply, sign in to grants.gov yourself as your organization's AOR and submit there."** plus a deep link to the official portal.
- **Never** renders: "we submitted," "you're eligible," "guaranteed," "you will be awarded," a fake tracking number styled as real, or any fundFinder-as-filer language.
- **Design gates:** all colors via existing design tokens (no raw hex — `check:hex`); all text meets contrast (`check:contrast`). Reuse `AutoApplyFlow`'s USWDS 60/30/10 styling. No inline `system:` model prompt strings anywhere (`check:prompts`).

---

## 12 · Task breakdown (PR-sized; dispatcher sequences worktrees from this)

Dependency graph (one fork, one join, then a chain):
```
        ┌─ T2 (assembler) ─┐
T1 (contracts+flag) ┤                  ├─ T4 (client+transport+gate+config) ─ T5 (UI) ─ T6 (honesty eval)
        └─ T3 (XML mapping) ┘
```
Each task passes **all five gates as a unit** (`typecheck` · `test` · `build` · `check:hex` · `check:contrast`), plus `check:prompts` where noted. G6 is deterministic, so `check:prompts` is a **trivial pass** for T1–T4 and T6 (no model calls, no registered prompts); it is *materially relevant* only to T5 (UI copy must contain no `BANNED_PHRASES`).

---

### T1 — Submission contracts + `g6_s2s_submission` flag (FOUNDATION)

- **Goal:** Land the self-contained `SubmissionPackage`, `AorAuthorization`, `SubmissionReceipt`/`SubmissionStatus` Zod contracts and the default-OFF flag. Keep `SubmissionPackage` **renderer-agnostic** — it is the shared source of truth both WS-G filing modalities consume (§1.1): the browser extension's autofill *and* G6's S2S XML mapping.
- **Inputs:** `lib/contracts/{primitives,companyProfile,applicationRequirements,applicationDraft,opportunity}.ts`; `lib/flags/{registry,env}.ts` + `lib/flags/__tests__/registry.test.ts`.
- **Files:** create `lib/contracts/submissionPackage.ts`, `lib/contracts/s2sSubmission.ts`, `lib/contracts/__tests__/submissionPackage.test.ts`, `lib/contracts/__tests__/s2sSubmission.test.ts`; edit `lib/flags/registry.ts`, `lib/flags/env.ts`, `lib/flags/__tests__/registry.test.ts`.
- **Acceptance (testable):** (a) `SubmissionPackageSchema.parse` accepts a well-formed package and `safeParse` rejects a malformed one (missing `org`, bad gap placeholder); (b) `AorAuthorizationSchema` requires `attested: true` and rejects `attested: false`; (c) `SubmissionReceiptSchema` requires `is_mock: true` + `submitted_to: "MOCK"`; (d) `isFlagEnabled("g6_s2s_submission") === false` with no env; `=== true` when `NEXT_PUBLIC_FLAG_G6_S2S_SUBMISSION=true`; (e) `registry.test.ts`'s exhaustive `expected` array includes the new flag and `deepEqual` passes; (f) every env var still unique + `NEXT_PUBLIC_`-prefixed.
- **Gates:** typecheck · test · build · check:hex · check:contrast. (`check:prompts` trivial.)
- **Model:** opus (contract design is load-bearing for every downstream task).
- **Deps / sequencing:** none. **PARALLEL off `origin/main`** (the root; nothing else can start until it merges).

---

### T2 — Package assembler (profile + G1 + G2 → SubmissionPackage)

- **Goal:** Pure, model-free `assembleSubmissionPackage(...)` with grounding enforcement (missing → gap, never fabricate) — the analogue of G2's `enforceGrounding`.
- **Inputs:** T1's `submissionPackage.ts`; `lib/apply/draft.ts` (`enforceGrounding`, `FOUNDER_TODO_PATTERN`, `providedProfileFields`), `lib/contracts/companyProfile.ts` (`isFieldProvided`, `PROFILE_FIELD_META`, `provenanced`), G1/G2 contracts, `scripts/check-prompt-registry.mjs` (`findBannedPhrases`, imported exactly as `draft.ts` does).
- **Files:** create `lib/apply/s2s/assemblePackage.ts`, `lib/apply/s2s/index.ts` (barrel), `lib/apply/s2s/__tests__/assemblePackage.test.ts`.
- **Acceptance (testable):** (a) a fully-provided profile → package with zero `org` gaps; (b) a profile missing `uei` → an `org.uei` **gap** with a valid `[founder to provide: your UEI]` placeholder, and **no** fabricated identifier; (c) `legal_name` (not a profile field) is always a gap; (d) a banned phrase in an input narrative → **throws** (mirror `DraftGroundingError`); (e) deterministic: identical inputs (fixed injected clock) → deep-equal output; (f) `formsOverride`/`orgOverride` merge over and absent overrides are no-ops (FR-10); (g) output passes `SubmissionPackageSchema.parse`.
- **Gates:** typecheck · test · build · check:hex · check:contrast. (`check:prompts` trivial — no model call.)
- **Model:** opus (grounding logic is honesty-critical).
- **Deps / sequencing:** **STACKS on T1.** Runs **PARALLEL with T3** (both need only T1).

---

### T3 — grants.gov submission-format (XML + SOAP) mapping

- **Goal:** Deterministic, gap-preserving `toGrantApplicationXml(pkg)` + `toSoapEnvelope(xml, meta)`, version-pinned, with the memo's re-verify doc block.
- **Inputs:** T1's `submissionPackage.ts`; memo §2/§9 for the structural shape; no network, no XML library required.
- **Files:** create `lib/apply/s2s/xml.ts`, `lib/apply/s2s/__tests__/xml.test.ts`.
- **Acceptance (testable):** (a) output is well-formed and parseable; (b) `& < > " '` in any field are escaped; (c) each `pkg.gaps[i]` and each inline `[founder to provide: …]` renders as a **visible gap marker/comment**, never an empty plausible value; (d) missing `cfda_number`/`competition_id` → gap markers, not invented values; (e) stable structure snapshot across runs (deterministic ordering); (f) `SCHEMA_VERSION` constant present and the header doc block names the re-verify requirement and cites memo §2; (g) contains **no** production endpoint/URL and **no** third-party-submit operation name (HR-6 grep-style assertion).
- **Gates:** typecheck · test · build · check:hex · check:contrast. (`check:prompts` trivial.)
- **Model:** opus (schema-mapping precision + honest gap rendering).
- **Deps / sequencing:** **STACKS on T1.** Runs **PARALLEL with T2**.

---

### T4 — S2S client + pluggable transport + mock + endpoint guard + config + AOR gate

- **Goal:** The typed integration adapter: `SubmissionTransport` interface, `MockTransport`, `selectTransport`, `assertNonProductionEndpoint`, `OrgS2SConfig`/`loadOrgS2SConfig`, `assertSubmissionAuthorized`, and the `submitPackage` orchestrator wired to **mock only**.
- **Inputs:** T1 (contracts), T2 (assembler — for the e2e test fixture), T3 (`toGrantApplicationXml`/`toSoapEnvelope`); `lib/flags` (`isFlagEnabled`, `FlagName`).
- **Files:** create `lib/apply/s2s/transport.ts`, `lib/apply/s2s/authorize.ts`, `lib/apply/s2s/config.ts`, `lib/apply/s2s/client.ts`, and `lib/apply/s2s/__tests__/{transport,authorize,config,client}.test.ts`; extend `lib/apply/s2s/index.ts`.
- **Acceptance (testable):** (a) `MockTransport.submit` → receipt with `is_mock: true`, `submitted_to: "MOCK"`, the mock human_note; (b) `selectTransport("mock")` returns it; `selectTransport("sandbox"|"live")` **throws `TransportNotAvailableError`** (FR-5); (c) `assertNonProductionEndpoint` throws for `*.grants.gov` production + unknown hosts (default-deny), passes only sandbox hosts (FR-6); (d) `loadOrgS2SConfig` returns `null` with no env, and **throws** if given a production endpoint; (e) `assertSubmissionAuthorized`: throws for `null` authorization, for org-UEI mismatch, for opportunity-id mismatch; passes for a valid mock authorization; throws for a non-mock kind unless `legalReviewApproved` (§6.4); (f) `submitPackage` throws when the flag is OFF; with the flag ON (via `configOverride`) + valid authorization + mock transport, returns a labeled receipt (FR-8); (g) HR-4 driver: no combination of inputs makes `submitPackage` reach a non-mock transport.
- **Gates:** typecheck · test · build · check:hex · check:contrast. (`check:prompts` trivial.)
- **Model:** opus (the gate/guard/transport is the safety core).
- **Deps / sequencing:** **STACKS on T2 AND T3** (branch after both merge — this is the single join point). By construction its lineage already contains T1.

---

### T5 — Honest UI / assisted-filing flow (behind `g6_s2s_submission`)

- **Goal:** The "prepare package → review & attest → submit (MOCK)" UI, extending `AutoApplyFlow`, with honest labeling.
- **Inputs:** T4 (`submitPackage`, `assembleSubmissionPackage`, contracts); `components/AutoApplyFlow.tsx`, `components/ApplicationChecklist.tsx`, `lib/mockAuth.ts` (`getAutoApplyRequirements`), `lib/flags` (`isFlagEnabled`); existing design tokens.
- **Files:** create `components/S2SSubmissionPanel.tsx` + `components/__tests__/S2SSubmissionPanel.test.tsx`; edit `components/AutoApplyFlow.tsx` (add the step, gated behind `g6_s2s_submission`).
- **Acceptance (testable):** (a) with the flag OFF, the new step does not render and `AutoApplyFlow` behaves exactly as on `origin/main` (regression); (b) with the flag ON, the package view shows provenance per field and lists gaps; (c) the mock-submit affordance is disabled until the attest box is checked; (d) the receipt view shows the "MOCK — nothing was submitted…" note + an official-portal deep link; (e) copy contains **no** `BANNED_PHRASES` (assert via `findBannedPhrases` over the rendered strings) and no fundFinder-as-filer language; (f) `check:hex` (no raw hex) and `check:contrast` pass.
- **Gates:** typecheck · test · build · check:hex · check:contrast · **check:prompts** (materially relevant here — the only task where UI copy could trip a banned phrase; keep copy clean and add no inline model `system:` strings).
- **Model:** sonnet (UI assembly over a fixed, well-specified contract).
- **Deps / sequencing:** **STACKS on T4.**

---

### T6 — Integration + honesty eval (CAPSTONE)

- **Goal:** Cross-cutting end-to-end + honesty invariant tests (the G6 analogue of G7's application honesty eval): assemble → authorize → map → mock-submit → receipt on golden fixtures, plus the "no live path" proof.
- **Inputs:** all of T1–T5.
- **Files:** create `lib/apply/s2s/__tests__/integration.honesty.test.ts` (and, if useful, a small golden-fixtures module under `lib/apply/s2s/__tests__/fixtures/`).
- **Acceptance (testable):** (a) **HR-4 invariant:** parametrized over `{flag on/off} × {authorized/not} × {kind mock/sandbox/live}`, the only non-throwing outcome is `{flag on, authorized, mock}` → labeled mock receipt; every other cell throws — and **no cell performs a network call** (assert via a transport spy that no non-mock transport is constructed); (b) **HR-1 preserved e2e:** a sparse profile flows through assemble→XML with gaps intact and zero fabricated values; (c) **HR-3:** every receipt in every passing case has `is_mock: true` + the mock note; (d) **HR-6:** a source-scan test asserts the wired `lib/apply/s2s` path contains no third-party-submit operation name and no production grants.gov host; (e) **HR-2:** a banned-phrase input is refused end-to-end.
- **Gates:** typecheck · test · build · check:hex · check:contrast. (`check:prompts` trivial.)
- **Model:** sonnet (test authoring against a frozen contract).
- **Deps / sequencing:** **STACKS on T5.**

**Sequencing summary for the dispatcher:** merge order `T1 → (T2 ∥ T3) → T4 → T5 → T6`. Only T2 and T3 run concurrently; T4 is the join (branch it after both T2 and T3 are merged). T1 must land before anything; T6 is last.

---

## 13 · Risks & mitigations

- **R-1 — Scope creep toward a live path.** *Mitigation:* no `LiveTransport` symbol exists (FR-5); the endpoint guard is default-deny (FR-6); HR-4/HR-6 tests fail if a non-mock/production path appears. E1/E2 stay open (§11).
- **R-2 — Stale grants.gov schema (the format is a moving target — memo §2).** *Mitigation:* `SCHEMA_VERSION="…UNVERIFIED…"`, versioned mapper, re-verify doc block; mock-only so a stale schema has no live consequence.
- **R-3 — Credential leakage.** *Mitigation:* mock needs none; `OrgS2SConfig` is server-only, sandbox-host-only, holds a cert *reference* not a secret, is `null` by default, and the mock never reads it (HR-5).
- **R-4 — Fabricated package fields (E4 liability).** *Mitigation:* grounding-enforced assembler → gaps not guesses (HR-1); provenance per field; XML gap markers; `findBannedPhrases` refusal (HR-2).
- **R-5 — Dependency on unmerged G3/G5.** *Mitigation:* self-contained contract + `formsOverride`/`orgOverride` seams (FR-10, NG-6); `legal_name` gap documented.
- **R-6 — Flag-registry exhaustive test breaks the build.** *Mitigation:* T1 updates `expected: FlagName[]` (explicit acceptance).
- **R-7 — UI copy trips a banned phrase or fundFinder-as-filer framing.** *Mitigation:* T5 runs `check:prompts` + a `findBannedPhrases` UI test; copy reviewed against §11.2.
- **R-8 — Judges/users mistake the mock for a real submission.** *Mitigation:* unmissable MOCK labeling on every receipt/step; default-OFF so it is never the judged surface (§3.2).

---

## 14 · Test strategy

- **Hermetic, static, no network, no model** — mirror G1/G2 tests (`node:test` + `assert/strict`, static fixtures). Every G6 test runs offline.
- **Unit — XML mapping (T3):** structure snapshot, escaping, gap-marker rendering, `SCHEMA_VERSION`, no-production-host scan.
- **Unit — schema round-trips (T1):** accept well-formed / reject malformed for `SubmissionPackage`, `AorAuthorization` (`attested` literal), `SubmissionReceipt` (`is_mock` literal).
- **Unit — grounding (T2):** missing fields → gaps, never fabricated; banned phrase → throw; determinism; override seams.
- **Unit — AOR gate (T4):** refuses without authorization / on UEI or opportunity mismatch; requires legal gate for non-mock; passes for valid mock authorization.
- **Unit — transport/guard/config (T4):** mock receipt labeling; `selectTransport` throws for sandbox/live; endpoint guard default-deny; `loadOrgS2SConfig` null-by-default + production-throw.
- **Honesty invariant (T4 + T6):** *no live-submit without flag + gate* — parametrized proof that the only non-throwing path is `{flag on, authorized, mock}`, and that no cell performs a network call.
- **Grounding-preserved e2e (T6):** sparse profile → assemble → XML with gaps intact, zero fabrication.
- **UI regression + honesty (T5):** flag-off renders the pre-G6 `AutoApplyFlow` unchanged; flag-on surfaces provenance/gaps; attest-gated mock submit; MOCK label present; `findBannedPhrases([UI copy]) === []`.

---

## 15 · Traceability matrix (constraint → enforcement → test)

| Constraint (source) | Enforced by | Test |
|---|---|---|
| Never submits on its own (memo §7, E1) | no `LiveTransport`; AOR gate; mock receipt | T4 (FR-5), T6 (HR-4) |
| Live capability needs flag+gate+authorization+non-prod (task) | `submitPackage` order; `assertSubmissionAuthorized`; endpoint guard | T4 (a,e,f,g), T6 (a) |
| No real credentials on default path (memo §7, E2) | mock needs none; `OrgS2SConfig` null/server-only/ref-not-secret | T4 (d), HR-5 |
| fundFinder ≠ AOR/E-Biz POC (memo §3, E3) | package models the org as submitter; UI "hand to your AOR" | T5 (e) |
| Grounding / no fabricated founder facts (northstar, R7.7, brief) | assembler gaps; provenance; XML gap markers | T2 (b,c), T3 (c,d), T6 (b) |
| Never eligibility/award/guarantee/submission claim (brief, R7.7) | `findBannedPhrases` refusal; `is_mock`/MOCK note | T2 (d), T5 (e), T6 (c,e) |
| Escalations E1–E6 stay open (task) | no PMO/third-party-submit/credential symbols in the wired path | T3 (g), T6 (d), HR-6 |
| Default-OFF flag, three-place pattern (gap-plan §1.6) | `registry.ts`+`env.ts`+`registry.test.ts` | T1 (d,e,f) |
| Schema re-verify before any live path (memo §2) | `SCHEMA_VERSION` UNVERIFIED + doc block | T3 (f) |
| No hard dep on G3/G5 (task) | self-contained contract + override seams | T2 (f), FR-10 |

---

## 16 · Revision / critique log

Three self-critique passes were run before converging (per method step 4):

- **v1 → v2 (completeness).** v1 under-specified the *self-contained* input contract and implied G6 could lean on G3's SF-424 forms. Fixed: added `SubmissionPackage` as a first-class contract populated purely from `origin/main` sources, with `formsOverride`/`orgOverride` seams (FR-10, NG-6); documented that `legal_name`/`cfda_number`/`competition_id` are typically gaps (§9.3). Added the exhaustive-`FlagName`-array acceptance to T1 after confirming `registry.test.ts` uses `deepEqual` on an explicit list.
- **v2 → v3 (feasibility).** v2 risked an over-large "adapter" task and a diamond dependency (UI needing both assembler and client). Fixed: split into six PR-sized tasks with a single join (T4 stacks on T2 **and** T3) so the graph is a fork-then-chain the dispatcher can sequence cleanly; pinned exact existing symbols/files per task so workers need no clarification; confirmed the `tsx` test glob covers `lib/apply/s2s/__tests__/`; confirmed `check:prompts` is trivial for deterministic tasks (no model calls / no registered prompts) and material only to T5.
- **v3 (honesty / legal boundaries).** Tightened the boundary so G6 *cannot* reach a live path, not merely *should not*: no `LiveTransport` shipped (FR-5), default-deny endpoint guard (FR-6), `OrgS2SConfig` holds a cert *reference* not a secret and is server-only + null-by-default (HR-5), `AorAuthorization` holds an attestation not a credential (§6.1), and the HR-4/HR-6 invariant tests fail if any non-mock/production/third-party symbol enters the wired path. Verified against the memo that every escalation E1–E6 stays open (§11) and against the brief that "complete application system" / "guarantee eligibility" remain out of scope with G6 positioned as a default-OFF, post-hackathon increment (§3.2). Confirmed no contradiction with the memo's recommendation: G6 *is* the thin slice, with a mock rail added for demoability.
