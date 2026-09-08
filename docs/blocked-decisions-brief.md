# Blocked decisions brief — R9 auth, R6 auto-apply, pricing

Purpose: three things are built (or partly built) and sitting behind default-off flags because
they need a decision only the product owner can make. Engineering cannot proceed past these
without guessing. Each section is designed to be readable and decidable in under 5 minutes.
Nothing below requires new code to unblock — these are dashboard clicks, sign-offs, and numbers.

Sources read for this brief: `open-questions.md`, `resolved-questions.md` (empty), `feedback.md`
(empty — no §9.1 human-validation findings recorded yet), `tasks/R9-supabase-auth.md`,
`tasks/R6-auto-apply-pro.md`, `tasks/R4b-cost-measurement.md`, `tasks/FE-06-auto-apply-stub.md`,
`tasks/APL-01-s2s-feasibility-memo.md`, `docs/R6-s2s-feasibility-memo.md`,
`docs/s2s-integration-spec.md`, `scaffold/docs/R4b-cost-findings.md`,
`prompts/fundfinder-orchestrator-prompt.md` (§9, §9.1, R9, R10), `task-graph.md`, and the current
`scaffold/lib/flags/registry.ts`, `scaffold/components/AuthProvider.tsx`,
`scaffold/lib/billing/mockBilling.ts`, `scaffold/lib/contracts/{entitlements,runBudget}.ts`.

---

## 1. R9 — Real Supabase Auth (Google sign-in)

### Status
**Built and verified**, behind `r9_supabase_auth` (default **OFF**). Confirmed by reading the
actual code, not the task file's claims:
- Flag registered in `lib/flags/registry.ts` + `lib/flags/env.ts` (static read, per the
  Next.js inlining requirement).
- `components/AuthProvider.tsx` is a true drop-in: picks backend by flag, exported context shape
  unchanged, mock path (`r9_0_mockauth`) untouched and still byte-for-byte identical when the new
  flag is off. When both flags are on, `r9_supabase_auth` wins.
- New files exist and are real: `lib/supabase/client.ts`, `lib/supabase/server.ts`,
  `app/auth/callback/route.ts` (OAuth code→session exchange).
- `@supabase/supabase-js` and `@supabase/ssr` are in `package.json`.
- Consent / "Delete my data" stay localStorage-backed in **both** modes (real auth does not move
  consent server-side) — matches §5.3.
- One discrepancy worth flagging: the task spec said `.env.example` should ship the *real* project
  URL (`https://zqvezuzdfwfwvfjjiein.supabase.co`) as a public value; the committed
  `.env.example` instead has a generic `https://YOUR-PROJECT-REF.supabase.co` placeholder. Not a
  blocker, just confirm which Supabase project is actually canonical before go-live (see decision
  2 below).

**Not yet exercisable end-to-end** — nobody has completed the Google/Supabase dashboard config, so
the real OAuth path has never actually been clicked through. Everything past "code compiles" is
blocked on the steps below.

### Decisions you must make
1. **Ratify Supabase as the auth provider.** The spec left this as `[DECIDE: Clerk, Supabase Auth,
   or Auth.js]` and nobody's decision is recorded in `resolved-questions.md` — Supabase was simply
   the one built. It's cheap to change now (flag is off, zero users on it) and expensive later.
   If you're fine with Supabase, say so explicitly so it's recorded; otherwise flag it now.
2. **Which Supabase project is canonical.** The task doc names project `zqvezuzdfwfwvfjjiein`; the
   committed `.env.example` is genericized. Confirm that project ref is the one to actually use
   (or provide the real one), for both dev and prod.
3. **Production domain(s)** for the redirect/site URL config below — the checklist only covers
   `localhost:3001` today.
4. **Go-live timing** — when to flip `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH` from `false` to `true`.

### Exact steps to unblock (dashboard-only, no code)
1. **Supabase Dashboard → Authentication → Providers → Google:** enable it, paste a Google Cloud
   OAuth **Client ID + Secret**. (You'll need a Google Cloud project with an OAuth consent screen
   configured if one doesn't already exist.)
2. **Google Cloud Console → your OAuth client → Authorized redirect URI:** add
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Supabase Dashboard → Authentication → URL Configuration → Site URL + Redirect URLs:** add
   `http://localhost:3001/auth/callback` (dev) and `https://<your-prod-domain>/auth/callback`
   (prod, once you have the domain from decision 3).
4. **Supabase Dashboard → Project Settings → API keys:** copy the **anon/publishable** key into
   `.env.local` as `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Set `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=true`
   to turn the real path on locally to test.

**Env vars involved:** `NEXT_PUBLIC_SUPABASE_URL` (public, safe to commit — it's just the project
URL), `NEXT_PUBLIC_SUPABASE_ANON_KEY` (paste yours locally; never commit a real one),
`NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH` (the go-live switch). Note there is already a
**secret** Supabase key (`SUPABASE_API_KEY`, service-role-equivalent) in the environment
elsewhere in this project — engineering has deliberately never wired it into this feature and it
must never reach the browser or a committed file. Nothing to do here except not change that.

### Recommendation
Lowest-regret default: **do the ~15 minutes of dashboard config now** (code is ready and won't
change), test the sign-in redirect once locally with the flag on, then decide go-live timing
separately from the config work. There's no reason to let dashboard clicks block a code review —
they're independent of whether you flip the flag on for real users today or next month.

---

## 2. R6 — Auto-apply ("Auto Fill") assisted-apply demo

### Status
**Built and shipped**, behind `r6_auto_fill` (default **OFF**; renamed from `r6_auto_apply` in a
later refactor — same feature). Verified in code:
- `components/AutoFillModal.tsx` (FE-06's Pro-upsell modal, flag-off path, unchanged) and
  `components/AutoFillFlow.tsx` (the R6 3-step stepper: **sign-in → requirements → admin-review
  pending**) both exist and are wired into `OpportunityCard.tsx` by the flag.
- The flow never submits anything and says so on every step; the "Admin review required prior to
  granting auto-apply approval" copy is present verbatim.
- "Pro" gating is a client-only framing stub (`lib/entitlements/useEntitlements.ts`) — it always
  resolves free-tier, gates nothing server-side, and the walkthrough proceeds regardless (it's a
  preview, not a real paywall).

**Important — this is not the only R6-adjacent thing that exists.** There is a second,
further-along initiative on top of this: a flag `g6_s2s_submission` (also default OFF) gates a
**mock-only** Grants.gov System-to-System submission integration (`scaffold/lib/s2s/*`,
spec at `docs/s2s-integration-spec.md`). It explicitly never reaches a live federal endpoint,
handles no credentials, and requires an AOR-attestation gate before anything happens — and its own
spec states it "reconciles with and does not resolve" the escalations below. **This is technical
readiness for a decision that has not been made, not evidence the decision has been made.**

**Not yet built:** the real package-builder R6 slice (`task-graph.md`'s APL-02/APL-03 — form
enumeration, prefilled fields with provenance, narrative drafting, deadline tracking, and the
mandatory human review-and-attest screen). That work is blocked on billing/entitlements
(`PLT-07`, see §3) and hasn't started.

### The decisions you must make
These come directly from the feasibility memo's escalation list (`docs/R6-s2s-feasibility-memo.md`
§6) — **the memo explicitly does not resolve any of them; needs counsel on the legal ones:**

1. **E1 — Do we ever pursue real Grants.gov S2S submission** (even via the gatekept,
   PMO-approved "Third Party Submitter" role)? The memo's technical finding: Grants.gov's own
   third-party web services let a system submit using the AOR's username/password with no human
   click at the moment of submission — NIH ASSIST does this today — so the "a human always
   submits" boundary is **fundFinder's own policy choice, not a technical wall**. The memo
   recommends **against** pursuing this for now. That recommendation itself needs your explicit
   sign-off (or rejection), not silent adoption. **Needs counsel.**
2. **E3 — Copy/positioning boundary.** fundFinder structurally cannot be the AOR or E-Biz POC for
   a customer (SAM.gov's own Terms of Use bar assigning that role to anyone outside the
   organization). Any marketing/product copy implying fundFinder "handles filing for you" would
   misstate that relationship. **Needs legal/marketing review before any such copy ships.**
3. **E4 — Liability if a prefilled field is wrong** and a human attests to it anyway on the review
   screen — does that create fundFinder liability distinct from the AOR's own federal exposure
   (18 U.S.C. §1001 / False Claims Act)? The memo flags this as a real open question it **cannot
   answer**. **Needs counsel; not resolvable by engineering or this brief.**
4. **Is the current `r6_auto_fill` demo (sign-in → requirements → admin-review-pending) OK to
   turn on for real users now**, as a preview, ahead of the real package builder — or should it
   stay off until the real slice and its legal review are both done? Nothing in it is unsafe on
   its own (it's honest, submits nothing), but turning it on implies a live "Pro" feature that
   isn't real yet.
5. **Schedule the required §9.1 human-validation session**: "at least one person with actual
   federal grant submission experience reviews the package builder output and the attest screen...
   someone who has been an AOR will catch things no test will." `feedback.md` is currently empty
   — this has not happened for either the demo flow or (once built) the real package builder.

### Exact steps to unblock
- For E1/E3/E4: this is a **legal/counsel conversation**, not an engineering task. Recommend
  reviewing `docs/R6-s2s-feasibility-memo.md` §6 directly with counsel (it's short and already
  cites sources), then recording the decision in `resolved-questions.md` so it stops being
  re-litigated by future tasks.
- For the human-validation session: find someone who has personally been an AOR or Signing
  Official (a grants administrator at a past company, a consultant, etc.) and walk them through
  the demo flow and/or the eventual attest screen. Log findings in `feedback.md`.
- Who signs off: **counsel** on E1/E3/E4 (legal exposure, ToS, copy that implies representative
  authority); **product owner** on whether to demo the current stub to real users before the real
  slice ships.

### Recommendation
Lowest-regret default: **keep both `r6_auto_fill` and `g6_s2s_submission` off in production**
until counsel has weighed in on E1/E3/E4 and the §9.1 reviewer session has happened. The stub is
safe to demo internally or to design partners as-is — it's honest about being a preview and
submits nothing — but flipping it on for the public implies a "Pro" feature is live when it isn't,
which cuts against the product's own honesty thesis (§11: "describe what the product does, never
promise what will happen"). If you want to show it publicly sooner, the lowest-risk version is to
keep the "Preview" / "nothing is submitted" copy exactly as-built rather than upgrading the framing
to sound more finished.

---

## 3. Pricing / tiers (R9.3 — billing mechanics)

### Status
**Not built for real.** The spec still has this as an open decision:
`[DECIDE: pricing, trial terms, and whether Pro is per-seat or per-account]` (§R9.3). No payment
integration, no `PLT-07` task file, no Stripe (or other processor) wiring exists yet.

What **does** exist today, and matters for this decision:
- **A local-only, 3-tier mock billing selector** (`lib/billing/mockBilling.ts`, FE-07) with
  **placeholder** prices already baked into the demo UI: **Free $0** / **Pro $20/mo** (Auto Fill
  preview, 10/month) / **Max $100/mo** (unlimited Auto Fill + competitor analysis). It's
  explicitly commented "THIS IS NOT BILLING" — no charge, no server call. These numbers are
  arbitrary demo placeholders, not derived from real cost data.
- **The frozen `CON-01` entitlements contract only supports 2 tiers** (`free`/`pro` — no `"max"`).
  The mock's 3rd tier is UI-only and collapses to `"pro"` under the hood. Adding a real 3rd tier
  means touching a contract that's explicitly frozen ("CON-01-owned"; changing it needs
  escalation/sign-off, not a quiet edit).
- **Real cost-per-search data exists and is no longer a blocker** — `R4b-cost-measurement.md`'s
  dependency is done (`scaffold/docs/R4b-cost-findings.md`, measured 2026-08-15 against live
  APIs): **average $0.224/search** (range $0.21–$0.24), ~99s average latency. The free-tier
  `RunBudget` cost ceiling is currently a $0.50/search placeholder (real cost is ~45% of it —
  there's headroom); Pro's ceiling placeholder is $3.00/search.
  - **Gap**: R4b measured the core *search* cost only. It did **not** measure the cost of a
    package-builder / Auto-Fill run or a competitor-intelligence run (the actual Pro-tier
    features) — those are likely materially more expensive (more LLM calls) and haven't been
    priced yet. Don't anchor a Pro price purely on the $0.224 search number.
- **Multi-seat is effectively off the table for this phase already**: §10 (non-goals) states
  "Multi-user or organization accounts, roles, and permissions. Single-user accounts only" — so
  "per-seat" pricing would mean revisiting a stated non-goal, not just a pricing choice.

### Decisions you must make
1. **Tier count**: stay at the frozen 2-tier `free`/`pro` contract, or formally add a paid 3rd
   tier (escalation required)?
2. **Real price points** — keep the $20/mo Pro (and $100/mo Max, if you keep a 3rd tier) demo
   placeholders as the actual launch prices, or set different numbers?
3. **Trial terms** — trial length, if any; free trial of Pro vs. none.
4. **Per-seat vs. per-account** — per-account only, given the single-user-accounts non-goal above,
   unless you want to explicitly revisit that non-goal.
5. **RunBudget dollar ceilings** — confirm or replace the $0.50 (free) / $3.00 (pro) placeholders
   now that real search-cost data exists.
6. **Downgrade/cancellation/refund behavior** — the spec already has a recommended default (below);
   confirm or override it.
7. **Payment processor** — not decided anywhere in the repo; needed before `PLT-07` can be scoped.

### Concrete options (lowest-regret framing)
- **Option A — adopt the mock placeholders as real prices** (Pro $20/mo, keep or drop Max
  $100/mo). Fastest: matches what's already in the demo copy, no rework.
- **Option B — 2-tier only, new prices.** Drop "Max" as a paid tier (fold its features into
  "Pro"), pick new numbers. Smallest contract footprint — matches the currently-frozen CON-01
  shape, no escalation needed. The mock's tier-collapse logic already treats "max" as "pro," so
  dropping the 3rd tier breaks nothing already shipped.
- **Option C — formally add a 3rd tier to CON-01.** Most flexible, but requires the contract
  owner's sign-off (an explicit escalation, not a quiet edit) before any engineering can touch it.

### Recommendation
**Option B** is lowest-regret: it needs zero contract escalation, matches the already-stated
single-tier-of-complexity posture (single-user accounts, no seats), and nothing shipped today
breaks if "Max" quietly disappears as a paid tier (its features fold into Pro). Treat the $20/mo
number as provisional, not final — commission one small R4b-style cost pass on the actual
package-builder/Auto-Fill code path (once it exists) before locking the Pro price, since that's
the feature the price is meant to cover and it hasn't been measured yet. Keep the recommended
default from the spec for downgrades: **previously generated Pro analyses stay readable; new ones
require an active subscription** — revoking access to something a founder already paid for and
acted on is both hostile and inconsistent with the honesty thesis.

---

## Executive summary (5 lines)

1. **R9 auth**: code is done and verified; unblock with ~15 minutes of Supabase/Google dashboard
   config (redirect URIs, anon key) — plus ratify Supabase as the provider and pick the canonical
   project/prod domain.
2. **R6 auto-apply**: the demo stepper is built, honest, and submits nothing, but three legal
   questions (E1 real S2S submission, E3 "handles filing" copy, E4 liability for wrong prefills)
   need counsel before it (or the mock S2S layer sitting behind it) goes live to real users.
3. **R6 also** needs its required human-validation session (an actual AOR/grants-submission
   reviewer) — not yet scheduled; `feedback.md` is empty.
4. **Pricing**: no real billing exists yet; the blocking cost-data dependency (R4b) is done
   (~$0.22/search), so the only remaining inputs are your price points, trial terms, and whether
   to keep a 3rd "Max" tier (recommend dropping it — 2-tier is the lower-effort path).
5. **Net effect of resolving all three**: R9 flips on with no further engineering; R6 stays gated
   on your legal sign-off, not on more code; pricing is now a numbers-and-tiers choice, not a
   data-gathering exercise.
