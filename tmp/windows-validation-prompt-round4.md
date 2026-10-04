# Windows validation round 4: Granted GUI installer, clean end-to-end pass

The project owner wants one clean, final validation run on real Windows
before merging. This is a **verification pass**: find and report problems
with concrete evidence. Do **not** fix code, push, merge, or open PRs.
Report back.

## Background

Three prior rounds found and fixed 7 bugs total across `installer/` (an
Electron GUI installer wizard) and `install-windows.ps1`:
- Round 1: 6 bugs found (double-click race, false-success reporting,
  Group-Policy incompatibility, stale prereq screen, raw error leakage,
  unsigned exe — the last one out of scope, needs code-signing infra).
- Round 2: validated 5 fixes; confirmed 4 worked, found the stale-prereq
  fix (#4) didn't actually work (Electron's main process never re-reads
  `PATH` after install-windows.ps1 updates the registry).
- Round 3: validated the fix for that. **The core scenario now works**:
  fresh machine, install from scratch, same still-open app flips from ✗✗
  to ✓✓ without a restart. But round 3 found the fix itself had a bug:
  every failed check appended the full registry PATH instead of merging,
  so repeated "Check again" clicks grew `process.env.PATH` without bound,
  saturating Windows's 32,767-char env-var limit after ~16-120 checks
  (depending on the machine's own PATH length) — after which PATH
  silently stops updating and the original bug comes back.
- That growth bug is now fixed too (latest commit on
  `fix/gui-installer-m1-findings` — fetch the branch yourself and use
  whatever is actually at its tip, don't assume a specific SHA). The fix
  rebuilds PATH from a fixed original snapshot + deduped registry entries
  on every call instead of ever appending, which was verified **only** via
  pure Node.js logic testing (no OS dependency in that part of the code) —
  **never on real Windows**. That's the one open gap this round closes.

**Your job**: run the full scenario clean, end to end, and specifically
prove the PATH-growth fix holds on real Windows under repeated use — not
just in isolated logic testing.

## Test setup — pin the one-liner to this commit

The public one-liner (`irm https://raw.githubusercontent.com/KurtLehnardt/
granted/main/install-windows.ps1 | iex`) is hardcoded to fetch from `main`,
which doesn't have any of this code yet. To test the actual branch:

```powershell
git clone -b fix/gui-installer-m1-findings https://github.com/KurtLehnardt/granted.git
cd granted\installer
git rev-parse --short HEAD   # record this
npm install
npm run build
```

Then patch the build so the **spawned script** (not the clipboard copy)
points at this commit. Round 3 found that patching `INSTALL_ONE_LINERS`
directly breaks the "clipboard holds the unmodified one-liner" assertion,
since that constant backs both. Instead, in the built `out/main/index.js`,
find the `scriptContents` template (search for `GRANTED_STATUS_FILE`) and
patch only the inner one-liner reference there — e.g. wrap it so the
commit's URL is substituted at the point the script content is built,
leaving `INSTALL_ONE_LINERS` itself untouched. Verify after patching:
1. The clipboard (`Get-Clipboard -Raw` after clicking the escape hatch)
   still equals the real, unmodified published one-liner, byte-for-byte.
2. The actual fetch URL embedded in the temp script you end up launching
   resolves to a file whose SHA256 matches your local `install-windows.ps1`
   exactly.

Don't skip step 2 — round 3 found this exact pinning step easy to get
subtly wrong, and an unpinned test silently validates the wrong code.

## Hard rules (unchanged, still non-negotiable)

- **Never touch a real Granted install** — throwaway `GRANTED_INSTALL_DIR`
  for every run, confirm `$HOME\granted` untouched if present (or never
  existed).
- Work in scratch directories, never an existing checkout.
- Don't deliberately trigger Defender detections beyond what's needed.
- Ask before system-level changes on a real/shared machine — standing
  permission to do all of it freely on your own disposable VM, which you
  create and destroy regardless.
- Report honestly, with exact strings/timings/screenshots/measured values.
  "It worked" is not evidence.

## Test matrix

### 1 — Clean end-to-end pass (the full scenario, once, cleanly)
Fresh machine, neither git nor Node present.
1. Build and launch the pinned app. Confirm ✗/✗.
2. Click "Open a terminal for me". Let it run to completion (console
   prints `Done. Next steps:`).
3. Without closing or relaunching the app: confirm the note updates to
   something like "Install finished — re-checking…" and the rows flip to
   ✓/✓ matching real `git --version`/`node -v` output from a brand-new
   shell.
4. Click "Check again" once more — still ✓/✓.
5. Confirm `%TEMP%\granted-install-status-*.json` for this run contains
   `{"state":"done","message":null}`.

### 2 — Directly measure PATH growth on real Windows (the actual new thing to prove)
This needs visibility into the **main process's** `process.env.PATH`,
which the renderer can't see directly. Launch the built app with **both**
`--remote-debugging-port=9333` (drives the renderer, same as prior rounds)
**and** `--inspect=9222` (Electron's main process exposes its own Node
inspector under this flag — a separate CDP-compatible endpoint from the
renderer's). Connect to `ws://127.0.0.1:9222/...` (get the exact URL from
`http://127.0.0.1:9222/json`) and use `Runtime.evaluate` there — this
evaluates in the **main process's own context**, so `process.env.PATH` is
directly readable.

On a machine where git/Node are **still missing** (so every check fails
and `refreshWindowsPathEnv` actually runs each time):
1. Record `process.env.PATH.length` via the inspector before any checks.
2. Click "Check again" in the renderer **30 times**, with a short pause
   between clicks so each one's async check actually completes before the
   next (e.g. 1-2s apart — confirm each click's result lands, don't just
   fire 30 clicks instantly).
3. Record `process.env.PATH.length` via the inspector after. **Expected:
   stable after the first call — not growing with each subsequent check.**
   Report the exact sequence of lengths (or at least before/1st-call/
   15th-call/30th-call) so growth, if any, is visible in the data, not
   just a pass/fail verdict.
4. As a final check, actually install git/Node (via the escape hatch, as
   in test 1) and confirm the app still picks them up correctly — proving
   the repeated-checks stress test didn't leave PATH in a state that
   breaks the real detection.

### Spot-check: everything else is still intact (light pass)
Pick 2 of these (not all — these have each already passed in 2-3 prior
rounds and this round didn't touch the code they depend on):
- **C** (double-click via direct IPC — call `window.api.openInstallTerminal()`
  twice back-to-back with zero delay): exactly one install should run.
- **D** (forced failure — `GRANTED_INSTALL_DIR` pointing at an existing
  non-empty non-clone dir): real error message, not false success.
- **H** (Group Policy `AllSigned`, your own disposable VM, ask first):
  within ~10-12s, "Couldn't confirm the installer actually started...".

## Automation tips

- **Node inspector on the main process**: `electron.exe <dir>
  --remote-debugging-port=9333 --inspect=9222`. `http://127.0.0.1:9222/json`
  lists the Node inspector target (distinct from the renderer's Chromium
  target on 9333) — connect a WebSocket to its `webSocketDebuggerUrl` and
  use `Runtime.evaluate` the same way as the renderer CDP connection used
  in prior rounds, just against this different endpoint.
- **AutoAdminLogon on a fresh EC2Launch v2 image**: patch
  `C:\ProgramData\Amazon\EC2Launch\config\agent-config.yml` to
  `setAdminAccount: password: type: DoNothing` first (its default
  `random` re-randomizes the password every boot and deletes
  `AutoAdminLogon` once `AutoLogonCount` hits 0), then set the password
  and `AutoAdminLogon` yourself with `ForceAutoLogon=1`.
- **No AWS CLI on the base Windows Server AMI** — use the pre-installed
  `AWSPowerShell` module (`Read-S3Object`/`Write-S3Object`) + a temp S3
  bucket for artifact transfer.
- **Free Tier instance-type restriction**: `m7i-flex.large` has worked
  fine for this workload in all 3 prior rounds. `--dry-run` does NOT catch
  the Free-Tier-type rejection if you try a different type.
- **Group-Policy `AllSigned` also blocks SSM** (`AWS-RunPowerShellScript`
  is itself a `.ps1`) — if testing Case H, arm a SYSTEM scheduled task
  (`reg.exe delete …`, a binary, immune to execution policy) a few minutes
  out as a safety net before setting the policy, with a try/finally revert.

## Cleanup (verify each, and report)

- Kill all `electron.exe`/installer PowerShell processes, stop any dev
  server.
- Delete every `granted-validate-*`/scratch directory and `%TEMP%\
  granted-install*` file you created.
- Revert any Group Policy change and verify reverted.
- Confirm `$HOME\granted` untouched (or never existed).
- Terminate every AWS resource you created and verify each is actually
  gone via API calls (instance, EBS, S3 bucket, security group, IAM
  role/instance profile — no key pair should be needed if you use SSM for
  everything, per prior rounds' approach).
- **Do not delete** any pre-existing `granted-*`-named resources you
  didn't create this round (prior rounds deliberately left some in place).

## Report format

1. **Environment table** (OS, admin y/n, git/Node versions at start,
   commit tested, confirmation the pinned URL + clipboard both check out).
2. **Results table**: test 1, test 2 (with the actual measured PATH
   lengths at each checkpoint), and the 2 spot-checks — pass/fail with
   evidence.
3. **Bugs found** (if any) — severity, exact repro, observed vs expected,
   root cause if verified, user impact. Don't fix them.
4. **Not tested**, with reasons.
5. **Cleanup confirmation**, with API-call evidence for every AWS resource.
6. **Cost.**
7. **Bottom line**: is this genuinely clean, or is there anything left?
