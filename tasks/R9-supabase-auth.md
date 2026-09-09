# R9 — Real Supabase Auth (drop-in for the R9.0 mock)

**Team:** Platform
**Release slice:** R9 (accounts) — auth only; persistence/billing out of scope
**Depends on:** PLT-01 mock auth (`components/AuthProvider.tsx`, `lib/mockAuth.ts`), CON-03 flags (`lib/flags`)
**Blocks:** R6 assisted-apply flow (chains off the real sign-in)

## Context
PLT-01 shipped a localStorage-backed **mock** Google sign-in (R9.0) behind the `r9_0_mockauth`
flag. Its React layer, `components/AuthProvider.tsx`, exposes a stable context
`{ user, loading, consent, signIn, signOut, setConsent }` that every auth surface reads
(`app/login/page.tsx`, `components/AppMenu.tsx`, `UserMenu.tsx`, `AuthGuard.tsx`,
`IntakeForm.tsx`). R9 replaces the *auth half* of that with **real Supabase Auth + Google OAuth**,
behind a NEW default-off flag `r9_supabase_auth`, as a genuine **drop-in**: the context interface
does not change, so no surface needs to be rewritten. Flag ON → real Supabase; flag OFF → today's
mock path, byte-for-byte unchanged. Consent + "Delete my data" (§5.3) stay localStorage-backed in
both modes.

Supabase project: `YOUR_SUPABASE_REF` (URL `https://YOUR_SUPABASE_REF.supabase.co`).

## Files in scope
- `scaffold/lib/flags/registry.ts` — add the `r9_supabase_auth` flag
- `scaffold/lib/flags/env.ts` — add its static `process.env` read
- `scaffold/lib/flags/__tests__/registry.test.ts` — add `r9_supabase_auth` to the `expected` list (the `deepEqual` test WILL fail otherwise)
- `scaffold/components/AuthProvider.tsx` — the drop-in: pick backend by flag
- `scaffold/components/AppMenu.tsx` — show the sign-in surface when EITHER auth flag is on
- `scaffold/app/login/page.tsx` — real Google OAuth path + honest copy when real auth is on
- `scaffold/lib/supabase/client.ts` (NEW) — browser client via `@supabase/ssr`
- `scaffold/lib/supabase/server.ts` (NEW) — server client for the OAuth callback
- `scaffold/app/auth/callback/route.ts` (NEW) — OAuth code→session exchange
- `scaffold/middleware.ts` (NEW, OPTIONAL) — session refresh ONLY; must gate nothing
- `scaffold/package.json` + `scaffold/package-lock.json` — add `@supabase/supabase-js`, `@supabase/ssr`
- `scaffold/.env.example` — add the Supabase vars (see constraints)
- `tasks/R9-supabase-auth.md` (this file)

Do not modify any other file. In particular DO NOT touch `lib/mockAuth.ts` (the mock path must
stay intact) or any other flag. Do not edit `IntakeForm.tsx` — its consent/delete controls read
the unchanged context and must keep working as-is.

## Definition of done
- [ ] New flag `r9_supabase_auth` registered: literal added to `FlagName`, a `FlagDefinition`
      entry in `FLAG_REGISTRY` (requirement `"R9"`, envVar `"NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH"`,
      one-line description), and a matching **static** line in `env.ts`
      (`r9_supabase_auth: process.env.NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH`). Default OFF (rely on the
      universal `FLAG_DEFAULT = false`; do not special-case it).
- [ ] `lib/flags/__tests__/registry.test.ts` `expected` array includes `r9_supabase_auth`; all flag
      tests pass.
- [ ] `AuthProvider` is a **true drop-in**: the exported context type and shape
      (`{ user, loading, consent, signIn, signOut, setConsent }`) are UNCHANGED, and `user` stays
      assignable to the existing `MockUser`-shaped type (`{ id, name, email, avatarUrl, signedInAt }`)
      so all consumers compile untouched. Map the Supabase user → that shape (`name` from
      `user_metadata.full_name`/`name`/email-local-part; `avatarUrl` from `user_metadata.avatar_url`,
      falling back to an inline SVG initials avatar like the mock's; `email` from `user.email`).
- [ ] Backend selected by `isFlagEnabled("r9_supabase_auth")`:
      - Flag OFF → existing mock path (`getUser`/`signIn`/`signOut`/consent from `lib/mockAuth`),
        behavior identical to today.
      - Flag ON → Supabase: on mount `getSession()` then subscribe to `onAuthStateChange`;
        `loading` stays true until the first session resolves; `signIn()` calls
        `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: \`${location.origin}/auth/callback?next=/\` } })`;
        `signOut()` calls `supabase.auth.signOut()` and clears local user state.
      - When BOTH flags are on, `r9_supabase_auth` wins.
- [ ] `consent` / `setConsent` remain localStorage-backed (`lib/mockAuth` getConsent/setConsent) in
      BOTH modes — real auth does not move consent server-side (§5.3).
- [ ] `AppMenu.tsx`: the sign-in link / `UserMenu` surface renders when
      `isFlagEnabled("r9_supabase_auth") || isFlagEnabled("r9_0_mockauth")` (today it only checks
      `r9_0_mockauth`, which would hide sign-in when only the real flag is on).
- [ ] `app/login/page.tsx`: "Continue with Google" triggers `signIn()` (real OAuth when the flag is
      on — the redirect leaves the page, so the trailing `router.push('/')` is harmless). When
      `r9_supabase_auth` is ON, the copy is honest for real auth: drop the "Demo mode" badge and the
      "Simulated sign-in… no Google account is contacted" line (those are true only for the mock).
      When it's OFF, the login page is unchanged.
- [ ] OAuth callback route `app/auth/callback/route.ts` exchanges `?code=` for a session via a
      `@supabase/ssr` server client (cookie-bound) and redirects to `next` (default `/`). Follow the
      official `@supabase/ssr` App Router pattern.
- [ ] Supabase clients are created **lazily / guarded** so that with the flag OFF and no
      `NEXT_PUBLIC_SUPABASE_*` env vars set, `npm run build` and SSR do not throw at import time
      (never construct the client at module top-level).
- [ ] `.env.example` gains:
      `NEXT_PUBLIC_SUPABASE_URL=https://YOUR_SUPABASE_REF.supabase.co` (real — the project URL is
      public), `NEXT_PUBLIC_SUPABASE_ANON_KEY=` (LEFT BLANK — see Out of scope), and
      `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=false`, each with a one-line comment.
- [ ] Dependencies `@supabase/supabase-js` and `@supabase/ssr` added to `package.json`; run
      `npm install` in the worktree's `scaffold/` so the lockfile updates and the build resolves.
- [ ] The PR body + a "User setup required" section in THIS task file document the Supabase-dashboard
      steps (see below) — these are user actions; note them, don't block on them.
- [ ] Local verification all green: `npx tsc --noEmit`, `npm test` (incl. `noServerRetention.test.ts`
      and the flag tests), `npm run build`, `npm run check:hex`, `npm run check:contrast`.

## Out of scope
- **Do NOT commit any real anon/publishable key.** The only Supabase key in the environment
  (`SUPABASE_API_KEY`) is the NEW-STYLE **secret** key (`sb_secret_…`, service_role-equivalent) —
  it must NEVER reach the browser or a committed file. Leave `NEXT_PUBLIC_SUPABASE_ANON_KEY` blank
  in `.env.example` and document that the user pastes their **anon/publishable** key from the
  dashboard into `.env.local`. Do not read `SUPABASE_API_KEY` anywhere.
- **No server-side gating of paid features on identity** (§5.3 / R9.0). The callback route and any
  middleware handle ONLY the session; they must not gate routes/features or read/log company
  descriptions or PII. If you add `middleware.ts`, it refreshes the session and nothing else.
- Do NOT delete `lib/mockAuth.ts` or the `r9_0_mockauth` flag (that removal happens later when R9
  fully lands). Do NOT build persistence (R9.2), billing (R9.3), or entitlement enforcement (PLT-07).
- Do not restyle surfaces beyond the honest-copy change on the login page.

## Test plan
- Static/CI: `npx tsc --noEmit`; `npm test` — the `noServerRetention` guard (a: no mock-auth
  identifier under `app/api/**`; b: analytics contract rejects descriptions; c: no
  description-mentioning `console.*` under `app/**`/`lib/**`) must stay green, as must the updated
  flag registry/accessor tests; `npm run build`; `npm run check:hex`; `npm run check:contrast`.
- Manual (flag OFF): app behaves exactly as today; login page shows Demo mode; mock sign-in works.
- Manual (flag ON) can only be fully exercised once the user completes the dashboard setup + pastes
  the anon key (blocked on user action) — the "Continue with Google" button should initiate the
  Supabase OAuth redirect. Note this as a tabled blocker; do not fake credentials.

## User setup required (document in PR body too — user action, do not block)
1. Supabase Dashboard → Authentication → Providers → **Google**: enable it, paste a Google Cloud
   OAuth **Client ID + Secret**.
2. Google Cloud Console → the OAuth client → Authorized redirect URI:
   `https://YOUR_SUPABASE_REF.supabase.co/auth/v1/callback`.
3. Supabase Dashboard → Authentication → URL Configuration → **Site URL** and **Redirect URLs**:
   add `http://localhost:3001/auth/callback` (the user runs on :3001) and the production
   `/auth/callback` URL.
4. Copy the project **anon/publishable** key (Project Settings → API keys) into `.env.local` as
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and set `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=true` to turn the
   real path on. (The secret key is never used client-side.)

## Escalate if
- The drop-in cannot preserve the exact context interface without editing consumer surfaces.
- The only way to make the session persist requires gating something server-side (it should not).
