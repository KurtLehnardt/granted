# Windows validation round 2: Granted GUI installer fixes

You are validating fixes to the Electron GUI installer in `installer/` on
real Windows hardware. This is a **verification pass**: find and report
problems with concrete evidence. Do **not** fix code, push, merge, or open
PRs. Report back.

## Background

This is round 2. Round 1 (see `tmp/windows-validation-prompt.md` on
`feature/gui-installer-m1-windows-validation`, commit `6e5be59`) validated
the installer broadly and found 6 new bugs on top of 5 already-fixed ones.
5 of those 6 are now fixed, on a new branch. **Your job is primarily to
validate those 5 fixes for real** — they were built, typechecked, and
unit-tested for the underlying state machine, but never run against a real
Windows machine. Secondarily, do a **light** regression pass confirming
round 1's 5 fixes are still intact (not a full re-run of round 1's entire
matrix — that would be redundant; spot-check, don't repeat exhaustively).

Code under test: branch **`fix/gui-installer-m1-findings`** (based on
`feature/gui-installer-m1-impl`). Record the exact commit you test
(`git rev-parse --short HEAD`). Key files: `install-windows.ps1` (repo
root — now writes a status sentinel), `installer/src/main/ipc.ts` (polls
it, holds the new in-flight lock), `installer/src/renderer/src/screens/
PrereqCheck.tsx` (auto-recheck + "Check again" button), `installer/src/
shared/ipc.ts` and `installer/src/preload/index.ts` (new `InstallStatusEvent`
/ `onInstallStatus` IPC surface).

### What changed, and exactly what "fixed" now looks like

| # | Round-1 bug | What changed | New pass criterion |
|---|---|---|---|
| 1 | Double-click raced two concurrent installs | A main-process `installInFlight` lock (Windows only) rejects a second escape-hatch call outright | See Case J1 below — a programmatic double-call must yield exactly one running install, not two |
| 2 | App claimed success even when nothing installed | `install-windows.ps1` now writes `%TEMP%\granted-install-status.json` as `{"state":"running"\|"done"\|"error","message":?}` at every outcome; the GUI polls it instead of trusting `spawn()` | See Case D and Case H below — the GUI must show the *real* outcome, not a generic "started" message |
| 3 | `-File` fix broke under Group-Policy `AllSigned`, where the old `-Command` form likely wouldn't have | Not solved at the PowerShell level (can't be, safely) — instead, the GUI now has a 10s "never confirmed it started" timeout distinct from a mid-install error, and tells the user to use the clipboard fallback | See Case H below — must see the *specific* "couldn't confirm it started" message, within ~10-12s, not a hang or a false success |
| 4 | PrereqCheck went stale after a successful install with no way to clear it | Auto-recheck on a real "done" event, plus a manual "Check again" button for everyone | See Case A' and the "Check again" check below |
| 5 | Raw Node/Windows errors (`EBUSY`, 8.3 paths) leaked into UI copy | Generic message now; raw detail goes to the main process's console (not visible in the packaged UI) | Re-run J2 (locked temp file) — the UI message should no longer contain `EBUSY` or similar |

Bug 6 (unsigned `electron.exe`) was explicitly **not** attempted — it needs
real code-signing infrastructure, not an installer-code fix. Don't re-test
it; it's unchanged from round 1.

**One intentional format change:** the temp script the GUI writes
(`%TEMP%\granted-install.ps1`) is no longer byte-identical to the clipboard
one-liner. It's now **two lines**: `$env:GRANTED_STATUS_FILE = "<path>"`
followed by the exact one-liner. The **clipboard** (`Get-Clipboard -Raw`)
is still the pure, unmodified one-liner — that didn't change. Update your
exact-match check accordingly: compare the clipboard to the one-liner
(unchanged assertion), and compare the temp script to
`$env:GRANTED_STATUS_FILE = "<the status path>"` + CRLF + the one-liner +
CRLF (changed assertion — don't flag this difference as a regression, it's
deliberate).

## Hard rules (unchanged from round 1 — still non-negotiable)

- **Never touch a real Granted install.** If `$HOME\granted` exists, it's
  the user's working checkout — set `GRANTED_INSTALL_DIR` to a throwaway
  **relative** name (e.g. `granted-validate-r2-<case>`) for every
  escape-hatch run. Record `(Get-Item "$HOME\granted\scaffold").LastWriteTime`
  before and after; confirm unchanged.
- Work in a fresh clone in a scratch/temp directory, never an existing
  checkout.
- **Don't deliberately trigger Defender detections** beyond what a test
  needs.
- **Ask before system-level changes** (accounts, installing/uninstalling
  git/Node, Group Policy, disabling AV) — same caveat as round 1: on a
  disposable VM you created and will destroy, you have standing permission
  to do all of this freely; it's what cases B/H need and the VM is thrown
  away regardless.
- Report honestly, with exact strings/timings/event IDs/screenshot paths.
  "It worked" is not evidence.

## Setup and ground truth (same as round 1)

```powershell
git clone -b fix/gui-installer-m1-findings https://github.com/KurtLehnardt/granted.git
cd granted\installer
git rev-parse --short HEAD
[Environment]::OSVersion.Version; (Get-CimInstance Win32_OperatingSystem).Caption
git --version; node --version; $PSVersionTable.PSVersion
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Get-MpComputerStatus | Select AMRunningMode, RealTimeProtectionEnabled
```

Build/run exactly as round 1 (`npm install`, `npm run dev` or `npm run build`
+ `electron.exe <installer dir>`).

## Test matrix

### A' — Baseline, now watching the new status flow
Full flow (`npm run dev`), prereqs missing, so the escape hatch actually
installs something. While it runs, in a **second** session/window, poll
`Get-Content $env:TEMP\granted-install-status.json` every couple seconds and
log what you see — expect to see it appear with `{"state":"running",...}`
within ~1-2s of clicking, then flip to `{"state":"done","message":null}`
right as the console prints "Done. Next steps:". In the app itself:
- The button should read **"Installing…"** (not just a brief "Opening…")
  and stay disabled the whole time the install runs.
- Once the console shows "Done.", the app's message area should update to
  something like "Install finished — re-checking…" **within ~1-2 seconds**,
  and the ✗/✗ prereq rows should flip to ✓/✓ **without you clicking
  anything or restarting the app**. Screenshot before and after.
- Confirm the **"Check again"** button is present and, clicked once more,
  re-runs the check and still shows ✓/✓.

### B — Non-admin spot-check (not a full re-run — round 1 already proved this)
One run as a standard user, prereqs already present, just to confirm the
new lock/status code doesn't behave differently for a non-admin session.
Console title still shouldn't start with "Administrator:".

### C — Double-click, now via direct IPC call (stronger than a UI click)
This is the real regression test for bug #1. A UI click is disabled almost
immediately, which could hide a real race if the *button* guard is doing
the work instead of the *lock*. Prove the lock itself holds:
1. Open the installer app, get to PrereqCheck.
2. Open DevTools (if available in the dev build) or use the
   `--remote-debugging-port` + CDP approach from the automation tips below
   to call `window.api.openInstallTerminal()` **twice**, back-to-back, with
   no delay, bypassing the UI entirely.
3. Expect: exactly **one** new visible console window / one
   `powershell.exe -File "...granted-install.ps1"` process in
   `Get-CimInstance Win32_Process`. The second call's resolved result
   should be `{ ok: false, message: "An install is already running..." }`
   (or similar — check the exact string in `ipc.ts`). Record both raw
   results.
4. Confirm no second clone/install race corrupted the target directory
   (only one `granted-validate-*` dir exists, `npm ci` ran exactly once —
   check `node_modules` isn't half-written or doubly-reinstalled mid-flight).

### D — Forced failure, now checking for the REAL outcome (not false success)
Same setup as round 1's Case D: `GRANTED_INSTALL_DIR` pointing at an
existing non-empty non-clone folder.
- **Round 1 result:** app falsely said "Opened PowerShell and started the
  installer — Granted will be installed to...". **Round 2 expectation:**
  the app's message area should now show the *actual* failure (something
  derived from `"git clone failed. If <dir> was partially created, remove
  it before re-running."`), not a false success message. Screenshot it.
- Cross-check: `Get-Content %TEMP%\granted-install-status.json` should show
  `{"state":"error","message":"git clone failed..."}` at the time the app
  updates.
- The console window itself should behave exactly as round 1 found (stays
  open, shows the red `[x]` line) — that part didn't change, just confirm
  it's still true.

### H — Group-Policy `AllSigned`, now checking for the specific timeout message
Same setup as round 1's Case H (`HKLM\SOFTWARE\Policies\Microsoft\Windows\
PowerShell` → `EnableScripts=1`, `ExecutionPolicy=AllSigned`; ask first /
VM only).
- **Round 1 result:** app falsely said "Opened PowerShell and started the
  installer...", exactly like a real success, even though the script was
  refused outright. **Round 2 expectation:** within **~10-12 seconds** of
  clicking, the app's message should change to something like "Couldn't
  confirm the installer actually started — a security policy on this
  machine may have blocked it. Paste the command from your clipboard into
  PowerShell yourself..." — check the exact string in `ipc.ts`.
- Cross-check: `%TEMP%\granted-install-status.json` should **never be
  created at all** for this case (the script is refused before its own
  first line — the `Write-Status "running"` call — ever executes). Confirm
  its absence explicitly, don't just assume.
- The console window itself should still show the same
  "not digitally signed" PowerShell error as round 1 (unchanged) — the fix
  is entirely in how the *app* reports this, not in the PowerShell
  behavior itself.
- Revert the policy afterward and verify (`Get-ExecutionPolicy -List` back
  to baseline).

### J2 — Locked temp file, now checking the error message is generic
Same setup as round 1 (hold `%TEMP%\granted-install.ps1` open with
`FileShare.None`, click the escape hatch).
- **Round 1 result:** message contained `EBUSY: resource busy or locked,
  open 'C:\Users\ADMINI~1\...'`. **Round 2 expectation:** a generic message
  ("Couldn't open a terminal automatically. The command is on your
  clipboard...") with **no** `EBUSY`, no raw path, no Node error text.
  Quote the exact string you see.

### Spot-check: round 1's fixes are still intact (light pass, not exhaustive)
Pick **2-3** of these, not all of them — just enough to be confident nothing
regressed:
- A new **visible** console window still appears (bug #3's fix) — `EnumWindows`
  before/after diff, same as round 1.
- **0** processes have `irm https` on their command line (bug #2's fix) —
  `Get-CimInstance Win32_Process` check.
- The UI message still names the real install path
  (`$HOME\<GRANTED_INSTALL_DIR>`) — bug #5's original fix.
- `0` new Defender `1116`/`1117` events across your whole session.

## Automation tips (same as round 1, repeated for convenience)

- **UI Automation**: Chromium's accessibility tree builds lazily — poll for
  the button/text to appear rather than querying once.
- **Screenshots**: `PrintWindow(hwnd, hdc, 2)` (PW_RENDERFULLCONTENT), not
  `CopyFromScreen`.
- **Locked screen / no interactive session**: start with
  `npx electron-vite dev --remote-debugging-port 9333`, then drive the
  renderer via Chrome DevTools Protocol — connect a WebSocket to the page
  target from `http://127.0.0.1:9333/json`, and send
  `Runtime.evaluate` with `awaitPromise: true` to call `window.api.*`
  methods directly (this is exactly how Case C above should be done — it
  calls `window.api.openInstallTerminal()` twice programmatically, which a
  UI click can't cleanly do with zero delay between calls). Python's
  `websockets` package or Node's `ws` both work fine for this.
- **Process command lines**: `Get-CimInstance Win32_Process | Select
  ProcessId, ParentProcessId, CommandLine`.
- **Defender events**:
  `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows
  Defender/Operational'; StartTime=$t0; Id=1116,1117}`

## Cleanup (verify each, and report)

Everything from round 1's cleanup checklist, **plus**:
- Delete `%TEMP%\granted-install-status.json` if it exists after your
  session (it's harmless to leave, but confirm you know whether it's
  there and account for it either way).
- Kill all `electron.exe` and installer PowerShell windows, stop the dev
  server (port 5173), delete every `granted-validate-r2-*` directory and
  your scratch clone, revert any Group Policy change and verify reverted,
  confirm `$HOME\granted` (if present) untouched (`LastWriteTime` matches
  what you recorded before starting).

## Report format

1. **Environment table** (OS, admin y/n, git/Node versions, commit tested).
2. **Results table**: case → pass/fail → evidence, written against the
   specific **new** pass criteria above (not round 1's old criteria, which
   this round's fixes deliberately changed the behavior of).
3. **Bugs found** (if any) — severity, exact repro, observed vs expected,
   root cause if verified, user impact. Don't fix them.
4. **Not tested**, with reasons.
5. **Cleanup confirmation.**
