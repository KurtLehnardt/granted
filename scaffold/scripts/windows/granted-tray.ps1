# Granted -- run the app in the background on Windows, with a tray icon.
#
# Starts `npm run dev` for this scaffold as a hidden process (no console
# window), puts a Granted icon in the notification area (Open Granted /
# status / Show log / Restart / Quit), and opens the browser once Granted
# answers. Only runs while you've opened it -- nothing starts at sign-in.
#
# Meant to be launched WITHOUT a console window -- via the Desktop/Start menu
# shortcut (or the GUI installer), which run it as:
#   conhost.exe --headless powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File granted-tray.ps1 -OpenBrowser
# (`powershell -WindowStyle Hidden` is NOT enough: where Windows Terminal is
# the default console host -- the Windows 11 default -- it still opens a
# visible terminal window. `conhost --headless` doesn't.)
#
# Other entry points:
#   -Stop      ask the running tray for this port to quit (stops the server too)
#   -NoTray    run the same server management without an icon (tests)
#   -StatusPath <file>  report progress the way install-windows.ps1 does, so
#              the GUI installer can tell "starting" from "failed" from
#              "window closed" (see installer/src/main/ipcPure.ts)
param(
  [string]$ScaffoldDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$Port = $(if ($env:GRANTED_PORT) { [int]$env:GRANTED_PORT } else { 3000 }),
  [switch]$OpenBrowser,
  [string]$StatusPath,
  [switch]$Stop,
  [switch]$NoTray
)

$ErrorActionPreference = "Stop"
$Url = "http://localhost:$Port"
$ProbeUrl = "http://127.0.0.1:$Port/"   # `next dev -H 127.0.0.1` binds IPv4 only
$MutexName = "Local\GrantedTray-$Port"
$QuitEventName = "Local\GrantedTray-Quit-$Port"
$LogDir = Join-Path $env:LOCALAPPDATA "Granted\logs"
$LogPath = Join-Path $LogDir "server-$Port.log"
$IconPath = Join-Path $PSScriptRoot "granted.ico"

# --- -Stop: signal a running tray and leave ---------------------------------
if ($Stop) {
  $quit = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting($QuitEventName, [ref]$quit)) {
    [void]$quit.Set()
    $quit.Dispose()
    exit 0
  }
  exit 1   # nothing running for this port
}

# --- status reporting (same format/lock as install-windows.ps1) -------------
if ($StatusPath) {
  try { $global:GrantedStatusLock = [System.IO.File]::Open("$StatusPath.lock", 'OpenOrCreate', 'ReadWrite', 'None') } catch { }
}
function Write-Status($state, $message) {
  if (-not $StatusPath) { return }
  try {
    @{ state = $state; message = $message; pid = $PID } | ConvertTo-Json -Compress | Set-Content -Path $StatusPath -Encoding utf8 -ErrorAction Stop
  } catch { }
}

# --- probing ----------------------------------------------------------------
# "granted" = Granted's page; "other" = something else answered; "busy" =
# accepted but didn't answer in time (e.g. Next still compiling); "down" =
# nothing listening. Same classification as installer/src/main/openGranted.ts.
function Test-Granted([int]$TimeoutMs = 3000) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($ProbeUrl)
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $res = $req.GetResponse()
  } catch [System.Net.WebException] {
    if ($_.Exception.Status -eq [System.Net.WebExceptionStatus]::Timeout) { return "busy" }
    if ($_.Exception.Response) { $res = $_.Exception.Response } else { return "down" }
  } catch {
    return "down"
  }
  try {
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Dispose()
  } catch {
    return "other"
  } finally {
    $res.Close()
  }
  if ($body -match "federal funding intelligence") { return "granted" }
  return "other"
}

function Open-Granted { Start-Process $Url }

# --- the server -------------------------------------------------------------
$script:Server = $null
$script:ServerStartedAt = $null
$script:EverReady = $false

function Start-GrantedServer {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  if (Test-Path $LogPath) { Move-Item -Force $LogPath "$LogPath.previous" -ErrorAction SilentlyContinue }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  # npm.cmd explicitly: `npm` in PowerShell can resolve to npm.ps1, which an
  # AllSigned execution policy blocks. Output goes to the log via cmd's own
  # redirection, so there are no pipes for this script to keep draining.
  $psi.Arguments = "/d /s /c `"npm.cmd run dev > `"$LogPath`" 2>&1`""
  $psi.WorkingDirectory = $ScaffoldDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["PORT"] = "$Port"
  $script:Server = [System.Diagnostics.Process]::Start($psi)
  $script:ServerStartedAt = Get-Date
  $script:EverReady = $false
}

function Stop-GrantedServer {
  if ($script:Server -and -not $script:Server.HasExited) {
    # The whole tree: cmd -> npm -> next -> its worker node processes.
    & taskkill.exe /PID $script:Server.Id /T /F 2>&1 | Out-Null
  }
  $script:Server = $null
}

# One of: starting | running | stopped | crashed
function Get-ServerState {
  if (-not $script:Server) { return "stopped" }
  if ($script:Server.HasExited) { return "crashed" }
  if ((Test-Granted 3000) -eq "granted") { $script:EverReady = $true; return "running" }
  return "starting"
}

function Get-LastLogLine {
  try {
    $line = Get-Content -Path $LogPath -Tail 40 -ErrorAction Stop | Where-Object { $_ -match "error|Error|ERR" } | Select-Object -Last 1
    if ($line) { return $line.Trim() }
  } catch { }
  return $null
}

# --- single instance --------------------------------------------------------
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  # Already running for this port: just open it (once it answers) and leave.
  if ($OpenBrowser) {
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
      if ((Test-Granted 3000) -eq "granted") { Open-Granted; break }
      Start-Sleep -Seconds 2
    }
  }
  exit 0
}

# --- what's on the port before we start? ------------------------------------
$before = Test-Granted 10000
if ($before -eq "granted") {
  # Started some other way (e.g. `npm run dev` in a terminal): nothing to
  # manage -- open it and leave without an icon.
  if ($OpenBrowser) { Open-Granted }
  $mutex.ReleaseMutex(); exit 0
}
if ($before -eq "other" -or $before -eq "busy") {
  $msg = "Something else is already using port $Port, so Granted can't start there. Close it and try again."
  Write-Status "error" $msg
  if (-not $NoTray) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, "Granted", "OK", "Warning")
  }
  $mutex.ReleaseMutex(); exit 2
}

$quitEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $QuitEventName)
Write-Status "running" $null
Start-GrantedServer

# Reports a failure to the installer (if it's watching) the first time the
# server dies before it ever answered.
$script:ReportedFailure = $false
function Report-EarlyCrash {
  if ($script:EverReady -or $script:ReportedFailure) { return }
  $script:ReportedFailure = $true
  $detail = Get-LastLogLine
  $msg = "Granted stopped before it finished starting. Details are in $LogPath"
  if ($detail) { $msg = "$msg -- last error: $detail" }
  Write-Status "error" $msg
}

# --- headless mode (tests) --------------------------------------------------
if ($NoTray) {
  while (-not $quitEvent.WaitOne(1000)) {
    if ((Get-ServerState) -eq "crashed") { Report-EarlyCrash }
  }
  Stop-GrantedServer
  $quitEvent.Dispose(); $mutex.ReleaseMutex()
  exit 0
}

# --- tray icon --------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = if (Test-Path $IconPath) { New-Object System.Drawing.Icon $IconPath } else { [System.Drawing.SystemIcons]::Application }
$icon.Text = "Granted - starting..."
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open Granted")
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$statusItem = $menu.Items.Add("Starting...")
$statusItem.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$logItem = $menu.Items.Add("Show log")
$restartItem = $menu.Items.Add("Restart")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add("Quit Granted")
$icon.ContextMenuStrip = $menu

$script:OpenWhenReady = [bool]$OpenBrowser
$script:LastState = ""

function Set-TrayState($state) {
  if ($state -eq $script:LastState) { return }
  $script:LastState = $state
  switch ($state) {
    "starting" { $statusItem.Text = "Starting... (the first start can take a minute)"; $icon.Text = "Granted - starting..." }
    "running"  { $statusItem.Text = "Running at $Url"; $icon.Text = "Granted - running" }
    "crashed"  { $statusItem.Text = "Stopped unexpectedly - see Show log, then Restart"; $icon.Text = "Granted - stopped" }
  }
}

function Invoke-Quit {
  $timer.Stop()
  Stop-GrantedServer
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$openItem.add_Click({
  if ($script:LastState -eq "running") { Open-Granted } else { $script:OpenWhenReady = $true }
})
$icon.add_DoubleClick({ if ($script:LastState -eq "running") { Open-Granted } else { $script:OpenWhenReady = $true } })
$logItem.add_Click({ if (Test-Path $LogPath) { Start-Process notepad.exe -ArgumentList "`"$LogPath`"" } })
$restartItem.add_Click({
  Stop-GrantedServer
  $script:LastState = ""
  Start-GrantedServer
})
$quitItem.add_Click({ Invoke-Quit })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($quitEvent.WaitOne(0)) { Invoke-Quit; return }
  $state = Get-ServerState
  $previous = $script:LastState
  Set-TrayState $state
  if ($state -eq "running" -and $previous -ne "running") {
    if ($script:OpenWhenReady) { Open-Granted; $script:OpenWhenReady = $false }
    $icon.ShowBalloonTip(5000, "Granted is running", "It keeps running in the background. Right-click this icon to open or quit it.", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  if ($state -eq "crashed" -and $previous -ne "crashed") {
    $title = if ($script:EverReady) { "Granted stopped" } else { "Granted couldn't start" }
    Report-EarlyCrash
    $icon.ShowBalloonTip(8000, $title, "Right-click the Granted icon: Show log for details, then Restart.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  Stop-GrantedServer
  $quitEvent.Dispose()
  $mutex.ReleaseMutex()
}
