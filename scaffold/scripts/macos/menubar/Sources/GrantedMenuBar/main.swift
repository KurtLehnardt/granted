//
// Granted's menu-bar icon on macOS.
//
// The same menu the Windows tray shows (scaffold/scripts/windows/granted-tray.ps1):
//
//   Open Granted
//   <status>                      (not clickable: starting / running / stopped)
//   Open in its own window        (a tick: Chrome/Edge app mode, or a browser tab)
//   ---
//   Show log
//   Restart
//   ---
//   Quit Granted
//
// Every action shells back into scripts/macos/granted-tray.sh, so the launchd,
// status-file and open-in-a-window logic lives in one place and is tested
// there; this process only draws the menu, polls that script for the server's
// state, and reports it the way the installer already reads it.
//
// Status reporting is the installer's existing mechanism, unchanged: this
// process holds the `<status>.lock.d` directory for its lifetime (the macOS
// stand-in for the Windows tray's exclusive lock file -- see
// installer/src/main/ipcPure.ts macStatusLockPath) and writes the same
// {state,message,pid} JSON. So, exactly as on Windows, quitting the icon
// before Granted ever answered reads back to the installer as "the window was
// closed", and a server that dies before answering reports the error itself.
//
// Configuration arrives in environment variables, all set by granted-tray.sh:
//   GRANTED_PORT              the port Granted serves on
//   GRANTED_TRAY_SCRIPT       the granted-tray.sh to call for every action
//   GRANTED_LOG_FILE          the server log "Show log" opens
//   GRANTED_STATUS_FILE       where to report status (optional)
//   GRANTED_HELPER_PID_FILE   this process's pid file, removed on quit (optional)
//   GRANTED_SETTINGS_PATH     the shared settings file, read for the "its own
//                             window" tick (optional; defaults to the real one)
//   GRANTED_MENUBAR_ICON      the icon file to use (optional)
//   GRANTED_MENUBAR_SELF_TEST "1", or "click:<menu item title>" — build
//                             everything, report it (and choose that item,
//                             the way a click does), then exit. The smoke
//                             test; nothing stays in the menu bar.
//   GRANTED_MENUBAR_RUN_TIMEOUT_TEST
//                             "<seconds>:<bash script>" — run that script
//                             through run() below and report what happened,
//                             then exit. The timeout harness; never part of
//                             normal running.
//
import AppKit
import Darwin
import Foundation

// MARK: - Small helpers

/// The result of one `run()`, filled in by that call's reader and waiter
/// threads and read back by the caller — hence the lock.
private final class RunOutcome {
  private let lock = NSLock()
  private var bytes = Data()
  private var code: Int32 = -1

  func append(_ chunk: Data) {
    lock.lock()
    bytes.append(chunk)
    lock.unlock()
  }

  func finish(_ value: Int32) {
    lock.lock()
    code = value
    lock.unlock()
  }

  var text: String {
    lock.lock()
    defer { lock.unlock() }
    return String(decoding: bytes, as: UTF8.self)
  }

  var status: Int32 {
    lock.lock()
    defer { lock.unlock() }
    return code
  }
}

/// SIGTERM or SIGKILL for the whole process group the child was spawned into,
/// so a wedged grandchild goes with the bash that started it. Every `run()`
/// here is `/bin/bash granted-tray.sh …`, whose real work is grandchildren
/// (launchctl, curl); signalling bash alone can leave one of those running and
/// still holding the pipe open.
///
/// If, for any reason, the child did not end up in a process group of its own,
/// this signals the child alone instead. That fallback is important: signalling
/// our own process group would kill this menu-bar helper, and whatever started
/// it, along with the child.
private func signalProcessGroup(of child: pid_t, _ signalNumber: Int32) {
  let group = getpgid(child)
  if group > 0 && group != getpgrp() {
    _ = killpg(group, signalNumber)
  } else {
    _ = kill(child, signalNumber)
  }
}

/// Runs a command, returning its stdout (trimmed) and exit status. Never
/// throws, and never blocks for longer than `timeout` plus a few seconds'
/// grace for a child that has to be killed.
///
/// REGRESSION. This used to call `readDataToEndOfFile()` and only then compute
/// the deadline and start checking it. That read blocks until the child's
/// stdout closes, so the timeout below it bounded nothing at all: a `launchctl`
/// or `curl` that wedged meant this function never returned, `serverState()`
/// never completed, the polling loop's `polling` flag never cleared, and the
/// menu-bar status label froze for good with no way back. (It survived Quit
/// only because granted-tray.sh's `stop_helper` has its own SIGKILL backstop —
/// an independent safety net, not this timeout working.)
///
/// Three things make the timeout real, and all three are load-bearing:
///
///   1. stdout is drained on its own thread as it arrives. That keeps the
///      ORIGINAL bug fixed too — the reason the blocking read was placed
///      before the wait in the first place. A child that fills the pipe buffer
///      blocks in `write()` until someone reads, so "wait for the child, then
///      read" deadlocks; here a reader is always running, and the wait is
///      never what the child is waiting on.
///   2. The wait is a deadline on a semaphore the reaping thread signals, not
///      a poll of `isRunning` reached only after a blocking read.
///   3. The child is spawned into its OWN process group
///      (POSIX_SPAWN_SETPGROUP with a pgroup of 0, which makes the group id
///      the child's own pid), so a timeout can kill the whole group.
///
/// POSIX_SPAWN_SETSIGDEF is required, not tidiness: `installSignalHandlers()`
/// sets SIGTERM and SIGINT to SIG_IGN, and an ignored disposition is inherited
/// across exec. Without resetting them in the child, the SIGTERM this function
/// sends on a timeout would be ignored by the very process it is trying to
/// stop.
func run(_ launchPath: String, _ arguments: [String], timeout: TimeInterval = 60) -> (output: String, status: Int32) {
  var ends: [Int32] = [-1, -1]
  guard pipe(&ends) == 0 else { return ("", -1) }
  let readEnd = ends[0]
  let writeEnd = ends[1]

  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  posix_spawn_file_actions_adddup2(&actions, writeEnd, STDOUT_FILENO)
  posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)
  posix_spawn_file_actions_addclose(&actions, readEnd)
  posix_spawn_file_actions_addclose(&actions, writeEnd)

  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
  posix_spawnattr_setpgroup(&attributes, 0)
  var defaulted = sigset_t()
  sigfillset(&defaulted)
  posix_spawnattr_setsigdefault(&attributes, &defaulted)
  var unblocked = sigset_t()
  sigemptyset(&unblocked)
  posix_spawnattr_setsigmask(&attributes, &unblocked)

  var argv: [UnsafeMutablePointer<CChar>?] = ([launchPath] + arguments).map { strdup($0) }
  argv.append(nil)
  var child: pid_t = 0
  let spawned = posix_spawn(&child, launchPath, &actions, &attributes, argv, environ)
  for argument in argv where argument != nil { free(argument) }
  posix_spawn_file_actions_destroy(&actions)
  posix_spawnattr_destroy(&attributes)
  // The child holds the only writing end now, so the reader below sees EOF
  // exactly when every process in its group has gone.
  close(writeEnd)
  guard spawned == 0 else {
    close(readEnd)
    return ("", -1)
  }

  let outcome = RunOutcome()
  let drained = DispatchSemaphore(value: 0)
  let exited = DispatchSemaphore(value: 0)

  DispatchQueue.global(qos: .utility).async {
    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { read(readEnd, $0.baseAddress, $0.count) }
      if count > 0 {
        outcome.append(Data(buffer[0..<count]))
      } else if count == 0 {
        break
      } else if errno != EINTR {
        break
      }
    }
    close(readEnd)
    drained.signal()
  }

  DispatchQueue.global(qos: .utility).async {
    var raw: Int32 = 0
    while waitpid(child, &raw, 0) < 0 && errno == EINTR { continue }
    // <sys/wait.h>'s WIFEXITED/WEXITSTATUS, which Swift does not import. A
    // child that was signalled rather than exiting reports -1, as a failure to
    // launch one always has.
    outcome.finish((raw & 0x7f) == 0 ? (raw >> 8) & 0xff : -1)
    exited.signal()
  }

  var timedOut = false
  if exited.wait(timeout: .now() + timeout) == .timedOut {
    timedOut = true
    signalProcessGroup(of: child, SIGTERM)
    if exited.wait(timeout: .now() + 1) == .timedOut {
      signalProcessGroup(of: child, SIGKILL)
      _ = exited.wait(timeout: .now() + 2)
    }
  }
  // Bounded, so this function returns even in the case nothing above can
  // reach: a grandchild that left the group on its own and still holds the
  // pipe open. Whatever arrived by then is what the caller gets.
  _ = drained.wait(timeout: .now() + 2)
  return (outcome.text.trimmingCharacters(in: .whitespacesAndNewlines), timedOut ? -1 : outcome.status)
}

func env(_ name: String) -> String? {
  guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
  return value
}

// MARK: - The helper

final class GrantedMenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let port: Int
  private let trayScript: String
  private let logFile: String
  private let statusPath: String?
  private let lockDir: String?
  private let pidFile: String?
  private let iconPath: String?
  private let settingsPath: String
  private let url: String

  private var statusItem: NSStatusItem?
  private var statusLabel: NSMenuItem?
  private var ownWindowItem: NSMenuItem?
  private var everReady = false
  private var reportedFailure = false
  private var openWhenReady = false
  private var lastState = ""
  private var quitting = false
  private var polling = false
  /// Background actions in flight (only ever touched on the main queue).
  private var pending = 0
  private var timer: Timer?
  private var signalSources: [DispatchSourceSignal] = []

  override init() {
    port = Int(env("GRANTED_PORT") ?? "") ?? 3000
    trayScript = env("GRANTED_TRAY_SCRIPT") ?? ""
    logFile = env("GRANTED_LOG_FILE") ?? ""
    statusPath = env("GRANTED_STATUS_FILE")
    lockDir = env("GRANTED_STATUS_FILE").map { "\($0).lock.d" }
    pidFile = env("GRANTED_HELPER_PID_FILE")
    iconPath = env("GRANTED_MENUBAR_ICON")
    settingsPath =
      env("GRANTED_SETTINGS_PATH") ?? "\(NSHomeDirectory())/Library/Application Support/Granted/settings.json"
    url = "http://localhost:\(Int(env("GRANTED_PORT") ?? "") ?? 3000)"
    super.init()
  }

  // MARK: Where Granted opens (the shared settings file's `openIn`)

  /// Whether the "Open in its own window" tick should be on, read straight
  /// from the settings file — the same file, and the same key, the installer
  /// and the Windows tray use.
  ///
  /// Read here rather than through `granted-tray.sh open-in` for one reason:
  /// this is called from `menuWillOpen`, on the main thread, at the instant
  /// the menu appears (the preference can have been changed by the installer,
  /// or by another copy of the menu, since the last time it was looked at —
  /// the Windows tray re-reads it on every menu open for exactly that
  /// reason). A subprocess there would stall the menu; a file read cannot.
  ///
  /// The rule is the one every other reader applies: its own window unless the
  /// file says, in exactly those letters, "browser" (ipcPure.ts's
  /// parseOpenInSetting, open-granted.sh's read_open_in). Nothing decides how
  /// Granted actually opens here — that is open-granted.sh's job, through
  /// `granted-tray.sh open` — so this is a mirror of the preference, never a
  /// second opinion about it.
  private func openInWindow() -> Bool {
    guard let data = FileManager.default.contents(atPath: settingsPath),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return true }
    return (parsed["openIn"] as? String) != "browser"
  }

  /// The menu is about to be shown: re-read the preference, so the tick is
  /// never stale (see openInWindow).
  func menuWillOpen(_ menu: NSMenu) {
    ownWindowItem?.state = openInWindow() ? .on : .off
  }

  // MARK: Status file (the installer's own mechanism)

  /// The lock directory first, then the status: the installer reads a missing
  /// lock as "this side already wrote its final status", so the order matters
  /// (openGranted.ts's isStatusWindowAlive).
  private func takeStatusLock() {
    guard let lockDir else { return }
    try? FileManager.default.createDirectory(atPath: lockDir, withIntermediateDirectories: false)
  }

  private func releaseStatusLock() {
    guard let lockDir else { return }
    try? FileManager.default.removeItem(atPath: lockDir)
  }

  private func writeStatus(_ state: String, _ message: String?) {
    guard let statusPath else { return }
    let payload: [String: Any] = ["state": state, "message": message ?? NSNull(), "pid": ProcessInfo.processInfo.processIdentifier]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    // .atomic: written to a temp file in the same folder and renamed into
    // place, so a poller never reads a half-written status -- the same
    // guarantee install-macos.sh's write_status gives with mktemp + mv.
    try? data.write(to: URL(fileURLWithPath: statusPath), options: .atomic)
  }

  /// The last error-looking line of the server log, for the message a
  /// too-early exit reports (the Windows tray's Get-LastLogLine).
  private func lastLogError() -> String? {
    guard !logFile.isEmpty, let data = FileManager.default.contents(atPath: logFile) else { return nil }
    let contents = String(decoding: data, as: UTF8.self)
    let lines = contents.split(whereSeparator: \.isNewline).suffix(40)
    let interesting = lines.last { $0.localizedCaseInsensitiveContains("error") || $0.contains("ERR") }
    guard let interesting else { return nil }
    return interesting.trimmingCharacters(in: .whitespaces)
  }

  // MARK: The server, through granted-tray.sh

  private func tray(_ arguments: [String], timeout: TimeInterval = 60) -> (output: String, status: Int32) {
    guard !trayScript.isEmpty else { return ("", -1) }
    return run("/bin/bash", [trayScript] + arguments + ["--port", String(port)], timeout: timeout)
  }

  /// One of starting | running | stopped | crashed, straight from
  /// granted-tray.sh's own `status` (so there is one state machine, not two).
  private func serverState() -> String {
    let result = tray(["status"], timeout: 20)
    guard let data = result.output.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let state = parsed["state"] as? String
    else { return "stopped" }
    return state
  }

  // MARK: The menu

  func applicationDidFinishLaunching(_ notification: Notification) {
    takeStatusLock()
    writeStatus("running", nil)
    buildMenu()
    installSignalHandlers()
    if let mode = env("GRANTED_MENUBAR_SELF_TEST") {
      // The smoke test: everything above has run for real (menu built, status
      // written, lock taken), so prove it — and optionally choose one item —
      // then leave, rather than sitting in the menu bar of whatever machine is
      // running the tests.
      runSelfTest(mode)
      return
    }
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.poll() }
  }

  private func buildMenu() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = menuBarImage()
    // Never an item with neither an image nor a title: that is a zero-width,
    // invisible menu bar extra the user can't click (see menuBarImage).
    if item.button?.image == nil { item.button?.title = "Granted" }
    item.button?.toolTip = "Granted — starting…"
    item.button?.setAccessibilityLabel("Granted")
    item.button?.setAccessibilityValue("starting")
    let menu = NSMenu()
    menu.autoenablesItems = false

    let open = NSMenuItem(title: "Open Granted", action: #selector(openGranted), keyEquivalent: "")
    open.target = self
    open.attributedTitle = NSAttributedString(
      string: "Open Granted",
      attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)]
    )
    describe(open, label: "Open Granted", help: "Opens Granted at \(url).")
    menu.addItem(open)

    let status = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    status.isEnabled = false
    describe(status, label: "Granted is starting", help: "Whether Granted's server is starting, running or stopped.")
    menu.addItem(status)
    statusLabel = status

    // The counterpart of the Windows tray's "Open in its own window" tick:
    // ticked, Granted opens as its own app window (Chrome/Edge --app=);
    // unticked, in an ordinary browser tab. The tick is the shared settings
    // file's `openIn`, so the installer's own checkbox and this one are the
    // same setting.
    let ownWindow = NSMenuItem(title: "Open in its own window", action: #selector(toggleOwnWindow), keyEquivalent: "")
    ownWindow.target = self
    ownWindow.state = openInWindow() ? .on : .off
    ownWindow.toolTip = "Open Granted like an app, in a window with no tabs or address bar (needs Chrome or Edge)."
    describe(
      ownWindow,
      label: "Open in its own window",
      help: "Ticked: Granted opens like an app, in its own window (needs Chrome or Edge). Unticked: in a browser tab."
    )
    menu.addItem(ownWindow)
    ownWindowItem = ownWindow

    menu.addItem(NSMenuItem.separator())

    let log = NSMenuItem(title: "Show log", action: #selector(showLog), keyEquivalent: "")
    log.target = self
    describe(log, label: "Show log", help: "Opens Granted's server log, \(logFile).")
    menu.addItem(log)

    let restart = NSMenuItem(title: "Restart", action: #selector(restart), keyEquivalent: "")
    restart.target = self
    describe(restart, label: "Restart Granted", help: "Stops Granted's server and starts it again.")
    menu.addItem(restart)

    menu.addItem(NSMenuItem.separator())

    let quit = NSMenuItem(title: "Quit Granted", action: #selector(quit), keyEquivalent: "")
    quit.target = self
    describe(quit, label: "Quit Granted", help: "Stops Granted and removes this icon.")
    menu.addItem(quit)

    menu.delegate = self
    item.menu = menu
    statusItem = item
  }

  /// A real VoiceOver label and help text for every item. macOS users who
  /// navigate the menu bar with VoiceOver get the item's purpose read out,
  /// not just its title — menu bar extras are expected to carry this.
  private func describe(_ item: NSMenuItem, label: String, help: String) {
    item.setAccessibilityLabel(label)
    item.setAccessibilityTitle(label)
    item.setAccessibilityHelp(help)
  }

  /// The menu-bar glyph: a template image, so macOS tints it correctly in
  /// light mode, dark mode and while the menu is open.
  ///
  /// NOT scaffold/scripts/windows/granted.ico, even though NSImage does read
  /// .ico files and the Windows tray uses exactly that file: a template image
  /// is drawn from its alpha channel alone, and that icon's decodes to a
  /// menu-bar item that is simply INVISIBLE — verified on real hardware
  /// (macOS 27, Apple Silicon): the status item was created, 34 points wide,
  /// and nothing was drawn. Menu bar extras are expected to be monochrome
  /// template artwork anyway; a proper .icns/PDF template is part of the
  /// separate icon work. Until then this is a system symbol (a classical
  /// building — Granted is about public funding), with the app's initial as a
  /// last resort so the item can never be invisible again.
  /// GRANTED_MENUBAR_ICON overrides it with a file, for anyone who has one.
  private func menuBarImage() -> NSImage? {
    if let iconPath, let image = NSImage(contentsOfFile: iconPath) {
      image.size = NSSize(width: 18, height: 18)
      image.isTemplate = true
      return image
    }
    if let symbol = NSImage(systemSymbolName: "building.columns", accessibilityDescription: "Granted") {
      symbol.isTemplate = true
      return symbol
    }
    return nil
  }

  // MARK: Polling

  /// The state check, off the main thread (it runs curl and launchctl, which
  /// can take a moment) with the UI updated back on it. Overlapping ticks are
  /// skipped, so a slow check can never queue up behind itself.
  private func poll() {
    guard !quitting, !polling else { return }
    // Once Granted has answered, stop asking so often: nothing needs a probe
    // every two seconds all day (the Windows tray stops probing entirely at
    // this point and just watches the process).
    if everReady {
      pollTick += 1
      if pollTick % 3 != 0 { return }
    }
    polling = true
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      let state = self.serverState()
      DispatchQueue.main.async {
        self.polling = false
        self.apply(state: state)
      }
    }
  }

  private var pollTick = 0

  private func apply(state: String) {
    guard !quitting else { return }
    let previous = lastState
    lastState = state
    if state == "running" { everReady = true }
    let shown: (title: String, label: String, help: String, tip: String, value: String)
    switch state {
    case "running":
      shown = (
        "Running at \(url)", "Granted is running at \(url)", "Granted is running in the background.",
        "Granted — running", "running"
      )
    case "crashed":
      shown = (
        "Stopped unexpectedly — see Show log, then Restart", "Granted stopped unexpectedly",
        "Open Show log for the reason, then Restart.", "Granted — stopped", "stopped"
      )
    case "stopped":
      shown = (
        "Stopped — choose Restart to start it again", "Granted is stopped", "Choose Restart to start it again.",
        "Granted — stopped", "stopped"
      )
    default:
      shown = (
        "Starting… (the first start can take a minute)", "Granted is starting",
        "The first start can take a minute or two.", "Granted — starting…", "starting"
      )
    }
    if let statusLabel {
      statusLabel.title = shown.title
      describe(statusLabel, label: shown.label, help: shown.help)
    }
    statusItem?.button?.toolTip = shown.tip
    statusItem?.button?.setAccessibilityValue(shown.value)
    if state == "running", previous != "running", openWhenReady {
      openWhenReady = false
      _ = tray(["open"], timeout: 20)
    }
    // Reported once per start, and only before Granted ever answered: that is
    // the case the installer is still waiting on (the Windows tray's
    // Report-EarlyCrash, same wording).
    if state == "crashed", !everReady, !reportedFailure {
      reportedFailure = true
      var message = "Granted stopped before it finished starting. Details are in \(logFile)"
      if let detail = lastLogError() { message += " — last error: \(detail)" }
      writeStatus("error", message)
    }
  }

  // MARK: Actions

  /// Anything that shells out, off the main thread so the menu never blocks,
  /// counted so the self-test below can tell when a clicked item has finished.
  private func inBackground(_ work: @escaping () -> Void, then done: @escaping () -> Void = {}) {
    inBackground(returning: { work() }, then: { (_: Void) in done() })
  }

  /// The same, for an action whose outcome the completion needs — saving the
  /// preference below has to know whether it worked to put the tick back. The
  /// result travels through the queue hop, so nothing is shared across
  /// threads.
  private func inBackground<Result>(returning work: @escaping () -> Result, then done: @escaping (Result) -> Void) {
    pending += 1
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = work()
      DispatchQueue.main.async {
        self?.pending -= 1
        done(result)
      }
    }
  }

  @objc private func openGranted() {
    if lastState == "running" {
      inBackground { _ = self.tray(["open"], timeout: 20) }
    } else {
      // Not up yet: open it as soon as it answers, like the Windows tray.
      openWhenReady = true
    }
  }

  /// The "Open in its own window" tick. Ticked straight away, as the Windows
  /// tray's CheckOnClick item is, and saved in the background — and if the
  /// save fails the tick goes back, so the menu never claims a setting that
  /// isn't stored. (The Windows tray shows a balloon tip saying so; a menu bar
  /// extra has nowhere to put one without a bundle and notification
  /// permission, so this says it in the helper's log instead.)
  ///
  /// Written to stderr, not with `print`, so that log line actually lands.
  /// granted-tray.sh's start_helper runs this process as
  /// `nohup "$binary" >> "$LOG_DIR/menubar.log" 2>&1`: stdout is a regular
  /// file, which libc fully buffers (_IOFBF), and this helper then runs for
  /// hours without exiting, so a `print` here sits in that buffer indefinitely
  /// and is lost outright if the helper is ever killed rather than quit. stderr
  /// is unbuffered and the `2>&1` already merges it into the very same
  /// menubar.log, so this needs no change to how the helper is logged -- only
  /// which stream this one message takes. (The self-test prints below stay on
  /// stdout on purpose: that path exits immediately, which flushes.)
  @objc private func toggleOwnWindow() {
    guard let item = ownWindowItem else { return }
    let wanted = item.state != .on
    item.state = wanted ? .on : .off
    let mode = wanted ? "window" : "browser"
    inBackground(returning: { self.tray(["set-open-in", "--mode", mode], timeout: 20).status == 0 }) { saved in
      guard !saved else { return }
      item.state = wanted ? .off : .on
      FileHandle.standardError.write(
        Data("granted-menubar: couldn't save where Granted opens — it will keep opening the way it did\n".utf8))
    }
  }

  @objc private func showLog() {
    inBackground { _ = self.tray(["show-log"], timeout: 20) }
  }

  @objc private func restart() {
    statusLabel?.title = "Restarting…"
    lastState = ""
    everReady = false
    reportedFailure = false
    inBackground({ _ = self.tray(["restart"], timeout: 180) }, then: { self.poll() })
  }

  @objc private func quit() {
    guard !quitting else { return }
    quitting = true
    timer?.invalidate()
    statusLabel?.title = "Quitting…"
    inBackground {
      // The server first, then the lock: a released lock with the status
      // still on "running" is exactly how the Windows tray's quit reads to
      // the installer ("its tray icon was closed"), and it must not be
      // reported before the server it describes has actually gone.
      _ = self.tray(["stop", "--server-only"], timeout: 60)
      self.releaseStatusLock()
      if let pidFile = self.pidFile { try? FileManager.default.removeItem(atPath: pidFile) }
    } then: {
      if let statusItem = self.statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
      NSApp.terminate(nil)
    }
  }

  // MARK: The self test (never part of normal running)

  /// GRANTED_MENUBAR_SELF_TEST, so the menu can be exercised without a mouse
  /// (and without needing the machine to grant anything assistive access):
  ///
  ///   1                    build everything, report it, exit
  ///   click:<item title>   also choose that menu item, exactly as a click
  ///                        does (NSMenu.performActionForItem sends the very
  ///                        same action to the very same target), wait for it
  ///                        to finish, then exit
  ///
  /// Used by macTray.integration.test.ts and by the by-hand check on real
  /// hardware. Everything it drives is the shipping code path.
  private func runSelfTest(_ mode: String) {
    let menu = statusItem?.menu
    print("granted-menubar: self test ok (port \(port), items: \(menu?.items.count ?? 0))")
    print("granted-menubar: icon=\(statusItem?.button?.image == nil ? "none" : "yes") title=\"\(statusItem?.button?.title ?? "")\" width=\(statusItem?.button?.frame.width ?? 0)")
    for item in menu?.items ?? [] where !item.isSeparatorItem {
      print(
        "granted-menubar: item \"\(item.title)\" enabled=\(item.isEnabled) "
          + "state=\(item.state == .on ? "on" : "off") a11y=\"\(item.accessibilityLabel() ?? "")\""
      )
    }
    guard mode.hasPrefix("click:"), let menu else {
      releaseStatusLock()
      exit(0)
    }
    // One state read first: a menu the user can click has always been polled
    // at least once, and some items (Open Granted) behave differently
    // depending on whether Granted is answering yet.
    apply(state: serverState())
    let wanted = String(mode.dropFirst("click:".count))
    guard let index = menu.items.firstIndex(where: { $0.title == wanted }) else {
      print("granted-menubar: no menu item titled \"\(wanted)\"")
      releaseStatusLock()
      exit(2)
    }
    guard menu.items[index].isEnabled, menu.items[index].action != nil else {
      print("granted-menubar: \"\(wanted)\" is not clickable")
      releaseStatusLock()
      exit(3)
    }
    print("granted-menubar: clicking \"\(wanted)\"")
    menu.performActionForItem(at: index)
    // Quit terminates this process itself; anything else finishes and is
    // waited for here (the state poll is not running in self-test mode, so
    // `pending` only ever counts the clicked action).
    let deadline = Date().addingTimeInterval(180)
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
      guard let self else { return }
      if self.pending == 0 || Date() > deadline {
        timer.invalidate()
        print("granted-menubar: \"\(wanted)\" done")
        self.releaseStatusLock()
        exit(0)
      }
    }
  }

  /// granted-tray.sh's `stop` (and an uninstall) asks this process to quit
  /// with SIGTERM; the default disposition would kill it outright, leaving
  /// the status lock behind and the server running.
  private func installSignalHandlers() {
    for signalNumber in [SIGTERM, SIGINT] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { [weak self] in self?.quit() }
      source.resume()
      signalSources.append(source)
    }
  }
}

// MARK: - Start

// The timeout harness for run() above, never part of normal running:
// GRANTED_MENUBAR_RUN_TIMEOUT_TEST="<seconds>:<bash script>" runs that script
// through the very same run() the polling loop uses, reports how long it
// actually took and what it returned, and exits. macTray.integration.test.ts
// uses it to prove that a child which never exits is killed — along with its
// own children — and that run() still returns promptly rather than hanging.
//
// Deliberately before NSApplication.shared: this needs no menu bar and no GUI
// (Aqua) session, so the test covering it can run anywhere macOS and the Swift
// toolchain are.
if let specification = env("GRANTED_MENUBAR_RUN_TIMEOUT_TEST") {
  let parts = specification.split(separator: ":", maxSplits: 1).map(String.init)
  let timeout = Double(parts.first ?? "") ?? 5
  let script = parts.count > 1 ? parts[1] : "/dev/null"
  let startedAt = Date()
  let result = run("/bin/bash", [script], timeout: timeout)
  let elapsed = Int((Date().timeIntervalSince(startedAt) * 1000).rounded())
  // `bytes` so a test can check a large output arrived whole without the whole
  // of it having to travel back through the test runner; the output line
  // itself is one line and capped.
  let flattened = result.output.replacingOccurrences(of: "\n", with: "\\n")
  let shown = flattened.count > 200 ? String(flattened.prefix(200)) : flattened
  print("granted-menubar: run timeout test elapsed=\(elapsed)ms status=\(result.status) bytes=\(result.output.utf8.count)")
  print("granted-menubar: run timeout test output=\(shown)")
  exit(0)
}

let app = NSApplication.shared
// .accessory: an icon in the menu bar, no Dock tile and no menu bar of its
// own — what a menu bar extra is.
app.setActivationPolicy(.accessory)
let delegate = GrantedMenuBar()
app.delegate = delegate
app.run()
