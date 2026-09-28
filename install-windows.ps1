# Granted -- one-shot Windows installer.
#
#   irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex
#
# Installs Node.js 20+ and git if missing (winget if available, otherwise a
# direct official-installer download -- winget isn't present on every Windows
# box, notably Windows Server), clones the repo, and runs `npm install`.
# Safe to re-run: skips anything already present/done.
#
# After this finishes, `cd granted\scaffold` and run `npm run setup` (hosted
# API keys) or `npm run setup:local -- --yes` (fully local via Ollama), then
# `npm run dev`.

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (still the default on many machines, including every
# Windows Server image) defaults its underlying .NET stack to TLS 1.0/1.1,
# which GitHub and nodejs.org both reject -- Invoke-WebRequest fails with a
# generic "connection was closed unexpectedly" that gives no hint why. Force
# TLS 1.2 before any web request.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = "https://github.com/KurtLehnardt/granted.git"
$TargetDir = if ($env:GRANTED_INSTALL_DIR) { $env:GRANTED_INSTALL_DIR } else { "granted" }
$NodeMajorMin = 20

function Log($msg)  { Write-Host "`n$msg" -ForegroundColor White }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  [x] $msg" -ForegroundColor Red; exit 1 }

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function HaveWinget() { return (Have "winget") }

Log "Granted -- Windows install"

# Refresh PATH in this process so a package we just installed is visible
# without needing a new shell (installers update the registry, not our PATH).
function Sync-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

if (HaveWinget) {
  Ok "winget available"
} else {
  Warn "winget not found (common on Windows Server / locked-down images) -- falling back to direct installer downloads"
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
    Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-" -Wait
    Remove-Item $gitInstaller -ErrorAction SilentlyContinue
  }
  Sync-Path
  if (-not (Have "git")) { Die "git install finished but 'git' still isn't on PATH -- open a new shell and re-run." }
  Ok "git installed ($(git --version))"
}

# 2) Node.js 20+.
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
    # nodejs.org's index.json is sorted newest-first; take the latest v20.x
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
  Sync-Path
  if (-not (Have "node")) { Die "node install finished but 'node' still isn't on PATH -- open a new shell and re-run." }
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
  Ok "cloned"
}

# 4) npm install.
Set-Location "$TargetDir\scaffold"
Log "Installing npm dependencies..."
npm install
Ok "dependencies installed"

Log "Done. Next steps:"
Write-Host "  cd $TargetDir\scaffold"
Write-Host "  npm run setup                  # hosted API keys (OpenAI + Anthropic), or"
Write-Host "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
Write-Host "  npm run dev                    # -> http://localhost:3000"
