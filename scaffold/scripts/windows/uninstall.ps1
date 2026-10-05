# Granted -- list Granted in Windows' "Installed apps", and uninstall it.
#
#   uninstall.ps1 -Register    add (or refresh) the Installed apps entry; run
#                              by install-windows.ps1 at the end of an install
#   uninstall.ps1              uninstall, asking first (what Installed apps ->
#                              Uninstall runs, with no console window)
#   uninstall.ps1 -Quiet       uninstall without asking (QuietUninstallString)
#
# Uninstalling:
#   - quits Granted (its tray icon and server) if it's running from this folder
#   - removes the Granted Desktop / Start menu shortcuts that point here
#   - deletes this install folder -- after checking it really is a Granted
#     clone -- and the Installed apps entry
#   - deletes %LOCALAPPDATA%\Granted (settings, logs) once no other Granted
#     install is registered
# Git and Node are left alone: they have their own Installed apps entries,
# and other programs may use them. Before deleting anything it offers to keep
# a copy of your API keys (scaffold\.env.local) in your Documents folder.
#
# The entry is per-user (HKCU), so neither registering nor uninstalling needs
# admin rights. Each install folder gets its own entry.
#
# Prints one JSON line describing what it did (for the installer and tests).
# Test-only overrides: GRANTED_UNINSTALL_KEY_ROOT (the registry key that
# holds the entries), GRANTED_SETTINGS_PATH (its folder is the app-data
# folder), GRANTED_SHORTCUT_DESKTOP_DIR / GRANTED_SHORTCUT_STARTMENU_DIR.
param(
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [switch]$Register,
  [switch]$Quiet,
  # -Quiet only: keep a copy of scaffold\.env.local (the interactive
  # uninstall asks instead).
  [switch]$KeepKeys,
  [string]$KeysBackupPath = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Granted API keys (backup).env.local.txt")
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$ScaffoldDir = Join-Path $InstallDir "scaffold"
$WindowsDir = Join-Path $ScaffoldDir "scripts\windows"
$TrayScript = Join-Path $WindowsDir "granted-tray.ps1"
$KeyRoot = if ($env:GRANTED_UNINSTALL_KEY_ROOT) { $env:GRANTED_UNINSTALL_KEY_ROOT } else { "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" }
$SettingsPath = if ($env:GRANTED_SETTINGS_PATH) { $env:GRANTED_SETTINGS_PATH } else { Join-Path $env:LOCALAPPDATA "Granted\settings.json" }
$AppDataDir = Split-Path -Parent $SettingsPath
$DesktopDir = if ($env:GRANTED_SHORTCUT_DESKTOP_DIR) { $env:GRANTED_SHORTCUT_DESKTOP_DIR } else { [Environment]::GetFolderPath("Desktop") }
$StartMenuDir = if ($env:GRANTED_SHORTCUT_STARTMENU_DIR) { $env:GRANTED_SHORTCUT_STARTMENU_DIR } else { [Environment]::GetFolderPath("Programs") }

# One entry per install folder: "Granted-" + a hash of the folder's path.
function Get-EntryName([string]$dir) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dir.ToLowerInvariant()))
  } finally { $sha.Dispose() }
  return "Granted-" + (-join ($bytes[0..5] | ForEach-Object { $_.ToString("x2") }))
}
$EntryKey = Join-Path $KeyRoot (Get-EntryName $InstallDir)

# Only ever delete a folder that is unmistakably a Granted clone, and never a
# drive root, the user's profile or Windows itself.
function Test-GrantedInstall([string]$dir) {
  $pkg = Join-Path $dir "scaffold\package.json"
  if (-not (Test-Path -LiteralPath $pkg)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $dir "scaffold\scripts\windows\granted-tray.ps1"))) { return $false }
  try { if ((Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).name -cne "granted") { return $false } } catch { return $false }
  $protected = @([System.IO.Path]::GetPathRoot($dir), $env:USERPROFILE, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $env:APPDATA) |
    Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
  return -not ($protected | Where-Object { $_ -ieq $dir })
}

function Write-Result($result) { Write-Output ($result | ConvertTo-Json -Compress) }

# --- -Register ---------------------------------------------------------------
if ($Register) {
  if (-not (Test-GrantedInstall $InstallDir)) { throw "uninstall.ps1: $InstallDir isn't a Granted install" }
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $self = Join-Path $WindowsDir "uninstall.ps1"
  # conhost --headless, like the shortcuts: no console window on Windows 11
  # (see granted-tray.ps1); the uninstall asks through a dialog box instead.
  $uninstall = "`"$conhost`" --headless `"$powershell`" -NoProfile -STA -ExecutionPolicy Bypass -File `"$self`""
  $version = "0.0.0"
  try { $version = (Get-Content -LiteralPath (Join-Path $ScaffoldDir "package.json") -Raw | ConvertFrom-Json).version } catch { }
  $defaultDir = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "granted")).TrimEnd('\')
  # The usual install is just "Granted"; any other folder says which it is.
  $name = if ($InstallDir -ieq $defaultDir) { "Granted" } else { "Granted ($(Split-Path -Leaf $InstallDir))" }
  # Installed apps shows this as the app's size (in KB). Best effort: never
  # fail the install over it.
  $sizeKb = 0
  try {
    $bytes = (Get-ChildItem -LiteralPath "\\?\$InstallDir" -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $sizeKb = [int][Math]::Min([int]::MaxValue, [Math]::Ceiling($bytes / 1KB))
  } catch { }

  New-Item -Path $EntryKey -Force | Out-Null
  $values = [ordered]@{
    DisplayName = $name
    DisplayVersion = $version
    Publisher = "Granted"
    DisplayIcon = (Join-Path $WindowsDir "granted.ico")
    InstallLocation = $InstallDir
    InstallDate = (Get-Date -Format "yyyyMMdd")
    UninstallString = $uninstall
    QuietUninstallString = "$uninstall -Quiet"
    URLInfoAbout = "https://github.com/KurtLehnardt/granted"
  }
  foreach ($k in $values.Keys) { New-ItemProperty -Path $EntryKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in "NoModify", "NoRepair") { New-ItemProperty -Path $EntryKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
  New-ItemProperty -Path $EntryKey -Name EstimatedSize -Value $sizeKb -PropertyType DWord -Force | Out-Null
  Write-Result @{ registered = $true; key = $EntryKey; displayName = $name }
  exit 0
}

# --- uninstall ---------------------------------------------------------------
# Out of the folder being deleted -- both PowerShell's location and the
# process's own working directory (a folder that's some process's working
# directory can't be removed).
Set-Location -LiteralPath $env:TEMP
[Environment]::CurrentDirectory = $env:TEMP

if (-not $Quiet) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::EnableVisualStyles()
}
function Show-Message([string]$text, [string]$icon = "Information") {
  if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($text, "Uninstall Granted", "OK", $icon) }
}
function Ask([string]$text) {
  if ($Quiet) { return $true }
  return [System.Windows.Forms.MessageBox]::Show($text, "Uninstall Granted", "YesNo", "Question") -eq "Yes"
}

if (-not (Test-GrantedInstall $InstallDir)) {
  # Already gone (deleted by hand?): just drop the stale entry.
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    Remove-Item -Path $EntryKey -Recurse -Force -ErrorAction SilentlyContinue
    Show-Message "Granted's folder ($InstallDir) was already deleted. It has been removed from Installed apps."
    Write-Result @{ removed = $true; alreadyGone = $true }
    exit 0
  }
  Show-Message "$InstallDir doesn't look like a Granted install, so nothing was deleted." "Warning"
  Write-Result @{ removed = $false; reason = "not-a-granted-install" }
  exit 2
}

if (-not (Ask "Uninstall Granted?`n`nThis deletes $InstallDir, Granted's shortcuts and its settings. Git and Node stay installed.")) {
  Write-Result @{ removed = $false; reason = "cancelled" }
  exit 1
}

# Your API keys: offer to keep a copy outside the folder about to be deleted.
$envLocal = Join-Path $ScaffoldDir ".env.local"
$keptKeys = $null
if (Test-Path -LiteralPath $envLocal) {
  $hasKeys = (Get-Content -LiteralPath $envLocal -Raw) -match '(?m)^(OPENAI|ANTHROPIC|EXA)_API_KEY=(?!sk-\.\.\.\s*$|sk-ant-\.\.\.\s*$)\S+'
  $keep = if ($Quiet) { [bool]$KeepKeys } else { $hasKeys -and (Ask "Keep a copy of your API keys?`n`nYes saves them to:`n$KeysBackupPath") }
  if ($keep) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeysBackupPath) | Out-Null
    Copy-Item -LiteralPath $envLocal -Destination $KeysBackupPath -Force
    $keptKeys = $KeysBackupPath
  }
}

# Quit Granted where it runs from this folder: the tray (which stops its
# server), then anything still running Node from in here (e.g. `npm run dev`
# in a terminal) -- only node.exe, never an editor that has the folder open.
function Stop-Tree([int]$id) {
  $kill = New-Object System.Diagnostics.ProcessStartInfo
  $kill.FileName = Join-Path $env:SystemRoot "System32\taskkill.exe"
  $kill.Arguments = "/PID $id /T /F"
  $kill.UseShellExecute = $false
  $kill.CreateNoWindow = $true
  $kill.RedirectStandardOutput = $true
  $kill.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($kill)
  [void]$p.StandardOutput.ReadToEnd(); [void]$p.StandardError.ReadToEnd()
  [void]$p.WaitForExit(10000)
}
$trays = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($TrayScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
foreach ($t in $trays) {
  $port = if ($t.CommandLine -match '-Port\s+(\d+)') { [int]$Matches[1] } else { 3000 }
  try { & $TrayScript -Stop -Port $port | Out-Null } catch { }
}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and @($trays | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -gt 0) {
  Start-Sleep -Milliseconds 500
}
foreach ($t in $trays) { if (Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue) { Stop-Tree $t.ProcessId } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  ($_.CommandLine -and $_.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase))
} | ForEach-Object { Stop-Tree $_.ProcessId }

# Shortcuts -- only the ones that launch THIS install's tray.
$removedShortcuts = @()
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $DesktopDir, $StartMenuDir) {
  $lnkPath = Join-Path $dir "Granted.lnk"
  if (-not (Test-Path -LiteralPath $lnkPath)) { continue }
  try {
    if ($shell.CreateShortcut($lnkPath).Arguments.IndexOf($TrayScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Remove-Item -LiteralPath $lnkPath -Force
      $removedShortcuts += $lnkPath
    }
  } catch { }
}

# The folder itself. First renamed aside: that fails, with nothing deleted,
# if a program is still using anything inside (an open file, a terminal
# whose current folder is in there) -- so the install is never left
# half-deleted and un-retryable. Tried a few times: a process that was just
# stopped can take a moment to let go.
$trash = "$InstallDir.uninstalling-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$renamed = $false
$renameError = $null
for ($i = 0; $i -lt 10 -and -not $renamed; $i++) {
  try { [System.IO.Directory]::Move($InstallDir, $trash); $renamed = $true }
  catch { $renameError = $_.Exception.Message; Start-Sleep -Milliseconds 500 }
}
if (-not $renamed) {
  $msg = "Granted's folder is still in use by another program, so nothing was deleted. Close anything using $InstallDir (a terminal or editor open there, say), then uninstall again."
  Show-Message $msg "Warning"
  Write-Result @{ removed = $false; reason = "files-in-use"; detail = $renameError; keptKeys = $keptKeys; removedShortcuts = $removedShortcuts }
  exit 3
}
# Then deleted. rd with the \\?\ prefix: node_modules has paths longer than
# Windows' old 260-character limit, which Remove-Item in Windows PowerShell
# 5.1 can't delete (rd also removes read-only files, like git's objects).
$rd = New-Object System.Diagnostics.ProcessStartInfo
$rd.FileName = $env:ComSpec
$rd.Arguments = "/d /c rd /s /q `"\\?\$trash`""
$rd.UseShellExecute = $false
$rd.CreateNoWindow = $true
$rd.RedirectStandardOutput = $true
$rd.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($rd)
[void]$p.StandardOutput.ReadToEnd(); [void]$p.StandardError.ReadToEnd()
$p.WaitForExit()
$leftover = if (Test-Path -LiteralPath $trash) { $trash } else { $null }

Remove-Item -Path $EntryKey -Recurse -Force -ErrorAction SilentlyContinue
# Settings and logs are shared by every Granted install: removed with the last one.
$othersLeft = @(Get-ChildItem -Path $KeyRoot -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like "Granted-*" }).Count
$removedAppData = $false
if ($othersLeft -eq 0 -and (Test-Path -LiteralPath $AppDataDir) -and (Split-Path -Leaf $AppDataDir) -eq "Granted") {
  Remove-Item -LiteralPath $AppDataDir -Recurse -Force -ErrorAction SilentlyContinue
  $removedAppData = -not (Test-Path -LiteralPath $AppDataDir)
}

$done = "Granted was uninstalled."
if ($leftover) { $done += "`n`nA few files couldn't be deleted. You can delete this folder yourself (restarting first may help):`n$leftover" }
if ($keptKeys) { $done += "`n`nA copy of your API keys is in:`n$keptKeys" }
Show-Message $done
Write-Result @{ removed = $true; leftover = $leftover; keptKeys = $keptKeys; removedShortcuts = $removedShortcuts; removedAppData = $removedAppData }
exit 0
