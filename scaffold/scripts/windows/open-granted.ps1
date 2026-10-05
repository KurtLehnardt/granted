# Granted -- open Granted in its own window, or in a browser tab.
#
# "Its own window" is Edge's (or Chrome's) app mode: `msedge --app=<url>`
# opens the page in a window with no tabs or address bar and its own taskbar
# entry, so Granted looks and feels like a desktop app. Edge ships with
# Windows 10/11; Chrome is the fallback; with neither (or when the user
# prefers it) Granted opens in the default browser as before.
#
#   open-granted.ps1 -Url http://localhost:3000     open it, the way the user prefers
#   open-granted.ps1 -Url ... -NoBrowserFallback    never open a browser tab itself
#                                                   (the GUI installer does that part)
#   open-granted.ps1 -SetOpenIn window|browser      save the preference
#   open-granted.ps1 -GetOpenIn                     print the preference
#
# Opening prints one JSON line: {"openedIn":"window"|"browser"|"none","browser":<path>|null}
# ("none" only with -NoBrowserFallback).
#
# The preference lives in %LOCALAPPDATA%\Granted\settings.json as
# { "openIn": "window" | "browser" } (default: window); the GUI installer
# reads and writes the same file (installer/src/main/ipcPure.ts).
# Test-only overrides: GRANTED_SETTINGS_PATH (the settings file) and
# GRANTED_APP_BROWSER (the app-mode browser; "none" = pretend there isn't one).
param(
  [string]$Url,
  [switch]$NoBrowserFallback,
  [ValidateSet("window", "browser")]
  [string]$SetOpenIn,
  [switch]$GetOpenIn
)

$ErrorActionPreference = "Stop"
$SettingsPath = if ($env:GRANTED_SETTINGS_PATH) { $env:GRANTED_SETTINGS_PATH } else { Join-Path $env:LOCALAPPDATA "Granted\settings.json" }

function Read-Settings {
  try {
    if (Test-Path -LiteralPath $SettingsPath) {
      $s = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
      if ($s -is [System.Management.Automation.PSCustomObject]) { return $s }
    }
  } catch { }   # unreadable or not JSON: treat as no settings
  return New-Object PSObject
}

function Get-OpenIn {
  if ((Read-Settings).openIn -eq "browser") { return "browser" }
  return "window"
}

# Edge, then Chrome: App Paths (where their installers register them), then
# the usual install folders.
function Find-AppBrowser {
  if ($env:GRANTED_APP_BROWSER) {
    if ($env:GRANTED_APP_BROWSER -eq "none") { return $null }
    return $env:GRANTED_APP_BROWSER
  }
  $folders = @(
    @{ exe = "msedge.exe"; paths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application", "$env:ProgramFiles\Microsoft\Edge\Application", "$env:LOCALAPPDATA\Microsoft\Edge\Application") },
    @{ exe = "chrome.exe"; paths = @("$env:ProgramFiles\Google\Chrome\Application", "${env:ProgramFiles(x86)}\Google\Chrome\Application", "$env:LOCALAPPDATA\Google\Chrome\Application") }
  )
  foreach ($b in $folders) {
    foreach ($root in "HKCU:\Software", "HKLM:\SOFTWARE", "HKLM:\SOFTWARE\WOW6432Node") {
      try {
        $p = (Get-ItemProperty -LiteralPath "$root\Microsoft\Windows\CurrentVersion\App Paths\$($b.exe)" -ErrorAction Stop).'(default)'
        if ($p) { $p = $p.Trim('"'); if (Test-Path -LiteralPath $p) { return $p } }
      } catch { }
    }
    foreach ($dir in $b.paths) {
      $p = Join-Path $dir $b.exe
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  return $null
}

# Start-Process (ShellExecute), never a child sharing this process's handles:
# a freshly started browser lives on, and must not hold the caller's stdout
# pipe open (the installer waits for this script's output).
function Open-AppWindow([string]$Browser) {
  $arg = "--app=$Url"
  if ($Browser -match '\.(cmd|bat)$') {
    # The tests' stand-in browser is a batch file: no console window for it.
    Start-Process -FilePath $Browser -ArgumentList $arg -WindowStyle Hidden
  } else {
    Start-Process -FilePath $Browser -ArgumentList $arg
  }
}

if ($SetOpenIn) {
  $s = Read-Settings
  $s | Add-Member -NotePropertyName openIn -NotePropertyValue $SetOpenIn -Force
  $dir = Split-Path -Parent $SettingsPath
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # No BOM: the installer reads this file with JSON.parse.
  [System.IO.File]::WriteAllText($SettingsPath, ($s | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  exit 0
}

if ($GetOpenIn) {
  Write-Output (@{ openIn = (Get-OpenIn) } | ConvertTo-Json -Compress)
  exit 0
}

if ($Url -notmatch '^https?://') { throw "open-granted.ps1: -Url must be an http(s) URL" }

$openedIn = "none"
$browser = $null
if ((Get-OpenIn) -eq "window") {
  $browser = Find-AppBrowser
  if ($browser) {
    try { Open-AppWindow $browser; $openedIn = "window" } catch { $browser = $null }
  }
}
if ($openedIn -eq "none" -and -not $NoBrowserFallback) {
  Start-Process $Url
  $openedIn = "browser"
}
Write-Output (@{ openedIn = $openedIn; browser = $browser } | ConvertTo-Json -Compress)
