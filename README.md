# Granted: government opportunity finder

<img width="979" height="965" alt="image" src="https://github.com/user-attachments/assets/2c3b54ae-9e96-4436-881f-cd691c1e774b" />

**Granted** turns a description of your business or research into a list of real **government funding opportunities** — federal grants, SBIR/STTR R&D, procurement, loans, assistance, scholarships, plus state grant programs in California, Illinois, and North Carolina. Each match is scored for fit on the criteria a program officer would apply, and screened for eligibility.

Run it with your own API keys or a fully local model — see **Run it yourself** below.

---

# Run it yourself

`npm run dev` listens only on your machine; `npm run dev:lan` opts in to exposing it to your local network.

Every OS below ends up running the exact same `npm` commands — the setup scripts detect your platform automatically. Only the prerequisite installs (Node, git, Ollama) differ, so pick yours:

## Quick links

- **[Windows](#install-on-windows)** — most users start here: [GUI installer](#windows-gui-installer) · [command line](#windows-command-line) · [cloud models](#windows-cloud-models) · [fully local](#windows-fully-local) · [run in the background](#windows-run-in-the-background)
- **[macOS](#install-on-macos)** — [GUI installer](#macos-gui-installer) · [command line](#macos-command-line) · [cloud models](#macos-cloud-models) · [fully local](#macos-fully-local)
- **[Linux](#install-on-linux)** — [command line](#linux-command-line) · [cloud models](#linux-cloud-models) · [fully local](#linux-fully-local)

**4. Run it in the background, from a launcher (optional)**

Instead of keeping a Terminal open for `npm run dev`, Granted can run hidden in the background with an icon in the menu bar. The GUI installer offers this: its "Installation complete" screen has an **Add to Dock** box, and "Open Granted" starts it this way. To add the launcher by hand:
```bash
bash scripts/macos/applications-launcher.sh install --add-to-dock
```
- **The Granted launcher** (`~/Applications/Granted.app`, per-user, no admin needed) starts Granted if it isn't already running, then opens it. **Nothing starts at login:** the server runs under a per-user LaunchAgent (`com.granted.server`) written with `RunAtLoad` off and no `KeepAlive`, so it is started when you open Granted and stopped when you quit it — the same as on Windows.
- **Its own window:** Granted opens like an app, in a Chrome (or Edge) window with no tabs or address bar and its own Dock entry (app mode, `--app=…`). With neither browser installed it opens in your default browser, which on a stock Mac is Safari. To use a normal browser tab instead, untick **Open in its own window** in the menu-bar menu or on the installer's last screen. The choice is saved in `~/Library/Application Support/Granted/settings.json` — the same `openIn` key Windows uses in its own settings file.
- **The Granted icon in the menu bar** has a menu: **Open Granted**, its status, **Open in its own window**, **Show log** (the server output, in `~/Library/Logs/Granted/`), **Restart**, **Uninstall Granted…** and **Quit Granted**. Quitting stops the server. Every item carries a VoiceOver label.
- **Updates:** **Settings → About Granted** shows the version, with **Check for updates**. On an install made by the installer, **Update to vX.Y.Z** updates in place: it runs `scripts/macos/update.sh` detached (so it survives Granted being stopped), quits Granted, installs the release, rolls back if that fails, and restarts Granted on the same port; the page reloads on the new version. **Install updates automatically** does the same when Granted is opened, at most every 6 hours. A developer checkout is told to `git pull` instead, and is never changed.
- **Uninstalling:** macOS has no "Installed apps" list, so uninstall is offered in two places: **Uninstall Granted…** in the menu-bar menu, and **Settings → About Granted** in the app. Either one:
  - quits Granted and removes its LaunchAgent, menu-bar helper, `~/Applications` launcher and Dock entry;
  - removes its folder, settings and logs;
  - first offers to save a copy of your API keys and local-model settings to your Documents folder (on by default).

  Homebrew, git and Node stay installed. It refuses to delete a Granted folder that its own installer didn't create (no `.git/granted-installer` marker), and asks again if the folder holds work that isn't on GitHub. From the command line: `bash scripts/macos/uninstall.sh` (add `--quiet` to skip the questions, `--check` to see what it would do and change nothing).
- **No menu-bar icon?** The icon is a small native Swift helper, built on first start, which needs the Xcode Command Line Tools: `xcode-select --install`. Without them Granted still runs in the background under launchd — there's just no icon, and `~/Library/Logs/Granted/tray.log` says so.

## Install on Windows

#### Windows GUI installer

**Easiest: download the installer.** Get **Granted-Setup-x.y.z.exe** from the [latest release](https://github.com/KurtLehnardt/granted/releases/latest) and double-click it.
- **SmartScreen warning:** the installer isn't code-signed yet, so Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**.
- **What it does:** it walks you through everything. It installs Git and Node.js if they're missing, then installs Granted, offers Desktop and Start menu shortcuts, and can open Granted for you. Uninstall it from **Settings → Apps → Installed apps**.
- **Which version:** each installer installs its own release. With **"Check for and install the latest version of Granted"** ticked (the default), it installs a newer release instead, if there is one. Run a newer installer over an existing install to update it.

#### Windows command line

Prefer the command line? The steps below do the same thing, from `main`.

*The app's local-model flow is verified end to end on Windows 11 (HP ZBook, 32GB RAM, 4GB Quadro P1000): qwen2.5:3b + nomic-embed-text, fully local, a novel-company search scoring 34 candidates completed in 7m33s. `install-windows.ps1` itself is separately verified on a fresh Windows Server 2022 box with no `winget` present, forcing the direct-download fallback path for both Node and git.*

**1. Install prerequisites + clone (one command, PowerShell)**
```powershell
irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
```
Installs Node 22+ and git if missing — via `winget` where available, otherwise a direct official-installer download (winget isn't present on every Windows box, notably Windows Server, which this was verified against) — clones the repo into `.\granted` and runs `npm ci`. It then:
- adds the Microsoft Visual C++ runtime if it's missing (the built-in search model needs it);
- downloads the search model;
- adds Granted to **Installed apps**.

Safe to re-run.

Prefer to do it by hand?
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
No `winget`? Grab [Node 22+](https://nodejs.org) and [git](https://git-scm.com/download/win) directly instead. PowerShell (default on Windows 10/11) or Git Bash both work with everything below.

#### Windows cloud models

**2. Search your own company — hosted (one key for scoring: Claude or OpenAI)**
```powershell
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `Copy-Item .env.example .env.local` (PowerShell) or `cp .env.example .env.local` (Git Bash), then edit `scaffold/.env.local` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for the scoring. Search itself needs no key — see **What you need** below.

#### Windows fully local

**3. Fully local (Ollama, no API keys)**
```powershell
# No Ollama yet? setup:local installs it via winget (or get it at https://ollama.com/download).
npm run setup:local -- --yes        # picks a model sized for your RAM/VRAM and pulls it
npm run dev
```

#### Windows run in the background

**4. Run it in the background, from a shortcut (optional)**

Instead of keeping a terminal open for `npm run dev`, Granted can run hidden in the background with an icon by the clock. The GUI installer offers this. Its "Installation complete" screen has **Desktop** and **Start menu** shortcut boxes, and "Open Granted" starts it this way. To add the shortcuts by hand:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\shortcuts.ps1 -Desktop -StartMenu
```
- **The Granted shortcut** starts Granted if it isn't already running, then opens it. Nothing starts at sign-in.
- **Its own window:** Granted opens like an app, in an Edge window with no tabs or address bar and its own taskbar entry (Edge's app mode, `msedge --app=…`; Chrome if there's no Edge). To use a normal browser tab instead, untick **Open in its own window** in the tray icon's menu or on the installer's last screen. The choice is saved in `%LOCALAPPDATA%\Granted\settings.json`. Links to other sites open in a regular Edge (or Chrome) window, not in your default browser.
- **The Granted icon by the clock** has a right-click menu: **Open Granted**, its status, **Open in its own window**, **Show log** (the server output, in `%LOCALAPPDATA%\Granted\logs`), **Restart** and **Quit Granted**. Quitting stops the server.
- **Updates:** **Settings → About Granted** shows the version, with **Check for updates**. On an install made by the installer, **Update to vX.Y.Z** updates in place: Granted closes, installs the release, reopens, and the page reloads. **Install updates automatically** does the same when Granted is opened, at most every 6 hours. A developer checkout is told to `git pull` instead, and is never changed.
- **Uninstalling:** the install adds Granted to **Settings → Apps → Installed apps** (per-user, no admin needed). **Uninstall** there:
  - quits Granted;
  - removes its shortcuts, its folder and its settings and logs;
  - first offers to save a copy of your API keys to your Documents folder.

  Git and Node stay installed. If a program is still using the folder, nothing is deleted and it says so. From PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1` (add `-Quiet` to skip the questions). An install made before this existed shows up after re-running the installer, or: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1 -Register`.
- **No window, even on Windows 11:** the shortcut runs `scripts\windows\granted-tray.ps1` through `conhost.exe --headless`. A plain `powershell -WindowStyle Hidden` still opens a visible Windows Terminal window when Windows Terminal is the default console host, as it is by default on Windows 11.

## Install on macOS

#### macOS GUI installer

**Easiest: download the installer.** Get **Granted-Setup-x.y.z-arm64.dmg** from the [latest release](https://github.com/KurtLehnardt/granted/releases/latest), open it, and drag **Granted Setup** to your **Applications** folder. **Apple Silicon only** (M1 and later) — there's no Intel build.

- **Gatekeeper, the first time.** The installer isn't signed by an Apple Developer account, so macOS blocks its first launch. Recent macOS versions removed the old right-click → **Open** shortcut, so this is the way through:
  1. Open **Granted Setup** from Applications. Nothing opens — macOS says it blocked the app.
  2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. It names Granted Setup as having been blocked, with an **Open Anyway** button.
  3. Click **Open Anyway** and confirm with Touch ID or your password. The app opens, and opens normally from then on.

  Advanced fallback, if you'd rather not go through System Settings: `xattr -dr com.apple.quarantine "/Applications/Granted Setup.app"` clears the download flag, after which it opens directly. Only do that for a file you downloaded yourself and trust.
- **What it does:** it walks you through everything. It checks for git and Node.js and installs them if they're missing (Homebrew where you have it, otherwise the Xcode Command Line Tools for git and the official nodejs.org package for Node), then clones and installs Granted into `~/granted`, downloads the built-in search model, and can open Granted for you. The install itself runs in a Terminal window the wizard opens and watches; the window closes itself when it's done, and stays open if something failed.
- **Which version:** each installer installs its own release. Running a newer installer over an existing install updates it, and never moves it backwards. It will not touch a Granted folder you cloned yourself — only one its own installer made.
- **After it's installed:** a **Granted** launcher in `~/Applications` (no admin needed), optionally added to your Dock from the last screen of the wizard. Everything below under **Run it in the background** applies.

#### macOS command line

*The app's local-model flow is verified end to end on a 32GB Mac: auto-picked `qwen2.5:14b` and completed a full novel-company search (18 candidates, fully local, zero API calls) in **3 minutes 43 seconds**. `install-macos.sh` is separately verified on a 2015 MacBook Pro (Intel i7-4770HQ, 16GB, macOS 12.7.6) — the oldest realistic case, which forces the Ollama CLI-tarball path described below — and on a clean macOS 15 (Sequoia) VM with nothing pre-installed, both with Homebrew already present and with no Homebrew and no terminal to prompt through (the one-liner bootstraps Homebrew itself in that case): `llama3.2:3b` on 4 vCPU/8GB completed a full novel-company search in 13m36s, fully local, zero API calls. The `.dmg` itself is built and Gatekeeper-tested on an M1 MacBook running macOS 27.0.1 (arm64) — the app bundle is native arm64 with no Rosetta prompt. The Gatekeeper behaviour above is what macOS actually did with a freshly quarantined copy of that build — blocked, terminated, and recorded for the **Open Anyway** button; the `xattr` fallback was confirmed to let it launch. The **Open Anyway** click itself was not exercised (it needs an administrator confirmation), and no release carrying a `.dmg` has been published yet: the asset appears from the first release tagged after this landed.*

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

#### macOS cloud models

**2. cloud models (one key for scoring: Claude or OpenAI)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for the scoring. Search itself needs no key — see **What you need** below.

#### macOS fully local

**3. Fully local (Ollama, no API keys)**
```bash
brew install ollama                 # already done if install-macos.sh found Homebrew; or https://ollama.com/download
npm run setup:local -- --yes        # picks a model sized for your RAM and pulls it
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

## Install on Linux

#### Linux command line

**1. Install prerequisites + clone (one command)**
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh)"
```
Installs git and Node 22+ if missing (supports `apt`, `dnf`, `yum`, and `pacman` — verified end to end on Ubuntu and Amazon Linux 2023), clones the repo into `./granted`, and runs `npm ci`. Safe to re-run.

On a distro it doesn't cover, or prefer to do it by hand?
```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
# Amazon Linux 2023 / Fedora / RHEL
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs git   # older releases: sudo yum install -y nodejs git
# Arch Linux
sudo pacman -Sy --needed nodejs npm git

git clone https://github.com/KurtLehnardt/granted.git
cd granted/scaffold
```
Both install Node 22, which is also what the one-shot script installs — see **Which Node version** below for why 22 and not 20.

#### Linux cloud models

**2. Search your own company — hosted (one key for scoring: Claude or OpenAI)**
```bash
npm run setup      # interactive: writes .env.local, collects your keys
npm run dev
```
Or by hand: `cp .env.example .env.local`, then edit `scaffold/.env.local` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for the scoring. Search itself needs no key — see **What you need** below.

#### Linux fully local

**3. Fully local (Ollama, no API keys)**
```bash
curl -fsSL https://ollama.com/install.sh | sh
npm run setup:local -- --yes        # picks a model sized for your RAM and pulls it
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
| **A scoring key** | **One** for your own searches: Anthropic **or** OpenAI (or another provider in Settings, or a local model). The 4 samples work without any keys. | below | Search itself needs no key: it runs on a built-in model on your computer (see **How search works** below). |
| **Anthropic API key** | Either this or OpenAI's (recommended) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Claude: scoring + explanations. A novel search runs ~$0.05–0.33. Or pick another provider in **Settings → Model → Cloud** (OpenAI, Gemini, OpenRouter, Groq, Mistral, or any OpenAI-compatible URL) and paste its key or point to an env var / secret file. No paid key? Run [Free Claude Code](https://github.com/KurtLehnardt/free-claude-code-secure) and pick **Anthropic-compatible proxy** (defaults to `http://127.0.0.1:8082` and `~/.fcc/proxy_auth_token`). Prompts are tuned on Claude. |
| **OpenAI API key** | Either this or Anthropic's | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Scoring with `gpt-4o-mini` when there's no Claude key. When it's set, search also uses OpenAI's embeddings (`text-embedding-3-small`, pennies per search), as it always has; `SEARCH_EMBEDDINGS=builtin` keeps search on your computer instead. |
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

### How search works (and why it needs no key)

Search embeds your description and compares it with every program in the corpus. That runs on a **built-in model, on your computer**: [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (fp16 ONNX, about 275 MB, run in the app by `@huggingface/transformers`). The corpus's vectors for it ship with Granted (`scaffold/data/vectors/`), so there is nothing to re-embed. No key, no per-search cost, and once the model is downloaded it works offline.

- **The model download.** The installers fetch it into `scaffold/models/` (gitignored) right after `npm ci`. If that didn't happen, the first search downloads it (Settings → Model shows the progress, with a **Download now** button), or run `npm run model:fetch`. The files are pinned to one Hugging Face revision and checked against SHA-256 checksums. At runtime the app only loads from `scaffold/models/`; it never fetches a model from the internet by itself except for that one download.
- **Behind a proxy or firewall.** The download uses Node's built-in `fetch`, which ignores `HTTPS_PROXY`. Point `GRANTED_MODEL_URL` at a mirror holding the same files instead (it fetches `<GRANTED_MODEL_URL>/onnx/model_fp16.onnx` and so on; the checksums still apply), or copy a `scaffold/models/` folder from another machine.
- **On Windows** the model needs the Microsoft Visual C++ runtime. The Windows installer adds it when it's missing (through winget, or Microsoft's own installer; it may ask for Administrator rights). Without it, the search model can't start.
- **If the model can't be downloaded or started**, search doesn't fail: it falls back to keyword matching and says so above the results ("Search is running in keyword-only mode: …"), and the Search line in Settings shows the reason with a **Retry** button.
- **Which embeddings search uses** is `SEARCH_EMBEDDINGS` in `scaffold/.env.local`: `auto` (the default) uses OpenAI's embeddings when a valid `OPENAI_API_KEY` is set, so existing setups behave exactly as before, and the built-in model otherwise; `builtin` always uses the built-in model; `openai` always uses OpenAI's. Settings → Model shows a **Search** line saying which one is in use.
- **With a Claude-only key** (or Gemini, Groq, OpenRouter, the Free Claude Code proxy and so on), search is built-in and that provider does the scoring.
- **On Local (Ollama)**, search is built-in too. Its vectors are the same ones Ollama's `nomic-embed-text` produces, so one shipped corpus serves both, and Local needs no embedding model pulled and no re-embedding. Nothing leaves your machine.

**How good is built-in search?** Coarser than OpenAI's embeddings, so Claude-only and Local users get somewhat different, and likely lower, recall than OpenAI users. Measured without any paid calls (`npm run eval:builtin`): the two models agree on 53.6% of each program's 24 nearest neighbours, and of the 7 strong matches in the four demo searches that are still in the corpus, 4 reach scoring through built-in retrieval (all 7 clear its similarity floor; 3 rank in its top 24). Those demo matches came from the OpenAI pipeline, so they favour it; a fair head-to-head would need paid OpenAI queries. Keyword (BM25) matching runs alongside either model. If recall matters most and you have an OpenAI key, `SEARCH_EMBEDDINGS=auto` already uses OpenAI's embeddings.

**Your own embedding server.** Setting `EMBEDDINGS_BASE_URL` / `EMBEDDINGS_MODEL` in `.env.local` still points search at any OpenAI-compatible embedder, over a corpus you re-embed with it (`npm run data:embed:local`). Setups made by an older `npm run setup:local` look like this and keep working unchanged. To switch one to the built-in model, remove those two lines, and if `.env.local` also has an OpenAI key, add `SEARCH_EMBEDDINGS=builtin` (otherwise search moves to OpenAI's embeddings, and uses the shipped grant list until you next refresh, since the refreshed copy holds the old local-model vectors).

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
npm run data:embed:builtin # vectors for the built-in search model (no key; ~40 min on a laptop CPU)
npm run data:embed      # OpenAI vectors too, for SEARCH_EMBEDDINGS=openai (~1 min, <$1 of OpenAI)
npm run data:precompute # (optional) freeze the demo test cases for instant renders
```

To stay current, `npm run data:refresh` (or Settings → "Refresh cached grants") fetches every open listing, drops expired deadlines, and embeds only new/changed records into a gitignored `scaffold/data/local/` copy the running app picks up without a restart. It embeds with whatever search uses. With the built-in model it needs no API key: new and changed records are embedded on your computer's CPU (a few hundred new grants take a few minutes; the whole corpus about 40 minutes on a laptop), and every unchanged record keeps its vector. With OpenAI it embeds only OpenAI vectors and spends no CPU on the built-in model; if you switch to the built-in model later, Granted indexes the grants that are missing in the background, and the Search line in Settings shows how many are indexed meanwhile (the rest are still found by keyword). Settings → "Max cached opportunities" (1,000–20,000, default 1,000) or `CORPUS_MAX` caps its size.

---

## How it works

1. **Intake.** Describe your company in natural language; Claude extracts a structured profile + expands it into government vocabulary.
2. **Retrieval.** Embeddings (the built-in model, or OpenAI's) + in-memory cosine similarity over the 4,698-opportunity corpus (no vector DB), plus keyword (BM25) matching; per-type quotas keep every instrument reachable.
3. **Scoring.** Claude scores each candidate 0–100 on the criteria a program officer would apply, with a met/unmet checklist and plain-language explanations.
4. **Eligibility screen.** A rules layer buckets eligibility from *stated* facts; it never turns a model guess into an exclusion.
5. **Discernment** *(flag)*. Recommend / verify / **don't-recommend** per match, plus a whole-map verdict, so a weak idea gets an honest "don't apply" instead of a wall of maybes.
6. **When nothing fits.** That's a first-class finding with real redirects, so even a weak-field run points you somewhere useful.

Results **stream**. Progress and grounded evidence appear in seconds rather than behind a frozen spinner.

## Troubleshooting

- **The installer says "Couldn't download the Granted installer from GitHub (The remote name could not be resolved: 'raw.githubusercontent.com')"** → the PC couldn't reach GitHub. It retries for about 40 seconds first. A VPN that's still connecting (or a DNS hiccup) is the usual cause: wait until you're online, then click **Try again**.
- **macOS says Granted Setup "was blocked" and nothing opens** → expected: the installer isn't signed by an Apple Developer account. Go to **System Settings → Privacy & Security → Open Anyway** (full steps under **Install on macOS**). If macOS instead calls the app **damaged**, the download didn't finish — check it against `SHA256SUMS.txt` on the release and download it again.
- **The installer's Terminal window closed before the install finished (macOS)** → the wizard notices straight away and says so. Click the button again; re-running the install is safe, and it picks up where a half-finished one left off.
- **No Granted icon in the menu bar (macOS)** → the icon needs the Xcode Command Line Tools to build its helper: `xcode-select --install`. Granted still runs in the background without it; see **Install on macOS** above.
- **`No cloud provider is configured`** → scoring needs one provider: add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `scaffold/.env.local` (then restart `npm run dev`), pick one in Settings → Model, or switch to Local.
- **"Search is running in keyword-only mode: couldn't download the search model (…)"** → run `npm run model:fetch` in `scaffold/` to see the full error. Behind a proxy or firewall, set `GRANTED_MODEL_URL` to a mirror (Node's `fetch` ignores `HTTPS_PROXY`).
- **"Search is running in keyword-only mode: the search model couldn't start because the Microsoft Visual C++ runtime is missing on this computer"** → install it from https://aka.ms/vs/17/release/vc_redist.x64.exe (or run the Granted installer again), then restart Granted.
- **"Embedding dimension mismatch"** → `.env.local` points `EMBEDDINGS_*` at a model the corpus wasn't embedded with: re-embed (`npm run data:embed:local`) or remove those settings to use the built-in model.
- **Anthropic 400 "credit balance too low"** → top up at console.anthropic.com; every search spends credits.
- **A flag change did nothing** → `NEXT_PUBLIC_*` vars are read at build/start; restart the dev server.
- **`npm test` prints `Could not find '…/**/*.test.ts'` and runs nothing** → you're on Node 20. The test runner only learned to expand globs in Node 22; upgrade to 22+ (see **Which Node version**). Running the app is unaffected.
- **Port 3000 in use** → Next picks the next free port; watch the `npm run dev` output for the URL. If `localhost:3000` shows a different app (on Windows, an app listening on all interfaces doesn't block the `127.0.0.1` bind), pick a port: `npm run dev -- -p 3001`.
- **Can't reach it from another device or a cloud VM** → `npm run dev` only listens on `127.0.0.1`. From a remote box, tunnel instead: `ssh -L 3000:127.0.0.1:3000 you@host`, then open `http://localhost:3000`. Use `npm run dev:lan` only on a network you trust.

---

**Built with:** Next.js · TypeScript · Tailwind · nomic-embed-text-v1.5 via Transformers.js (search) · Anthropic Claude (scoring & explanations).

**License:** see [LICENSE](LICENSE).

## Releasing (maintainers)

Releases publish both installers — `Granted-Setup-x.y.z.exe` for Windows and `Granted-Setup-x.y.z-arm64.dmg` for Apple Silicon macOS — through `.github/workflows/release.yml`.
1. Set `"version"` to the new version in **both** `installer/package.json` and `scaffold/package.json`, and merge that.
2. Tag `main` and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow runs one build job per platform (`windows-latest` and `macos-latest`), each of which:
- checks that the tag is on `main` and matches both versions;
- runs the installer's tests;
- builds its installer with the tag baked in, so it installs exactly that release (or a newer one, when asked);
- smoke-tests the packaged app.

A separate publish job then creates the release with both installers and their SHA-256 checksums. Neither is code-signed: Windows shows SmartScreen's "Windows protected your PC", and macOS blocks the first launch (see **Install on macOS** above for the steps through it). The macOS `.app` is given a valid *ad-hoc* signature during packaging — not a real identity, but enough that macOS treats the block as the ordinary unsigned-app one rather than as a damaged bundle. `release.yml` has a clearly marked slot in its `build-macos` job for real signing and notarization once there's a paid Apple Developer account.

To build them locally:
- Windows: `cd installer; $env:GRANTED_RELEASE_TAG='v0.2.0'; npm run dist`, which writes `installer\dist\Granted-Setup-<version>.exe`.
- macOS: `cd installer && GRANTED_RELEASE_TAG=v0.2.0 npm run dist:mac`, which writes `installer/dist/Granted-Setup-<version>-arm64.dmg`. Needs a Mac — it converts the icon with `iconutil` and signs with `codesign`.