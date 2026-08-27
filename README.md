# Granted: government opportunity finder

**Granted** turns a founder's plain-English company description into a map of real **federal funding opportunities**: grants, SBIR/STTR R&D, procurement, loans, assistance, scholarships. Each match is scored for fit, screened for eligibility, and calibrated to do the thing no other tool will: **tell you honestly when *not* to apply.**

Nothing is fabricated. Every match traces to a real award record, and a schema layer *throws* on any invented program, amount, or citation.

**Live demo:** [fund-finder-blush.vercel.app](https://fund-finder-blush.vercel.app)

> Originally built for the GOED bounty at AI Builder Day (Aug 2026). It's a working prototype, not enterprise software. But you can run the whole thing on your own keys and deploy it to your own Vercel + Supabase in ~15 minutes. This README is the guide.

## Why this matters

Calibration is the product. Any system can return five matches for any input. The differentiator is the willingness to say *"there probably isn't a strong match, and here's why"*. That's a designed screen, not an error. If your system fabricates matches for a company that doesn't align with federal grant mechanics, it fails the people using it.

---

# Run it yourself

## Quick start (≈ 5 minutes)

You need [Node 20 LTS](https://nodejs.org) (18.17+ works) and two API keys (OpenAI + Anthropic). That's it. The 968-opportunity corpus ships committed, so there's no data pipeline to run before you can start.

```bash
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
npm run setup      # interactive: scaffolds .env.local, collects your keys, installs deps
npm run dev        # → http://localhost:3000
```

`npm run setup` never prints or commits your keys (they go into `scaffold/.env.local`, which is gitignored). Prefer to do it by hand? See **Manual setup** below.

## What you need (and where to get it)

| Thing | Required? | Where | Notes |
|---|---|---|---|
| **OpenAI API key** | ✅ Yes | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Embeddings (`text-embedding-3-small`). Pennies per search. |
| **Anthropic API key** | ✅ Yes | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude: scoring + explanations. A novel search runs ~$0.05–0.33. |
| **Exa API key** | Optional | [dashboard.exa.ai](https://dashboard.exa.ai) | Only for the deep competitor analysis' *live web* results. Without it, that feature degrades honestly to federal awardees only. |
| **Supabase project** | Optional | [supabase.com](https://supabase.com) | Only for **real Google sign-in**. The core app runs fine without any auth. |
| **Google OAuth credentials** | Optional | [Google Cloud Console](https://console.cloud.google.com) | Only if you enable real sign-in (see below). |
| **Vercel account** | Optional | [vercel.com](https://vercel.com) | Only to deploy. Local dev needs none of it. |

> **Cost:** every search spends real OpenAI + Anthropic credits. Keep an eye on your Anthropic balance. A heavy batch (e.g. re-running the 31-case golden set) can burn several dollars and will 400 with *"credit balance too low"* if you run dry.

## Manual setup (instead of the script)

```bash
cd scaffold
cp .env.example .env.local
npm install
```

Then edit `scaffold/.env.local` and set at least:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

Everything else in `.env.example` is optional and documented inline. Start with `npm run dev`.

## Run on a local model (Ollama: no API keys, can be fully offline)

Don't want to pay for or send data to a hosted model? Point the reasoning at a local LLM. The scoring, explanations, and honest verdicts then run entirely on your machine.

1. Install [Ollama](https://ollama.com) and pull a capable instruction model:
   ```bash
   ollama pull gemma4        # or qwen2.5, llama3.1 — pick one that follows JSON well
   ```
2. In `scaffold/.env.local`:
   ```bash
   LLM_PROVIDER=ollama
   LOCAL_LLM_MODEL=gemma4:latest
   # ANTHROPIC_API_KEY is no longer needed.
   ```
3. `npm run dev`. Every scoring/explanation call now routes to Ollama's OpenAI-compatible endpoint, with grammar-constrained JSON so a local model stays parseable. Any OpenAI-compatible server works (LM Studio, vLLM, llama.cpp). Set `LLM_BASE_URL` to its `/v1` URL.

### Fully offline
By default the tiny query embedding still uses OpenAI (the corpus ships pre-embedded at 512 dims; it costs fractions of a cent). To remove that last hosted call, run embeddings locally and re-embed the corpus once:
```bash
ollama pull nomic-embed-text
# in .env.local:
EMBEDDINGS_BASE_URL=http://localhost:11434/v1
EMBEDDINGS_MODEL=nomic-embed-text
npm run data:embed        # re-embeds the 968-opportunity corpus locally (~1–2 min)
```
Now nothing leaves your machine.

### The honest tradeoff
Hosted Claude is faster and more reliable at the strict, structured JSON this pipeline asks for, and its scoring is better calibrated. A capable local model still handles it. In testing, gemma4 ran the full pipeline end to end and reached the *same headline verdict* as hosted Claude on the same input (a genuine strong fit, with the right NIH SBIR grant as its top recommendation). Two caveats:
- **It's much slower.** A single local GPU serves the scoring batches one at a time, so a full 24-candidate search can take several minutes (vs. ~90s hosted). Batches run serially and smaller when local (`LLM_BATCH_SIZE`, default 3) to stay under the per-call timeout; raise `ANTHROPIC_TIMEOUT_MS` if a big model needs longer.
- **Quality is rougher.** Smaller or older models score less consistently and occasionally emit JSON even the repair layer can't recover. Use a strong instruction-following model, and expect a coarser result than the hosted default.

It's a real option for privacy or zero-cost runs, just not the fast path.

## Feature flags (turn on the good stuff)

Everything risky ships **default-OFF** so a fresh clone is safe and boring. Flip these in `.env.local` (they're `NEXT_PUBLIC_*`, so **restart `npm run dev` after changing them**):

| Flag | What it turns on |
|---|---|
| `NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER=true` | The **honest "don't apply"** layer: per-match recommend / verify / do-not-recommend verdicts, a whole-map verdict, and rubric-anchored scoring. This is the headline feature. |
| `NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true` | The live **competitor & market-analysis** brief (`/api/competitors`). Add `EXA_API_KEY` for web competitors. |
| `NEXT_PUBLIC_MOCK_AUTH=true` | A localStorage-only **mock** sign-in, to demo the login loop without real OAuth. |
| `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=true` | **Real** Google sign-in via Supabase (see next section). Wins over mock auth if both are on. |

The full flag list lives in `scaffold/lib/flags/registry.ts`.

## Real Google sign-in (Supabase + OAuth)

Optional. The app works without it. When you want real accounts:

1. **Create a Supabase project** at [supabase.com](https://supabase.com) → New project.
2. **Copy your keys:** Supabase Dashboard → *Project Settings → API* → copy the **Project URL** and the **anon / publishable** key into `scaffold/.env.local`:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...        # the anon key — NEVER the service_role key
   NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=true
   ```
3. **Create Google OAuth credentials:** [Google Cloud Console](https://console.cloud.google.com) → *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*.
   - Under **Authorized redirect URIs**, add the callback Supabase gives you. It looks like `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. (Supabase shows the exact URL in step 4.) *This is the Supabase callback, not your app URL. That's why changing your app domain later does **not** require touching Google.*
   - Save, then copy the **Client ID** and **Client secret**.
4. **Enable Google in Supabase:** Dashboard → *Authentication → Providers → Google* → toggle on, paste the Client ID + secret from step 3, save.
5. **Set your app URLs in Supabase:** Dashboard → *Authentication → URL Configuration*:
   - **Site URL:** `http://localhost:3000` (for local). Change to your Vercel URL for production.
   - **Redirect URLs:** add `http://localhost:3000/**` (local) and, once deployed, `https://YOUR-APP.vercel.app/auth/callback`.
6. Restart `npm run dev` and sign in. The app requests OAuth with `redirectTo = <origin>/auth/callback`, so it adapts to whatever domain it's served from. You only ever update the **Supabase** redirect allowlist, never Google.

> **Common gotcha:** if sign-in bounces to the wrong URL, it's almost always Supabase's *Site URL / Redirect URLs* pointing at the old domain. Update them there.

## Deploy to Vercel

1. **Push the repo to your own GitHub** (fork or your own remote).
2. **Vercel → Add New… → Project → import the repo.**
3. **Set the Root Directory to `scaffold`.** ⚠️ This is the one non-obvious step. The Next.js app lives in `scaffold/`, not the repo root. Vercel will fail to build if you skip it.
4. **Add environment variables** (Vercel → Project → Settings → Environment Variables): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and any optional ones you use (`EXA_API_KEY`, the `NEXT_PUBLIC_FLAG_*` flags, `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`). `NEXT_PUBLIC_*` vars are inlined at build time, so **redeploy after changing them.**
5. **Deploy.** The corpus is committed and read-only at runtime, so there's no data step and no live government-API dependency.
6. **If you enabled real auth:** add your Vercel production URL to Supabase's *Site URL* + *Redirect URLs* (see step 5 above).

Vercel Pro is recommended (the deep-analysis + novel-search routes can run up to ~2 minutes; Pro raises the serverless function timeout to 120s).

## Optional: assisted-apply identifiers (UEI, grants.gov, ORCID, NSF)

The **experimental** application-assistance pieces, the grants.gov S2S integration (mock/sandbox only) and the Chrome autofill extension, can use your real federal identifiers to *pre-fill* forms. These are **entirely optional**, off by default, and **the tool never submits anything on your behalf**. A human always files.

If you want to experiment, set them as shell environment variables (not in `.env.local`), e.g.:

```bash
export UEI='YOUR-UEI'                 # from SAM.gov, once your registration is Active
export GRANTS_GOV_USERNAME='...'
export GRANTS_GOV_PASSWORD='...'      # write-only: used to pre-fill, never logged or submitted
export ORCID='0000-0000-0000-0000'
export NSF_ID='...'
```

> A **UEI alone is not enough** to apply: grant portals reject it until your **SAM.gov registration is Active** (which can take ~2 weeks). See `scaffold/components/ApplicationChecklist.tsx`.

## Chrome extension (assisted fill, experimental)

An optional companion extension (`extension/`, "Granted Assisted Fill") can pre-fill a grant portal's application form **in your own authenticated browser session**, from a package the app generates. Think of it like a password manager for grant forms: it fills what it can ground, flags what it can't, and lets you step through the portal's own sections. **It never submits, signs, certifies, or files anything**. Your organization's Authorized Organization Representative (AOR) reviews everything and clicks the portal's own submit button.

**Load it into Chrome:**
```bash
cd extension
npm install
npm run build            # emits a loadable extension into extension/dist/
```
Then in Chrome (or any Chromium browser): open `chrome://extensions` → turn on **Developer mode** (top-right) → **Load unpacked** → select `extension/dist/`. The "Granted Assisted Fill" icon appears in the toolbar. After code changes, re-run `npm run build` and hit reload on the extension's card.

**What it needs to actually fill a form:**
- A completed application **package exported from the Granted app**. That's the set of fields and grounded values to fill.
- Your **federal identifiers on file** (UEI, ORCID, NSF ID, grants.gov login): the values that go into the form.
- **Real field selectors captured for the specific portal** (see the caveat below; they do not ship).
- An **Active SAM.gov registration**, so you can actually log into the portal the extension is filling.

**Honest state: it is not a working auto-filler yet.** Every portal field selector in `extension/src/config/portals/*.ts` ships as a `TODO:` placeholder, because the initial recon couldn't reach the four target portals (grants.gov, NIH ASSIST, Research.gov, SBIR.gov). They sit behind login and an **Active SAM.gov registration**. So out of the box the extension loads but fills nothing (and `nih_assist` has no steps at all). To make it actually fill, you capture the real selectors from a live portal session (`extension/README.md` documents that step-by-step procedure), and to reach those portals you first need your SAM.gov registration Active (which can take ~2 weeks).

By design it is an assistive form-filler, not a submission service: a human always files.

## Refreshing the data (optional)

The corpus (`scaffold/data/opportunities.json`, 968 opportunities across grants.gov, SAM.gov, SBIR, USAspending) is committed, so you don't need this to run. To rebuild it from the live public sources:

```bash
cd scaffold
npm run data:mvp        # fetch SAM assistance + SBIR + procurement, assemble
npm run data:embed      # embed everything (~1 min, <$1 of OpenAI)
npm run data:precompute # (optional) freeze the demo test cases for instant renders
```

All sources are keyless. There is a Supabase-backed corpus store (`supabase/migrations/00001_*.sql`) for a future dynamic pipeline, but the app reads the static JSON by default, so you can ignore it.

---

## How it works

1. **Intake.** Describe your company in natural language; Claude extracts a structured profile + expands it into government vocabulary.
2. **Retrieval.** OpenAI embeddings + in-memory cosine similarity over the 968-opportunity corpus (no vector DB); per-type quotas keep every instrument reachable.
3. **Scoring.** Claude scores each candidate 0–100 on the criteria a program officer would apply, with a met/unmet checklist and plain-language explanations.
4. **Eligibility screen.** A rules layer buckets eligibility from *stated* facts; it never turns a model guess into an exclusion.
5. **Discernment** *(flag)*. Recommend / verify / **don't-recommend** per match, plus a whole-map verdict, so a weak idea gets an honest "don't apply" instead of a wall of maybes.
6. **The honest no.** When nothing fits, that's a first-class finding with real redirects, not an empty screen.

Results **stream**. Progress and grounded evidence appear in seconds rather than behind a frozen spinner.

## Design philosophy

- **Say no plainly.** Honesty is the differentiator, not a failure state.
- **Ground everything.** Every claim traces to a real record; the schema throws on fabrication.
- **Translate government.** Founder language first; jargon only when necessary.
- **Ship risky things dark.** Every feature is flag-gated and default-off.

## Project structure

```
.
├── README.md                     (this file)
├── LICENSE
├── go-to-market/                 (positioning, strategy, validation-outreach kit)
├── retrospective/                (build retrospective + architecture diagram)
├── supabase/migrations/          (optional corpus-store schema)
├── extension/                    (optional Chrome "assisted fill" extension — experimental)
└── scaffold/                     (the Next.js app — Vercel Root Directory)
    ├── .env.example              (all env vars, documented)
    ├── scripts/setup.mjs         (npm run setup)
    ├── lib/
    │   ├── match.ts              (pipeline + calibration knobs)
    │   ├── recommend.ts          (the discernment verdict logic)
    │   ├── flags/registry.ts     (every feature flag)
    │   └── prompts/registry.ts   (all LLM prompts, hash-locked)
    ├── data/opportunities.json   (the committed 968-opportunity corpus)
    ├── app/api/match/route.ts    (the streaming matching endpoint)
    └── app/{welcome,readiness}/  (marketing landing + free readiness tool)
```

## Troubleshooting

- **`OPENAI_API_KEY is not set`** → add it to `scaffold/.env.local` and restart `npm run dev`.
- **Anthropic 400 "credit balance too low"** → top up at console.anthropic.com; every search spends credits.
- **A flag change did nothing** → `NEXT_PUBLIC_*` vars are read at build/start; restart the dev server (and redeploy on Vercel).
- **Vercel build fails immediately** → you probably didn't set **Root Directory = `scaffold`**.
- **Sign-in redirects to the wrong place** → fix Supabase → *Authentication → URL Configuration* (Site URL + Redirect URLs).
- **Port 3000 in use** → Next picks the next free port; watch the `npm run dev` output for the URL.

---

**Built with:** Next.js · TypeScript · Tailwind · OpenAI (embeddings) · Anthropic Claude (scoring & explanations) · Supabase (optional auth) · Vercel.

**License:** see [LICENSE](LICENSE).
