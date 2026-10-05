# Granted -- run the app in the background on Windows, with a tray icon.
#
# Starts `npm run dev` for this scaffold as a hidden process (no console
# window), puts a Granted icon in the notification area (Open Granted /
# status / Show log / Restart / Quit), and opens Granted once it answers --
# in its own window (Edge/Chrome app mode) unless the user prefers a browser
# tab (see open-granted.ps1). Only runs while you've opened it -- nothing starts at sign-in.
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
#   -Restart   ask the running tray for this port to restart its server
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
  [switch]$Restart,
  [switch]$NoTray,
  # How long a second launch waits for an already-running tray's Granted to
  # answer before reporting that it isn't (tests shorten it).
  [int]$AlreadyRunningWaitSeconds = 60
)

$ErrorActionPreference = "Stop"
$Url = "http://localhost:$Port"
$ProbeUrl = "http://127.0.0.1:$Port/"   # `next dev -H 127.0.0.1` binds IPv4 only
$MutexName = "Local\GrantedTray-$Port"
$QuitEventName = "Local\GrantedTray-Quit-$Port"
$RestartEventName = "Local\GrantedTray-Restart-$Port"
$LogDir = Join-Path $env:LOCALAPPDATA "Granted\logs"
$LogPath = Join-Path $LogDir "server-$Port.log"
$IconPath = Join-Path $PSScriptRoot "granted.ico"
$OpenScript = Join-Path $PSScriptRoot "open-granted.ps1"

# --- -Stop / -Restart: signal a running tray and leave ----------------------
if ($Stop -or $Restart) {
  $name = if ($Stop) { $QuitEventName } else { $RestartEventName }
  $signal = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting($name, [ref]$signal)) {
    [void]$signal.Set()
    $signal.Dispose()
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

# Whether anything is accepting connections on the port (no HTTP request).
function Test-PortOpen {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# Waits while the port is "busy" (a server there that's still starting up);
# returns the first non-busy probe, or "busy" if it never settles.
function Wait-NotBusy([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    $p = Test-Granted 5000
    if ($p -ne "busy") { return $p }
  } while ((Get-Date) -lt $deadline)
  return "busy"
}

# In its own window or a browser tab, as the user prefers (open-granted.ps1);
# a plain browser tab if that script is missing or fails.
function Open-Granted {
  if (Test-Path -LiteralPath $OpenScript) {
    try { [void](& $OpenScript -Url $Url); return } catch { }
  }
  Start-Process $Url
}

function Get-OpenInPreference {
  try { return ((& $OpenScript -GetOpenIn) | ConvertFrom-Json).openIn } catch { return "window" }
}

# --- the server -------------------------------------------------------------
$script:Server = $null
$script:EverReady = $false
$script:ReportedFailure = $false

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
  $script:EverReady = $false
  $script:ReportedFailure = $false
}

# Kills the whole server tree (cmd -> npm -> next -> its workers) and waits
# until it has actually let go of the port, so a Restart's new server can
# bind it and the log can be rotated. taskkill runs as a plain process, never
# through PowerShell's native-command handling: under $ErrorActionPreference
# = "Stop", Windows PowerShell 5.1 turns any stderr line from a native
# command (taskkill prints one when a process in the tree is already gone)
# into a terminating error -- which made Quit/Restart throw half-way.
function Stop-GrantedServer {
  $server = $script:Server
  $script:Server = $null
  if (-not $server) { return }
  try {
    if (-not $server.HasExited) {
      $kill = New-Object System.Diagnostics.ProcessStartInfo
      $kill.FileName = Join-Path $env:SystemRoot "System32\taskkill.exe"
      $kill.Arguments = "/PID $($server.Id) /T /F"
      $kill.UseShellExecute = $false
      $kill.CreateNoWindow = $true
      $kill.RedirectStandardOutput = $true
      $kill.RedirectStandardError = $true
      $p = [System.Diagnostics.Process]::Start($kill)
      [void]$p.StandardOutput.ReadToEnd(); [void]$p.StandardError.ReadToEnd()
      [void]$p.WaitForExit(10000)
    }
  } catch { }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Test-PortOpen) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
}

function Restart-GrantedServer {
  Stop-GrantedServer
  Write-Status "running" $null
  Start-GrantedServer
}

# One of: starting | running | stopped | crashed. Probes over HTTP only until
# Granted first answers (short timeout, so a tray tick never blocks the UI
# for long); after that it just watches the process -- no request every few
# seconds re-rendering the page and filling the log all day.
function Get-ServerState {
  if (-not $script:Server) { return "stopped" }
  if ($script:Server.HasExited) { return "crashed" }
  if ($script:EverReady) { return "running" }
  if ((Test-Granted 500) -eq "granted") { $script:EverReady = $true; return "running" }
  return "starting"
}

function Get-LastLogLine {
  try {
    $line = Get-Content -Path $LogPath -Tail 40 -ErrorAction Stop | Where-Object { $_ -match "error|Error|ERR" } | Select-Object -Last 1
    if ($line) { return $line.Trim() }
  } catch { }
  return $null
}

# Reports a failure to the installer (if it's watching) the first time the
# server dies before it ever answered (once per start).
function Report-EarlyCrash {
  if ($script:EverReady -or $script:ReportedFailure) { return }
  $script:ReportedFailure = $true
  $detail = Get-LastLogLine
  $msg = "Granted stopped before it finished starting. Details are in $LogPath"
  if ($detail) { $msg = "$msg -- last error: $detail" }
  Write-Status "error" $msg
}

# --- single instance --------------------------------------------------------
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  # A tray is already running for this port: wait for its Granted to answer
  # (opening it if asked). If it doesn't, say so -- the installer, if it
  # launched this one, would otherwise wait out its own timeout with nothing
  # to report. No "running" status meanwhile: this process exits either way,
  # and its released lock must not read as "the tray was closed".
  $deadline = (Get-Date).AddSeconds($AlreadyRunningWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Granted 3000) -eq "granted") {
      if ($OpenBrowser) { Open-Granted }
      exit 0
    }
    Start-Sleep -Seconds 2
  }
  Write-Status "error" "Granted is already running in the background (its icon is by the clock), but it isn't answering. Right-click the Granted icon and choose Restart, or Quit Granted and open it again."
  exit 3
}

# --- what's on the port before we start? ------------------------------------
$before = Test-Granted 10000
if ($before -eq "busy") {
  # Something's there but slow to answer -- most likely a Granted that's
  # still compiling (started from a terminal, say). Wait for it, as the
  # installer does, rather than calling it "another program".
  $before = Wait-NotBusy 300
}
if ($before -eq "granted") {
  # Started some other way: nothing for this tray to manage -- open it and leave.
  if ($OpenBrowser) { Open-Granted }
  $mutex.ReleaseMutex(); exit 0
}
if ($before -ne "down") {
  $msg = "Something else is already using port $Port, so Granted can't start there. Close it and try again."
  Write-Status "error" $msg
  if (-not $NoTray) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($msg, "Granted", "OK", "Warning")
  }
  $mutex.ReleaseMutex(); exit 2
}

$quitEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $QuitEventName)
$restartEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $RestartEventName)
Write-Status "running" $null
Start-GrantedServer

# --- headless mode (tests) --------------------------------------------------
if ($NoTray) {
  try {
    while (-not $quitEvent.WaitOne(1000)) {
      if ($restartEvent.WaitOne(0)) { Restart-GrantedServer; continue }
      if ((Get-ServerState) -eq "crashed") { Report-EarlyCrash }
    }
  } finally {
    Stop-GrantedServer
    $quitEvent.Dispose(); $restartEvent.Dispose(); $mutex.ReleaseMutex()
  }
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
$windowItem = $null
if (Test-Path -LiteralPath $OpenScript) {
  # Ticked: Granted opens in its own window; unticked: in a browser tab.
  $windowItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open in its own window")
  $windowItem.CheckOnClick = $true
  [void]$menu.Items.Add($windowItem)
}
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$logItem = $menu.Items.Add("Show log")
$restartItem = $menu.Items.Add("Restart")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add("Quit Granted")
$icon.ContextMenuStrip = $menu

$script:OpenWhenReady = [bool]$OpenBrowser
$script:LastState = ""
$script:Quitting = $false

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
  if ($script:Quitting) { return }
  $script:Quitting = $true
  $timer.Stop()
  try { Stop-GrantedServer } finally {
    $icon.Visible = $false
    $icon.Dispose()
    [System.Windows.Forms.Application]::Exit()
  }
}

function Invoke-Restart {
  $timer.Stop()
  try {
    $statusItem.Text = "Restarting..."
    Restart-GrantedServer
    $script:LastState = ""
  } finally { $timer.Start() }
}

$openItem.add_Click({
  if ($script:LastState -eq "running") { Open-Granted } else { $script:OpenWhenReady = $true }
})
$icon.add_DoubleClick({ if ($script:LastState -eq "running") { Open-Granted } else { $script:OpenWhenReady = $true } })
$logItem.add_Click({ if (Test-Path $LogPath) { Start-Process notepad.exe -ArgumentList "`"$LogPath`"" } })
$restartItem.add_Click({ Invoke-Restart })
$quitItem.add_Click({ Invoke-Quit })
if ($windowItem) {
  # Re-read on every open: the installer can change the preference too.
  $menu.add_Opening({ $windowItem.Checked = ((Get-OpenInPreference) -ne "browser") })
  $windowItem.add_Click({
    $mode = if ($windowItem.Checked) { "window" } else { "browser" }
    try { & $OpenScript -SetOpenIn $mode } catch {
      $windowItem.Checked = -not $windowItem.Checked
      $icon.ShowBalloonTip(5000, "Granted", "Couldn't save that setting -- Granted will keep opening the way it did.", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  })
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($quitEvent.WaitOne(0)) { Invoke-Quit; return }
  if ($restartEvent.WaitOne(0)) { Invoke-Restart; return }
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
  $restartEvent.Dispose()
  $mutex.ReleaseMutex()
}
