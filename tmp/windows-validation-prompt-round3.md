# Windows validation round 3: Granted GUI installer, PATH-refresh fix

You are validating one more fix to the Electron GUI installer in
`installer/` on real Windows hardware. This is a **verification pass**:
find and report problems with concrete evidence. Do **not** fix code, push,
merge, or open PRs. Report back.

## Background

Round 2 (see `tmp/windows-validation-prompt-round2.md` on
`feature/gui-installer-m1-windows-validation-round2`) ran the 5 round-1
fixes on a real Windows VM and confirmed 4 of them work, including the
BOM-strip fix on the real `powershell.exe` 5.1 target where that bug
actually lives. **Bug #4's fix did not work**: on a fresh machine with
neither git nor Node, the install succeeded, but the prereq rows stayed
`✗ Git: not found` / `✗ Node.js (22+ required): not found` forever —
neither the auto-recheck nor the manual "Check again" button helped.
Round 2 also found (and fixed) a release-ordering test-harness issue: the
GUI's one-liner is hardcoded to fetch `install-windows.ps1` from `main`,
so testing pre-merge requires pinning the built app to the actual commit
under test — see the "Test setup" section below, which does this for you.

Root cause, confirmed in round 2: Electron's main process snapshots
`process.env.PATH` once at launch. `install-windows.ps1` updates the
Machine/User PATH in the Windows registry when it installs git/Node — a
long-lived Node process never re-reads that on its own, so `checkPrereqs()`
kept resolving against the stale snapshot no matter how many times it
reran. Only relaunching the whole app (a fresh process, a fresh snapshot)
ever picked up the real result.

**Your job**: confirm the fix for that (commit `19302d0`+ on
`fix/gui-installer-m1-findings`) actually works, plus a light spot-check
that round 2's 4 already-confirmed fixes are still intact (they weren't
touched by this round's changes, so this should be quick).

### What changed this round

| What | Where | Expected effect |
|---|---|---|
| `refreshWindowsPathEnv()` re-reads the registry Machine+User PATH and merges it into `process.env.PATH` | `installer/src/main/ipc.ts`, called at the top of every `checkPrereqs()` on win32 only | After a successful install, the *same still-open app* should see git/Node without needing to relaunch |
| `pollInstallStatus`'s `finish()` no longer deletes the per-attempt status file | same file | `%TEMP%\granted-install-status-<uuid>.json` should still exist (with `{"state":"done",...}` or `{"state":"error",...}`) after the install finishes — this makes round 2's "watch it flip to done" check non-racy, where before it wasn't |
| `install-windows.ps1`'s `Write-Status` catch no longer fails silently | `install-windows.ps1` | Not expected to fire in normal testing — only relevant if something prevents the status write entirely |

## Test setup — pin the one-liner to this commit (same trick round 2 used)

The public one-liner is `irm https://raw.githubusercontent.com/KurtLehnardt/
granted/main/install-windows.ps1 | iex` — always `main`, regardless of what
the GUI itself was built from. To test this branch's actual script, build
normally, then patch the **one token** in the built output before running:

```powershell
git clone -b fix/gui-installer-m1-findings https://github.com/KurtLehnardt/granted.git
cd granted\installer
git rev-parse --short HEAD   # record this -- should be 19302d0 or later
npm install
npm run build
# Replace /granted/main/ with /granted/<the commit above>/ in out/main/index.js
# so the GUI fetches the SAME revision as the code under test. Verify after
# patching: fetch that URL yourself and confirm its SHA256 matches your
# local install-windows.ps1's SHA256 -- don't just assume the patch took.
```

Confirm the clipboard still holds the **unmodified, unpinned** one-liner
(`Get-Clipboard -Raw` should equal the real published one-liner exactly) —
only the internal fetch URL is pinned for testing; what a real user would
copy/paste is unaffected by this patch and must stay correct.

## Hard rules (unchanged, still non-negotiable)

- **Never touch a real Granted install** — throwaway `GRANTED_INSTALL_DIR`
  for every run, confirm `$HOME\granted` untouched if present.
- Work in scratch directories, never an existing checkout.
- Don't deliberately trigger Defender detections beyond what's needed.
- Ask before system-level changes on a real/shared machine — standing
  permission to do all of it freely on your own disposable VM, which you
  create and destroy regardless.
- Report honestly, with exact strings/timings/screenshots. "It worked" is
  not evidence.

## Test matrix

### A'' — The actual target scenario: fresh machine, watch PATH staleness get fixed
On a machine with **neither** git nor node (a freshly launched Windows
Server instance from a stock AMI naturally starts this way — don't
pre-install anything):
1. Build and launch the **pinned** app (per Test setup above).
2. Get to PrereqCheck. Confirm ✗/✗ for both.
3. Click "Open a terminal for me". Let it run to completion — console
   should print `Done. Next steps:`.
4. **This is the actual regression test.** Without closing or relaunching
   the app, confirm:
   - The note updates to something like "Install finished — re-checking…"
   - The rows flip to **✓ Git: found (...)** / **✓ Node.js (22+ required):
     found (...)**, matching the real versions `git --version`/`node -v`
     report in a brand-new shell, **without restarting the app**.
5. Also click **"Check again"** once more afterward — should still show
   ✓/✓ (confirms the manual path independently, not just the auto-recheck
   event).
6. Check `%TEMP%\granted-install-status-*.json` — the file from this run
   should still exist, containing `{"state":"done","message":null}` (round
   2 found this used to get deleted immediately, making it hard to verify
   externally; that's fixed now, so this should be straightforward).

### Spot-check: round 2's confirmed-working fixes are still intact
Pick **2-3**, not all — this round didn't touch the code these depend on,
so a full re-run would be redundant:
- **D** (forced failure — `GRANTED_INSTALL_DIR` pointing at an existing
  non-empty non-clone dir): UI should show the real git-clone-failed
  message, not a false success.
- **H** (Group Policy `AllSigned`, VM only, ask first / your own
  disposable VM): within ~10-12s, UI should show "Couldn't confirm the
  installer actually started — a security policy...". No status file
  should ever appear for this case (the script never runs its first line).
- **C** (double-click via direct IPC, same technique as round 2 — call
  `window.api.openInstallTerminal()` twice back-to-back with zero delay):
  exactly one install should run; the second call should return
  `{ ok: false, message: "An install is already running..." }`.

## Automation tips (same as prior rounds)

- **Locked screen / no interactive session**: `npx electron-vite dev
  --remote-debugging-port 9333` (or launch the built `electron.exe` the
  same way) + Chrome DevTools Protocol via a WebSocket to the page target
  from `http://127.0.0.1:9333/json`. `Runtime.evaluate` with
  `awaitPromise: true` can call `window.api.*` methods directly.
- **AutoAdminLogon on a fresh EC2Launch v2 Windows image**: if you hit this
  again, EC2Launch v2's default `setAdminAccount: password: type: random`
  re-randomizes the Administrator password on every boot and deletes
  `AutoAdminLogon`/`DefaultPassword` once `AutoLogonCount` reaches 0. Patch
  `C:\ProgramData\Amazon\EC2Launch\config\agent-config.yml` to
  `type: DoNothing` first, then set the password and `AutoAdminLogon`
  yourself, and set `ForceAutoLogon=1` instead of leaving `AutoLogonCount`
  present at all.
- **No AWS CLI on the base Windows Server AMI**: use the pre-installed
  `AWSPowerShell` module (`Read-S3Object`/`Write-S3Object`) for artifact
  transfer via a temporary S3 bucket, same as prior rounds.
- **Free Tier instance-type restriction**: `m7i-flex.large` (2 vCPU/8GB)
  worked fine for this workload in both prior rounds. `--dry-run` does
  NOT catch the Free-Tier-type rejection; don't rely on it.

## Cleanup (verify each, and report)

- Kill all `electron.exe`/installer PowerShell processes, stop any dev
  server.
- Delete every `granted-validate-*` directory, your scratch clone, and any
  `%TEMP%\granted-install*` files you created for testing.
- Revert any Group Policy change (Case H) and verify reverted.
- Confirm `$HOME\granted` (if present) untouched.
- Terminate every AWS resource you created (instance, EBS, S3 bucket,
  security group, IAM role/instance profile, key pair) and verify with API
  calls that each is actually gone — not just that you issued a delete.
- **Do not delete** any pre-existing resources you didn't create this
  round (prior rounds left some `granted-*`-named security groups/roles/key
  pairs in place deliberately, unattached, $0 cost — leave them alone
  unless you created them this session).

## Report format

1. **Environment table** (OS, admin y/n, git/Node versions at start,
   commit tested, confirmation the pinned URL serves the matching SHA256).
2. **Results table**: case → pass/fail → evidence, against the criteria
   above.
3. **Bugs found** (if any) — severity, exact repro, observed vs expected,
   root cause if verified, user impact. Don't fix them.
4. **Not tested**, with reasons.
5. **Cleanup confirmation**, with API-call evidence for every AWS resource.
6. **Cost**: instance runtime × rate, plus any other billable usage.
