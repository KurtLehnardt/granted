# Prompt: bring the Granted installer to macOS (Apple Silicon)

Paste everything below the line into Claude Code on the M1 MacBook. It is written for an agent that has never seen this repo before.

---

You're working on **Granted** (https://github.com/KurtLehnardt/granted). It's a Next.js app in `scaffold/` with an Electron installer wizard in `installer/`. On **Windows** the install experience is now complete and released as `Granted-Setup-x.y.z.exe`. Your job is to give **macOS on Apple Silicon (this M1 MacBook)** the same experience: a downloadable installer, the same wizard flow, background running, shortcuts, updates, uninstall, and the same level of testing, validation and robustness. Then ship it through the repo's PR and release process.

## Ground rules (hard)

- **Never touch a real Granted install.** If `~/granted` exists it's the user's own copy: don't fetch, branch, build or run anything in it. For every real-install test, set `GRANTED_INSTALL_DIR` to a throwaway name such as `granted-validate-mac-1`, and delete it afterwards.
- **Work in a fresh scratch clone** (for example `~/scratch/granted-mac`). Branch from `origin/main`.
- **This Mac is the user's machine, not a disposable VM.** Restore anything you change that isn't Granted itself:
  - Login Items or LaunchAgents you created;
  - Dock and Applications entries;
  - `defaults` you wrote;
  - Homebrew packages you installed only for testing.

  Don't turn off Gatekeeper or SIP, or loosen system security.
- **No paid API calls.** The user has no OpenAI or Anthropic credits. The app's built-in search model and Ollama need no key. For scoring tests, use Ollama, or mock the provider.
- **Report honestly:** what you verified on real hardware versus only in tests, and anything you skipped.
- **Repo workflow:**
  - one PR per coherent piece, with a review (spawn a reviewer subagent), fixes, CI green, then squash-merge;
  - no force-pushes, no branch deletion;
  - commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and PR descriptions with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Releases:**
  - Bump `"version"` in both `installer/package.json` and `scaffold/package.json` (and both lockfile root entries) in the PR.
  - After merge, tag `vX.Y.Z` on `main` and push the tag. `.github/workflows/release.yml` builds and publishes; extend it rather than replacing it.
- **Don't ask the user design questions.** Pick the option a careful engineer would recommend, note it in the PR, and keep going.

## What Windows has today (the bar to match)

Read these first; they're the reference implementation:

- **The `.exe` and its build:**
  - `installer/` is Electron + React (electron-vite), packaged by electron-builder as a portable `Granted-Setup-x.y.z.exe` (`npm run dist`).
  - The build bakes in the release tag (`GRANTED_RELEASE_TAG` → `__GRANTED_RELEASE_TAG__`, see `installer/src/main/release.ts`).
- **The wizard flow:**
  - Welcome → "Checking your computer" (Git + Node) → install → "Installation complete" → Open Granted.
  - The check screen has **"Check for and install the latest version of Granted"**, on by default. It asks GitHub's latest-release API, never downgrades, and falls back to the installer's own release.
- **The Windows install script (`install-windows.ps1`):**
  - It is run by the wizard in a console window, from a temp script built by `windowsInstallScriptFor` / `windowsDownloadAndRun` in `installer/src/main/ipcPure.ts`.
  - The temp script retries the download, reports "can't reach GitHub" plainly, and closes the window by itself after a successful install.
  - The install script reports progress to a status file: JSON `{state, message, pid}` plus an exclusive `.lock` the GUI uses to tell "running" from "window closed".
  - It pins a release via `GRANTED_REF`, and updates an install the installer made (marked with `.git/granted-installer`). It never moves an install backwards, never touches someone's own checkout, and never overwrites local changes.
  - It stops a running Granted before `npm ci`, fetches the built-in search model, installs the VC++ runtime when missing, and registers an **Installed apps** entry.
- **Running in the background:** `scaffold/scripts/windows/granted-tray.ps1` keeps a hidden server and a tray icon with Open / status / Open in its own window / Show log / Restart / Quit.
- **Shortcuts:** Desktop and Start-menu shortcuts (`shortcuts.ps1`).
- **Its own window:** `open-granted.ps1` opens Granted as an app window (Edge/Chrome `--app=`), with a preference stored in `%LOCALAPPDATA%\Granted\settings.json`.
- **Uninstall:** `uninstall.ps1` registers the Installed apps entry and uninstalls safely:
  - it refuses non-installer folders and asks again about unsaved git work;
  - it moves the folder aside first, so a folder in use changes nothing;
  - it rolls back cleanly.
- **In-app updates:** Settings → About Granted has the version, **Check for updates**, **Update to vX.Y.Z** and **Install updates automatically**. That's `scaffold/lib/appUpdate/*` and `scaffold/app/api/app/update/*`. The updater, `scaffold/scripts/windows/update.ps1`, runs detached, stops Granted, runs the release's install script, rolls back on failure and restarts Granted; the page reloads on the new version.
- **Search with no key:** a built-in nomic-embed-text-v1.5 model via `@huggingface/transformers`/onnxruntime-node, downloaded at install time into `scaffold/models/`. Search falls back to keyword-only if the model can't load.
- **Tests:**
  - node:test unit and integration tests (`installer/src/main/__tests__`, `scaffold/**/__tests__`);
  - Playwright `_electron` e2e (`installer/e2e`), including a packaged-app smoke test (`e2e/packaged.spec.ts`);
  - Windows integration tests that run the real PowerShell scripts against local stand-in git repos, a test registry key, a test LOCALAPPDATA and port 3979.
- **CI** (`.github/workflows/ci.yml`): Linux unit tests, plus a `installer-windows` job that runs unit, integration and e2e, and packages and smoke-tests the `.exe`.

**What macOS has today:**
- `install-macos.sh`: a one-liner that installs git and Node, clones the repo, runs `npm ci` and optionally installs Ollama.
- The wizard just opens Terminal with that one-liner (see `openInstallTerminal` in `installer/src/main/ipc.ts`, the `darwin` branch).
- There's no status reporting, so the wizard never learns the outcome, and no "Installation complete" screen.
- No background running, no Dock or Applications entry, no uninstall, no in-app updates, no release asset.

## The work

Do it in roughly this order, one PR per numbered item (or a couple of related items together). Keep the Windows paths working: every PR must pass the existing Windows CI.

1. **Status reporting for `install-macos.sh`.** Mirror Windows: `GRANTED_STATUS_FILE`, the `{state, message, pid}` JSON, and a lock the GUI can test for "still running". On macOS, use `flock` if available, or a pid plus process-start-time check. Add a trap that reports errors, and wire the wizard's `darwin` branch to poll it exactly like Windows does (reuse `decideStatusPoll` and its helpers).
   - Run the script from a temp script in Terminal. Use AppleScript `do script`, or `open -a Terminal` with a `.command` file.
   - The temp script retries the download and closes the window after success; keep the window open on error.
   - Then turn on the "Installation complete" / Open Granted flow for macOS.
2. **Pin releases and update in place:** `GRANTED_REF`, the `.git/granted-installer` marker and the same safety rules as `install-windows.ps1` (never backwards, never someone's own checkout, never over local changes). Stop a running Granted before `npm ci`, and fetch the built-in model (`npm run model:fetch`, which must never fail the install). Match the Windows tests in `installRef.integration.test.ts` with a macOS integration test that runs the real script against a local git repo with annotated tags.
3. **The search model on Apple Silicon.** Verify onnxruntime-node loads natively on arm64 (not under Rosetta). Run the real-model integration test on this Mac and record load time, memory and query latency. Check that keyword-only fallback works when the model is missing.
4. **Background running.** A per-user **LaunchAgent** (or a menu-bar helper) that runs the server hidden and starts only when the user opens Granted: no login item unless the user opts in.
   - Provide a menu-bar status item with the same menu as the Windows tray: Open, status, Open in its own window, Show log, Restart, Quit.
   - A small native helper is fine (Swift, or a minimal Electron tray), if it stays lightweight and is built in CI.
   - Store logs in `~/Library/Logs/Granted/`, and settings in `~/Library/Application Support/Granted/settings.json`. Share the settings keys with Windows (`openIn`, `autoUpdate`, `lastAutoCheck`); the app reads that path through `scaffold/lib/appUpdate/install.ts` `settingsPath()`, so extend it for macOS.
5. **"Its own window" on macOS.** Open with Chrome or Edge `--app=` if installed; otherwise open in a regular Safari tab. Same preference file and toggle.
6. **Applications / Dock entry.** Instead of shortcuts, add a small `Granted.app` launcher in `~/Applications` (the per-user folder, no admin needed) that starts the background server and opens Granted. Offer "Add to Dock" as an option on the Installation complete screen. Use the repo's existing icon (`scaffold/scripts/windows/granted.ico` → `.icns`).
7. **Uninstall.** A `scaffold/scripts/macos/uninstall.sh` with the same safety rules as `uninstall.ps1`:
   - refuse non-installer folders;
   - ask again about unsaved git work, and refuse it under `--quiet` without `--force`;
   - move the folder aside first;
   - remove the LaunchAgent, menu-bar helper, `~/Applications` launcher, Dock item, settings and logs;
   - offer to keep a copy of the API keys.

   macOS has no "Installed apps" list: expose uninstall from the menu-bar menu and from Settings → About Granted.
8. **In-app updates on macOS.** Extend `scaffold/lib/appUpdate/install.ts` so `installInfo()` allows darwin installs that have the marker and a `scripts/macos/update.sh`. Write `update.sh` to mirror `update.ps1`:
   - start it detached (`nohup` / `launchctl`), so it survives the server being stopped;
   - refuse declined updates before stopping anything;
   - roll back on failure;
   - restart Granted on the page's port.

   Port the Windows integration tests (real updater, a real running server, killing the parent) to macOS.
9. **A downloadable `.dmg` release asset.**
   - Package the wizard with electron-builder as a `.dmg` for arm64: `Granted-Setup-x.y.z-arm64.dmg` (add x64 or universal if it's cheap).
   - Add a `macos-latest` job to `release.yml` that builds, smoke-tests (extend `e2e/packaged.spec.ts` for the macOS app bundle) and uploads it next to the `.exe`.
   - Also add a macOS job to `ci.yml` running the installer unit, integration and e2e tests, plus packaging and smoke-testing.
   - **Signing:** the user has no paid Apple Developer account. Ship it unsigned and not notarized. Make the release notes and README explain the Gatekeeper prompt step by step for current macOS. Recent versions removed right-click → Open for unsigned apps: verify the real steps on this Mac (System Settings → Privacy & Security → "Open Anyway"), and test them. Note `xattr -dr com.apple.quarantine` only as an advanced fallback.
   - Leave a clearly marked place in the workflow for signing and notarization later.
10. **Docs.** Bring the README's macOS section to the same level as Windows: the download link and Gatekeeper steps; what the installer does; the menu-bar icon, its own window, updates and uninstall; and troubleshooting. Keep the verified-on-hardware notes honest, with model, macOS version, timings and what was tested.

## Robustness checklist (test each on this Mac, with a throwaway install)

- A fresh install with Homebrew present, and with no Homebrew. The script already handles both; make sure the wizard reports each outcome.
- Git or Node already installed versus missing (reuse the existing `install-macos.sh` paths; don't uninstall the user's own git/Node unless that's clearly safe and restorable).
- No network, or a DNS failure mid-install, then a retry. You should get a plain "can't reach GitHub" message, then success on Try again.
- The Terminal window closed mid-install: the wizard says so right away, and Try again works.
- Re-running the installer over an existing install (an update), over an older one, and over a folder with local changes.
- An in-app update while Granted is running; a failed update (rolls back); a declined one (left running).
- Uninstall while Granted is running, while a file is in use, and with unsaved work.
- Paths with spaces and apostrophes in the install folder.
- Gatekeeper and quarantine on the downloaded `.dmg`, and the first launch of the app inside it.
- Apple Silicon only: no Rosetta prompt, and native arm64 binaries for Electron, node and onnxruntime.

## Testing requirements (match the Windows coverage)

- **Unit tests** for every pure piece: status parsing, ref choice, command building, sanitizing paths and arguments, settings paths.
- **Integration tests** that run the **real** shell scripts against throwaway installs, local stand-in git repos and a test settings and log folder. Never use the real `~/Library/Application Support/Granted` or a real LaunchAgent label: make the label overridable for tests.
- **Playwright `_electron` e2e** for the macOS wizard flow, with `shell.openExternal` stubbed and no real Terminal windows in CI (make the Terminal launcher injectable).
- **A packaged-app smoke test** against the built `.app`.
- **CI:** a `macos-latest` job (arm64 runners) in `ci.yml`, and `.dmg` build and upload in `release.yml`.
- Before each push, run the full suites locally: `cd scaffold && npm test && npx tsc --noEmit`; `cd installer && npm test && npm run typecheck && npm run e2e`.
- Known unrelated flakes: the Windows-only `launchOllamaDaemon` test, and `pidLock`'s 8-process race under heavy load.

## When you're done

- **Releases:** publish a new release (bump the version, tag it) whose assets include both `Granted-Setup-x.y.z.exe` and `Granted-Setup-x.y.z-arm64.dmg`.
- **Real-hardware check:** download the `.dmg` from that release on this Mac and do a full real install into a throwaway folder: install → Open Granted → a local search via Ollama → an in-app update check → uninstall. Report each step.
- **Final report:**
  - links to the PRs and the release;
  - what was verified on real hardware versus in tests;
  - timings;
  - anything skipped and why;
  - anything you left changed on this Mac.
