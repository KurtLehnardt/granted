# Granted -- one-shot Windows installer.
#
#   irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
#
# Installs Node.js 22+ and git if missing (winget if available, otherwise a
# direct official-installer download -- winget isn't present on every Windows
# box, notably Windows Server), clones the repo, and runs `npm ci` (installs
# exactly what's in package-lock.json, and never rewrites it).
# Safe to re-run: skips anything already present/done (npm ci does remove and
# reinstall node_modules each time, which is expected). Set GRANTED_REF to a
# release tag (v1.2.3) to install that release instead of main.
#
# After this finishes, `cd granted\scaffold` and run `npm run setup` (hosted
# API keys) or `npm run setup:local -- --yes` (fully local via Ollama), then
# `npm run dev`.

$ErrorActionPreference = "Stop"

# Reports real progress back to the Electron GUI, which launches this script
# detached (via `cmd /c start`) specifically so its console window survives
# the GUI closing -- which also means the GUI can't see this process's exit
# code. Without this file the GUI could only ever report "I opened
# PowerShell", never whether the install actually succeeded. $env:GRANTED_
# STATUS_FILE is set by the GUI to a path that matches what it's polling;
# falls back to a fixed name so this script still no-ops safely when run
# standalone (copy-pasted into a terminal by hand, as the README documents).
# While this console window is alive the GUI keeps waiting however long a UAC
# prompt sits unanswered; once it's gone without a done/error the GUI knows
# the window was closed (a real Windows 11 run went past the GUI's old fixed
# 10-minute limit at a UAC prompt, and a second click then started a
# concurrent install). "Alive" = this window still holds an exclusive lock on
# "<status>.lock" (Windows releases it the moment the process exits, and
# unlike a PID it can't be inherited by an unrelated process); `pid` in each
# status write is the fallback. The lock line must stay identical to
# STATUS_LOCK_LINE in installer/src/main/ipcPure.ts -- a test checks.
$StatusPath = if ($env:GRANTED_STATUS_FILE) { $env:GRANTED_STATUS_FILE } else { Join-Path $env:TEMP "granted-install-status.json" }
try { $global:GrantedStatusLock = [System.IO.File]::Open("$StatusPath.lock", 'OpenOrCreate', 'ReadWrite', 'None') } catch { }
function Write-Status($state, $message) {
  try {
    $payload = @{ state = $state; message = $message; pid = $PID } | ConvertTo-Json -Compress
    Set-Content -Path $StatusPath -Value $payload -Encoding utf8 -ErrorAction Stop
  } catch {
    # Never let status reporting itself break the install -- but don't go
    # silent about it either: the GUI's only way to learn this write failed
    # is a generic "couldn't confirm it started" timeout, which reads as a
    # security-policy block even when the real cause is something else
    # (AV, a redirected/read-only %TEMP%, disk full). Surfacing it here
    # means it's at least visible in the one place that's guaranteed to be
    # readable -- this console window.
    Write-Host "  [!] Couldn't write install status to $StatusPath -- $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Log($msg)  { Write-Host "`n$msg" -ForegroundColor White }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Status "error" $msg; Write-Host "  [x] $msg" -ForegroundColor Red; exit 1 }

# Catches anything Die() doesn't -- a terminating error PowerShell itself
# raises (a failed Invoke-WebRequest/Invoke-RestMethod, for example) would
# otherwise unwind straight out of the script with the status file still
# stuck on "running" forever. `exit 1` inside Die() does NOT re-trigger this
# (it isn't a terminating error), so there's no risk of a double report.
trap {
  Write-Status "error" $_.Exception.Message
  Write-Host "  [x] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Status "running" $null

# Windows PowerShell 5.1 (still the default on many machines, including every
# Windows Server image) defaults its underlying .NET stack to TLS 1.0/1.1,
# which GitHub and nodejs.org both reject -- Invoke-WebRequest fails with a
# generic "connection was closed unexpectedly" that gives no hint why. Force
# TLS 1.2 before any web request.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# GRANTED_REPO_URL: tests point this at a local repo.
$RepoUrl = if ($env:GRANTED_REPO_URL) { $env:GRANTED_REPO_URL } else { "https://github.com/KurtLehnardt/granted.git" }
$TargetDir = if ($env:GRANTED_INSTALL_DIR) { $env:GRANTED_INSTALL_DIR } else { "granted" }
# GRANTED_REF: install this release (a tag like v1.2.3) instead of the latest
# code on main. The downloadable installer (Granted-Setup-x.y.z.exe) sets it
# to its own version -- or to a newer release, if the user asked it to check
# for updates -- and an install made by this script is moved to it on a re-run.
$Ref = $env:GRANTED_REF
if ($Ref -and $Ref -notmatch '^v\d+\.\d+\.\d+$') { Die "GRANTED_REF must be a release tag like v1.2.3 (got '$Ref')." }
$NodeMajorMin = 22

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function HaveWinget() { return (Have "winget") }

# $ErrorActionPreference = "Stop" only promotes PowerShell cmdlet errors to
# terminating ones -- it does NOT make a native command's nonzero exit code
# throw (unlike bash's `set -e`, which install-linux.sh relies on for the
# same calls). Every native command that can fail is checked explicitly here.
function Assert-LastExitCode($msg) {
  if ($LASTEXITCODE -ne 0) { Die $msg }
}

$script:IsElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

Log "Granted -- Windows install"

# Refresh PATH in this process so a package we just installed is visible
# without needing a new shell (installers update the registry, not our PATH).
# Merges into the existing $env:Path rather than replacing it, so anything
# the calling session had that isn't persisted to Machine/User scope survives.
function Sync-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$env:Path;$machine;$user"
}

# The installer's own process can exit slightly before its registry PATH
# write (or a deferred/spawned step) lands, especially under disk/AV
# contention -- poll briefly instead of judging success from one snapshot.
function Wait-Have($cmd, $timeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    Sync-Path
    if (Have $cmd) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

if (HaveWinget) {
  Ok "winget available"
} else {
  Warn "winget not found (common on Windows Server / locked-down images) -- falling back to direct installer downloads"
  if (-not $script:IsElevated) {
    Warn "Not running as Administrator. git's fallback installs per-user (no admin needed), but Node's official .msi is machine-scoped and its install will fail without elevation. If the Node step below fails, re-open PowerShell as Administrator and re-run."
  }
}

# 1) git.
if (Have "git") {
  Ok "git already installed ($(git --version))"
} else {
  Log "Installing git..."
  if (HaveWinget) {
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  } else {
    # Ask GitHub for the actual latest release rather than hardcoding a
    # version+build pin -- git-for-windows' build number doesn't track its
    # version number 1:1 (e.g. 2.47.1 shipped as build 2.47.1.2), so any pin
    # goes stale (and silently 404s) the moment a new release ships.
    $gitRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "granted-install-script" }
    $gitAsset = $gitRelease.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
    if (-not $gitAsset) { Die "couldn't find a 64-bit installer in the latest git-for-windows release ($($gitRelease.tag_name))." }
    $gitUrl = $gitAsset.browser_download_url
    $gitInstaller = "$env:TEMP\git-installer.exe"
    Log "Downloading Git for Windows ($($gitRelease.tag_name))..."
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
    Log "Running installer silently..."
    # /CURRENTUSER installs per-user -- unlike Node's .msi below, git-for-
    # windows' Inno Setup installer supports this, so it works without
    # Administrator rights regardless of $script:IsElevated. Validated
    # behavior: as a standard user this lands per-user with no UAC prompt,
    # as documented; run elevated, Inno Setup installs all-users anyway
    # (Program Files, Machine PATH) -- both work, /CURRENTUSER just isn't a
    # hard guarantee once already elevated.
    Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CURRENTUSER" -Wait
    Remove-Item $gitInstaller -ErrorAction SilentlyContinue
  }
  if (-not (Wait-Have "git")) { Die "git install finished but 'git' still isn't on PATH -- open a new shell and re-run." }
  Ok "git installed ($(git --version))"
}

# 2) Node.js 22+.
$nodeOk = $false
if (Have "node") {
  $nodeVersionRaw = (node -v)
  if ($nodeVersionRaw -match '^v(\d+)\.') {
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -ge $NodeMajorMin) {
      Ok "node already installed ($nodeVersionRaw)"
      $nodeOk = $true
    } else {
      Warn "node $nodeVersionRaw is older than $NodeMajorMin -- installing a newer one"
    }
  } else {
    Warn "couldn't parse a version from 'node -v' ($nodeVersionRaw) -- installing $NodeMajorMin to be safe"
  }
}
if (-not $nodeOk) {
  Log "Installing Node.js $NodeMajorMin..."
  if (HaveWinget) {
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  } else {
    # nodejs.org's index.json is sorted newest-first; take the latest v22.x
    # release rather than pinning one, for the same reason as the git lookup
    # above -- a pinned version goes stale.
    $nodeRelease = (Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json") | Where-Object { $_.version -match "^v$NodeMajorMin\." } | Select-Object -First 1
    if (-not $nodeRelease) { Die "couldn't find a v$NodeMajorMin release in nodejs.org's release index." }
    $nodeUrl = "https://nodejs.org/dist/$($nodeRelease.version)/node-$($nodeRelease.version)-x64.msi"
    $nodeInstaller = "$env:TEMP\node-installer.msi"
    Log "Downloading Node.js ($($nodeRelease.version))..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing
    Log "Running installer silently..."
    Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$nodeInstaller`"", "/qn", "/norestart" -Wait
    Remove-Item $nodeInstaller -ErrorAction SilentlyContinue
  }
  if (-not (Wait-Have "node")) {
    $hint = if (-not $script:IsElevated) { " This is likely the earlier elevation warning -- re-run as Administrator." } else { " Open a new shell and re-run." }
    Die "node install finished but 'node' still isn't on PATH.$hint"
  }
  Ok "node installed ($(node -v))"
}

# 3) Clone (skip if already present). Checked via scaffold\package.json, not a
# bare .git dir -- a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet. If $TargetDir exists but isn't a finished clone,
# `git clone` below fails with its own clear error rather than this script
# guessing whether it's safe to delete.
# Quits Granted if it's running from this folder -- its background tray
# (which stops its server) and any node.exe running from in here, e.g. a
# `npm run dev` in a terminal -- and WAITS until it has: an update replaces
# files a running server holds open (npm ci would fail with EBUSY/EPERM).
# It starts again the next time Granted is opened.
function Stop-GrantedIn([string]$dir) {
  $full = (Get-Item -LiteralPath $dir).FullName.TrimEnd('\')
  $tray = Join-Path $full "scaffold\scripts\windows\granted-tray.ps1"
  $trays = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($tray, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  foreach ($t in $trays) {
    # Its port: its own -Port, else GRANTED_PORT (as the tray reads it), else 3000.
    $port = if ($t.CommandLine -match '-Port\s+(\d+)') { [int]$Matches[1] } elseif ($env:GRANTED_PORT -match '^\d+$') { [int]$env:GRANTED_PORT } else { 3000 }
    try { & $tray -Stop -Port $port | Out-Null } catch { }
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and @($trays | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
  $node = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf("$full\", [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  # Anything still running: stopped outright. taskkill via Start-Process --
  # never PowerShell's native-command handling, which turns its stderr (a
  # process already gone) into a terminating error here.
  foreach ($p in @($trays | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }) + $node) {
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\taskkill.exe") -ArgumentList "/PID $($p.ProcessId) /T /F" -WindowStyle Hidden -Wait
  }
  if ($trays.Count -gt 0 -or $node.Count -gt 0) { Ok "stopped the Granted that was running (it starts again when you open it)" }
}

# "1.2.3" (or "v1.2.3", "1.2.3-dev") -> [version] 1.2.3, for comparing.
function Get-VersionNumber([string]$text) {
  if ($text -match '(\d+)\.(\d+)\.(\d+)') { return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
  return $null
}

$existingInstall = Test-Path "$TargetDir\scaffold\package.json"
if ($existingInstall) {
  Ok "$TargetDir already cloned"
  # Asked for a specific release: move an install THIS script made to it (an
  # update) -- never someone's own checkout (no marker), never over changes
  # made in the folder, and never backwards: an older installer run again
  # (or one whose update check failed) must not replace newer code.
  if ($Ref) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetDir ".git\granted-installer"))) {
      Warn "Not changing $TargetDir to $Ref -- it wasn't installed by this installer (your own checkout?)."
    } elseif (git -C $TargetDir status --porcelain) {
      Warn "Not changing $TargetDir to $Ref -- it has local changes."
    } else {
      # Just this tag, forced: a release tag that was moved on GitHub (re-tagged
      # after a fix) must not break updates, and a stale local copy of it must
      # not be what's installed.
      git -C $TargetDir fetch --quiet --force origin "+refs/tags/${Ref}:refs/tags/${Ref}"
      Assert-LastExitCode "Couldn't download Granted $Ref (git fetch failed)."
      git -C $TargetDir merge-base --is-ancestor "refs/tags/$Ref" HEAD
      if ($LASTEXITCODE -eq 0) {
        Ok "already includes Granted $Ref -- nothing to update"
      } else {
        $have = Get-VersionNumber ((Get-Content -LiteralPath "$TargetDir\scaffold\package.json" -Raw | ConvertFrom-Json).version)
        $want = Get-VersionNumber $Ref
        if ($have -and $want -and $have -gt $want -and $env:GRANTED_ALLOW_DOWNGRADE -ne "1") {
          Warn "Not changing $TargetDir to $Ref -- it already has a newer Granted ($have)."
        } else {
          Log "Updating $TargetDir to Granted $Ref ..."
          Stop-GrantedIn $TargetDir
          git -C $TargetDir -c advice.detachedHead=false checkout --quiet "refs/tags/$Ref"
          Assert-LastExitCode "Couldn't switch $TargetDir to $Ref (git checkout failed)."
          Ok "now at $Ref"
        }
      }
    }
  }
} else {
  Log "Cloning $RepoUrl into .\$TargetDir ..."
  if ($Ref) {
    git -c advice.detachedHead=false clone --branch $Ref $RepoUrl $TargetDir
  } else {
    git clone $RepoUrl $TargetDir
  }
  Assert-LastExitCode "git clone failed. If $TargetDir was partially created, remove it before re-running."
  # Marks this clone as made by the installer (inside .git, so git never
  # sees it): only such clones are listed in Installed apps -- a folder that
  # was already here may be someone's own checkout, which Settings must never
  # offer to delete. See scaffold\scripts\windows\uninstall.ps1.
  Set-Content -LiteralPath (Join-Path $TargetDir ".git\granted-installer") -Value "Cloned by install-windows.ps1 on $(Get-Date -Format s)" -Encoding ascii
  Ok "cloned"
}

# 4) npm ci -- installs exactly what package-lock.json pins, and never rewrites it
# (unlike `npm install`, which can touch the lockfile on a version/registry mismatch).
# A re-run (an update, say) while Granted is running: quit it first -- its
# server holds files in node_modules that npm ci is about to replace.
if ($existingInstall) { Stop-GrantedIn $TargetDir }
Set-Location "$TargetDir\scaffold"
Log "Installing npm dependencies..."
npm ci
Assert-LastExitCode "npm ci failed -- see the output above for the underlying error."
Ok "dependencies installed"

# 5) List Granted in Settings -> Apps -> Installed apps (per-user, no admin),
# so it can be uninstalled from there like any other app -- only a clone this
# script made (see the marker above). Never fails the install: Granted works
# the same without the entry. -LiteralPath / .FullName: a folder name with
# [brackets] is a wildcard pattern to Test-Path and Resolve-Path.
$uninstallScript = Join-Path (Get-Location).ProviderPath "scripts\windows\uninstall.ps1"
if (Test-Path -LiteralPath $uninstallScript) {
  try {
    $registered = (& $uninstallScript -Register -InstallDir (Get-Item -LiteralPath "..").FullName | Select-Object -Last 1) | ConvertFrom-Json
    if ($registered.registered) {
      Ok "added to Installed apps (uninstall it from Settings -> Apps)"
    } elseif ($registered.reason -eq "not-made-by-installer") {
      Ok "not added to Installed apps: $TargetDir was already here before this install (your own checkout?)"
    } else {
      Warn "Couldn't add Granted to Installed apps ($($registered.detail)). Granted still works."
    }
  } catch {
    Warn "Couldn't add Granted to Installed apps ($($_.Exception.Message)). Granted still works."
  }
}

Write-Status "done" $null
Log "Done. Next steps:"
Write-Host "  cd $TargetDir\scaffold"
Write-Host "  npm run setup                  # hosted API key (OpenAI; Claude optional), or"
Write-Host "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
Write-Host "  npm run dev                    # -> http://localhost:3000"
