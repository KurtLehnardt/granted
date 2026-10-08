# Granted -- update this install to a release, then start Granted again.
#
# Started by the app itself (Settings -> Check for updates -> Update now, or
# automatic updates; see scaffold/lib/appUpdate/install.ts) with no console
# window:
#   conhost.exe --headless powershell.exe -File update.ps1 -Ref v1.2.3 -Port 3000
#
# It runs that release's own install-windows.ps1 with GRANTED_REF set -- the
# same update path as running a newer Granted-Setup .exe: it stops Granted
# (the tray and its server, which is why this can't run inside the server),
# moves this install to the release (never backwards, never over local
# changes), runs npm ci and refreshes the Installed apps entry -- and if that
# fails half-way, puts the previous version back. Then it starts
# Granted in the background again (the tray), and the open page reloads once
# the new version answers.
#
# Progress and the outcome go to %LOCALAPPDATA%\Granted\update-status.json
# (next to settings.json), which the app shows; the install's own output goes
# to %LOCALAPPDATA%\Granted\logs\update.log.
# Test-only overrides: GRANTED_SETTINGS_PATH (its folder is used),
# GRANTED_INSTALL_SCRIPT (a local install-windows.ps1 instead of downloading
# the release's), GRANTED_REPO_URL (passed on to it).
param(
  [Parameter(Mandatory = $true)][string]$Ref,
  [int]$Port = 3000,
  # Default: the install this script sits in (scaffold\scripts\windows\..\..\..).
  [string]$InstallDir,
  # Tests: don't start Granted again afterwards.
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $InstallDir) { $InstallDir = [System.IO.Path]::Combine($PSScriptRoot, "..\..\..") }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$Scaffold = [System.IO.Path]::Combine($InstallDir, "scaffold")
$SettingsPath = if ($env:GRANTED_SETTINGS_PATH) { $env:GRANTED_SETTINGS_PATH } else { [System.IO.Path]::Combine($env:LOCALAPPDATA, "Granted\settings.json") }
$AppData = [System.IO.Path]::GetDirectoryName($SettingsPath)
$StatusPath = [System.IO.Path]::Combine($AppData, "update-status.json")
$LogDir = [System.IO.Path]::Combine($AppData, "logs")
$LogPath = [System.IO.Path]::Combine($LogDir, "update.log")
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-InstalledVersion {
  try { return ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($Scaffold, "package.json")) | ConvertFrom-Json).version } catch { return $null }
}
$From = Get-InstalledVersion

function Write-UpdateStatus([string]$State, [string]$Message) {
  $payload = @{ state = $State; from = $From; to = $Ref; message = $Message; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($StatusPath, $payload, (New-Object System.Text.UTF8Encoding $false))
}

# Starts Granted in the background again, as the shortcuts do -- whatever
# happened (an update that failed half-way still leaves the previous version
# runnable in most cases, and the app then shows what went wrong).
function Start-Granted {
  if ($NoRestart) { return }
  $tray = [System.IO.Path]::Combine($Scaffold, "scripts\windows\granted-tray.ps1")
  if (-not [System.IO.File]::Exists($tray)) { return }
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  Start-Process -FilePath $conhost -ArgumentList "--headless `"$powershell`" -NoProfile -STA -ExecutionPolicy Bypass -File `"$tray`" -Port $Port" -WorkingDirectory $Scaffold
}

trap {
  try { Write-UpdateStatus "error" "The update didn't finish: $($_.Exception.Message)" } catch { }
  try { Start-Granted } catch { }
  exit 1
}

if ($Ref -notmatch '^v\d+\.\d+\.\d+$') { throw "-Ref must be a release tag like v1.2.3 (got '$Ref')" }
Write-UpdateStatus "running" $null

# git, as a plain process (never PowerShell's native-command handling, which
# turns git's stderr into terminating errors here). Returns exit code + stdout.
function Invoke-Git([string]$GitArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "git"
  $psi.Arguments = "-C `"$InstallDir`" $GitArgs"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $out = $proc.StandardOutput.ReadToEnd(); [void]$proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return @{ code = $proc.ExitCode; out = $out.Trim() }
}

# What the install script would decline anyway -- checked BEFORE it stops
# Granted, so a declined update doesn't shut Granted down and reinstall it
# for nothing (and, with automatic updates, every few hours).
if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($InstallDir, ".git\granted-installer"))) {
  Write-UpdateStatus "error" "Granted wasn't updated to ${Ref}: this folder wasn't installed by the Granted installer."
  exit 0
}
if ((Invoke-Git "status --porcelain --untracked-files=no").out) {
  Write-UpdateStatus "error" "Granted wasn't updated to ${Ref}: it has local changes in $InstallDir."
  exit 0
}
# Where to go back to if the update fails half-way.
$previousHead = (Invoke-Git "rev-parse HEAD").out

# That release's own install script (or a local one, in tests).
$installScript = $env:GRANTED_INSTALL_SCRIPT
if (-not $installScript) {
  $installScript = [System.IO.Path]::Combine($env:TEMP, "granted-update-$([Guid]::NewGuid().ToString('N')).ps1")
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/KurtLehnardt/granted/$Ref/install-windows.ps1" -OutFile $installScript
}

# Run it in its own process, from the install's parent folder (it installs
# into .\<GRANTED_INSTALL_DIR>), reporting into its own status file.
$installStatus = [System.IO.Path]::Combine($env:TEMP, "granted-update-status-$([Guid]::NewGuid().ToString('N')).json")
$env:GRANTED_REF = $Ref
$env:GRANTED_INSTALL_DIR = [System.IO.Path]::GetFileName($InstallDir)
$env:GRANTED_STATUS_FILE = $installStatus
$env:GRANTED_PORT = "$Port"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$p = Start-Process -FilePath $powershell `
  -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$installScript`"" `
  -WorkingDirectory ([System.IO.Path]::GetDirectoryName($InstallDir)) `
  -RedirectStandardOutput $LogPath -RedirectStandardError "$LogPath.err" `
  -WindowStyle Hidden -Wait -PassThru

$result = $null
try { $result = [System.IO.File]::ReadAllText($installStatus) | ConvertFrom-Json } catch { }
$to = Get-InstalledVersion
if ($p.ExitCode -eq 0 -and $result -and $result.state -eq "done") {
  if ($to -and "v$to" -ne $Ref) {
    # The install script declined to switch (local changes, not made by the
    # installer, already newer): say why, from its log.
    $why = (Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '\[!\]' } | Select-Object -Last 1)
    Write-UpdateStatus "error" ("Granted wasn't updated to $Ref" + $(if ($why) { ": $($why.Trim().TrimStart('[!]').Trim())" } else { "." }))
  } else {
    Write-UpdateStatus "done" $null
  }
} else {
  $msg = if ($result -and $result.message) { $result.message } else { "the install step failed (exit code $($p.ExitCode))." }
  # The install script's own wording points at its console; there is none here.
  $msg = $msg -replace ' -- see the output above for the underlying error\.?', '.'
  # Failed half-way (say npm ci, after the switch to the new release): put the
  # previous version back, so Granted still starts.
  $restored = ""
  if ($previousHead -and (Invoke-Git "rev-parse HEAD").out -ne $previousHead) {
    $back = Invoke-Git "-c advice.detachedHead=false checkout --quiet $previousHead"
    if ($back.code -eq 0) {
      $npm = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c npm.cmd ci --no-audit --no-fund" `
        -WorkingDirectory $Scaffold -RedirectStandardOutput "$LogPath.restore" -RedirectStandardError "$LogPath.restore.err" `
        -WindowStyle Hidden -Wait -PassThru
      if ($npm.ExitCode -eq 0) { $restored = " Granted v$From was put back." }
    }
  }
  if (-not $msg.TrimEnd().EndsWith(".")) { $msg = "$($msg.TrimEnd())." }
  Write-UpdateStatus "error" "The update to $Ref didn't finish: $msg$restored Details are in $LogPath."
}
if (-not $env:GRANTED_INSTALL_SCRIPT) { Remove-Item -LiteralPath $installScript -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $installStatus -Force -ErrorAction SilentlyContinue
Start-Granted
