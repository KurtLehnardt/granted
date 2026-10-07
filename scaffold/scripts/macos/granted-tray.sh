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
# This script is what the GUI installer, the menu-bar helper and the
# ~/Applications launcher (scripts/macos/applications-launcher.sh, whose
# Granted.app runs `start --open-browser` on a click) all call:
#
#   granted-tray.sh start [--open-browser] [--status-path FILE] [--no-helper]
#   granted-tray.sh stop [--server-only]   quit Granted (and the menu-bar icon)
#   granted-tray.sh restart                restart the server
#   granted-tray.sh status                 one JSON line: state, url, log, label
#   granted-tray.sh open                   open Granted (how the user prefers)
#   granted-tray.sh open-in                one JSON line: {"openIn":"window"|"browser"}
#   granted-tray.sh set-open-in --mode window|browser
#                                          save where Granted opens
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
#   GRANTED_APP_BROWSER        the app-mode browser ("none" = pretend there isn't one)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCAFFOLD_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
MENUBAR_PKG="$SCRIPT_DIR/menubar"
OPEN_SCRIPT="$SCRIPT_DIR/open-granted.sh"

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
MODE=""

# An option that takes a value must actually have been given one, and must say
# so when it wasn't -- checked before `$2` is read rather than left to it. With
# `set -u` a bare `--mode` at the end of the line dies on `$2: unbound
# variable`, which exits 1 with a raw shell diagnostic instead of this script's
# own message and its own exit 64 for bad input. Exit 1 also means something
# else entirely here: it is what a failed `stop` or `set-open-in` reports, and
# what open-granted.sh reserves for "I opened nothing, fall back".
need_value() {
  [ "$1" -ge 2 ] && return 0
  printf 'granted-tray.sh: %s needs a value\n' "$2" >&2
  exit 64
}

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --port) need_value "$#" --port; PORT="$2"; shift 2 ;;
    --status-path) need_value "$#" --status-path; STATUS_PATH="$2"; shift 2 ;;
    --mode) need_value "$#" --mode; MODE="$2"; shift 2 ;;
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
# `|| true`: with pipefail set, agent_field's pipeline reports launchctl's own
# failure, and the job can go away between server_state's agent_loaded test and
# this read. No answer means no runs, not an error.
agent_runs() { local r; r="$(agent_field runs)" || true; printf '%s' "${r:-0}"; }

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

# How long each of stop_server's two waits runs: first for the launchd job to
# exit, then for the port to be free again. A whole stop_server can therefore
# take twice this, which is why stop_helper's own wait is derived from it
# below rather than written out as its own number.
SERVER_STOP_WAIT=15

# Stops the server and unloads the agent, so nothing stays registered. Waits
# for the port to be free afterwards, the way the Windows tray's
# Stop-GrantedServer does, so a Restart's new server can bind it.
stop_server() {
  local deadline
  if agent_loaded; then
    launchctl kill SIGTERM "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + SERVER_STOP_WAIT ))
    while agent_running && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
  deadline=$(( $(date +%s) + SERVER_STOP_WAIT ))
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

# Is $1 really this install's menu-bar helper?
#
# REGRESSION (review). helper_pid below used to stop at `kill -0`, which only
# says the pid is alive -- not that it is still the process the pid file was
# written for. That file survives a SIGKILL, a force-quit and a power loss
# (only the helper's own graceful quit removes it), and pids restart low after
# a reboot, so a collision with an unrelated process is realistic rather than
# theoretical. stop_helper would then SIGTERM that process, wait the whole
# HELPER_STOP_WAIT deadline for it, and SIGKILL it -- someone's editor, say.
# This is the same hazard, and the same fix, as install-macos.sh's
# matching_pids: never signal a pid without first confirming what it is.
#
# Checked three ways, and never on `comm` alone, for the reason matching_pids
# is checked two ways: macOS's `ps` truncates the `comm` column to a short
# fixed width once it is combined with other `-o` fields (verified live there
# -- a Homebrew node invoked via its real Cellar path showed up as
# "/opt/homebrew/Ce"), so a comm-only test is one `ps` invocation away from
# silently never matching. On top of that, a helper that is a #! script (the
# integration tests' stand-ins) execs as its interpreter: its `comm` is
# /bin/bash, and only its arguments name the helper at all -- verified on real
# hardware, `comm=[/bin/bash] args=[/bin/bash /path/to/helper.sh]`.
helper_is_running() {
  local pid="$1" binary name comm args argv0
  binary="$(helper_path)"
  name="${binary##*/}"
  comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [ -n "$comm$args" ] || return 1
  # 1) the command name, by basename ("granted-menubar" as well as whatever
  #    GRANTED_MENUBAR_HELPER points at, so a `stop` run without that override
  #    still recognizes a helper started with one).
  case "${comm##*/}" in "$name"|granted-menubar) return 0 ;; esac
  # 2) argv[0]'s basename, from the untruncated args field.
  argv0="${args%% *}"
  case "${argv0##*/}" in "$name"|granted-menubar) return 0 ;; esac
  # 3) the helper's own path as an argument -- how a #! script shows up. Only
  #    for a real absolute path, never for the "none" sentinel.
  case "$binary" in
    /*) case "$args" in *"$binary"*) return 0 ;; esac ;;
  esac
  return 1
}

# The live menu-bar helper's pid, or failure. Failure means "no helper", which
# is also what a pid file left behind by a killed one reads as: the caller
# (stop_helper) removes the stale file and signals nothing.
helper_pid() {
  local pid
  [ -f "$HELPER_PID_FILE" ] || return 1
  pid="$(cat "$HELPER_PID_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  helper_is_running "$pid" || return 1
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

# How long to wait for a SIGTERMed helper to finish and exit on its own.
#
# This is NOT "long enough to hide an icon". SIGTERM makes the helper run a
# whole `granted-tray.sh stop --server-only` of its own -- the entire
# stop_server above, both of its waits -- and only when that returns does it
# release its `<status>.lock.d` directory and remove its pid file. So the wait
# here has to outlast a full stop_server, with room for the shell and launchctl
# invocations around it. A shorter wait SIGKILLs the helper partway through its
# own shutdown, before it ever reaches that cleanup, and the lock directory it
# was holding is then left behind for good: nothing else knows where it is, and
# the next helper's createDirectory over it fails silently.
HELPER_STOP_WAIT=$(( SERVER_STOP_WAIT * 2 + 15 ))

stop_helper() {
  local pid deadline
  # No helper, or a pid file left behind by one that was killed and whose pid
  # now belongs to something else entirely (see helper_is_running): drop the
  # stale file and signal nothing.
  pid="$(helper_pid)" || { rm -f "$HELPER_PID_FILE"; return 1; }
  # SIGTERM, not SIGKILL: the helper's own handler stops the server, removes
  # its status lock directory and hides its icon before exiting.
  kill -TERM "$pid" 2>/dev/null || true
  deadline=$(( $(date +%s) + HELPER_STOP_WAIT ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then
    # Wedged well past a whole stop_server: nothing it was going to clean up
    # has been cleaned up, and nothing ever will be. When this call was told
    # the status path, release the lock directory on its behalf -- rmdir, not
    # rm -rf, so it can only ever remove the empty directory a lock is.
    #
    # Say so in the log first. This line is the only outward difference between
    # the two ways stop_helper can finish, because the cleanup below runs the
    # same either way: a helper that shut itself down gracefully and a helper
    # that had to be killed both end with no lock directory and no pid file.
    # Reaching here is always abnormal -- either the helper really is stuck, or
    # HELPER_STOP_WAIT above has been set too short for the shutdown it covers
    # -- so it must leave a trace rather than looking like an ordinary stop.
    note "the menu-bar helper (pid $pid) did not exit within ${HELPER_STOP_WAIT}s of SIGTERM -- killing it, and releasing its status lock on its behalf"
    kill -KILL "$pid" 2>/dev/null || true
    [ -n "$STATUS_PATH" ] && rmdir "$STATUS_PATH.lock.d" 2>/dev/null || true
  fi
  rm -f "$HELPER_PID_FILE"
  return 0
}

# --- opening things --------------------------------------------------------
# Both of the menu's "open something" actions go through here, so there is one
# place to override in tests (GRANTED_OPEN_CMD, a stand-in that just records
# what it was asked to open — the counterpart of the Windows tests'
# GRANTED_APP_BROWSER) and one place where "its own window" is decided.
#
# In its own window or a browser tab, as the user prefers (open-granted.sh
# does the deciding, the browser-finding and the launching); a plain browser
# tab if that script is missing or fails. Exactly the shape of the Windows
# tray's Open-Granted.
#
# open-granted.sh exits non-zero only when it opened nothing at all, so the
# fallback below can never open Granted a second time on top of an app window
# it did start.
open_granted() {
  if [ -f "$OPEN_SCRIPT" ]; then
    if /bin/bash "$OPEN_SCRIPT" --url "$URL" >/dev/null 2>&1; then return 0; fi
  fi
  "${GRANTED_OPEN_CMD:-open}" "$URL" >/dev/null 2>&1 || true
}

# The saved preference, and saving it — the menu-bar helper's "Open in its own
# window" tick, which is the counterpart of the Windows tray asking
# open-granted.ps1 with -GetOpenIn/-SetOpenIn. Routed through this script
# because the helper is given only GRANTED_TRAY_SCRIPT, not the scripts
# folder, and so that every settings write still goes through the one place
# that owns the preference.
#
# With no open-granted.sh (an install too old to have it), reading reports the
# default and saving fails — the helper puts its tick back and says so, the
# same as when the write itself fails.
open_in_pref() {
  if [ -f "$OPEN_SCRIPT" ]; then
    /bin/bash "$OPEN_SCRIPT" --get-open-in && return 0
  fi
  printf '{"openIn":"window"}\n'
}

set_open_in() {
  case "$1" in
    window|browser) ;;
    *) printf 'granted-tray.sh: set-open-in needs --mode window or --mode browser\n' >&2; return 64 ;;
  esac
  [ -f "$OPEN_SCRIPT" ] || { printf 'granted-tray.sh: no %s in this install\n' "$OPEN_SCRIPT" >&2; return 1; }
  /bin/bash "$OPEN_SCRIPT" --set-open-in "$1"
}

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
    # The helper first, and it is the one that actually stops the server: a
    # live helper answers SIGTERM by running this script's own `stop
    # --server-only`, and asking it to go first means it never reports the
    # shutdown it was told to perform as a crash. stop_helper waits for all of
    # that to finish, so the stop_server below is a backstop for the cases the
    # helper didn't cover (no helper running, or one that had to be killed) and
    # normally finds the agent already gone and the port already free.
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
  open-in) open_in_pref ;;
  set-open-in) set_open_in "$MODE" ;;
  show-log) show_log ;;
  log-path) printf '%s\n' "$LOG_FILE" ;;
  plist) emit_plist ;;
  plist-path) printf '%s\n' "$PLIST_PATH" ;;
  build-helper) build_helper && printf '\n' ;;
  helper-path) helper_path && printf '\n' ;;
  *)
    printf 'usage: granted-tray.sh {start|stop|restart|status|open|open-in|set-open-in|show-log|log-path|plist|plist-path|build-helper|helper-path} [--port N]\n' >&2
    exit 64
    ;;
esac
