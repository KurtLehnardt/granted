# Granted -- one-shot Windows installer.
#
#   irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
#
# Installs Node.js 22+ and git if missing (winget if available, otherwise a
# direct official-installer download -- winget isn't present on every Windows
# box, notably Windows Server), clones the repo, and runs `npm ci` (installs
# exactly what's in package-lock.json, and never rewrites it).
# Safe to re-run: skips anything already present/done (npm ci does remove and
# reinstall node_modules each time, which is expected).
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
$StatusPath = if ($env:GRANTED_STATUS_FILE) { $env:GRANTED_STATUS_FILE } else { Join-Path $env:TEMP "granted-install-status.json" }
function Write-Status($state, $message) {
  try {
    $payload = @{ state = $state; message = $message } | ConvertTo-Json -Compress
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

$RepoUrl = "https://github.com/KurtLehnardt/granted.git"
$TargetDir = if ($env:GRANTED_INSTALL_DIR) { $env:GRANTED_INSTALL_DIR } else { "granted" }
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
if (Test-Path "$TargetDir\scaffold\package.json") {
  Ok "$TargetDir already cloned"
} else {
  Log "Cloning $RepoUrl into .\$TargetDir ..."
  git clone $RepoUrl $TargetDir
  Assert-LastExitCode "git clone failed. If $TargetDir was partially created, remove it before re-running."
  Ok "cloned"
}

# 4) npm ci -- installs exactly what package-lock.json pins, and never rewrites it
# (unlike `npm install`, which can touch the lockfile on a version/registry mismatch).
Set-Location "$TargetDir\scaffold"
Log "Installing npm dependencies..."
npm ci
Assert-LastExitCode "npm ci failed -- see the output above for the underlying error."
Ok "dependencies installed"

Write-Status "done" $null
Log "Done. Next steps:"
Write-Host "  cd $TargetDir\scaffold"
Write-Host "  npm run setup                  # hosted API keys (OpenAI + Anthropic), or"
Write-Host "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
Write-Host "  npm run dev                    # -> http://localhost:3000"
