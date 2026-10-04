# Self-test for install-windows.ps1's status-reporting mechanism
# (Write-Status / Die / the top-level trap) — the piece the GUI installer
# depends on entirely to know whether an install actually succeeded (see
# installer/src/main/ipcPure.ts's parseInstallStatusJson, which reads what
# this writes).
#
# Run (either shell):
#   powershell.exe -NoProfile -File install-windows.tests.ps1
#   pwsh           -NoProfile -File install-windows.tests.ps1
# Exit code 0 = all passed, 1 = at least one failed (CI-friendly).
#
# install-windows.ps1 is deliberately a single, self-contained file — it's
# fetched and run directly via `irm <url> | iex`, so it can't be split into
# a separate testable module without breaking that real deployment
# mechanism. Rather than hand-duplicate its Write-Status/Die/trap logic
# here (which could silently drift from the real file — exactly the
# failure mode a regression test exists to prevent), this extracts the
# ACTUAL current source text of that block out of install-windows.ps1 at
# test time and evaluates it for real. A structural change to that block
# large enough to break the extraction below will make this test error
# loudly, not silently pass against a stale copy.
#
# Each case runs in its own CHILD-SHELL subprocess: `exit` terminates the
# whole process (not just a function/scriptblock scope), so cases that
# trigger Die()/the trap can't share a process with any other case.
#
# The child shell is `powershell.exe` 5.1 when available, falling back to
# `pwsh` (PowerShell Core) otherwise -- deliberately, not arbitrarily: real
# Windows (including every Windows Server image this script is validated
# against) ships only `powershell.exe` 5.1, which is what install-windows.ps1
# actually runs under in production and whose `Set-Content -Encoding utf8`
# writes a UTF-8 BOM that `pwsh` does not. A prior version of this suite
# hardcoded `pwsh`, which meant it silently validated the one shell that
# does NOT reproduce that BOM behavior -- on a stock Windows box with no
# PowerShell 7 installed, it didn't run at all (CommandNotFoundException).
# `pwsh` is kept as a fallback only so this suite still runs somewhere on a
# machine with no `powershell.exe` at all (e.g. a non-Windows dev machine).
$ChildShell = if (Get-Command "powershell.exe" -ErrorAction SilentlyContinue) { "powershell.exe" }
  elseif (Get-Command "pwsh" -ErrorAction SilentlyContinue) {
    Write-Host "[SETUP WARNING] powershell.exe not found -- falling back to pwsh. This will NOT exercise the UTF-8 BOM behavior that's the actual reason this test suite exists (see parseInstallStatusJson's comment in installer/src/main/ipcPure.ts); only trust a run of this suite under powershell.exe as validating the BOM path." -ForegroundColor Yellow
    "pwsh"
  } else {
    Write-Host "[SETUP FAILED] Neither powershell.exe nor pwsh is available on PATH." -ForegroundColor Red
    exit 1
  }

$ErrorActionPreference = "Stop"
$RealScriptPath = Join-Path $PSScriptRoot "install-windows.ps1"
$RealSource = Get-Content -Path $RealScriptPath -Raw

# Extract everything from the start of the file up to (but not including)
# the real script's own first action -- `Write-Status "running" $null` as
# a bare statement. That line is the boundary between "function/trap
# definitions" and "the script doing things" in the real file; grabbing
# everything before it gets $StatusPath, Write-Status, Log/Ok/Warn/Die,
# and the trap, without also running any real install logic.
$boundaryMarker = 'Write-Status "running" $null'
$boundaryIndex = $RealSource.IndexOf($boundaryMarker)
if ($boundaryIndex -lt 0) {
  Write-Host "[SETUP FAILED] Couldn't find the expected boundary line ($boundaryMarker) in install-windows.ps1 -- the file's structure changed enough that this test needs updating, not just re-run." -ForegroundColor Red
  exit 1
}
$HeaderBlock = $RealSource.Substring(0, $boundaryIndex)
foreach ($required in @('function Write-Status', 'function Die', 'trap {', '$StatusPath =')) {
  if ($HeaderBlock -notmatch [regex]::Escape($required)) {
    Write-Host "[SETUP FAILED] Extracted header block is missing '$required' -- extraction boundary or install-windows.ps1's structure changed; update this test." -ForegroundColor Red
    exit 1
  }
}

$TempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "granted-install-windows-tests-$([guid]::NewGuid())")
New-Item -ItemType Directory -Path $TempDir | Out-Null

$script:failures = 0
$script:total = 0

function Run-Case {
  param(
    [string]$Name,
    [string]$ActionSource,   # PowerShell source appended after the extracted header block
    [Nullable[int]]$ExpectedExitCode,
    [string]$ExpectedState,  # "running" | "done" | "error" | $null (null = expect no status file at all)
    [string]$ExpectedMessageSubstring = $null,
    [string]$ExpectedOutputSubstring = $null
  )
  $script:total++
  $statusPath = Join-Path $TempDir "$Name-status.json"
  $caseScriptPath = Join-Path $TempDir "$Name.ps1"
  $outputPath = Join-Path $TempDir "$Name-output.txt"
  Set-Content -Path $caseScriptPath -Value ($HeaderBlock + "`n" + $ActionSource) -Encoding utf8

  $env:GRANTED_STATUS_FILE = $statusPath
  & $ChildShell -NoProfile -File $caseScriptPath *> $outputPath
  $actualExitCode = $LASTEXITCODE
  Remove-Item Env:\GRANTED_STATUS_FILE -ErrorAction SilentlyContinue
  $capturedOutput = if (Test-Path $outputPath) { Get-Content -Path $outputPath -Raw } else { "" }

  $problems = @()

  if ($null -ne $ExpectedExitCode -and $actualExitCode -ne $ExpectedExitCode) {
    $problems += "exit code: expected $ExpectedExitCode, got $actualExitCode"
  }

  if ($ExpectedOutputSubstring -and ($capturedOutput -notlike "*$ExpectedOutputSubstring*")) {
    $problems += "captured output did not contain expected substring '$ExpectedOutputSubstring' (got: '$capturedOutput')"
  }

  if ([string]::IsNullOrEmpty($ExpectedState)) {
    if (Test-Path $statusPath) {
      $problems += "expected NO status file, but one was written: $(Get-Content $statusPath -Raw)"
    }
  } else {
    if (-not (Test-Path $statusPath)) {
      $problems += "expected a status file with state='$ExpectedState', but none was written"
    } else {
      $raw = Get-Content -Path $statusPath -Raw
      # Mirrors parseInstallStatusJson's own BOM handling (installer/src/main/ipcPure.ts)
      # -- Set-Content -Encoding utf8 under real Windows PowerShell 5.1 writes one;
      # $ChildShell is pwsh (no BOM) on a box with no powershell.exe, so strip
      # defensively either way rather than assuming which shell actually ran.
      $withoutBom = $raw -replace "^\xEF\xBB\xBF", ""
      try {
        $parsed = $withoutBom | ConvertFrom-Json
      } catch {
        $problems += "status file content isn't valid JSON: $withoutBom"
        $parsed = $null
      }
      if ($parsed) {
        if ($parsed.state -ne $ExpectedState) {
          $problems += "state: expected '$ExpectedState', got '$($parsed.state)'"
        }
        if ($ExpectedMessageSubstring -and ($parsed.message -notlike "*$ExpectedMessageSubstring*")) {
          $problems += "message did not contain expected substring '$ExpectedMessageSubstring' (got: '$($parsed.message)')"
        }
        # Every write carries the writing window's own PID (the GUI's
        # closed-window detection depends on it) -- the child shell's, so
        # never this test runner's.
        if (-not ($parsed.pid -is [int] -or $parsed.pid -is [long]) -or $parsed.pid -le 0) {
          $problems += "pid: expected a positive integer, got '$($parsed.pid)'"
        } elseif ($parsed.pid -eq $PID) {
          $problems += "pid: got the test runner's own PID ($PID), not the child shell's"
        }
      }
    }
  }

  if ($problems.Count -eq 0) {
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } else {
    $script:failures++
    Write-Host "[FAIL] $Name" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "         - $p" -ForegroundColor Red }
  }
}

Run-Case -Name "running-then-done" `
  -ActionSource 'Write-Status "running" $null; Write-Status "done" $null' `
  -ExpectedExitCode 0 -ExpectedState "done"

Run-Case -Name "die-writes-error-with-message" `
  -ActionSource 'Die "git clone failed. If foo was partially created, remove it before re-running."' `
  -ExpectedExitCode 1 -ExpectedState "error" -ExpectedMessageSubstring "git clone failed"

Run-Case -Name "uncaught-terminating-error-is-caught-by-trap" `
  -ActionSource 'Write-Status "running" $null; throw "simulated network failure: could not reach api.github.com"' `
  -ExpectedExitCode 1 -ExpectedState "error" -ExpectedMessageSubstring "simulated network failure"

Run-Case -Name "die-exit-does-not-double-trigger-trap" `
  -ActionSource @'
$script:trapFireCount = 0
# Redefine trap in this case's own scope to count fires, proving Die()'s
# `exit 1` (not a terminating error) never re-enters it -- only an actual
# uncaught error would.
trap {
  $script:trapFireCount++
  Write-Status "error" "TRAP-FIRED: $($_.Exception.Message)"
  exit 1
}
Die "deliberate failure"
'@ `
  -ExpectedExitCode 1 -ExpectedState "error" -ExpectedMessageSubstring "deliberate failure"

Run-Case -Name "write-status-failure-is-surfaced-not-silent" `
  -ActionSource @'
# Point $StatusPath at a path whose parent segment is itself a FILE (not
# a directory), so Set-Content inside Write-Status cannot possibly
# succeed -- then confirm the catch block prints a warning to the console
# rather than swallowing the failure silently.
$blocker = Join-Path ([System.IO.Path]::GetTempPath()) "granted-test-blocker-file-$PID.txt"
Set-Content -Path $blocker -Value "not a directory" -Encoding utf8
$StatusPath = Join-Path $blocker "status.json"
Write-Status "running" $null
Remove-Item $blocker -ErrorAction SilentlyContinue
exit 0
'@ `
  -ExpectedExitCode 0 -ExpectedState $null -ExpectedOutputSubstring "Couldn't write install status"

Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($script:failures -eq 0) {
  Write-Host "All $script:total install-windows.ps1 status-mechanism tests passed." -ForegroundColor Green
  exit 0
} else {
  Write-Host "$script:failures of $script:total install-windows.ps1 status-mechanism tests FAILED." -ForegroundColor Red
  exit 1
}
