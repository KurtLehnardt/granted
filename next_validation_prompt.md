# Windows validation: real Windows 11 client hardware (your own machine)

You are validating the Granted GUI installer (`installer/`) on a **real,
persistent Windows 11 machine you use day to day** — not a disposable cloud
VM. This is a **verification pass**: find and report problems with concrete
evidence. Do **not** fix code, push, merge, or open PRs. Report back.

## Why this run matters

Four prior rounds validated this installer thoroughly, but **entirely on
AWS EC2 Windows Server 2022** — because a standard AWS account has no
Windows 10/11 client AMI available at all. That left two real, specific
gaps no prior round could close:

1. **Windows 11 client itself has never been tested.** Every prior round
   ran on Windows Server 2022 Datacenter.
2. **The `winget`-present install path has never actually executed.**
   Windows Server doesn't ship `winget`, so every prior round exercised
   the *fallback* path (direct-download installers for git/Node). Modern,
   updated Windows 11 machines — almost certainly including this one —
   ship `winget` (the "App Installer") by default. The real
   `winget install -e --id Git.Git --silent --accept-package-agreements
   --accept-source-agreements` and `winget install -e --id
   OpenJS.NodeJS.LTS ...` commands in `install-windows.ps1` have been read
   and reasoned about, but never actually run.

This machine is a genuine opportunity to close both gaps for real. If it
happens to run a third-party antivirus product (not just Defender),
that's a bonus third gap this run could close — note whatever AV is
actually running, even if you don't deliberately test around it.

## Hard rules — read these twice, this is your real machine

- **Never touch a real Granted install.** If `$HOME\granted` already
  exists on this machine, it is your own real checkout. Before you start,
  record `(Get-Item "$HOME\granted\scaffold").LastWriteTime` if it exists,
  and confirm it is byte-for-byte unchanged at the end. For **every**
  escape-hatch run, set `GRANTED_INSTALL_DIR` to a throwaway **relative**
  name (e.g. `granted-validate-nvp-<case>`) in the environment that
  launches the app — never the default.
- **Work in a fresh scratch clone**, never an existing checkout, for the
  repo clone you build the installer app from.
- **This machine is not disposable.** Everything you install for this
  test (git, Node, via winget or otherwise) should be something you're
  fine keeping, OR you should uninstall it afterward if you'd rather not
  have it — say explicitly in your report which you did. Don't leave the
  machine in a worse state than you found it.
- **Don't deliberately trigger antivirus detections** beyond what a test
  naturally needs.
- **System-level changes** (installing git/Node, changing any settings):
  fine to do as needed for the test, since you're testing exactly that —
  but nothing destructive, and restore anything you changed that isn't
  git/Node itself (e.g. don't leave Group Policy or execution policy
  altered).
- Report honestly, with exact strings/timings/screenshots. "It worked" is
  not evidence.

## Setup

```powershell
git clone -b fix/gui-installer-m1-findings https://github.com/KurtLehnardt/granted.git granted-validate-nvp-src
cd granted-validate-nvp-src\installer
git rev-parse --short HEAD   # record this -- should be 81d4d97 or later
[Environment]::OSVersion.Version; (Get-CimInstance Win32_OperatingSystem).Caption
Get-Command winget -ErrorAction SilentlyContinue   # confirm it's actually present before relying on it below
git --version 2>$null; node --version 2>$null       # note whether either is ALREADY installed -- if both are, you'll need to temporarily rename/hide them to exercise the install path for real (see Test 2)
$PSVersionTable.PSVersion
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | Select displayName, productState
Get-MpComputerStatus | Select AMRunningMode, RealTimeProtectionEnabled
npm install
npm run build
```

### Pin the one-liner to this commit

The public one-liner (`irm https://raw.githubusercontent.com/KurtLehnardt/
granted/main/install-windows.ps1 | iex`) is hardcoded to fetch from `main`,
which doesn't have this branch's fixes yet. Patch the built
`out/main/index.js`: find the `scriptContents` template (search for
`GRANTED_STATUS_FILE`) and replace `/granted/main/` with
`/granted/<the short SHA you recorded above>/` **only in that template
string** — leave `INSTALL_ONE_LINERS` itself untouched, so the clipboard
still holds the exact published one-liner. Verify both after patching:

1. Fetch `https://raw.githubusercontent.com/KurtLehnardt/granted/<SHA>/install-windows.ps1`
   yourself and confirm its SHA256 matches your local clone's
   `install-windows.ps1` exactly.
2. After clicking the escape hatch once (any case below), `Get-Clipboard
   -Raw` should still equal the real, unmodified published one-liner —
   case-sensitive, byte-for-byte.

## Test matrix

### Test 1 — Baseline on real Windows 11 client (closes gap #1)
Launch the built app (`npm run dev`, or `electron.exe` against the `out/`
directory). Full flow: Welcome → PrereqCheck → (if git/Node already
present, skip to Test 2 for the install path) confirm versions shown
match `git --version`/`node --version` exactly. This alone is valuable
just by running on real Windows 11 — note the exact build
(`[Environment]::OSVersion.Version` / `Caption` from Setup above).

### Test 2 — The winget-present install path (closes gap #2, the important one)
If git and/or Node are **already installed** on this machine, you need
them to look absent to the app for this test, without actually
uninstalling anything you want to keep:
- Easiest: temporarily rename their directories off PATH, or temporarily
  strip them from your **User** PATH (not Machine, to minimize blast
  radius) for this one escape-hatch run, then restore it afterward —
  pick whichever is less disruptive to your own setup, and say which you
  did.
- Alternative: use a non-admin **standard** Windows account on this
  machine if one exists (cleaner — genuinely no git/Node there), or ask
  whether creating a temporary local standard account for this one test
  is acceptable (then delete it afterward).

With `winget` confirmed present (from Setup) and git/Node genuinely
invisible to a fresh `Get-Command git`/`node`:
1. Click "Open a terminal for me" with a throwaway `GRANTED_INSTALL_DIR`.
2. Watch the real console output for `Installing git...` → does it
   actually invoke `winget install -e --id Git.Git --silent
   --accept-package-agreements --accept-source-agreements`? Record the
   exact winget output (progress bar text, any prompt, success/failure
   line). Same for `Installing Node.js 22...` → `winget install -e --id
   OpenJS.NodeJS.LTS ...`.
3. Does `Wait-Have` correctly detect them once winget finishes (it polls
   for up to 15s)? Time how long winget itself actually took for each.
4. Does the install then proceed to clone + `npm ci` and print `Done.
   Next steps:`?
5. Back in the GUI (without restarting the app): does PrereqCheck
   auto-recheck and flip to ✓/✓ (the round-2/3 PATH-refresh fix)? This is
   the first time that fix has been proven on a path where winget (not
   the direct-download fallback) is what actually modified PATH — the
   registry-write mechanism should be identical either way, but this is
   real confirmation, not assumption.
6. Restore whatever PATH/account change you made in step 0 of this test.

This is the single most valuable thing this run can prove — prioritize it
if you're short on time.

### Test 3 — Light spot-check of what's already proven (don't redo everything)
Pick 2, not all — these have passed repeatedly on Windows Server across 4
prior rounds, so this is just a sanity check that real client Windows (and
whatever real AV you found in Setup) doesn't behave differently:
- **Double-click**: click "Open a terminal for me" twice fast. Exactly one
  install should run (the `installInFlight` lock), not two.
- **Forced failure**: set `GRANTED_INSTALL_DIR` to an existing non-empty
  non-clone folder. Should show the real `git clone failed...` error, not
  a false success.
- **Antivirus**: if Setup found a real-time AV product running (Defender
  or otherwise), confirm 0 detections/blocks across whatever you ran
  above. If it's NOT Defender, say explicitly what it is — that alone is
  new information no prior round had.

## Report format

1. **Environment**: exact OS build/edition, winget presence, AV
   product(s) actually running, admin vs standard account used, whether
   git/Node were pre-installed (and how you worked around that for Test
   2), commit tested, pin verification (SHA256 match + clipboard
   byte-for-byte check).
2. **Results**: Test 1, Test 2 (the important one — full winget output,
   timings, whether PATH-refresh correctly picked it up), Test 3's 2
   picks. Pass/fail with evidence for each.
3. **Bugs found**, if any — severity, exact repro, observed vs expected,
   root cause if verified, user impact. Don't fix them.
4. **Not tested**, with reasons.
5. **Machine state confirmation**: what you changed (packages installed,
   accounts created, PATH modified) and what you did or didn't revert,
   explicitly. Confirm `$HOME\granted` (if it existed) is unchanged.
