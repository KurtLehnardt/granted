# Granted: government opportunity finder

**Granted** turns a plain-English description of your business or research into a map of real **federal funding opportunities**: grants, SBIR/STTR R&D, procurement, loans, assistance, scholarships. Each match is scored for fit on the criteria a program officer would apply, and screened for eligibility.

Run it with your own API keys or a fully local model — see **Run it yourself** below.

---

# Run it yourself

**No API keys? Still works.** Clone it, install, run it, and try the 4 built-in sample companies (in the welcome guide, replayable from Settings) — their results are cached, so they need no keys at all. You only need API keys (or a local model) to search your *own* company description.

`npm run dev` only listens on this machine; `npm run dev:lan` opts in to exposing it to your local network.

Every OS below ends up running the exact same `npm` commands — the setup scripts detect your platform automatically. Only the prerequisite installs (Node, git, Ollama) differ, so pick yours:

## Install on macOS

*The app's local-model flow is verified end to end on a 32GB Mac: auto-picked `qwen2.5:14b` and completed a full novel-company search (18 candidates, fully local, zero API calls) in **3 minutes 43 seconds**. `install-macos.sh` is separately verified on a 2015 MacBook Pro (Intel i7-4770HQ, 16GB, macOS 12.7.6) — the oldest realistic case, which forces the Ollama CLI-tarball path described below.*

**1. Install prerequisites + clone (one command)**
```bash
curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh | bash
```
Installs Node 20+ and git if missing — via Homebrew where available, otherwise the Xcode Command Line Tools for git and the official nodejs.org `.pkg` for Node — clones the repo into `./granted`, runs `npm install`, and installs Ollama with the method your macOS version actually supports (see the note below). Safe to re-run.

Prefer to do it by hand?
```bash
brew install node git             # or Node from https://nodejs.org, git via xcode-select --install
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
npm install
```

**2. Try it with zero keys**
```bash
cd granted/scaffold      # already done if you used install-macos.sh
npm run dev              # → http://localhost:3000
```
Try the 4 sample companies now — no keys needed.

**3. Search your own company — cloud models (OpenAI + Anthropic)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` — see **What you need** below for where to get them.

**3, alternative — fully local (Ollama, no API keys)**
```bash
brew install ollama                 # or https://ollama.com/download
npm run setup:local -- --yes        # picks a model sized for your RAM, pulls it, re-embeds the corpus
npm run dev
```

> **On macOS 13 or older?** Ollama's `.app`/`.dmg` and its Homebrew formula are built for **macOS 14+**. On an older Mac the download page hands you an app that won't launch, and Homebrew has dropped those releases (no bottles), so `brew install ollama` fails too. The release's **CLI tarball is a universal binary that does run there** — `install-macos.sh` picks it automatically, or install it by hand:
> ```bash
> curl -fsSL -o ollama-darwin.tgz \
>   https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz
> mkdir -p ~/.local/ollama && tar xzf ollama-darwin.tgz -C ~/.local/ollama
> ln -sf ~/.local/ollama/ollama /usr/local/bin/ollama
> ```
> There's no `.app` wrapper on this path, so start the daemon yourself with `ollama serve` — and again after each reboot, since nothing auto-starts it.

## Install on Windows

*The app's local-model flow is verified end to end on Windows 11 (HP ZBook, 32GB RAM, 4GB Quadro P1000): qwen2.5:3b + nomic-embed-text, fully local, a novel-company search scoring 34 candidates completed in 7m33s. `install-windows.ps1` itself is separately verified on a fresh Windows Server 2022 box with no `winget` present, forcing the direct-download fallback path for both Node and git.*

**1. Install prerequisites + clone (one command, PowerShell)**
```powershell
irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
```
Installs Node 20+ and git if missing — via `winget` where available, otherwise a direct official-installer download (winget isn't present on every Windows box, notably Windows Server, which this was verified against) — clones the repo into `.\granted`, and runs `npm install`. Safe to re-run.

Prefer to do it by hand?
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
No `winget`? Grab [Node 20+](https://nodejs.org) and [git](https://git-scm.com/download/win) directly instead. (Node 22+ avoids an `EBADENGINE` warning one dependency now emits on 20 — the app runs fine either way.) PowerShell (default on Windows 10/11) or Git Bash both work with everything below.

**2. Try it with zero keys**
```powershell
cd granted/scaffold
npm install            # already done if you used install-windows.ps1
npm run dev            # → http://localhost:3000
```
Try the 4 sample companies now — no keys needed.

**3. Search your own company — hosted (OpenAI + Anthropic)**
```powershell
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `Copy-Item .env.example .env.local` (PowerShell) or `cp .env.example .env.local` (Git Bash), then edit `scaffold/.env.local` and set `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` — see **What you need** below.

**3, alternative — fully local (Ollama, no API keys)**
```powershell
# Install Ollama first: https://ollama.com/download — it runs as a background app once installed.
npm run setup:local -- --yes        # picks a model sized for your RAM/VRAM, pulls it, re-embeds the corpus
npm run dev
```

## Install on Linux

**1. Install prerequisites + clone (one command)**
```bash
curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh | bash
```
Installs git and Node 20+ if missing (supports `apt`, `dnf`, and `yum` — verified end to end on both Ubuntu and Amazon Linux 2023), clones the repo into `./granted`, and runs `npm install`. Safe to re-run.

On a distro it doesn't cover, or prefer to do it by hand?
```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
# Amazon Linux 2023 / Fedora / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
sudo dnf install -y nodejs git   # older releases: sudo yum install -y nodejs git

git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
Both install Node 20, which throws a harmless `EBADENGINE` warning during `npm install` (some dependencies now want 22+; the app runs fine on 20 regardless) — use `setup_22.x` above instead to avoid it.

**2. Try it with zero keys**
```bash
cd granted/scaffold
npm install            # already done if you used install-linux.sh
npm run dev            # → http://localhost:3000
```
Try the 4 sample companies now — no keys needed.

**3. Search your own company — hosted (OpenAI + Anthropic)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` — see **What you need** below.

**3, alternative — fully local (Ollama, no API keys)**
```bash
curl -fsSL https://ollama.com/install.sh | sh
npm run setup:local -- --yes        # picks a model sized for your RAM, pulls it, re-embeds the corpus
npm run dev
```
Verified end to end via `install-linux.sh` on a fresh Amazon Linux 2023 box (2 vCPU, 8GB RAM, no GPU — the smallest realistic case): auto-picked `llama3.2:1b` and completed a full novel-company search (21 candidates, fully local) in **18 minutes 58 seconds**. The same flow on Ubuntu, same hardware class, ran comparably (20m43s). A machine with a GPU or more cores will be dramatically faster — the macOS and Windows numbers above are the same engine, just more hardware.

## What you need (and where to get it)

| Thing | Required? | Where | Notes |
|---|---|---|---|
| **OpenAI API key** | For your own searches (the 5 samples work without any keys) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Embeddings (`text-embedding-3-small`). Pennies per search. |
| **Anthropic API key** | For your own searches (the 5 samples work without any keys) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude: scoring + explanations. A novel search runs ~$0.05–0.33. Or pick another provider in **Settings → Model → Cloud** (OpenAI, Gemini, OpenRouter, Groq, Mistral, or any OpenAI-compatible URL) and paste its key or point to an env var / secret file. Prompts are tuned on Claude. |
| **Exa API key** | Optional | [dashboard.exa.ai](https://dashboard.exa.ai) | Only for the deep competitor analysis' *live web* results. Without it, that feature degrades honestly to federal awardees only. |
| **Supabase project** | Optional | [supabase.com](https://supabase.com) | Only for **real Google sign-in**. The core app runs fine without any auth. |
| **Google OAuth credentials** | Optional | [Google Cloud Console](https://console.cloud.google.com) | Only if you enable real sign-in (see below). |

### Picking a local model manually

`npm run setup:local` picks a model tier from your available memory/VRAM automatically. Choosing one by hand instead? Match it to your machine — `ollama pull gemma4` alone, for instance, pulls a 9.6GB model that won't run on an 8GB machine:

| Memory / VRAM | Recommended model | Note |
|---|---|---|
| 32GB+ | `qwen2.5:14b` | Best local quality. |
| 16–32GB | `qwen2.5:7b` | Strong, well-calibrated default. |
| 8–16GB | `llama3.2:3b` | Good balance. |
| Under 8GB | `llama3.2:1b` | Runs on modest RAM (verified CPU-only, no GPU); rougher quality, slow scoring. |

Then in `scaffold/.env.local`:
```bash
LLM_PROVIDER=ollama
LOCAL_LLM_MODEL=<the tag you pulled>
# ANTHROPIC_API_KEY is no longer needed.
```
Every scoring/explanation call now routes to Ollama's OpenAI-compatible endpoint, with grammar-constrained JSON so a local model stays parseable. Any OpenAI-compatible server works (LM Studio, vLLM, llama.cpp) — set `LLM_BASE_URL` to its `/v1` URL.

### Fully offline

**Embeddings are a SEPARATE setting from the LLM.** `LLM_PROVIDER=ollama` only moves the scoring/explanation calls — it does **not** move the query embedding. By default that tiny embedding still uses OpenAI (the corpus ships pre-embedded at 512 dims; it costs fractions of a cent), and if `OPENAI_API_KEY` is missing or still the `.env.example` placeholder you'll get a clear error rather than a hosted call. `npm run setup:local` sets this up for you; to do it by hand, pull a local embedding model and re-embed the corpus with it:
```bash
ollama pull nomic-embed-text
# add these two lines to scaffold/.env.local:
EMBEDDINGS_BASE_URL=http://localhost:11434/v1
EMBEDDINGS_MODEL=nomic-embed-text
# then just run (data:embed reads scaffold/.env.local — no inline env needed):
npm run data:embed        # re-embeds the 968-opportunity corpus locally
```
Now nothing leaves your machine.

### The honest tradeoff

Hosted Claude is faster and more reliable at the strict, structured JSON this pipeline asks for, and its scoring is better calibrated. A capable local model still handles it — verified end to end on macOS (`qwen2.5:14b`, 32GB RAM: 3:43 for an 18-candidate search) and Linux (`llama3.2:1b`, 2 vCPU/8GB/no GPU: 18:58–20:43 for 21 candidates, depending on distro), both fully local with real matches. Two caveats:
- **It's much slower on modest hardware.** A CPU-only, small-memory box serves scoring batches one at a time — the Linux number above is close to worst-case. A GPU or more RAM (the macOS number) closes most of that gap. Local runs use two-stage scoring — a score-only pass over all candidates, then full write-ups for the top 8 — tunable with `E3_TWO_PASS_TOP_N` (`NEXT_PUBLIC_FLAG_E3_TWO_PASS=false` writes up every candidate instead); raise `LOCAL_LLM_TIMEOUT_MS` (default 30 min per call) if a big model needs longer.
- **Quality is rougher.** Smaller or older models score less consistently and occasionally emit JSON even the repair layer can't recover. Use a strong instruction-following model, and expect a coarser result than the hosted default.

It's a real option for privacy or zero-cost runs, just not the fast path.

## Feature flags (turn on the good stuff)

Everything risky ships **default-OFF** so a fresh clone is safe and boring. Flip these in `.env.local` (they're `NEXT_PUBLIC_*`, so **restart `npm run dev` after changing them**):

| Flag | What it turns on |
|---|---|
| `NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER=true` | Per-match **recommend / verify / do-not-recommend** verdicts, a whole-map verdict, and rubric-anchored scoring. |
| `NEXT_PUBLIC_MOCK_AUTH=true` | A localStorage-only **mock** sign-in, to demo the login loop without real OAuth. |
| `NEXT_PUBLIC_FLAG_R9_SUPABASE_AUTH=true` | **Real** Google sign-in via Supabase (see next section). Wins over mock auth if both are on. |

**Competitor & market analysis** (`/api/competitors`) is **on by default** in the template — add `EXA_API_KEY` for richer web competitors, or set `NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=false` to turn it off.

**"How can I apply?"** is a plain, read-only reference on every match: key dates, documents to prepare, questions to answer, and next steps — read straight off that program's own listing plus generic guidance for its kind. No form, no LLM call, nothing to submit.

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
   - **Site URL:** `http://localhost:3000`.
   - **Redirect URLs:** add `http://localhost:3000/**`.
6. Restart `npm run dev` and sign in. The app requests OAuth with `redirectTo = <origin>/auth/callback`, so it follows whatever origin it's served from. You only ever update the **Supabase** redirect allowlist, never Google.

> **Common gotcha:** if sign-in bounces to the wrong URL, it's almost always Supabase's *Site URL / Redirect URLs* pointing somewhere other than `http://localhost:3000`. Update them there.

## Chrome extension (assisted fill, experimental, not currently wired up)

An optional companion extension (`extension/`, "Granted Assisted Fill") is built to pre-fill a grant portal's application form **in your own authenticated browser session**, from a `.granted.json` package. Think of it like a password manager for grant forms: it would fill what it can ground, flag what it can't, and let you step through the portal's own sections. **It never submits, signs, certifies, or files anything** — a human always reviews and clicks the portal's own submit button.

**Load it into Chrome:**
```bash
cd extension
npm install
npm run build            # emits a loadable extension into extension/dist/
```
Then in Chrome (or any Chromium browser): open `chrome://extensions` → turn on **Developer mode** (top-right) → **Load unpacked** → select **`extension/dist/`** (the *build output* — **not** the `extension/` folder itself; the manifest is generated into `dist/` by the build, so pointing Chrome at `extension/` gives *"manifest file not found or unreadable"*). The "Granted Assisted Fill" icon appears in the toolbar. After code changes, re-run `npm run build` and hit reload on the extension's card.

Portal field selectors (grants.gov, NIH ASSIST, Research.gov, SBIR.gov) are still `TODO:` placeholders, so today the extension loads and validates a package but fills nothing. Test the import with the bundled sample, [`extension/example.granted.json`](extension/example.granted.json).

## Refreshing the data (optional)

The corpus (`scaffold/data/opportunities.json`, 968 opportunities across grants.gov, SAM.gov, SBIR, USAspending) is committed, so you don't need this to run. To rebuild it from the live public sources:

```bash
cd scaffold
npm run data:mvp        # fetch SAM assistance + SBIR + procurement, assemble
npm run data:embed      # embed everything (~1 min, <$1 of OpenAI)
npm run data:precompute # (optional) freeze the demo test cases for instant renders
```

To stay current, `npm run data:refresh` (or Settings → "Refresh cached grants") fetches every open listing, drops expired deadlines, and embeds only new/changed records into a gitignored `scaffold/data/local/` copy the running app picks up without a restart. It uses the app's embedding settings (no API key with local Ollama embeddings). Settings → "Max cached opportunities" (1,000–20,000, default 1,000) or `CORPUS_MAX` caps its size.

---

## How it works

1. **Intake.** Describe your company in natural language; Claude extracts a structured profile + expands it into government vocabulary.
2. **Retrieval.** OpenAI embeddings + in-memory cosine similarity over the 968-opportunity corpus (no vector DB); per-type quotas keep every instrument reachable.
3. **Scoring.** Claude scores each candidate 0–100 on the criteria a program officer would apply, with a met/unmet checklist and plain-language explanations.
4. **Eligibility screen.** A rules layer buckets eligibility from *stated* facts; it never turns a model guess into an exclusion.
5. **Discernment** *(flag)*. Recommend / verify / **don't-recommend** per match, plus a whole-map verdict, so a weak idea gets an honest "don't apply" instead of a wall of maybes.
6. **When nothing fits.** That's a first-class finding with real redirects, so even a weak-field run points you somewhere useful.

Results **stream**. Progress and grounded evidence appear in seconds rather than behind a frozen spinner.

## Project structure

```
.
├── README.md                     (this file)
├── LICENSE
├── supabase/migrations/          (optional corpus-store schema)
├── extension/                    (optional Chrome "assisted fill" extension — experimental)
└── scaffold/                     (the Next.js app)
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
- **A flag change did nothing** → `NEXT_PUBLIC_*` vars are read at build/start; restart the dev server.
- **Sign-in redirects to the wrong place** → fix Supabase → *Authentication → URL Configuration* (Site URL + Redirect URLs).
- **Port 3000 in use** → Next picks the next free port; watch the `npm run dev` output for the URL. If `localhost:3000` shows a different app (on Windows, an app listening on all interfaces doesn't block the `127.0.0.1` bind), pick a port: `npm run dev -- -p 3001`.
- **Can't reach it from another device or a cloud VM** → `npm run dev` only listens on `127.0.0.1`. From a remote box, tunnel instead: `ssh -L 3000:127.0.0.1:3000 you@host`, then open `http://localhost:3000`. Use `npm run dev:lan` only on a network you trust.

---

**Built with:** Next.js · TypeScript · Tailwind · OpenAI (embeddings) · Anthropic Claude (scoring & explanations) · Supabase (optional auth).

**License:** see [LICENSE](LICENSE).
