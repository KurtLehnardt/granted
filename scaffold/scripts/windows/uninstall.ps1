# Granted -- list Granted in Windows' "Installed apps", and uninstall it.
#
#   uninstall.ps1 -Register    add (or refresh) the Installed apps entry; run
#                              by install-windows.ps1 at the end of an install
#   uninstall.ps1              uninstall, asking first (what Installed apps ->
#                              Uninstall runs, with no console window)
#   uninstall.ps1 -Quiet       uninstall without asking (QuietUninstallString)
#
# Only installs this installer created are registered: install-windows.ps1
# leaves a marker (.git\granted-installer) in clones it makes, so a
# developer's own checkout that happens to sit in the same folder is never
# listed -- and so never deleted from Settings. -Register -Force lists one
# anyway (e.g. an install made before the marker existed).
#
# Uninstalling:
#   - asks first; then, if the folder has work that isn't on GitHub
#     (uncommitted changes, unpushed commits, stashes), asks again -- -Quiet
#     refuses that case unless -Force is given
#   - offers to save a copy of your API keys and settings (scaffold\.env.local,
#     scaffold\data\local\llm-config.json) to your Documents folder
#   - quits Granted (its tray icon and server, and node running from the folder)
#   - moves the folder aside -- which fails, with nothing deleted, if a program
#     is still using it -- then removes the Granted shortcuts that point here,
#     deletes the folder and the Installed apps entry
#   - deletes %LOCALAPPDATA%\Granted (settings, logs) with the last registered
#     install
# Git and Node are left alone: they have their own Installed apps entries,
# and other programs may use them.
#
# Installed apps runs a COPY of this script kept in %LOCALAPPDATA%\Granted\
# uninstallers, so the entry can still be removed if the install folder was
# deleted by hand. The entry is per-user (HKCU): no admin rights needed.
#
# Prints one JSON line describing what it did (for the installer and tests).
# Test-only overrides: GRANTED_UNINSTALL_KEY_ROOT (the registry key that
# holds the entries), GRANTED_SETTINGS_PATH (its folder is the app-data
# folder), GRANTED_SHORTCUT_DESKTOP_DIR / GRANTED_SHORTCUT_STARTMENU_DIR.
param(
  # Default: the install this script sits in (scaffold\scripts\windows\..\..\..).
  [string]$InstallDir,
  [switch]$Register,
  [switch]$Quiet,
  [switch]$Force,
  # -Quiet only: keep a copy of the keys/settings (the interactive uninstall asks).
  [switch]$KeepKeys,
  [string]$BackupDir = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) ("Granted backup " + (Get-Date -Format "yyyy-MM-dd HHmm")))
)

$ErrorActionPreference = "Stop"

function Write-Result($result) { Write-Output ($result | ConvertTo-Json -Compress) }

# Anything unexpected: say so. Uninstall runs with no console window, so an
# error that's only printed would look like nothing happened at all.
trap {
  $msg = $_.Exception.Message
  if (-not $Quiet -and -not $Register) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show("Granted couldn't be uninstalled:`n`n$msg", "Uninstall Granted", "OK", "Error")
    } catch { }
  }
  [Console]::Error.WriteLine("uninstall.ps1: $msg")
  Write-Result @{ removed = $false; registered = $false; reason = "error"; detail = $msg }
  exit 1
}

if (-not $InstallDir) { $InstallDir = [System.IO.Path]::Combine($PSScriptRoot, "..\..\..") }

# A folder can be named two ways: long (C:\Users\Jo Smith\granted) and 8.3
# short (C:\Users\JOSMIT~1\granted) -- %TEMP% is often the short form. The
# entry's key is a hash of the LONG form, so registering and uninstalling
# always agree; paths in command lines and shortcuts are converted too.
Add-Type -Namespace GrantedUninstall -Name Paths -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern uint GetLongPathName(string path, System.Text.StringBuilder buffer, uint size);
'@
function Get-LongPath([string]$path) {
  $buffer = New-Object System.Text.StringBuilder 32768
  $n = [GrantedUninstall.Paths]::GetLongPathName($path, $buffer, 32768)
  if ($n -gt 0 -and $n -lt 32768) { return $buffer.ToString() }
  return $path   # doesn't exist (any more): as given
}
# [System.IO.Path], never Resolve-Path: a folder named like C:\[x]\granted is
# a wildcard pattern to the PowerShell path cmdlets.
$InstallDir = (Get-LongPath ([System.IO.Path]::GetFullPath($InstallDir))).TrimEnd('\')

# The absolute paths in a command line (or shortcut arguments), each in its
# long form. A path can mix forms (a short %TEMP% followed by long folder
# names), so each is converted as a whole rather than compared as text.
function Get-LongPaths([string]$text) {
  if (-not $text) { return @() }
  return @([regex]::Matches($text, '"([A-Za-z]:\\[^"]+)"|([A-Za-z]:\\[^\s"]+)') | ForEach-Object {
    $p = if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    try { Get-LongPath ([System.IO.Path]::GetFullPath($p)) } catch { $p }
  })
}
# Whether a path in $text is $relative inside this install ("" = anywhere inside it).
function Test-MentionsInstall([string]$text, [string]$relative = "") {
  foreach ($p in (Get-LongPaths $text)) {
    if ($relative) {
      if ($p -ieq [System.IO.Path]::Combine($InstallDir, $relative)) { return $true }
    } elseif ($p.StartsWith("$InstallDir\", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}
# For cmd's rd and long paths: \\?\C:\... or \\?\UNC\server\share\...
function Get-ExtendedPath([string]$path) {
  if ($path.StartsWith("\\")) { return "\\?\UNC\" + $path.Substring(2) }
  return "\\?\$path"
}

$ScaffoldDir = [System.IO.Path]::Combine($InstallDir, "scaffold")
$WindowsDir = [System.IO.Path]::Combine($ScaffoldDir, "scripts\windows")
$TrayRelative = "scaffold\scripts\windows\granted-tray.ps1"
$TrayScript = [System.IO.Path]::Combine($InstallDir, $TrayRelative)
$Marker = [System.IO.Path]::Combine($InstallDir, ".git\granted-installer")
$KeyRoot = if ($env:GRANTED_UNINSTALL_KEY_ROOT) { $env:GRANTED_UNINSTALL_KEY_ROOT } else { "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" }
$SettingsPath = if ($env:GRANTED_SETTINGS_PATH) { $env:GRANTED_SETTINGS_PATH } else { [System.IO.Path]::Combine($env:LOCALAPPDATA, "Granted\settings.json") }
$AppDataDir = [System.IO.Path]::GetDirectoryName($SettingsPath)
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
$EntryName = Get-EntryName $InstallDir
$EntryKey = Join-Path $KeyRoot $EntryName
# The copy Installed apps runs (see the top).
$UninstallerCopy = [System.IO.Path]::Combine($AppDataDir, "uninstallers\$EntryName.ps1")

# Only ever delete a folder that is unmistakably a Granted clone, and never a
# drive root, the user's profile or Windows itself.
function Test-GrantedInstall([string]$dir) {
  $pkg = [System.IO.Path]::Combine($dir, "scaffold\package.json")
  if (-not [System.IO.File]::Exists($pkg)) { return $false }
  if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($dir, $TrayRelative))) { return $false }
  try { if (([System.IO.File]::ReadAllText($pkg) | ConvertFrom-Json).name -cne "granted") { return $false } } catch { return $false }
  $protected = @([System.IO.Path]::GetPathRoot($dir), $env:USERPROFILE, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $env:APPDATA) |
    Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
  return -not ($protected | Where-Object { $_ -ieq $dir })
}

function Get-OtherEntryCount {
  return @(Get-ChildItem -Path $KeyRoot -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like "Granted-*" -and $_.PSChildName -ne $EntryName }).Count
}

# Settings, logs and the uninstaller copies are shared by every Granted
# install: they go with the last one.
function Remove-AppDataIfLast {
  if (Test-Path -LiteralPath $UninstallerCopy) { Remove-Item -LiteralPath $UninstallerCopy -Force -ErrorAction SilentlyContinue }
  if ((Get-OtherEntryCount) -eq 0 -and (Split-Path -Leaf $AppDataDir) -eq "Granted" -and (Test-Path -LiteralPath $AppDataDir)) {
    Remove-Item -LiteralPath $AppDataDir -Recurse -Force -ErrorAction SilentlyContinue
    return -not (Test-Path -LiteralPath $AppDataDir)
  }
  return $false
}

# --- -Register ---------------------------------------------------------------
if ($Register) {
  if (-not (Test-GrantedInstall $InstallDir)) { throw "$InstallDir isn't a Granted install" }
  if (-not $Force -and -not [System.IO.File]::Exists($Marker)) {
    # Not made by this installer: perhaps someone's own checkout. Never list
    # it, so Settings can never offer to delete it.
    Write-Result @{ registered = $false; reason = "not-made-by-installer" }
    exit 0
  }
  # The copy that Installed apps runs, refreshed on every install.
  New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($UninstallerCopy)) | Out-Null
  if ($PSCommandPath -ine $UninstallerCopy) { [System.IO.File]::Copy($PSCommandPath, $UninstallerCopy, $true) }

  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  # conhost --headless, like the shortcuts: no console window on Windows 11
  # (see granted-tray.ps1); the uninstall asks through dialog boxes instead.
  $uninstall = "`"$conhost`" --headless `"$powershell`" -NoProfile -STA -ExecutionPolicy Bypass -File `"$UninstallerCopy`" -InstallDir `"$InstallDir`""
  $version = "0.0.0"
  try { $version = ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($ScaffoldDir, "package.json")) | ConvertFrom-Json).version } catch { }
  $defaultDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($env:USERPROFILE, "granted")).TrimEnd('\')
  # The usual install is just "Granted"; any other folder says which it is.
  $name = if ($InstallDir -ieq $defaultDir) { "Granted" } else { "Granted ($([System.IO.Path]::GetFileName($InstallDir)))" }
  # Installed apps shows this as the app's size (in KB). Best effort: never
  # fail the install over it.
  $sizeKb = 0
  try {
    $bytes = (Get-ChildItem -LiteralPath (Get-ExtendedPath $InstallDir) -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($bytes) { $sizeKb = [int][Math]::Min([int]::MaxValue, [Math]::Ceiling($bytes / 1KB)) }
  } catch { }

  New-Item -Path $EntryKey -Force | Out-Null
  $values = [ordered]@{
    DisplayName = $name
    DisplayVersion = $version
    Publisher = "Granted"
    DisplayIcon = [System.IO.Path]::Combine($WindowsDir, "granted.ico")
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
# directory can't be moved or removed).
Set-Location -LiteralPath $env:TEMP
[Environment]::CurrentDirectory = $env:TEMP

if (-not $Quiet) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::EnableVisualStyles()
}
function Show-Message([string]$text, [string]$icon = "Information") {
  if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($text, "Uninstall Granted", "OK", $icon) }
}
function Ask([string]$text, [string]$icon = "Question") {
  if ($Quiet) { return $true }
  return [System.Windows.Forms.MessageBox]::Show($text, "Uninstall Granted", "YesNo", $icon) -eq "Yes"
}

# Already deleted by hand: just tidy up the entry (and the shared data, if
# this was the last install).
if (-not [System.IO.Directory]::Exists($InstallDir)) {
  Remove-Item -Path $EntryKey -Recurse -Force -ErrorAction SilentlyContinue
  $removedAppData = Remove-AppDataIfLast
  Show-Message "Granted's folder ($InstallDir) was already deleted. It has been removed from Installed apps."
  Write-Result @{ removed = $true; alreadyGone = $true; removedAppData = $removedAppData }
  exit 0
}

# A link to a folder elsewhere: deleting it would only delete the link,
# leaving everything on disk while reporting success.
if (([System.IO.File]::GetAttributes($InstallDir) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  Show-Message "$InstallDir is a link to another folder, so it wasn't uninstalled automatically. Delete the folder it points to yourself." "Warning"
  Write-Result @{ removed = $false; reason = "is-a-link" }
  exit 2
}

if (-not (Test-GrantedInstall $InstallDir)) {
  Show-Message "$InstallDir doesn't look like a Granted install, so nothing was deleted." "Warning"
  Write-Result @{ removed = $false; reason = "not-a-granted-install" }
  exit 2
}

if (-not (Ask "Uninstall Granted?`n`nThis deletes $InstallDir, Granted's shortcuts and its settings. Git and Node stay installed.")) {
  Write-Result @{ removed = $false; reason = "cancelled" }
  exit 1
}

# Work in the folder that isn't on GitHub: uncommitted changes, unpushed
# commits, stashes. Deleting the folder would lose it for good.
function Invoke-Git([string[]]$gitArgs) {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { return $null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $git.Source
  $psi.Arguments = (@("-C", "`"$InstallDir`"") + $gitArgs) -join " "
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd(); [void]$p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { return $null }   # not a working git repo: nothing to check
  return @($out -split "`r?`n" | Where-Object { $_ })
}
$unsaved = @()
$changes = Invoke-Git @("status", "--porcelain")
if ($changes) { $unsaved += "changed or new files ($($changes.Count))" }
# HEAD as well as branches: a release install sits on a tag with no branch
# ("detached"), and a commit made there is on no branch at all.
$unpushed = Invoke-Git @("log", "HEAD", "--branches", "--not", "--remotes", "--tags", "--oneline")
if ($unpushed) { $unsaved += "commits that aren't pushed ($($unpushed.Count))" }
$stashes = Invoke-Git @("stash", "list")
if ($stashes) { $unsaved += "stashed changes ($($stashes.Count))" }
if ($unsaved.Count -gt 0) {
  $list = ($unsaved | ForEach-Object { "  - $_" }) -join "`n"
  if ($Quiet -and -not $Force) {
    Write-Result @{ removed = $false; reason = "unsaved-work"; unsaved = $unsaved }
    exit 4
  }
  if (-not (Ask "$InstallDir has work that isn't saved to GitHub:`n$list`n`nUninstalling deletes it permanently. Uninstall anyway?" "Warning")) {
    Write-Result @{ removed = $false; reason = "cancelled"; unsaved = $unsaved }
    exit 1
  }
}

# Your API keys and settings: offer to keep a copy outside the folder.
$keyFiles = @(
  [System.IO.Path]::Combine($ScaffoldDir, ".env.local"),
  [System.IO.Path]::Combine($ScaffoldDir, "data\local\llm-config.json")
) | Where-Object { [System.IO.File]::Exists($_) }
$keptKeys = $null
if ($keyFiles.Count -gt 0) {
  $keep = if ($Quiet) { [bool]$KeepKeys } else { Ask "Keep a copy of your API keys and Granted settings?`n`nYes saves them to:`n$BackupDir" }
  if ($keep) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    foreach ($f in $keyFiles) { [System.IO.File]::Copy($f, [System.IO.Path]::Combine($BackupDir, [System.IO.Path]::GetFileName($f)), $true) }
    $keptKeys = $BackupDir
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
  $_.ProcessId -ne $PID -and (Test-MentionsInstall $_.CommandLine $TrayRelative)
})
foreach ($t in $trays) {
  # The tray's port: its -Port, else GRANTED_PORT (as the tray reads it), else 3000.
  $port = if ($t.CommandLine -match '-Port\s+(\d+)') { [int]$Matches[1] } elseif ($env:GRANTED_PORT -match '^\d+$') { [int]$env:GRANTED_PORT } else { 3000 }
  try { & $TrayScript -Stop -Port $port | Out-Null } catch { }
}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and @($trays | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -gt 0) {
  Start-Sleep -Milliseconds 500
}
foreach ($t in $trays) { if (Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue) { Stop-Tree $t.ProcessId } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  (Test-MentionsInstall $_.CommandLine) -or (Test-MentionsInstall $_.ExecutablePath)
} | ForEach-Object { Stop-Tree $_.ProcessId }

# The folder: first moved aside. That fails, with nothing deleted, if a
# program is still using anything inside (an open file, a terminal whose
# current folder is in there) -- so the install is never left half-deleted.
# Tried a few times: a process that was just stopped can take a moment to
# let go.
$trash = "$InstallDir.uninstalling-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$moveError = $null
for ($i = 0; $i -lt 10; $i++) {
  try { [System.IO.Directory]::Move($InstallDir, $trash); $moveError = $null; break }
  catch { $moveError = $_.Exception; Start-Sleep -Milliseconds 500 }
}
if ($moveError) {
  $inner = if ($moveError.InnerException) { $moveError.InnerException } else { $moveError }
  if ($inner -is [System.UnauthorizedAccessException]) {
    $reason = "access-denied"
    $msg = "Windows won't let this account move or delete $InstallDir (it may have been installed as Administrator), so nothing was deleted. Uninstall Granted again from an Administrator account."
  } else {
    $reason = "files-in-use"
    $msg = "Granted's folder is still in use by another program, so nothing was deleted. Close anything using $InstallDir (a terminal or editor open there, say), then uninstall again."
  }
  Show-Message $msg "Warning"
  Write-Result @{ removed = $false; reason = $reason; detail = $inner.Message; keptKeys = $keptKeys }
  exit 3
}

# Moved: from here on, Granted is going. Its shortcuts (only the ones that
# launch THIS install's tray)...
$removedShortcuts = @()
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $DesktopDir, $StartMenuDir) {
  $lnkPath = [System.IO.Path]::Combine($dir, "Granted.lnk")
  if (-not [System.IO.File]::Exists($lnkPath)) { continue }
  try {
    if (Test-MentionsInstall $shell.CreateShortcut($lnkPath).Arguments $TrayRelative) {
      [System.IO.File]::Delete($lnkPath)
      $removedShortcuts += $lnkPath
    }
  } catch { }
}

# ...then the files. rd with the \\?\ prefix: node_modules has paths longer
# than Windows' old 260-character limit, which Remove-Item in Windows
# PowerShell 5.1 can't delete (rd also removes read-only files, like git's).
$rd = New-Object System.Diagnostics.ProcessStartInfo
$rd.FileName = $env:ComSpec
$rd.Arguments = "/d /c rd /s /q `"$(Get-ExtendedPath $trash)`""
$rd.UseShellExecute = $false
$rd.CreateNoWindow = $true
$rd.RedirectStandardOutput = $true
$rd.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($rd)
[void]$p.StandardOutput.ReadToEnd(); [void]$p.StandardError.ReadToEnd()
$p.WaitForExit()
$leftover = if ([System.IO.Directory]::Exists($trash)) { $trash } else { $null }

Remove-Item -Path $EntryKey -Recurse -Force -ErrorAction SilentlyContinue
$removedAppData = Remove-AppDataIfLast

$done = "Granted was uninstalled."
if ($leftover) { $done += "`n`nA few files couldn't be deleted. You can delete this folder yourself (restarting first may help):`n$leftover" }
if ($keptKeys) { $done += "`n`nA copy of your API keys and settings is in:`n$keptKeys" }
Show-Message $done
Write-Result @{ removed = $true; leftover = $leftover; keptKeys = $keptKeys; removedShortcuts = $removedShortcuts; removedAppData = $removedAppData }
exit 0
