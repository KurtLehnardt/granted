#!/usr/bin/env bash
# Granted -- run the app in the background on macOS, with a menu-bar icon.
#
# The macOS counterpart of scripts/windows/granted-tray.ps1. Two pieces do
# there what one PowerShell script does on Windows:
#
#   * launchd runs the server. A per-user LaunchAgent (label
#     com.granted.server, plist in ~/Library/LaunchAgents) runs `npm run dev`
#     with no window and no terminal, logging to ~/Library/Logs/Granted. The
#     plist is deliberately written with RunAtLoad false and no KeepAlive, so
#     it never starts Granted at login: it is bootstrapped and kickstarted
#     when the user actually opens Granted, and booted out again when they
#     quit. That matches Windows, where nothing starts at sign-in either.
#   * The menu-bar icon is a small native Swift helper (scripts/macos/menubar,
#     an NSStatusItem app) -- the counterpart of the Windows tray's
#     NotifyIcon, with the same menu: Open / status / Open in its own window /
#     Show log / Restart / Quit. It shells back into this script for every
#     action, so the launchd and status-file logic lives in exactly one place.
#     If Swift (Xcode Command Line Tools) is missing, or the helper can't be
#     built, Granted still runs under launchd -- there is just no menu-bar
#     icon, and this script says so in the log.
#
# This script is what the GUI installer, the menu-bar helper and (later) the
# ~/Applications launcher all call:
#
#   granted-tray.sh start [--open-browser] [--status-path FILE] [--no-helper]
#   granted-tray.sh stop [--server-only]   quit Granted (and the menu-bar icon)
#   granted-tray.sh restart                restart the server
#   granted-tray.sh status                 one JSON line: state, url, log, label
#   granted-tray.sh open                   open Granted (how the user prefers)
#   granted-tray.sh show-log               open the server log
#   granted-tray.sh log-path               the server log for this port
#   granted-tray.sh plist                  print the LaunchAgent plist
#   granted-tray.sh build-helper           build the menu-bar helper, print its path
#   granted-tray.sh helper-path            print the menu-bar helper's path
#
# Every subcommand accepts --port N (default: $GRANTED_PORT, else 3000).
#
# Status reporting is the installer's existing mechanism, unchanged: the
# {state,message,pid} JSON of install-macos.sh's write_status, plus the
# `<status>.lock.d` directory lock (installer/src/main/ipcPure.ts's
# macStatusLockPath). The menu-bar helper holds that lock for its lifetime and
# writes the status, exactly as the Windows tray holds its own lock file and
# writes the same JSON -- so a quit before Granted answered reads back as a
# closed window, through the very same openGranted.ts isStatusWindowAlive.
#
# Test-only overrides, so nothing here ever touches the real install:
#   GRANTED_LAUNCH_LABEL       the LaunchAgent label (never the real one in tests)
#   GRANTED_LAUNCH_AGENTS_DIR  where the plist is written
#   GRANTED_LOG_DIR            the log folder
#   GRANTED_SETTINGS_PATH      the settings file (its folder holds the pid file)
#   GRANTED_MENUBAR_HELPER     the helper binary ("none" = don't run one)
#   GRANTED_NPM                the npm binary to run the server with
#   GRANTED_OPEN_CMD           what opens Granted and the log (instead of `open`)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCAFFOLD_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
MENUBAR_PKG="$SCRIPT_DIR/menubar"

LABEL="${GRANTED_LAUNCH_LABEL:-com.granted.server}"
LAUNCH_AGENTS_DIR="${GRANTED_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${GRANTED_LOG_DIR:-$HOME/Library/Logs/Granted}"
SETTINGS_PATH="${GRANTED_SETTINGS_PATH:-$HOME/Library/Application Support/Granted/settings.json}"
SUPPORT_DIR="$(dirname -- "$SETTINGS_PATH")"
STATUS_PATH="${GRANTED_STATUS_FILE:-}"
DOMAIN="gui/$(id -u)"

PORT="${GRANTED_PORT:-3000}"
OPEN_BROWSER=0
NO_HELPER=0
SERVER_ONLY=0

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --status-path) STATUS_PATH="$2"; shift 2 ;;
    --open-browser) OPEN_BROWSER=1; shift ;;
    --no-helper) NO_HELPER=1; shift ;;
    --server-only) SERVER_ONLY=1; shift ;;
    *) printf 'granted-tray.sh: unknown option %s\n' "$1" >&2; exit 64 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) printf 'granted-tray.sh: --port must be a number (got %s)\n' "$PORT" >&2; exit 64 ;;
esac

PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_FILE="$LOG_DIR/server-$PORT.log"
HELPER_PID_FILE="$SUPPORT_DIR/menubar-$PORT.pid"
URL="http://localhost:$PORT"
# `npm run dev` is `next dev -H 127.0.0.1`, which binds IPv4 only -- probe
# that, not "localhost", which can resolve to ::1 first.
PROBE_URL="http://127.0.0.1:$PORT/"

# --- status reporting (install-macos.sh's write_status, verbatim shape) -----
# `pid` is omitted on purpose: this script exits as soon as it has started
# things, so a recorded pid of its own would read as a dead window the moment
# it exits (openGranted.ts's resolveTaskStatus only asks about liveness when
# there IS a pid). The menu-bar helper, which does stay alive, writes the
# status with its own pid and takes the lock directory.
write_status() {
  local state="$1" message="$2" tmp escaped
  [ -n "$STATUS_PATH" ] || return 0
  tmp="$(mktemp "${STATUS_PATH}.XXXXXX" 2>/dev/null)" || return 0
  escaped="null"
  if [ -n "$message" ]; then
    escaped="\"$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
  fi
  if printf '{"state":"%s","message":%s}' "$state" "$escaped" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATUS_PATH" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
}

note() {
  mkdir -p -- "$LOG_DIR" 2>/dev/null || true
  printf '[granted-tray %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_DIR/tray.log" 2>/dev/null || true
}

# --- probing (scripts/windows/granted-tray.ps1's Test-Granted) -------------
# "granted" = Granted's own page; "other" = something else answered; "busy" =
# accepted but didn't answer in time (Next still compiling); "down" = nothing
# listening. Same four outcomes, and the same page marker, as the Windows
# tray and installer/src/main/openGranted.ts's probeGranted.
probe_server() {
  local timeout="${1:-3}" body rc
  set +e
  body="$(curl -fsS -m "$timeout" "$PROBE_URL" 2>/dev/null)"
  rc=$?
  set -e
  case "$rc" in
    0) if printf '%s' "$body" | grep -qi 'federal funding intelligence'; then echo granted; else echo other; fi ;;
    28) echo busy ;;
    22|52|56) echo other ;;   # an HTTP error / empty reply from something that IS listening
    *) echo down ;;
  esac
}

# --- the LaunchAgent -------------------------------------------------------
xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

npm_bin() {
  if [ -n "${GRANTED_NPM:-}" ]; then printf '%s' "$GRANTED_NPM"; return 0; fi
  command -v npm 2>/dev/null || true
}

# The plist, templated rather than shipped as a static file: it has to carry
# this install's own scaffold path, port, log path and npm location.
#
# RunAtLoad is false and there is no KeepAlive, so loading the agent does not
# start Granted -- `launchctl kickstart` does, when the user opens it. That is
# what keeps this from becoming a login item: at the next login launchd loads
# the plist again and, with RunAtLoad false, runs nothing.
#
# EnvironmentVariables.PATH is this process's PATH, not launchd's default
# (/usr/bin:/bin:/usr/sbin:/sbin): npm and node usually live somewhere
# launchd would not look (/opt/homebrew/bin on Apple Silicon, ~/.nvm/...),
# and npm's own shim resolves `node` through PATH.
emit_plist() {
  local npm
  npm="$(npm_bin)"
  [ -n "$npm" ] || { printf 'granted-tray.sh: npm not found on PATH -- install Node.js 22+ first\n' >&2; return 1; }
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$npm")</string>
    <string>run</string>
    <string>dev</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$SCAFFOLD_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$PATH")</string>
    <key>PORT</key>
    <string>$(xml_escape "$PORT")</string>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
PLIST
}

write_plist() {
  local tmp
  mkdir -p -- "$LAUNCH_AGENTS_DIR"
  tmp="$(mktemp "${TMPDIR:-/tmp}/granted-plist.XXXXXX")"
  if emit_plist > "$tmp"; then
    mv -f "$tmp" "$PLIST_PATH"
  else
    rm -f "$tmp"
    return 1
  fi
}

agent_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# `launchctl print`'s own fields, read at the top level only (the nested
# sections repeat `state = ...` for coalitions, which must not be mistaken
# for the job's).
agent_field() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk -v key="$1" '
    $0 ~ "^\t" key " = " { sub("^\t" key " = ", ""); print; exit }'
}

agent_running() { [ "$(agent_field state)" = "running" ]; }
agent_runs() { local r; r="$(agent_field runs)"; printf '%s' "${r:-0}"; }

load_agent() {
  write_plist || return 1
  if agent_loaded; then
    # Already loaded, possibly from an older plist: boot it out and back in so
    # the file just written is what launchd actually uses.
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
  agent_loaded
}

start_server() {
  load_agent || return 1
  launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1
}

# Stops the server and unloads the agent, so nothing stays registered. Waits
# for the port to be free afterwards, the way the Windows tray's
# Stop-GrantedServer does, so a Restart's new server can bind it.
stop_server() {
  local deadline
  if agent_loaded; then
    launchctl kill SIGTERM "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + 15 ))
    while agent_running && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
  deadline=$(( $(date +%s) + 15 ))
  while [ "$(probe_server 1)" != "down" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done
}

# One of starting | running | stopped | crashed -- the same four the Windows
# tray's Get-ServerState reports, from the same two signals (is the server
# process there, and does Granted answer).
server_state() {
  if ! agent_loaded; then
    [ "$(probe_server 1)" = "granted" ] && echo running || echo stopped
    return 0
  fi
  if agent_running; then
    [ "$(probe_server 1)" = "granted" ] && echo running || echo starting
    return 0
  fi
  [ "$(agent_runs)" != "0" ] && echo crashed || echo stopped
}

# --- the menu-bar helper ---------------------------------------------------
helper_path() {
  if [ -n "${GRANTED_MENUBAR_HELPER:-}" ]; then printf '%s' "$GRANTED_MENUBAR_HELPER"; return 0; fi
  printf '%s' "$MENUBAR_PKG/.build/release/granted-menubar"
}

helper_pid() {
  local pid
  [ -f "$HELPER_PID_FILE" ] || return 1
  pid="$(cat "$HELPER_PID_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# Builds the helper with the Swift toolchain that ships with the Xcode Command
# Line Tools -- no Xcode project, no Xcode.app. Output goes to the package's
# own .build (gitignored). Build failures are logged and never fatal: Granted
# runs under launchd regardless, just without a menu-bar icon.
build_helper() {
  local binary
  binary="$(helper_path)"
  mkdir -p -- "$LOG_DIR" 2>/dev/null || true
  if [ -x "$binary" ]; then printf '%s' "$binary"; return 0; fi
  command -v swift >/dev/null 2>&1 || { note "swift not found: no menu-bar icon (install the Xcode Command Line Tools with 'xcode-select --install')"; return 1; }
  [ -f "$MENUBAR_PKG/Package.swift" ] || { note "no menu-bar helper package at $MENUBAR_PKG"; return 1; }
  note "building the menu-bar helper (first run only)..."
  if ! swift build -c release --package-path "$MENUBAR_PKG" >> "$LOG_DIR/tray.log" 2>&1; then
    note "the menu-bar helper didn't build -- Granted still runs in the background, without a menu-bar icon"
    return 1
  fi
  [ -x "$binary" ] || return 1
  printf '%s' "$binary"
}

start_helper() {
  local binary
  if [ "$NO_HELPER" = "1" ] || [ "${GRANTED_MENUBAR_HELPER:-}" = "none" ]; then return 0; fi
  if helper_pid >/dev/null; then return 0; fi   # already showing
  binary="$(build_helper)" || return 1
  mkdir -p -- "$SUPPORT_DIR"
  # Detached (setsid-less: nohup plus & is enough on macOS) so it outlives
  # whoever called this -- the installer, or a Terminal window.
  GRANTED_PORT="$PORT" \
  GRANTED_STATUS_FILE="$STATUS_PATH" \
  GRANTED_TRAY_SCRIPT="$SCRIPT_DIR/granted-tray.sh" \
  GRANTED_LOG_FILE="$LOG_FILE" \
  GRANTED_SETTINGS_PATH="$SETTINGS_PATH" \
  GRANTED_HELPER_PID_FILE="$HELPER_PID_FILE" \
  GRANTED_LAUNCH_LABEL="$LABEL" \
  GRANTED_LAUNCH_AGENTS_DIR="$LAUNCH_AGENTS_DIR" \
  GRANTED_LOG_DIR="$LOG_DIR" \
    nohup "$binary" >> "$LOG_DIR/menubar.log" 2>&1 &
  printf '%s' "$!" > "$HELPER_PID_FILE"
  return 0
}

stop_helper() {
  local pid deadline
  pid="$(helper_pid)" || { rm -f "$HELPER_PID_FILE"; return 1; }
  # SIGTERM, not SIGKILL: the helper's own handler removes its status lock
  # directory and hides its icon before exiting.
  kill -TERM "$pid" 2>/dev/null || true
  deadline=$(( $(date +%s) + 10 ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$HELPER_PID_FILE"
  return 0
}

# --- opening things --------------------------------------------------------
# Both of the menu's "open something" actions go through here, so there is one
# place to override in tests (GRANTED_OPEN_CMD, a stand-in that just records
# what it was asked to open — the counterpart of the Windows tests'
# GRANTED_APP_BROWSER) and one place for "its own window" to land in later.
#
# Granted in a browser tab today. "Its own window" (Chrome/Edge --app=, the
# openIn preference the Windows tray's open-granted.ps1 handles) is the next
# piece of macOS work; it lands here, so the menu-bar helper and the installer
# need no change when it does.
open_granted() { "${GRANTED_OPEN_CMD:-open}" "$URL" >/dev/null 2>&1 || true; }

# The server log, in whatever the user opens .log files with (Console, by
# default) — the menu's "Show log", the counterpart of the Windows tray
# opening it in Notepad. With no log yet (Granted has never started here),
# its folder, so there's something to look at either way.
show_log() {
  if [ -f "$LOG_FILE" ]; then
    "${GRANTED_OPEN_CMD:-open}" "$LOG_FILE" >/dev/null 2>&1 || true
  else
    "${GRANTED_OPEN_CMD:-open}" "$LOG_DIR" >/dev/null 2>&1 || true
  fi
}

# --- subcommands -----------------------------------------------------------
cmd_start() {
  local before state
  mkdir -p -- "$LOG_DIR" "$SUPPORT_DIR"

  before="$(probe_server 10)"
  if [ "$before" = "busy" ]; then
    # Something is there but slow to answer -- most likely a Granted still
    # compiling (started from a terminal, say). Wait for it rather than
    # calling it another program, exactly as the Windows tray does.
    local deadline
    deadline=$(( $(date +%s) + 300 ))
    while [ "$before" = "busy" ] && [ "$(date +%s)" -lt "$deadline" ]; do before="$(probe_server 5)"; done
  fi
  if [ "$before" = "granted" ]; then
    # Already running (perhaps started some other way): show the icon, open it, done.
    start_helper || true
    [ "$OPEN_BROWSER" = "1" ] && open_granted
    return 0
  fi
  if [ "$before" != "down" ]; then
    local msg="Something else is already using port $PORT, so Granted can't start there. Close it and try again."
    write_status "error" "$msg"
    printf '%s\n' "$msg" >&2
    return 2
  fi

  # Rotate the log, so a failed start's output isn't buried under the last run's.
  [ -f "$LOG_FILE" ] && mv -f "$LOG_FILE" "$LOG_FILE.previous" 2>/dev/null || true
  write_status "running" ""
  start_server || { write_status "error" "Granted's background service couldn't be started. Details are in $LOG_FILE"; return 1; }
  note "started $LABEL on port $PORT (log: $LOG_FILE)"
  start_helper || true
  if [ "$OPEN_BROWSER" = "1" ]; then
    # Wait for Granted to answer before opening a browser at it (the first
    # `next dev` compile takes a while); give up quietly after five minutes.
    local deadline
    deadline=$(( $(date +%s) + 300 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      state="$(probe_server 5)"
      [ "$state" = "granted" ] && break
      sleep 2
    done
    open_granted
  fi
  return 0
}

cmd_stop() {
  local stopped=1
  if [ "$SERVER_ONLY" != "1" ]; then
    # The helper first: its own quit stops the server and boots the agent out
    # too, and asking it to go first means it never reports the shutdown it
    # was told to perform as a crash.
    stop_helper && stopped=0
  fi
  agent_loaded && stopped=0
  stop_server
  return "$stopped"
}

cmd_restart() {
  stop_server
  write_status "running" ""
  start_server
}

cmd_status() {
  local state
  state="$(server_state)"
  printf '{"state":"%s","url":"%s","log":"%s","label":"%s","port":%s}\n' \
    "$state" "$URL" "$(printf '%s' "$LOG_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')" "$LABEL" "$PORT"
}

case "$COMMAND" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  open) open_granted ;;
  show-log) show_log ;;
  log-path) printf '%s\n' "$LOG_FILE" ;;
  plist) emit_plist ;;
  plist-path) printf '%s\n' "$PLIST_PATH" ;;
  build-helper) build_helper && printf '\n' ;;
  helper-path) helper_path && printf '\n' ;;
  *)
    printf 'usage: granted-tray.sh {start|stop|restart|status|open|show-log|log-path|plist|plist-path|build-helper|helper-path} [--port N]\n' >&2
    exit 64
    ;;
esac
