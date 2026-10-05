# Granted: government opportunity finder

<img width="979" height="965" alt="image" src="https://github.com/user-attachments/assets/2c3b54ae-9e96-4436-881f-cd691c1e774b" />

**Granted** turns a description of your business or research into a list of real **government funding opportunities** — federal grants, SBIR/STTR R&D, procurement, loans, assistance, scholarships, plus state grant programs in California, Illinois, and North Carolina. Each match is scored for fit on the criteria a program officer would apply, and screened for eligibility.

Run it with your own API keys or a fully local model — see **Run it yourself** below.

---

# Run it yourself

`npm run dev` listens only on your machine; `npm run dev:lan` opts in to exposing it to your local network.

Every OS below ends up running the exact same `npm` commands — the setup scripts detect your platform automatically. Only the prerequisite installs (Node, git, Ollama) differ, so pick yours:

## Install on macOS

*The app's local-model flow is verified end to end on a 32GB Mac: auto-picked `qwen2.5:14b` and completed a full novel-company search (18 candidates, fully local, zero API calls) in **3 minutes 43 seconds**. `install-macos.sh` is separately verified on a 2015 MacBook Pro (Intel i7-4770HQ, 16GB, macOS 12.7.6) — the oldest realistic case, which forces the Ollama CLI-tarball path described below — and on a clean macOS 15 (Sequoia) VM with nothing pre-installed, both with Homebrew already present and with no Homebrew and no terminal to prompt through (the one-liner bootstraps Homebrew itself in that case): `llama3.2:3b` on 4 vCPU/8GB completed a full novel-company search in 13m36s, fully local, zero API calls.*

**1. Install prerequisites + clone (one command)**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh)"
```
Installs Node 22+ and git if missing — via Homebrew where available, otherwise the Xcode Command Line Tools for git and the official nodejs.org `.pkg` for Node — clones the repo into `./granted`, runs `npm ci`, and installs Ollama with the method your macOS version actually supports (see the note below). Safe to re-run.

Prefer to do it by hand?
```bash
brew install node git             # Node 22+; or from https://nodejs.org, git via xcode-select --install
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
npm install
```

**2. cloud models (one OpenAI key; Claude optional)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `OPENAI_API_KEY` (and, optionally, `ANTHROPIC_API_KEY` to have Claude do the scoring) — see **What you need** below for where to get them.

**3. Fully local (Ollama, no API keys)**
```bash
brew install ollama                 # already done if install-macos.sh found Homebrew; or https://ollama.com/download
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
Installs Node 22+ and git if missing — via `winget` where available, otherwise a direct official-installer download (winget isn't present on every Windows box, notably Windows Server, which this was verified against) — clones the repo into `.\granted`, and runs `npm ci`. Safe to re-run.

Prefer to do it by hand?
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
No `winget`? Grab [Node 22+](https://nodejs.org) and [git](https://git-scm.com/download/win) directly instead. PowerShell (default on Windows 10/11) or Git Bash both work with everything below.

**2. Search your own company — hosted (one OpenAI key; Claude optional)**
```powershell
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `Copy-Item .env.example .env.local` (PowerShell) or `cp .env.example .env.local` (Git Bash), then edit `scaffold/.env.local` and set `OPENAI_API_KEY` (and, optionally, `ANTHROPIC_API_KEY` to have Claude do the scoring) — see **What you need** below.

**3. Fully local (Ollama, no API keys)**
```powershell
# No Ollama yet? setup:local installs it via winget (or get it at https://ollama.com/download).
npm run setup:local -- --yes        # picks a model sized for your RAM/VRAM, pulls it, re-embeds the corpus
npm run dev
```

**4. Run it in the background, from a shortcut (optional)**

Instead of keeping a terminal open for `npm run dev`, Granted can run hidden in the background with an icon by the clock. The GUI installer offers this. Its "Installation complete" screen has **Desktop** and **Start menu** shortcut boxes, and "Open Granted" starts it this way. To add the shortcuts by hand:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\shortcuts.ps1 -Desktop -StartMenu
```
- **The Granted shortcut** starts Granted if it isn't already running, then opens it. Nothing starts at sign-in.
- **Its own window:** Granted opens like an app, in an Edge window with no tabs or address bar and its own taskbar entry (Edge's app mode, `msedge --app=…`; Chrome if there's no Edge). To use a normal browser tab instead, untick **Open in its own window** in the tray icon's menu or on the installer's last screen. The choice is saved in `%LOCALAPPDATA%\Granted\settings.json`. Links to other sites still open in a regular browser window.
- **The Granted icon by the clock** has a right-click menu: **Open Granted**, its status, **Open in its own window**, **Show log** (the server output, in `%LOCALAPPDATA%\Granted\logs`), **Restart** and **Quit Granted**. Quitting stops the server.
- **No window, even on Windows 11:** the shortcut runs `scripts\windows\granted-tray.ps1` through `conhost.exe --headless`. A plain `powershell -WindowStyle Hidden` still opens a visible Windows Terminal window when Windows Terminal is the default console host, as it is by default on Windows 11.

## Install on Linux

**1. Install prerequisites + clone (one command)**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh)"
```
Installs git and Node 22+ if missing (supports `apt`, `dnf`, and `yum` — verified end to end on both Ubuntu and Amazon Linux 2023), clones the repo into `./granted`, and runs `npm ci`. Safe to re-run.

On a distro it doesn't cover, or prefer to do it by hand?
```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
# Amazon Linux 2023 / Fedora / RHEL
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs git   # older releases: sudo yum install -y nodejs git

git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
Both install Node 22, which is also what the one-shot script installs — see **Which Node version** below for why 22 and not 20.

**3. Search your own company — hosted (one OpenAI key; Claude optional)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `OPENAI_API_KEY` (and, optionally, `ANTHROPIC_API_KEY` to have Claude do the scoring) — see **What you need** below.

**3. Fully local (Ollama, no API keys)**
```bash
curl -fsSL https://ollama.com/install.sh | sh
npm run setup:local -- --yes        # picks a model sized for your RAM, pulls it, re-embeds the corpus
npm run dev
```
Verified end to end via `install-linux.sh` on a fresh Amazon Linux 2023 box (2 vCPU, 8GB RAM, no GPU — the smallest realistic case): auto-picked `llama3.2:1b` and completed a full novel-company search (21 candidates, fully local) in **18 minutes 58 seconds**. The same flow on Ubuntu, same hardware class, ran comparably (20m43s). A machine with a GPU or more cores will be dramatically faster — the macOS and Windows numbers above are the same engine, just more hardware.

## Which Node version

**Running** Granted needs Node 20+. **Developing** it needs **Node 22+**, and the
installers above give you 22 so you are never caught out by the difference.

The split is real: `npm test` hands glob patterns to Node's built-in test
runner, and glob expansion only arrived in **Node 22**. On Node 20 the runner
takes the pattern literally and exits without running a single test:

```
Could not find '/…/scaffold/lib/**/__tests__/**/*.test.ts'
```

Nothing about the app itself requires 22 — `npm install`, `npm run typecheck`
and `npm run dev` are all fine on 20, which is why `engines` still allows it.
CI runs the suite on Node 22 and 24.

## What you need (and where to get it)

| Thing | Required? | Where | Notes |
|---|---|---|---|
| **OpenAI API key** | **The one key you need** for your own searches (the 4 samples work without any keys) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Search embeddings (`text-embedding-3-small`), pennies per search. With no Anthropic key it also does the scoring (`gpt-4o-mini`). A Claude key alone can't search — Anthropic has no embeddings API — so without an OpenAI key, use local models (`npm run setup:local`). |
| **Anthropic API key** | Optional (recommended) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude: scoring + explanations. A novel search runs ~$0.05–0.33. Or pick another provider in **Settings → Model → Cloud** (OpenAI, Gemini, OpenRouter, Groq, Mistral, or any OpenAI-compatible URL) and paste its key or point to an env var / secret file. No paid key? Run [Free Claude Code](https://github.com/KurtLehnardt/free-claude-code-secure) and pick **Anthropic-compatible proxy** (defaults to `http://127.0.0.1:8082` and `~/.fcc/proxy_auth_token`). Prompts are tuned on Claude. |
| **Exa API key** | Optional | [dashboard.exa.ai](https://dashboard.exa.ai) | Only for the deep competitor analysis' *live web* results. Without it, that feature degrades honestly to federal awardees only. |

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

Search also embeds your description and compares it against the corpus, and the shipped corpus is embedded with OpenAI (512 dims). A local model can't search that corpus until the corpus is re-embedded with the same local model. **Picking Local in Settings → Model handles this for you.** In the background, Granted:

1. checks that Ollama is running and pulls the `nomic-embed-text` embedding model if you don't have it,
2. re-embeds the corpus with it into a separate, gitignored index (`scaffold/data/local/local-embeddings/`). This takes from a few minutes to half an hour, depending on your machine.
3. switches search to that index only once it's complete.

Settings shows the progress, and any failure in plain language (Ollama not running, the download failed or stalled, embedding failed or stalled) with a **Retry** button. Until the index is ready, searches on Local can't run yet; your hosted setup is never touched. Switch back to a Cloud model and search goes straight back to hosted OpenAI embeddings and the original corpus. Switch to Local again later and the finished index is reused. After **Refresh cached grants** on Local, the index is updated in the background, re-embedding only new or changed grants. (The refresh itself still embeds the hosted corpus with OpenAI, so it needs `OPENAI_API_KEY`.) Run the setup from a terminal instead with `node --import tsx scripts/local-embeddings-job.mjs` (in `scaffold/`); its output goes to `scaffold/data/local/local-embeddings-job.log`.

This automatic setup is for Ollama. If your local model runs on another OpenAI-compatible server (`LLM_PROVIDER=openai` or `local`, e.g. LM Studio), Settings tells you to configure embeddings by hand, as below.

**Configuring `.env.local` by hand** (or via `npm run setup:local`) still works, and an `EMBEDDINGS_BASE_URL` there always wins over Settings. `LLM_PROVIDER=ollama` alone only moves the scoring/explanation calls, not the query embedding. If `OPENAI_API_KEY` is missing or still the `.env.example` placeholder, you'll get a clear error rather than a hosted call. To do it by hand, pull a local embedding model and re-embed the corpus with it:
```bash
ollama pull nomic-embed-text
# add these two lines to scaffold/.env.local:
EMBEDDINGS_BASE_URL=http://localhost:11434/v1
EMBEDDINGS_MODEL=nomic-embed-text
# then just run (data:embed:local reads scaffold/.env.local — no inline env needed):
npm run data:embed:local  # re-embeds the 4,698-opportunity corpus into the gitignored data/local/
```
Now nothing leaves your machine.

### The tradeoff

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

**Competitor & market analysis** (`/api/competitors`) is **on by default** in the template — add `EXA_API_KEY` for richer web competitors, or set `NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=false` to turn it off.

**"How can I apply?"** is a plain, read-only reference on every match: key dates, documents to prepare, questions to answer, and next steps — read straight off that program's own listing plus generic guidance for its kind. No form, no LLM call, nothing to submit.

The full flag list lives in `scaffold/lib/flags/registry.ts`.

## Refreshing the data (optional)

The corpus (`scaffold/data/opportunities.json`, which contains opportunities across grants.gov, SAM.gov assistance listings, and state grant programs in California, Illinois, and North Carolina) is committed, so you don't need this to run. To rebuild it from the live public sources:

```bash
cd scaffold
npm run data:mvp        # fetch SAM assistance, assemble
npm run data:embed      # embed everything (~1 min, <$1 of OpenAI)
npm run data:precompute # (optional) freeze the demo test cases for instant renders
```

To stay current, `npm run data:refresh` (or Settings → "Refresh cached grants") fetches every open listing, drops expired deadlines, and embeds only new/changed records into a gitignored `scaffold/data/local/` copy the running app picks up without a restart. It uses the app's embedding settings (no API key with local Ollama embeddings). Settings → "Max cached opportunities" (1,000–20,000, default 1,000) or `CORPUS_MAX` caps its size.

---

## How it works

1. **Intake.** Describe your company in natural language; Claude extracts a structured profile + expands it into government vocabulary.
2. **Retrieval.** OpenAI embeddings + in-memory cosine similarity over the 4,698-opportunity corpus (no vector DB); per-type quotas keep every instrument reachable.
3. **Scoring.** Claude scores each candidate 0–100 on the criteria a program officer would apply, with a met/unmet checklist and plain-language explanations.
4. **Eligibility screen.** A rules layer buckets eligibility from *stated* facts; it never turns a model guess into an exclusion.
5. **Discernment** *(flag)*. Recommend / verify / **don't-recommend** per match, plus a whole-map verdict, so a weak idea gets an honest "don't apply" instead of a wall of maybes.
6. **When nothing fits.** That's a first-class finding with real redirects, so even a weak-field run points you somewhere useful.

Results **stream**. Progress and grounded evidence appear in seconds rather than behind a frozen spinner.

## Troubleshooting

- **`OPENAI_API_KEY is not set`** → add it to `scaffold/.env.local` and restart `npm run dev`.
- **Anthropic 400 "credit balance too low"** → top up at console.anthropic.com; every search spends credits.
- **A flag change did nothing** → `NEXT_PUBLIC_*` vars are read at build/start; restart the dev server.
- **`npm test` prints `Could not find '…/**/*.test.ts'` and runs nothing** → you're on Node 20. The test runner only learned to expand globs in Node 22; upgrade to 22+ (see **Which Node version**). Running the app is unaffected.
- **Port 3000 in use** → Next picks the next free port; watch the `npm run dev` output for the URL. If `localhost:3000` shows a different app (on Windows, an app listening on all interfaces doesn't block the `127.0.0.1` bind), pick a port: `npm run dev -- -p 3001`.
- **Can't reach it from another device or a cloud VM** → `npm run dev` only listens on `127.0.0.1`. From a remote box, tunnel instead: `ssh -L 3000:127.0.0.1:3000 you@host`, then open `http://localhost:3000`. Use `npm run dev:lan` only on a network you trust.

---

**Built with:** Next.js · TypeScript · Tailwind · OpenAI (embeddings) · Anthropic Claude (scoring & explanations).

**License:** see [LICENSE](LICENSE).
