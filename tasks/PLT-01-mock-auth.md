# PLT-01 — R9.0 mock auth + consent + local-only persistence

**Team:** Platform
**Release slice:** 2
**Depends on:** CON-03 (flags — `r9_0_mockauth` already maps `NEXT_PUBLIC_MOCK_AUTH`)
**Blocks:** none (independent)

## Context
R9.0: an interim, **client-side-only** mocked Google sign-in backed by `localStorage` — a UI state
machine that **gates nothing** (no paid feature, private data, or API access conditioned on it),
env-flagged so it can't silently reach production, removed at R9. **The implementation already
exists** in `<repo-root>/prompts/mock-auth-bundle.md` (5 files). **Move them
in per that bundle's README — do NOT re-implement from prose** (the code is more specific than R9.0's
prose; re-implementing drifts).

## Files in scope
- From the bundle → `scaffold/lib/mockAuth.ts`, `scaffold/components/AuthProvider.tsx`,
  `AuthGuard.tsx`, `UserMenu.tsx`, `scaffold/app/login/page.tsx`.
- Wire `AuthProvider` into `scaffold/app/layout.tsx`.
- Add the **consent control** + a **"Delete my data"** control near the description input
  (`app/page.tsx` / `IntakeForm.tsx`).
- `.env.example` / flag: `NEXT_PUBLIC_MOCK_AUTH` (via the CON-03 `r9_0_mockauth` flag).

## Definition of done
- [ ] Bundle files placed verbatim; `AuthProvider` wraps the app; the `/login → / → log out` loop works.
- [ ] **Gates nothing** — no server-side check reads the mock (PLT-02 will assert this; do not add any).
- [ ] Env-flagged off by default (`NEXT_PUBLIC_MOCK_AUTH`); flag off → v1 path unchanged.
- [ ] **Consent control at the input**: plain language, defaulted **off**, timestamped record, revocable.
- [ ] **"Delete my data"** clears local storage (`clearAllLocalData()`).
- [ ] Storage failure (Safari private mode) degrades to signed-out, not a white screen.
- [ ] Provider interface (`user`, `loading`, `signIn`, `signOut`) matches what real OAuth will implement (R9 swap).
- [ ] `tsc` + `build` green.

## Out of scope
Real Google OAuth (R9/slice 6), server-side persistence, the no-server-retention recon test (PLT-02),
entitlement enforcement, run storage.

## Escalate if (§8.3)
- Wiring would require a server-side check of the mock (it must NEVER gate server-side) → stop, report.
