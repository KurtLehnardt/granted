#!/usr/bin/env bash
# Granted -- update this install to a release, then start Granted again (macOS).
#
# The macOS counterpart of scripts/windows/update.ps1, with the same steps in
# the same order, the same refusals and the same status file. Started by the app
# itself (Settings -> About Granted -> Check for updates -> Update now, or
# automatic updates; see scaffold/lib/appUpdate/install.ts startUpdater):
#
#   /bin/bash update.sh --ref v1.2.3 --port 3000
#
# It runs that release's own install-macos.sh with GRANTED_REF set -- the same
# update path as re-running a newer installer: it stops Granted (the menu-bar
# helper and the server under its LaunchAgent, which is why this cannot run
# inside that server), moves this install to the release (never backwards,
# never over local changes, never someone's own checkout), runs npm ci -- and
# if that fails half-way, puts the previous version back. Then it starts
# Granted in the background again, on the same port, and the open page reloads
# once the new version answers.
#
# Progress and the outcome go to update-status.json next to the settings file
#   ~/Library/Application Support/Granted/update-status.json
# which is the file scaffold/lib/appUpdate/install.ts readUpdateStatus() already
# reads and the page already polls -- the same {state,from,to,message,at} shape
# update.ps1 writes, deliberately not a new protocol. The install's own output
# goes to ~/Library/Logs/Granted/update.log.
#
# WHO MAKES THIS DETACHED. The script is started in its own session, with no
# inherited stdio and a working directory outside the install, by the app's
# startUpdater -- exactly as uninstall.sh is started by startUninstaller, and
# exactly as update.ps1 is launched through Start-Process on Windows rather
# than detaching itself. That is what lets it outlive the server it is about to
# stop. SIGHUP is ignored here as well, so a copy run by hand from a Terminal
# window that is then closed still finishes.
#
# WHY IT RE-RUNS ITSELF FROM A COPY. This script lives inside the very folder
# it is about to `git checkout` to another release, and bash does not read a
# script into memory up front: it reads as it goes, seeking back to where it
# left off. Both halves of that were measured here rather than assumed, and the
# answer is worth writing down exactly:
#
#   * A script whose file is REWRITTEN IN PLACE underneath a running bash does
#     break, and spectacularly -- bash reads the new bytes at its old offset and
#     reports a syntax error partway through ("unexpected EOF while looking for
#     matching quote"), having already run half the script.
#   * `git checkout` does not rewrite in place: it unlinks the old file and
#     creates a new one (verified -- the inode number changes), so a bash that
#     still holds the old descriptor goes on reading the old, complete file.
#
# So the hazard is real and this particular trigger happens to miss it, by a
# detail of how git writes working-tree files that nothing here controls or is
# promised. One `cp` removes the dependency on that detail: the first thing this
# does is copy itself to the temporary folder and hand over to that copy, which
# is outside every folder the update touches. The copy removes itself when it
# exits. (PowerShell parses the whole file up front, which is why update.ps1
# needs none of this.)
#
# Options:
#   --ref vX.Y.Z      the release to update to (required)
#   --port N          the port Granted was serving on, and is started on again
#                     (default: $GRANTED_PORT, else 3000)
#   --install-dir DIR the install to update (default: the one this script is in)
#   --no-restart      don't start Granted again afterwards (tests)
#
# Test-only overrides, so nothing here ever touches a real install:
#   GRANTED_SETTINGS_PATH   the settings file (its folder holds update-status.json)
#   GRANTED_LOG_DIR         the log folder
#   GRANTED_INSTALL_SCRIPT  a local install-macos.sh instead of downloading the
#                           release's own
#   GRANTED_REPO_URL        passed on to it (a local stand-in repo)
#   GRANTED_NPM             the npm binary a rollback reinstalls with
#   plus everything granted-tray.sh itself honours (GRANTED_LAUNCH_LABEL,
#   GRANTED_LAUNCH_AGENTS_DIR, GRANTED_MENUBAR_HELPER, ...), which this script
#   passes through by calling that script rather than reimplementing it.
set -euo pipefail
# errtrace, as install-macos.sh and uninstall.sh both set it and for the same
# reason: bash does not run an ERR trap for a command that fails inside a shell
# function unless this is on, and an unreported failure here leaves the status
# file stuck on "running" with nothing to show the user.
set -o errtrace
# Ignored, not handled: there is nothing to clean up on a hangup that the EXIT
# trap below does not already do, and an update that stops half-way because a
# Terminal window closed is the one outcome this script exists to avoid.
trap '' HUP

# Absolute, because a relative $0 stops meaning anything the moment the working
# directory changes (and the caller's is "/").
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SELF="$SELF_DIR/$(basename -- "${BASH_SOURCE[0]}")"

# The install this script sits in: scripts/macos/../../.. -- worked out from
# the ORIGINAL location and passed on, because the copy that does the work does
# not sit in the install at all.
if [ -z "${GRANTED_UPDATE_DEFAULT_DIR:-}" ]; then
  GRANTED_UPDATE_DEFAULT_DIR="$(cd -- "$SELF_DIR/../../.." && pwd -P)"
  export GRANTED_UPDATE_DEFAULT_DIR
fi

# Hand over to a copy outside the install folder (see the header). A copy that
# cannot be made is not fatal: carrying on in place is what every version
# before this did, and it is still better than refusing to update at all.
if [ "${GRANTED_UPDATE_REEXEC:-}" != "1" ]; then
  SELF_COPY="$(mktemp "${TMPDIR:-/tmp}/granted-update.XXXXXX" 2>/dev/null)" || SELF_COPY=""
  if [ -n "$SELF_COPY" ] && cp -- "$SELF" "$SELF_COPY" 2>/dev/null; then
    export GRANTED_UPDATE_REEXEC=1
    export GRANTED_UPDATE_SELF_COPY="$SELF_COPY"
    exec /bin/bash "$SELF_COPY" "$@"
  fi
  [ -n "$SELF_COPY" ] && rm -f -- "$SELF_COPY" 2>/dev/null || true
fi

TEMP_INSTALL_SCRIPT=""
TEMP_STATUS_FILE=""
# Everything this run made outside the install: the downloaded install script,
# the install script's own status file and the lock directory beside it, and the
# copy of this script that is running. Unlinking that copy while bash is still
# reading it is safe -- the open descriptor keeps the inode alive until this
# process ends, which is the same guarantee the copy was made for.
#
# Installed HERE, before the arguments are read, rather than further down with
# the rest of the setup: the bad-input exits below would otherwise leave that
# copy of this script behind in the temporary folder every time.
cleanup() {
  [ -n "$TEMP_INSTALL_SCRIPT" ] && rm -f -- "$TEMP_INSTALL_SCRIPT" 2>/dev/null || true
  if [ -n "$TEMP_STATUS_FILE" ]; then
    rm -f -- "$TEMP_STATUS_FILE" 2>/dev/null || true
    rmdir -- "$TEMP_STATUS_FILE.lock.d" 2>/dev/null || true
  fi
  [ -n "${GRANTED_UPDATE_SELF_COPY:-}" ] && rm -f -- "$GRANTED_UPDATE_SELF_COPY" 2>/dev/null || true
  return 0
}
trap cleanup EXIT

REF=""
PORT="${GRANTED_PORT:-3000}"
INSTALL_DIR=""
NO_RESTART=0

# An option that takes a value must actually have been given one, and must say
# so when it wasn't -- the same guard, for the same reason, as granted-tray.sh's
# and uninstall.sh's: with `set -u` a bare `--ref` at the end of the line dies
# on `$2: unbound variable`, which exits 1 with a raw shell diagnostic instead
# of this script's own message and its own exit 64 for bad input.
need_value() {
  [ "$1" -ge 2 ] && return 0
  printf 'update.sh: %s needs a value\n' "$2" >&2
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) need_value "$#" --ref; REF="$2"; shift 2 ;;
    --port) need_value "$#" --port; PORT="$2"; shift 2 ;;
    --install-dir) need_value "$#" --install-dir; INSTALL_DIR="$2"; shift 2 ;;
    --no-restart) NO_RESTART=1; shift ;;
    *) printf 'update.sh: unknown option %s\n' "$1" >&2; exit 64 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) printf 'update.sh: --port must be a number (got %s)\n' "$PORT" >&2; exit 64 ;;
esac

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$GRANTED_UPDATE_DEFAULT_DIR"
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
while [ "${INSTALL_DIR%/}" != "$INSTALL_DIR" ]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="/"

SCAFFOLD_DIR="$INSTALL_DIR/scaffold"
TRAY_SCRIPT="$SCAFFOLD_DIR/scripts/macos/granted-tray.sh"
MARKER="$INSTALL_DIR/.git/granted-installer"
PARENT_DIR="$(dirname -- "$INSTALL_DIR")"
INSTALL_NAME="$(basename -- "$INSTALL_DIR")"

SETTINGS_PATH="${GRANTED_SETTINGS_PATH:-$HOME/Library/Application Support/Granted/settings.json}"
SUPPORT_DIR="$(dirname -- "$SETTINGS_PATH")"
STATUS_FILE="$SUPPORT_DIR/update-status.json"
LOG_DIR="${GRANTED_LOG_DIR:-$HOME/Library/Logs/Granted}"
LOG_FILE="$LOG_DIR/update.log"

NPM_BIN="${GRANTED_NPM:-$(command -v npm 2>/dev/null || true)}"
NODE_BIN="$(command -v node 2>/dev/null || true)"

# --- the status file -------------------------------------------------------
# A JSON string: backslashes and quotes escaped, and line breaks turned into
# spaces. The whole status file is one JSON object on one line, and a raw
# newline inside a string is not valid JSON -- it would make readUpdateStatus()
# read the file as nothing at all, so the page would show no reason and wait out
# its own timeout instead. The message can carry a shell command
# ($BASH_COMMAND, in the ERR trap below), which is not always one line.
json_string() {
  printf '"%s"' "$(printf '%s' "$1" | tr '\n\r' '  ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# An ISO-8601 instant WITH MILLISECONDS, which matters rather than being
# decorative: components/useAppUpdate.ts ignores any status whose `at` is older
# than the moment the server started this attempt, so a timestamp truncated to
# the second can be read as belonging to an earlier attempt and the real error
# then goes unreported until the page's own fifteen-minute timeout. BSD date
# has no sub-second format, so node (which this install is running on anyway)
# provides it; the fallback biases to the end of the second for the same
# reason, rather than to its start.
iso_now() {
  local t=""
  if [ -n "$NODE_BIN" ]; then
    t="$("$NODE_BIN" -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)"
  fi
  [ -n "$t" ] || t="$(date -u +%Y-%m-%dT%H:%M:%S.999Z)"
  printf '%s' "$t"
}

# This install's version, read the way install-macos.sh reads it: resolved to
# an absolute path and passed through argv, never spliced into JS source. The
# sed fallback is for a machine where node has gone missing mid-update (the new
# release's npm ci is what would notice first); the root "version" is the first
# one in a package.json.
installed_version() {
  local v=""
  [ -f "$SCAFFOLD_DIR/package.json" ] || return 0
  if [ -n "$NODE_BIN" ]; then
    v="$("$NODE_BIN" -e 'process.stdout.write(String(require(process.argv[1]).version || ""))' "$SCAFFOLD_DIR/package.json" 2>/dev/null || true)"
  fi
  if [ -z "$v" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCAFFOLD_DIR/package.json" 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$v"
}

FROM="$(installed_version)"

write_update_status() {
  local state="$1" message="$2" tmp from to
  mkdir -p -- "$SUPPORT_DIR" 2>/dev/null || true
  tmp="$(mktemp "${STATUS_FILE}.XXXXXX" 2>/dev/null)" || return 0
  from="null"; [ -n "$FROM" ] && from="$(json_string "$FROM")"
  to="null"; [ -n "$REF" ] && to="$(json_string "$REF")"
  if printf '{"state":"%s","from":%s,"to":%s,"message":%s,"at":"%s"}' \
      "$state" "$from" "$to" \
      "$([ -n "$message" ] && json_string "$message" || printf 'null')" \
      "$(iso_now)" > "$tmp" 2>/dev/null; then
    mv -f -- "$tmp" "$STATUS_FILE" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
  else
    rm -f -- "$tmp" 2>/dev/null
  fi
  return 0
}

# --- starting Granted again ------------------------------------------------
# Whatever happened. An update that failed half-way still leaves the previous
# version runnable (that is what the rollback below is for), and the app then
# shows what went wrong -- which it can only do with a server to ask.
#
# Through granted-tray.sh, which owns the LaunchAgent and the menu-bar helper,
# and through the copy in the install as it is NOW: after a successful update
# that is the new release's own script. GRANTED_STATUS_FILE is cleared for it
# on purpose -- that variable means the INSTALLER's progress file, and a tray
# that inherited the one this script hands to install-macos.sh below would
# report a finished install over it.
start_granted() {
  [ "$NO_RESTART" = "1" ] && return 0
  [ -f "$TRAY_SCRIPT" ] || return 0
  ( unset GRANTED_STATUS_FILE; /bin/bash "$TRAY_SCRIPT" start --port "$PORT" ) >> "$LOG_FILE" 2>&1 </dev/null || true
  return 0
}

# Anything unexpected: say so, put Granted back up, and stop. This runs with no
# terminal at all, so an error that was only printed would look like nothing
# happened. An explicit `exit` does not re-trigger this (bash runs an ERR trap
# only for a command whose own non-zero status would trip `set -e`), so none of
# the refusals below are reported twice.
on_error() {
  local line="$1" command="$2"
  write_update_status "error" "The update didn't finish: update.sh failed at line $line: $command"
  printf 'update.sh: failed at line %s: %s\n' "$line" "$command" >&2
  start_granted
  exit 1
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# --- the release asked for -------------------------------------------------
# Only a release tag, checked before anything else: this value is handed to git
# and to a URL. bash's own `=~`, as install-macos.sh uses for the same check,
# and never a `printf | grep -q` pipeline: `grep -q` exits the moment it
# matches, which can SIGPIPE the printf feeding it, and under `set -o pipefail`
# that failure becomes the pipeline's status -- so a perfectly good release tag
# would be rejected at random.
if [[ ! "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  write_update_status "error" "The update didn't finish: --ref must be a release tag like v1.2.3 (got '$REF')."
  printf 'update.sh: --ref must be a release tag like v1.2.3 (got %s)\n' "'$REF'" >&2
  start_granted
  exit 1
fi

write_update_status "running" ""

# --- what the install script would decline anyway --------------------------
# Checked BEFORE Granted is stopped, so a declined update doesn't shut Granted
# down and reinstall it for nothing (and, with automatic updates on, every few
# hours). Both of these are install-macos.sh's own rules, restated here only to
# decide them early; the script itself still enforces them.
if [ ! -f "$MARKER" ]; then
  write_update_status "error" "Granted wasn't updated to $REF: this folder wasn't installed by the Granted installer."
  exit 0
fi
if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]; then
  write_update_status "error" "Granted wasn't updated to $REF: it has local changes in $INSTALL_DIR."
  exit 0
fi

# Where to go back to if the update fails half-way.
PREV_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"

# --- the release's own install script --------------------------------------
INSTALL_SCRIPT="${GRANTED_INSTALL_SCRIPT:-}"
if [ -z "$INSTALL_SCRIPT" ]; then
  TEMP_INSTALL_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/granted-install-macos.XXXXXX")"
  if ! curl -fsSL -o "$TEMP_INSTALL_SCRIPT" "https://raw.githubusercontent.com/KurtLehnardt/granted/$REF/install-macos.sh"; then
    write_update_status "error" "The update to $REF didn't finish: Granted's installer for that release couldn't be downloaded -- check your network connection and try again."
    start_granted
    exit 1
  fi
  INSTALL_SCRIPT="$TEMP_INSTALL_SCRIPT"
fi

# A fresh log for this run, with the last one kept beside it: the declined
# reason below is read back out of this file, and a previous run's warning must
# never be mistaken for this one's.
mkdir -p -- "$LOG_DIR" 2>/dev/null || true
[ -f "$LOG_FILE" ] && mv -f -- "$LOG_FILE" "$LOG_FILE.previous" 2>/dev/null || true
: > "$LOG_FILE" 2>/dev/null || true

# --- stop Granted ----------------------------------------------------------
# The menu-bar helper and the server under its LaunchAgent, through the one
# script that owns all of that -- never reimplemented here. A non-zero exit
# means there was nothing running, which is not a failure.
if [ -f "$TRAY_SCRIPT" ]; then
  ( unset GRANTED_STATUS_FILE; /bin/bash "$TRAY_SCRIPT" stop --port "$PORT" ) >> "$LOG_FILE" 2>&1 || true
fi

# --- run it ----------------------------------------------------------------
# In its own process, from the install's parent folder (it installs into
# ./<GRANTED_INSTALL_DIR>), reporting into its own status file -- never this
# script's, which belongs to the update as a whole.
TEMP_STATUS_FILE="$(mktemp "${TMPDIR:-/tmp}/granted-update-status.XXXXXX")"
# `|| INSTALL_CODE=$?`, not `set +e` around it: the ERR trap above fires on a
# failing command whether or not errexit is on (errexit and errtrace govern
# exiting and inheritance, not the trap), so a non-zero install would be
# reported by on_error as an internal failure instead of being handled here.
# The left-hand side of a `||` is the one thing that trap is documented to skip.
INSTALL_CODE=0
(
  cd -- "$PARENT_DIR" || exit 1
  GRANTED_REF="$REF" \
  GRANTED_INSTALL_DIR="$INSTALL_NAME" \
  GRANTED_STATUS_FILE="$TEMP_STATUS_FILE" \
  GRANTED_PORT="$PORT" \
    /bin/bash "$INSTALL_SCRIPT"
) >> "$LOG_FILE" 2>&1 || INSTALL_CODE=$?

# One field out of the install script's own {state,message,pid} status file.
status_field() {
  local key="$1" v=""
  [ -f "$TEMP_STATUS_FILE" ] || return 0
  if [ -n "$NODE_BIN" ]; then
    v="$("$NODE_BIN" -e '
      const fs = require("node:fs");
      try {
        const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const value = o[process.argv[2]];
        if (value !== undefined && value !== null) process.stdout.write(String(value));
      } catch { /* nothing readable: nothing to report */ }
    ' "$TEMP_STATUS_FILE" "$key" 2>/dev/null || true)"
  fi
  if [ -z "$v" ]; then
    v="$(sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$TEMP_STATUS_FILE" 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$v"
}

# Why install-macos.sh declined to switch this folder over, in its own words.
#
# Its warn() prints "  ! <message>" wrapped in SGR colour escapes, which are
# stripped here: this string is shown in a browser page, which would render
# them as mojibake rather than as colour.
#
# Its decline always says "Not changing <dir> to <ref> -- ...", and that line,
# and ONLY that line, is what is looked for -- never simply the last warning in
# the log. The install script carries on past a decline -- npm ci, the built-in
# model, the Ollama check -- and those later steps warn too (no Homebrew, no
# Ollama), so on a machine missing either of those the last warning in the file
# is about Ollama and has nothing to do with why the update didn't happen.
# update.ps1 takes the last one, and is wrong the same way.
#
# There is deliberately NO fallback to the last warning when there is no "Not
# changing" line, because that is a reachable state rather than a theoretical
# one: install-macos.sh also leaves the folder alone with an ok() -- "already
# includes Granted <ref> -- nothing to update", when the installed HEAD already
# contains the tag -- and the installed version can still differ from the ref
# then. A fallback would quote the Ollama warning as the reason Granted wasn't
# updated, which is not a reason at all. The caller says "Granted wasn't updated
# to <ref>." with no reason when this comes back empty, and no stated reason is
# strictly better than a wrong one.
last_warning() {
  local plain warning
  [ -f "$LOG_FILE" ] || return 0
  plain="$(sed "s/$(printf '\033')\[[0-9;]*m//g" "$LOG_FILE" 2>/dev/null || true)"
  warning="$(printf '%s\n' "$plain" | grep -E '^  ! Not changing ' | tail -1 || true)"
  printf '%s' "${warning#  ! }"
}

INSTALL_STATE="$(status_field state)"
INSTALL_MESSAGE="$(status_field message)"
TO="$(installed_version)"

if [ "$INSTALL_CODE" = "0" ] && [ "$INSTALL_STATE" = "done" ]; then
  if [ -n "$TO" ] && [ "v$TO" != "$REF" ]; then
    # The install script declined to switch (local changes made since, already
    # newer, not made by the installer): say why, in its own words.
    WHY="$(last_warning)"
    if [ -n "$WHY" ]; then
      write_update_status "error" "Granted wasn't updated to $REF: $WHY"
    else
      write_update_status "error" "Granted wasn't updated to $REF."
    fi
  else
    write_update_status "done" ""
  fi
else
  MSG="$INSTALL_MESSAGE"
  [ -n "$MSG" ] || MSG="the install step failed (exit code $INSTALL_CODE)."
  # Failed half-way (say npm ci, after the switch to the new release): put the
  # previous version back, so Granted still starts and can say what happened.
  RESTORED=""
  NOW_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$PREV_HEAD" ] && [ -n "$NOW_HEAD" ] && [ "$NOW_HEAD" != "$PREV_HEAD" ]; then
    if git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout --quiet "$PREV_HEAD" >> "$LOG_FILE" 2>&1; then
      if [ -n "$NPM_BIN" ] && ( cd -- "$SCAFFOLD_DIR" && "$NPM_BIN" ci --no-audit --no-fund ) >> "$LOG_FILE.restore" 2>&1; then
        # Only once the restore's own npm ci succeeded: a half-restored install
        # is not a version that was "put back".
        RESTORED=" Granted v$FROM was put back."
      fi
    fi
  fi
  case "$MSG" in
    *.|*!|*\?) ;;
    *) MSG="$MSG." ;;
  esac
  write_update_status "error" "The update to $REF didn't finish: $MSG$RESTORED Details are in $LOG_FILE."
fi

# The status file is written before Granted is started again, so the page has
# something to read the moment the server answers. The temporary files go in the
# EXIT trap, after this returns.
start_granted
