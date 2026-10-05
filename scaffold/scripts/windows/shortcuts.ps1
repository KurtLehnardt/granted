# Granted -- create the "Granted" Desktop and/or Start menu shortcut.
#
# Each shortcut starts Granted in the background with a tray icon
# (granted-tray.ps1, next to this file) and opens it in the browser; if it's
# already running it just opens the browser. Called by the GUI installer with
# whichever boxes the user ticked; also runnable by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scaffold\scripts\windows\shortcuts.ps1 -Desktop -StartMenu
#
# Prints one JSON object: { "created": [<.lnk paths>] }. Re-running just
# overwrites the same shortcut(s).
param(
  [switch]$Desktop,
  [switch]$StartMenu,
  [int]$Port = 0,               # 0 = the tray's default (GRANTED_PORT or 3000)
  [string]$DesktopDir = [Environment]::GetFolderPath("Desktop"),
  [string]$StartMenuDir = [Environment]::GetFolderPath("Programs")
)

$ErrorActionPreference = "Stop"
$trayScript = Join-Path $PSScriptRoot "granted-tray.ps1"
$iconPath = Join-Path $PSScriptRoot "granted.ico"
$scaffoldDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path $trayScript)) { throw "granted-tray.ps1 not found next to shortcuts.ps1 ($PSScriptRoot)" }

# conhost --headless, not `powershell -WindowStyle Hidden`: with Windows
# Terminal as the default console host (Windows 11's default) the latter
# still opens a visible terminal window. See granted-tray.ps1.
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "--headless `"$powershell`" -NoProfile -STA -ExecutionPolicy Bypass -File `"$trayScript`" -OpenBrowser"
if ($Port -gt 0) { $arguments += " -Port $Port" }

$shell = New-Object -ComObject WScript.Shell
$created = @()
$targets = @()
if ($Desktop) { $targets += $DesktopDir }
if ($StartMenu) { $targets += $StartMenuDir }
foreach ($dir in $targets) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $lnkPath = Join-Path $dir "Granted.lnk"
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $conhost
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $scaffoldDir
  $lnk.Description = "Granted - federal funding intelligence"
  if (Test-Path $iconPath) { $lnk.IconLocation = "$iconPath,0" }
  $lnk.WindowStyle = 7   # minimized: belt and braces, there's no window anyway
  $lnk.Save()
  $created += $lnkPath
}

@{ created = $created } | ConvertTo-Json -Compress
