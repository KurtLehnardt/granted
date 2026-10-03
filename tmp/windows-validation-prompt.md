# Windows validation: Granted GUI installer (Milestone 1)

You are validating the Electron GUI installer in `installer/` on real Windows
hardware. This is a **verification pass**: find and report problems with
concrete evidence. Do **not** fix code, push, merge, or open PRs. Report back.

## Background

Granted (`https://github.com/KurtLehnardt/granted`) is a Next.js app in
`scaffold/`. `installer/` is a new Electron wizard so non-technical users can
set it up without a terminal. Milestone 1 has three pieces:

1. **Welcome** screen → "Get Started".
2. **PrereqCheck** screen. It runs `git --version` / `node --version` in the
   main process and shows the versions (Node must be 22+).
3. **"Open a terminal for me"** escape hatch. It copies the official one-liner
   to the clipboard and opens a terminal that runs it. On Windows that
   one-liner is:

   ```
   irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
   ```

   `install-windows.ps1` installs git/Node via winget if missing, clones the
   repo into `.\granted` (or `$env:GRANTED_INSTALL_DIR`), and runs `npm ci` in
   `scaffold\`.

Code under test: branch **`feature/gui-installer-m1-impl`**. Record the exact
commit you test (`git rev-parse --short HEAD`). Key files:
`installer/src/main/ipc.ts` (prereq check + escape hatch),
`installer/src/main/index.ts` (window), `installer/src/preload/index.ts`
(contextBridge API), and `installer/package.json`.

### Windows problems already found and fixed (verify they stay fixed)

| # | Problem | Fix now on the branch |
|---|---|---|
| 1 | `npm install` didn't download Electron. The first `npm run dev` died after about 5s with `Error: Electron uninstall`, because electron-vite reads `node_modules/electron/path.txt` itself and never triggers Electron's lazy download. | `postinstall` prints a message, then runs `install-electron`. |
| 2 | Microsoft Defender flagged the process command line `powershell.exe -NoExit -Command "irm <url> \| iex"` as **`Trojan:Win32/Commando.A!ml`** (Severe) and blocked it (`spawn EPERM`) or killed it about 14s later. It flags the *command-line text* regardless of parent: even a signed `node.exe` with that string in its args was flagged. | The one-liner is written verbatim to `%TEMP%\granted-install.ps1` and run with `powershell.exe -NoExit -ExecutionPolicy Bypass -File <that file>`. |
| 3 | `spawn(..., {detached: true})` maps to `DETACHED_PROCESS` on Windows, so PowerShell got **no console window**. It ran invisibly, and `-NoExit` then exited on stdin EOF. | Launch via `cmd.exe /d /s /c "start "" powershell.exe ..."` (`windowsVerbatimArguments`). This gives a real console window that outlives the app. |
| 4 | `spawn` errors arrive as an async `'error'` event, so the `try/catch` never saw them. The UI could also report "Opened PowerShell" even though nothing was running. | Await the child's `spawn` / `error` event before reporting. |
| 5 | PowerShell inherited the app's working directory, so the repo was cloned into the installer's own folder. | `cwd: os.homedir()`. The UI message names the install path. |

Already **proven** (twice, consecutively) on one Windows 11 Pro machine, under
an **elevated (admin)** session, with git 2.39.2 and Node 24.14.0 already
installed and Defender as the only AV. That covered the happy path in both
`npm run dev` and the built app (`npm run build` + `electron.exe <installer dir>`).
**Your job is everything else.** Do re-run the happy path once first as a
baseline, but spend most of your effort on the gaps below.

## Hard rules

- **Never touch a real Granted install.** If `$HOME\granted` exists, it is the
  user's working checkout. Running the one-liner against it would skip the
  clone and **run `npm ci` in it, wiping `node_modules`**. For every escape-hatch
  run, set `GRANTED_INSTALL_DIR` to a throwaway **relative** name (for example
  `granted-validate-<case>`) in the environment that launches the app. It is
  inherited by Electron → cmd → PowerShell. Being relative also proves the
  window starts in `$HOME`: the clone must land in `$HOME\<name>`.
  Record `(Get-Item "$HOME\granted\scaffold").LastWriteTime` before you start,
  and confirm it is unchanged at the end.
- Work in a fresh clone in a scratch/temp directory, never in an existing checkout.
- **Don't deliberately trigger Defender detections** beyond what a test needs.
  They land in the machine's protection history, which can't be cleared without
  admin. If you must test the old flagged pattern, do it once and say so.
- **Ask before system-level changes**: creating or deleting Windows user
  accounts, installing or uninstalling git/Node, changing Group Policy or
  execution policy, or disabling AV. Prefer a disposable VM for these.
- Report honestly. "It worked" is not evidence. Give exact versions, command
  lines, dialog text, timings, exit codes, screenshot paths and Defender event
  IDs. If you skip something, say so and why.

## Setup and ground truth (every machine)

```powershell
git clone -b feature/gui-installer-m1-impl https://github.com/KurtLehnardt/granted.git
cd granted\installer
git rev-parse --short HEAD
[Environment]::OSVersion.Version; (Get-CimInstance Win32_OperatingSystem).Caption
git --version; node --version; $PSVersionTable.PSVersion
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Get-ExecutionPolicy -List
Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | Select displayName, productState
Get-MpComputerStatus | Select AMRunningMode, RealTimeProtectionEnabled
```

Note that `productState` can list stale AV registrations. Check that the
product's process is actually running before blaming it.

Before each "first install" test, delete `%LOCALAPPDATA%\electron` (Electron's
download cache) and `node_modules`.

## Test matrix

For each case, capture **pass/fail with evidence**. "Full flow" means all of:

- **Welcome:** renders, and "Get Started" works.
- **PrereqCheck:** shows versions that match `git --version` / `node --version`
  exactly. Git shows semver only: `2.39.2.windows.1` → `2.39.2`.
- **Escape hatch:**
  - a **new visible** console window appears;
  - its command line is `-File "...\granted-install.ps1"`, and **no process**
    has `irm https` on its command line;
  - the temp script and `Get-Clipboard -Raw` both equal the one-liner exactly
    (case-sensitive);
  - the UI message names `$HOME\<GRANTED_INSTALL_DIR>`.
- **Install outcome:**
  - the install completes ("Done. Next steps:", and
    `scaffold\node_modules\.package-lock.json` exists);
  - nothing is cloned under `installer\`;
  - the window stays open afterwards;
  - closing the installer app does not kill the PowerShell window;
  - Defender logs 0 new detections.

### A. Baseline happy path (re-confirm)
Full flow in `npm run dev` **and** the built app. Time `npm install` with an
empty Electron cache, and confirm the postinstall message shows. Run A twice.

### B. Standard (non-admin) user, the most important gap
All prior proof ran elevated. Run the full flow as a **standard user** account
(ask before creating one, or use a VM). Check:
- the console title (it should *not* start with "Administrator:");
- that winget/npm behave the same;
- that `-ExecutionPolicy Bypass` works with that user's policy.

### C. Missing or old prerequisites (clean VM strongly preferred)
Each of these should be its own clean snapshot:
- no git;
- no Node;
- Node < 22 (for example 20.x);
- neither git nor Node.

For each, check:
- **PrereqCheck:** shows ✗ / "not found" / "needs to be updated to 22+",
  with no hang or crash. Time it: the check has a 5s timeout per tool.
- **Escape hatch:** the script installs the missing pieces via winget. Note
  any UAC prompt, its exact text, and what the user must click.
- **PATH:** after the install, a freshly opened PowerShell finds git/node.
- **App state:** whether the *already-open* installer app still shows stale
  results. There is no re-check button; report this as a UX gap if so.
- **No winget:** also test once with winget absent (Windows Server, or
  LTSC/older images). That uses the direct-download fallback, and Node's
  `.msi` needs admin.

### D. Failure path
Force a real failure of `install-windows.ps1`. Safe example: set
`GRANTED_INSTALL_DIR` to a relative name of an **existing non-empty folder that
isn't a clone**, which makes `git clone` fail. Also try with the network
disconnected.

Expected: the window **stays open** showing the red `[x]` error. It runs via
`-File`, so `exit 1` must not close it. Screenshot it. Also check what the
installer app's UI says, and whether it should have said something else.

### E. Paths with spaces and special characters
Use a Windows account whose username contains a space (for example
`Test User`), so that `%TEMP%` and `$HOME` contain spaces. Optionally also try
an apostrophe or `&` if feasible.

Check that the `cmd /s /c "start "" ... -File "<path>""` quoting still works,
and that the clone lands in the right home folder. Also try a non-ASCII
username if you can.

### F. Windows 10
Repeat A, and at least one of C, on Windows 10 22H2. Note the default console
host (conhost vs Windows Terminal), and confirm that `start` opens a visible
window either way.

### G. Other antivirus / EDR
If any machine has a third-party AV or EDR (Kaspersky, Bitdefender, Norton,
CrowdStrike, SentinelOne, etc.), run A there. Report:
- any block, quarantine or prompt;
- the exact detection name;
- whether it targeted `electron.exe`, `cmd.exe`, `powershell.exe -ExecutionPolicy Bypass -File %TEMP%\...`, or the downloaded script.

`-ExecutionPolicy Bypass -File <temp .ps1>` is itself a pattern some EDRs
score as suspicious.

### H. Locked-down execution policy
With `MachinePolicy` or `UserPolicy` execution policy set by Group Policy (VM
only; ask first), `-ExecutionPolicy Bypass` is ignored. Expected: the script is
refused. Report:
- what the console shows;
- whether the app's clipboard fallback message is enough for a user to recover.

### I. SmartScreen / Mark-of-the-Web
No packaged `.exe` exists yet (later milestone), so simulate one. Add a
`Zone.Identifier` stream to a **copy** of the built app's `electron.exe`
(`ZoneId=3`), launch it via `Start-Process` (ShellExecute), and screenshot
every dialog in order. Expect at least "Open File - Security Warning" /
"Unknown Publisher".

Note that upstream `electron.exe` already has SmartScreen reputation, so the
blue "Windows protected your PC" screen may not appear for it. Say that
explicitly. Remove the stream afterwards.

### J. Robustness and edge cases
- **Double-click:** click "Open a terminal for me" twice quickly. Do two
  windows appear? Do two installs race on the same directory?
- **Re-run:** rerun with an existing **throwaway** clone at the target
  (`GRANTED_INSTALL_DIR` pointing at a completed `granted-validate-*` dir).
  Expect "already cloned", then `npm ci`.
- **Close mid-install:** close the installer app while the install is running.
  The PowerShell window must keep going.
- **Leftover temp file:** delete or lock `%TEMP%\granted-install.ps1` between
  clicks, and check the app handles it.
- **Offline launch:** start the app with no network. Prereq check must still
  work, and the escape hatch must fail visibly in the console, not silently.

### K. Defender over time
Re-run A's escape hatch on a different day, or after a Defender signature
update (`Update-MpSignature`). Record the engine and signature versions
(`Get-MpComputerStatus | Select AMProductVersion, AntivirusSignatureVersion`)
and whether any `1116`/`1117` events appear.

### L. Security baseline (source review)
Confirm from the source, not the UI:
- `BrowserWindow` uses `contextIsolation: true`, `nodeIntegration: false` and
  `sandbox: true`, and has a `setWindowOpenHandler` that denies new windows.
- The preload exposes only `window.api.checkPrereqs` /
  `window.api.openInstallTerminal` via `contextBridge`, with no raw
  `ipcRenderer` or `require`.
- The temp-script approach doesn't create a new injection vector. Who can
  write `%TEMP%\granted-install.ps1`? Is there a race between write and exec?
  Is the content constant? Report your reasoning.

### M. (Separate hardware) Mac and Linux regression
The new `postinstall` runs on all platforms. On macOS and Linux, run
`npm install` with an empty Electron cache, then `npm run dev`, and run the
full flow. On Linux, note whether the known `chrome-sandbox` (root-owned,
mode 4755) failure now surfaces at install time instead of first launch.
Skip if you have no such hardware, and say so.

## Automation tips (learned the hard way on Windows)

- **UI Automation** (`System.Windows.Automation`) works on the Electron window
  (title "Granted Installer"). Chromium builds its accessibility tree
  **lazily**: the first query returns only the Pane, so poll until the text or
  button appears. Click with `InvokePattern`.
- **Screenshots:**
  - Use `PrintWindow(hwnd, hdc, 2)` (PW_RENDERFULLCONTENT), not
    `CopyFromScreen`. Windows often refuses `SetForegroundWindow`, so screen
    copies capture whatever is on top, possibly other private windows. Never
    keep a screenshot that shows unrelated windows.
  - A dark empty frame means you captured before the page loaded.
    Poll for content first.
- **Locked screen:** when the session is locked (`LogonUI.exe` in your
  session), UIA and screen capture fail ("The handle is invalid"). Fallback:
  start with `npx electron-vite dev --remoteDebuggingPort 9333`, then drive the
  renderer via the Chrome DevTools Protocol (`/json` → `webSocketDebuggerUrl` →
  `Runtime.evaluate` clicking buttons by text). Prefer real UIA clicks when
  unlocked, and say which you used.
- **Don't launch the app via WMI** (`Win32_Process.Create`): the window often
  never paints (white frame, though the DOM is fine). Use
  `Start-Process`/Explorer.
- **Visible-window proof:** diff the top-level UIA windows before and after the
  click. Look for a new `conhost` / `WindowsTerminal` / `OpenConsole` window.
  The process existing is not enough: bug #3 was an invisible process.
- **Process command lines:** `Get-CimInstance Win32_Process | Select ProcessId, ParentProcessId, CommandLine`.
- **Defender events:**
  ```powershell
  Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=$t0; Id=1116,1117}
  Get-MpThreatDetection
  ```
- **Install finished:** `scaffold\node_modules\.package-lock.json` exists, and
  the PowerShell process has no child processes left.
- `electron.exe` is a GUI-subsystem binary. Under `ELECTRON_RUN_AS_NODE=1` its
  stdout doesn't reach your console, so redirect to a file.
- `npm install` with npm 11 rewrites `installer/package-lock.json` (drops
  `libc` fields). That's known noise; don't commit it.
- If your own agent session runs elevated, everything you launch inherits
  admin. That's why case B needs a separate standard-user session.

## Cleanup (verify each, and report)

- Kill all `electron.exe` and installer PowerShell windows (match
  `granted-install.ps1` in the command line). Stop the dev server (port 5173).
- Delete every `$HOME\granted-validate-*`, your scratch clone,
  `%TEMP%\granted-install.ps1`, any `Zone.Identifier` copies, and
  `%LOCALAPPDATA%\electron` if it didn't exist before you started.
- Clear the clipboard if you put test data there.
- Confirm `$HOME\granted` (if present) is untouched (same `LastWriteTime`).
- Remove any temporary user accounts or policy changes **you were permitted**
  to create, and say so.

## Report format

1. **Environment table**, one row per machine/session: OS + build, admin y/n,
   console host, git/Node versions, AV products (running), commit tested.
2. **Results table:** case → pass/fail → evidence (timings, exact strings,
   event IDs, screenshot paths).
3. **Bugs found**, each with:
   - severity;
   - exact reproduction steps;
   - observed vs expected;
   - root cause, if you verified it (say "unverified" otherwise);
   - user impact for a non-technical user.

   Don't fix them.
4. **Not tested**, with the reason for each item.
5. **Cleanup confirmation.**
