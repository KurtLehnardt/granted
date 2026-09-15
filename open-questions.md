# Open Questions — need user/orchestrator input

<!-- ====== Grant Auto-Fill Chrome Extension (MV3) — Phase-1/2 blockers (2026-08-16) ====== -->

## Browser recon tooling unavailable → NO live selectors captured (needs in-session pass)
Phase-1 portal recon could not capture any real DOM selectors: the Playwright browser
bridge was unavailable this session — every `browser_navigate` failed with
`Extension connection timeout: Make sure the "Playwright MCP Bridge" extension is installed`
(confirmed by the recon worker AND independently by the dispatcher). Recon fell back to
text-content fetches, so the field map
(`docs/grant-portal-field-map.md`) is honest but selector-free: the SF-424 canonical field
table (boxes 1–21 → package keys) is documented from the public OMB 4040-0004 form structure,
and **every selector is a `TODO: in-session selector capture` placeholder — none fabricated.**

Impact on the build: the extension ships with four seed portal configs whose selectors are all
`TODO`. The runtime resolver treats `TODO` as absent, so v0.1 degrades gracefully (imports a
package, fills 0 fields, flags everything "unmapped") until real selectors are added — this is
enforced invariant INV-9 in `docs/grant-autofill-extension-spec.md`. **No code change is needed
to add selectors later; they are data in the config files.**

**ACTION NEEDED (YOUR action — a human, later):** run an in-session selector-capture pass with
working browser tooling, logged into your OWN portal accounts (grants.gov Workspace,
Research.gov, NIH ASSIST, SBIR.gov), to replace the `TODO` selectors with real `id`/`name`/
`aria`/label strings. The extension README documents the exact procedure. Nothing about the
honesty/security boundary changes — this is purely populating the selector data.

## Portals that are fully / mostly auth-gated (real fill-target fields behind login)
Captured in `docs/grant-portal-field-map.md`; flagged here for the in-session pass priority:
- **NIH ASSIST — FULLY auth-gated.** `https://public.era.nih.gov/assist/` IS the login screen;
  zero application content is public. Highest-priority for in-session capture (nothing else is
  knowable without a logged-in eRA Commons/Login.gov account + mandatory 2FA).
- **Grants.gov Workspace — auth-gated.** The public site is informational only; every SF-424
  data-entry field, the section Next/Save controls, and the Sign-&-Submit control live inside the
  authenticated Workspace (Login.gov-backed).
- **Research.gov — auth-gated.** Proposal-prep fields sit behind "Prepare & Submit Proposals"
  (NSF account). Exact gate-trigger click not traced this pass.
- **SBIR.gov — partially public.** Only the public topic-SEARCH form was reachable (not a fill
  target); company registration / application fields are behind Register/Login.

## Grants.gov Workspace exact host unconfirmed (least-privilege manifest)
The MV3 manifest scopes `host_permissions` to specific portal hosts (no `<all_urls>`). The exact
authenticated Workspace host could not be confirmed without login; `apply07.grants.gov` is
included as the current best guess, flagged `CONFIRM`. Verify the real Workspace host during the
in-session pass and narrow before any Chrome Web Store submission. A `https://*.grants.gov/*`
wildcard is documented as an interim-only fallback, never the shipped default.

## DSIP (DoD SBIR/STTR) deferred from v0.1
`www.dodsbirsttr.mil` is out of scope for extension v0.1 — R6 memo escalation E5 flags its
auth/role model as unverified from a primary source. Adding it later = one manifest host pattern
+ one declarative config, no code change.
