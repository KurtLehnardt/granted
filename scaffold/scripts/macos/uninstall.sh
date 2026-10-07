#!/usr/bin/env bash
# Granted -- uninstall Granted on macOS.
#
# The macOS counterpart of scripts/windows/uninstall.ps1, with the same safety
# rules, the same exit codes and the same one-JSON-line output. Windows has an
# "Installed apps" list to be registered in and to be run from; macOS has no
# such list, so this script has no -Register half at all. It is reached instead
# from the two places the work order names: the menu-bar icon's "Uninstall
# Granted..." item (which runs it through `granted-tray.sh uninstall`) and
# Settings -> About Granted in the app itself (which runs it with --quiet,
# having done its own asking in the page).
#
#   uninstall.sh                     uninstall, asking first
#   uninstall.sh --confirmed         uninstall; the first "are you sure?" was
#                                    already answered elsewhere (the menu-bar
#                                    item's alert), so only the unsaved-work
#                                    question is still asked
#   uninstall.sh --quiet             uninstall without asking anything
#   uninstall.sh --quiet --force     ...including when there is unsaved work
#   uninstall.sh --check             report what an uninstall would find and
#                                    change nothing at all
#
# Other options: --install-dir DIR (default: the install this script sits in),
# --backup-dir DIR (which must be outside the install folder), --keep-keys /
# --no-keep-keys, --port N.
#
# What it does, in this order:
#
#   - refuses a folder that isn't a Granted install, a folder that is a symlink
#     to one, and -- the check this whole macOS arc has used for "did our
#     installer make this?" -- a folder with no .git/granted-installer marker,
#     which is how someone's own checkout is never deleted (the same marker
#     install-macos.sh writes and scaffold/lib/appUpdate/install.ts reads);
#   - asks first; then, if the folder holds work that isn't on GitHub
#     (uncommitted changes, unpushed commits, stashes), asks again -- --quiet
#     refuses that case outright unless --force is given;
#   - offers to keep a copy of your API keys and settings (scaffold/.env.local,
#     scaffold/data/local/llm-config.json) outside the folder, in your
#     Documents folder. Unlike the Windows script's opt-in -KeepKeys this
#     defaults to YES, including under --quiet: keeping a copy is the
#     non-destructive choice, and the work order for this item asks for it.
#     --keep-keys and --no-keep-keys decide it outright wherever either is
#     given, --quiet or not, and the question is then not asked at all; the
#     dialog decides only an interactive run that was given neither;
#   - quits Granted: the menu-bar helper and the server under its LaunchAgent
#     (through granted-tray.sh stop, so none of that logic lives twice), then
#     any node/npm still running from inside the folder (a `npm run dev` left
#     in a terminal), matched the way install-macos.sh's matching_pids matches
#     and never on the path alone;
#   - moves the folder aside, then deletes it;
#   - removes the LaunchAgent plist, the ~/Applications/Granted.app launcher
#     and its Dock entry -- each only when it belongs to THIS install -- and
#     the shared settings and logs folders;
#   - prints one JSON line saying what it did.
#
# Git, Node and Homebrew are left alone: other programs use them.
#
# A FOLDER ALREADY DELETED BY HAND is not a refusal. uninstall.ps1 treats that
# case as removed (exit 0, alreadyGone), tidying up what the install left
# elsewhere, and this does the same: the LaunchAgent plist, the launcher, its
# Dock tile and the shared settings and logs are all still there otherwise, and
# nothing would ever clean them up -- the two ways in (the menu-bar icon and
# the app's own Settings) went with the folder. ONE rule here is deliberately
# stricter than the Windows script's. There is no marker left to read and no
# Installed-apps list to count, so the shared settings and logs are deleted in
# that case only when a LaunchAgent plist or an ~/Applications launcher naming
# THIS exact folder is found -- the only evidence available that the path given
# ever was a Granted install. Without it, `--install-dir /a/typo` would delete
# a real install's settings while reporting success.
#
# WHY THE FOLDER IS MOVED ASIDE FIRST, and what that does and does not buy on
# macOS. The Windows script moves the folder before deleting anything because
# Windows refuses to move or delete a folder while a program holds a file in it
# open, so the move is a single all-or-nothing step: it fails with nothing
# deleted, and the install is never left half-removed. The same ordering is
# kept here, and it keeps the same all-or-nothing property -- rename(2) is
# atomic, so either the whole install has moved or nothing has changed -- but
# it must be said plainly that it does NOT fail for a file in use, because
# POSIX has no such rule: a rename succeeds while another process holds a file
# inside open, and the delete that follows succeeds too (the file goes on
# existing for that process alone, under no name, until it closes it). What
# still makes the move fail here, with nothing deleted, is a parent folder this
# account cannot write to, a cross-device move, or a folder that is a mount
# point -- and those are exactly the cases where a delete-in-place would
# otherwise stop halfway.
#
# A SIBLING FOLDER, NOT THE TRASH. The folder is moved to a sibling
# "<install>.uninstalling-<random>" and then deleted, rather than being put in
# the user's Trash. Two reasons. Moving a file to the Trash from a script means
# asking Finder to do it through AppleScript, which needs Automation permission
# for Finder: on current macOS that shows a system prompt the user has to
# accept (and which a GUI-less run cannot answer at all), and a refusal would
# leave the install sitting there. And a Granted install is a git clone with
# node_modules in it -- gigabytes, which the user would then have to empty by
# hand. The script that put the files there deletes them again.
#
# Test-only overrides, so nothing here ever touches a real install:
#   GRANTED_LAUNCH_LABEL       the LaunchAgent label
#   GRANTED_LAUNCH_AGENTS_DIR  where its plist lives
#   GRANTED_LOG_DIR            the log folder
#   GRANTED_SETTINGS_PATH      the settings file (its folder is the shared one)
#   GRANTED_APPLICATIONS_DIR   where the launcher lives (never ~/Applications)
#   GRANTED_UNINSTALL_ASK_CMD  what asks the user: "yes" or "no" to answer
#                              without a dialog, or a command run with the
#                              question as its argument (exit 0 = yes). An
#                              osascript dialog would block a test run forever.
#   GRANTED_UNINSTALL_BACKUP_DIR  where a kept copy of the keys goes, instead
#                              of the user's real Documents folder
#   plus everything granted-tray.sh and applications-launcher.sh themselves
#   honour (GRANTED_DOCK_DOMAIN, GRANTED_DOCK_RELOAD_CMD, ...), which this
#   script passes through by calling those scripts rather than reimplementing
#   them.
#
# Exit codes, matching uninstall.ps1's: 0 removed (or --check, or a folder that
# was already deleted by hand), 1 cancelled or an unexpected error, 2 refused
# (not a Granted install, not made by the installer, a symlink), 3 the folder
# could not be moved aside so nothing was deleted, 4 unsaved work under --quiet
# without --force, 64 bad input (an unknown option, an option given no value, a
# --port that isn't a number, a --backup-dir inside the install folder). Every
# one of those prints its JSON line too ({"removed":false,"reason":"bad-input"})
# and not only a message on stderr -- the app's own uninstall --check already
# fails identically on bad input (so its panel never gets far enough to render
# a started/waiting state over this), but the menu-bar helper and a
# hand-run CLI invocation both go straight to a real run and have no
# equivalent --check step first, so this is what lets THEM report the real
# reason instead of just a nonzero exit.
set -euo pipefail
# errtrace, exactly as install-macos.sh sets it and for the same reason: bash
# does NOT run an ERR trap for a command that fails inside a shell function
# unless this is on, so without it a failure in (say) the copy of the API keys
# would unwind out of this script silently, printing no JSON line at all and
# leaving the caller with nothing to report.
set -o errtrace

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_INSTALL_DIR="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"

# --- output ----------------------------------------------------------------
# Defined up here, before the arguments are read, so that the bad-input
# refusals below can print a JSON line too. Every caller of this script
# (the app, the menu-bar helper, a hand-run CLI invocation) learns what
# happened by reading the one JSON line written to a log file
# (lib/appUpdate/install.ts, parseUninstallOutcome); an exit that printed
# only to stderr is an exit none of them could parse an answer for. The app
# itself is shielded from ever hitting these specific paths, since its own
# uninstall --check fails on the same bad input before a real run ever
# starts -- but the menu-bar helper and a direct CLI run have no such
# --check step first, so for them this is the only way to report the real
# reason instead of a bare nonzero exit. Two of these are reachable without
# a single typed argument -- GRANTED_UNINSTALL_BACKUP_DIR pointed inside the
# install folder (or, now, the shared settings/log folders), and a
# GRANTED_PORT that isn't a number.
json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# A JSON list of the strings given, or [].
json_list() {
  local first=1 item
  printf '['
  for item in "$@"; do
    [ "$first" = "1" ] || printf ','
    first=0
    json_string "$item"
  done
  printf ']'
}

# An argument or an environment variable this script cannot work with: say so
# on stderr for whoever typed it, say the same thing in JSON for whatever
# started it, and exit 64 having touched nothing.
bad_input() {
  printf 'uninstall.sh: %s\n' "$1" >&2
  printf '{"removed":false,"reason":"bad-input","detail":%s}\n' "$(json_string "$1")"
  exit 64
}

INSTALL_DIR=""
QUIET=0
FORCE=0
CONFIRMED=0
CHECK=0
KEEP_KEYS=1
# Whether --keep-keys or --no-keep-keys was given at all, kept separately from
# the value the way applications-launcher.sh keeps PORT_GIVEN beside PORT: an
# explicit choice has to be distinguishable from this default, or an
# interactive run cannot tell "keep them, because nobody said otherwise" from
# "keep them, because the caller said so" -- and it would then put the
# interactive dialog's answer over the caller's explicit flag. The keys are
# secrets, and --no-keep-keys means do not write them anywhere.
KEEP_KEYS_GIVEN=0
BACKUP_DIR=""
PORT="${GRANTED_PORT:-3000}"

# An option that takes a value must actually have been given one, and must say
# so when it wasn't -- the same guard, for the same reason, as
# granted-tray.sh's and applications-launcher.sh's: with `set -u` a bare
# `--port` at the end of the line dies on `$2: unbound variable`, which exits 1
# with a raw shell diagnostic instead of this script's own message and its own
# exit 64 for bad input. Exit 1 means something else entirely here: it is what
# a cancelled uninstall reports.
need_value() {
  [ "$1" -ge 2 ] && return 0
  bad_input "$2 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) need_value "$#" --install-dir; INSTALL_DIR="$2"; shift 2 ;;
    --backup-dir) need_value "$#" --backup-dir; BACKUP_DIR="$2"; shift 2 ;;
    --port) need_value "$#" --port; PORT="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    --force) FORCE=1; shift ;;
    --confirmed) CONFIRMED=1; shift ;;
    --check) CHECK=1; shift ;;
    --keep-keys) KEEP_KEYS=1; KEEP_KEYS_GIVEN=1; shift ;;
    --no-keep-keys) KEEP_KEYS=0; KEEP_KEYS_GIVEN=1; shift ;;
    *) bad_input "unknown option $1" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) bad_input "--port must be a number (got $PORT)" ;;
esac

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$DEFAULT_INSTALL_DIR"
# Absolute, with no trailing slash, and WITHOUT resolving symlinks: a folder
# that is a symlink to a Granted install must be reported as the link it is
# (see is_a_link below), never followed and then deleted at the other end.
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
while [ "${INSTALL_DIR%/}" != "$INSTALL_DIR" ]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
# Stripping the trailing slashes off "/" leaves nothing at all; keep it as the
# root, which the protected-folder check below then refuses by name.
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="/"

SCAFFOLD_DIR="$INSTALL_DIR/scaffold"
MACOS_DIR="$SCAFFOLD_DIR/scripts/macos"
TRAY_SCRIPT="$MACOS_DIR/granted-tray.sh"
MARKER="$INSTALL_DIR/.git/granted-installer"
KEY_FILES=("$SCAFFOLD_DIR/.env.local" "$SCAFFOLD_DIR/data/local/llm-config.json")

LABEL="${GRANTED_LAUNCH_LABEL:-com.granted.server}"
LAUNCH_AGENTS_DIR="${GRANTED_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_DIR="${GRANTED_LOG_DIR:-$HOME/Library/Logs/Granted}"
SETTINGS_PATH="${GRANTED_SETTINGS_PATH:-$HOME/Library/Application Support/Granted/settings.json}"
SUPPORT_DIR="$(dirname -- "$SETTINGS_PATH")"
APPLICATIONS_DIR="${GRANTED_APPLICATIONS_DIR:-$HOME/Applications}"
APP_PATH="$APPLICATIONS_DIR/Granted.app"
DOMAIN="gui/$(id -u)"
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="${GRANTED_UNINSTALL_BACKUP_DIR:-$HOME/Documents/Granted backup $(date '+%Y-%m-%d %H%M')}"

# The copy of the keys has to go somewhere that outlives the uninstall, so the
# finished BACKUP_DIR is made absolute and then refused if it is inside the
# folder about to be deleted.
#
# Absolute first, and against $PWD here rather than when it is used: this run
# changes its own working directory to "/" before anything is deleted (see
# `cd /` below), so a relative path kept as given would be resolved against a
# different folder than the one the caller typed it in.
#
# And then the check that matters. A backup inside the install folder is
# destroyed by the very move-and-delete it is meant to survive -- and the run
# would still exit 0, report "keptKeys" and name a path that no longer exists,
# which breaks the one promise this script makes about the keys while claiming
# to have kept it. It is bad input, and it is reported the way every other bad
# argument here is: a message on stderr, exit 64, and nothing touched.
case "$BACKUP_DIR" in
  /*) ;;
  *) BACKUP_DIR="$PWD/$BACKUP_DIR" ;;
esac
while [ "${BACKUP_DIR%/}" != "$BACKUP_DIR" ]; do BACKUP_DIR="${BACKUP_DIR%/}"; done
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="/"
# Comparing the two as text catches the literal spellings and misses every
# other NAME for the same place. On this Mac's case-insensitive APFS volume
# "<install>/keys" and "<INSTALL>/keys" are one folder with two names; a
# symlinked parent is a third name for it; a sideways ".." that climbs out of
# the install folder and straight back into it is a fourth. All three were
# reproduced against a textual check: the keys were copied in, the folder was
# destroyed by the very move-and-delete the copy was meant to survive, and the
# run still exited 0 reporting "keptKeys" at a path that no longer existed.
#
# `pwd -P` alone is not the answer either. It does resolve symlinks and
# collapse "..", but it reports a path's on-disk CAPITALISATION only when what
# it was given contained a symlink, which is what forces bash to ask getcwd(3)
# instead of tracking the path itself -- verified here, where an
# already-resolved ".../GRANTED" comes back spelled exactly that way.
#
# So the question goes to the filesystem instead. A directory has one identity,
# its device and inode numbers, however many names lead to it, and that is
# immune to spelling by construction: ".../GRANTED" and ".../granted" report
# the same pair.
BACKUP_INSIDE=0

# The real path of the nearest ancestor of $1 that exists -- the backup folder
# itself usually does not yet, and it is judged by where it would be created.
# `cd` can only enter a directory that is there, which is exactly the walk's
# stopping condition, and the path it hands back has no symlinks and no ".."
# left in it, so climbing it afterwards with `dirname` really does visit the
# parents.
existing_ancestor() {
  local path="$1"
  while [ ! -d "$path" ]; do
    case "$path" in /|.|"") return 1 ;; esac
    path="$(dirname -- "$path")"
  done
  (cd -- "$path" 2>/dev/null && pwd -P) || return 1
}

# Device and inode, of the directory itself and never of what a symlink points
# at (BSD stat is lstat unless given -L). That matters for INSTALL_DIR: a
# folder that is a symlink to a Granted install is reported as the link it is
# and never followed (see is_a_link below), so it is not going to be deleted
# and a backup inside the folder it POINTS at is not in danger. The literal
# comparison below still refuses a backup written through the link's own path.
dir_id() {
  stat -f '%d:%i' -- "$1" 2>/dev/null || true
}

# Not just INSTALL_DIR: SUPPORT_DIR and LOG_DIR are both removed by this same
# run (the last-install-out cleanup further down), so a backup placed inside
# either of those is destroyed exactly the same way a backup inside
# INSTALL_DIR would be. kept_keys_json()'s existence check at report time
# would still catch it and keep the final JSON honest either way, but
# refusing up front -- same as we already do for INSTALL_DIR -- means the
# keys are never put at risk in the first place, not just honestly reported
# as lost afterward.
BACKUP_INSIDE_WHAT=""
for protected_dir in "$INSTALL_DIR" "$SUPPORT_DIR" "$LOG_DIR"; do
  # "/" contains every path there is, and an --install-dir of "/" is refused
  # by name further down (PROTECTED_DIRS); answering it here with "your
  # backup folder is inside it" would answer a different question than the
  # one that is actually wrong.
  [ "$protected_dir" = "/" ] && continue
  if [ "$BACKUP_DIR" = "$protected_dir" ] || [ "${BACKUP_DIR#"$protected_dir"/}" != "$BACKUP_DIR" ]; then
    BACKUP_INSIDE=1
    BACKUP_INSIDE_WHAT="$protected_dir"
    break
  fi
  protected_id="$(dir_id "$protected_dir")"
  BACKUP_REAL="$(existing_ancestor "$BACKUP_DIR" || true)"
  if [ -n "$protected_id" ] && [ -n "$BACKUP_REAL" ]; then
    # From where the backup would be created, up to the root.
    probe="$BACKUP_REAL"
    while : ; do
      if [ "$(dir_id "$probe")" = "$protected_id" ]; then
        BACKUP_INSIDE=1
        BACKUP_INSIDE_WHAT="$protected_dir"
        break
      fi
      [ "$probe" = "/" ] && break
      probe="$(dirname -- "$probe")"
    done
  fi
  [ "$BACKUP_INSIDE" = "1" ] && break
done

if [ "$BACKUP_INSIDE" = "1" ]; then
  # The resolved path is named as well when it differs, because the whole
  # difficulty with these is that the path as typed does not look like it is
  # inside anything.
  if [ -n "${BACKUP_REAL:-}" ] && [ "$BACKUP_REAL" != "$BACKUP_DIR" ]; then
    bad_input "the copy of your API keys has to go outside the folder being deleted, and $BACKUP_DIR (really under $BACKUP_REAL) is inside $BACKUP_INSIDE_WHAT"
  else
    bad_input "the copy of your API keys has to go outside the folder being deleted, and $BACKUP_DIR is inside $BACKUP_INSIDE_WHAT"
  fi
fi

# Everything that could still be reported after a partial run, so the JSON line
# is filled in as the uninstall goes rather than guessed at the end.
KEPT_KEYS=""
REMOVED_LAUNCH_AGENT=false
REMOVED_LAUNCHER=false
REMOVED_FROM_DOCK=false
REMOVED_SETTINGS=false
REMOVED_LOGS=false
LEFTOVER=""

# --- output ----------------------------------------------------------------
# (json_string and json_list are defined near the top, above the argument
# parsing, so that bad input can report itself in JSON as well -- see
# bad_input.)

# Where the copy of the keys ACTUALLY is, for every JSON line that mentions it
# -- not where it was meant to go.
#
# The containment check above refuses a --backup-dir inside the install folder,
# and asks the filesystem rather than the two strings so that a symlink, a ".."
# or a different capitalisation of that folder is caught before anything is
# copied. That is still a prediction, about one folder; this is not a prediction
# at all. By the time any of these lines is printed the move and the delete have
# either happened or they have not, so the only question left worth asking is
# whether the folder named is there.
#
# Which is why this is the check that closes the question rather than a second
# opinion on the first one. The install folder is not the only thing a run
# deletes: a --backup-dir inside the SHARED settings folder is destroyed by
# this same run as the last install out, and no amount of comparing against
# the install folder would ever see that coming.
#
# `keptKeys` naming a path that does not exist is the single promise this
# script makes about the keys, broken while claiming to have kept it -- and it
# reads as success, exit 0 and all. A folder that is gone is reported as no
# copy instead, which is true, and the text below says so in words.
kept_keys_json() {
  if [ -n "$KEPT_KEYS" ] && [ -d "$KEPT_KEYS" ]; then json_string "$KEPT_KEYS"; else printf 'null'; fi
}

refused() {
  printf '{"removed":false,"reason":"%s","installDir":%s}\n' "$1" "$(json_string "$INSTALL_DIR")"
}

# Anything unexpected: say so. This can run with no terminal at all (from the
# menu-bar item, or from the app), so an error that was only printed would look
# like nothing happened. An explicit `exit` does not re-trigger this (bash runs
# an ERR trap only for a command whose own non-zero status would trip `set -e`),
# so none of the refusals below are reported twice.
on_error() {
  local line="$1" command="$2"
  printf '{"removed":false,"reason":"error","detail":%s,"installDir":%s,"keptKeys":%s}\n' \
    "$(json_string "uninstall.sh failed at line $line: $command")" \
    "$(json_string "$INSTALL_DIR")" \
    "$(kept_keys_json)"
  exit 1
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# --- asking ----------------------------------------------------------------
# Whether there is really a terminal to ask on.
#
# NOT `[ -r /dev/tty ]`, which is the obvious test and the wrong one: that
# device node is world-readable, so access(2) succeeds for a process with no
# controlling terminal at all -- verified on this Mac, where `[ -r /dev/tty ]`
# is true in a process whose stdin is /dev/null and which has no tty. The menu-
# bar item's child and the app's are both exactly that, so the terminal branch
# would have been taken there, the `read` would have failed, and an empty
# answer reads as "no" -- a user who chose Uninstall in the alert would have
# been told nothing and had nothing happen.
#
# Opening the device is the real test. No subshell, and stderr redirected
# BEFORE stdin so that bash's own "Device not configured" never reaches the
# caller: a `( … )` here would inherit the ERR trap (set -o errtrace) and print
# this script's error JSON from inside the subshell.
have_tty() {
  [ -t 0 ] && return 0
  : 2>/dev/null < /dev/tty
}

# Yes or no, however this run can ask: a test's own answer or stand-in command,
# a terminal prompt when there is a terminal, and otherwise an alert on screen
# (which is the case that matters -- the menu-bar item and the app both run
# this with no terminal attached).
#
#   ask "<question>" "<detail>" [<yes button>] [<no button>]
#
# The buttons are named per question rather than always "Uninstall"/"Cancel",
# because one of the questions is not about uninstalling at all: "Delete your
# API keys with Granted?" reads as nonsense with an Uninstall button on it.
ask() {
  local question="$1" detail="${2:-}" yes_label="${3:-Uninstall}" no_label="${4:-Cancel}" override reply out
  override="${GRANTED_UNINSTALL_ASK_CMD:-}"
  if [ -n "$override" ]; then
    case "$override" in
      yes) return 0 ;;
      no) return 1 ;;
      *) "$override" "$question" "$detail" >/dev/null 2>&1 && return 0 || return 1 ;;
    esac
  fi
  if have_tty; then
    if [ -n "$detail" ]; then printf '%s\n' "$detail" >&2; fi
    printf '%s [y/N] ' "$question" >&2
    reply=""
    if [ -t 0 ]; then
      read -r reply || true
    else
      read -r reply < /dev/tty || true
    fi
    case "$reply" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
  fi
  # `as critical`, and the "no" button is the default one: this deletes things,
  # so the keystroke that dismisses the alert must never be the one that
  # proceeds.
  out="$(osascript \
    -e 'on run argv' \
    -e 'display alert (item 1 of argv) message (item 2 of argv) as critical buttons {item 4 of argv, item 3 of argv} default button (item 4 of argv)' \
    -e 'end run' \
    -- "$question" "$detail" "$yes_label" "$no_label" 2>/dev/null || true)"
  case "$out" in *"$yes_label"*) return 0 ;; *) return 1 ;; esac
}

# Says something that needs no answer, the same way round: a terminal if there
# is one, an alert if there isn't. Never under --quiet, which has no one to
# tell.
notify() {
  local text="$1"
  [ "$QUIET" = "1" ] && return 0
  if [ -n "${GRANTED_UNINSTALL_ASK_CMD:-}" ] || have_tty; then
    printf '%s\n' "$text" >&2
    return 0
  fi
  osascript -e 'on run argv' -e 'display alert "Uninstall Granted" message (item 1 of argv)' -e 'end run' -- "$text" >/dev/null 2>&1 || true
}

# --- is this really a Granted install? --------------------------------------
# The top-level "name" in a package.json, read with sed rather than node for
# the reason applications-launcher.sh's install_version is: uninstalling must
# not need node to be on PATH (the user may well be uninstalling because the
# install is broken). The first "name" in the file is npm's own top-level one;
# the dependency entries that follow are "<name>": "<range>" pairs, which this
# pattern cannot match.
package_name() {
  [ -f "$1" ] || return 1
  sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

# Never delete a folder that isn't unmistakably a Granted clone, and never one
# of the folders a mistyped --install-dir could point at.
PROTECTED_DIRS=(
  "/" "/Applications" "/Library" "/System" "/Users" "/Volumes" "/bin" "/etc"
  "/opt" "/private" "/sbin" "/tmp" "/usr" "/var"
  "$HOME" "$HOME/Applications" "$HOME/Desktop" "$HOME/Documents" "$HOME/Downloads" "$HOME/Library"
)

is_granted_install() {
  local dir="$1" protected
  for protected in "${PROTECTED_DIRS[@]}"; do
    if [ "$dir" = "$protected" ]; then return 1; fi
  done
  [ -f "$dir/scaffold/package.json" ] || return 1
  [ -f "$dir/scaffold/scripts/macos/granted-tray.sh" ] || return 1
  [ "$(package_name "$dir/scaffold/package.json" || true)" = "granted" ] || return 1
  return 0
}

# --- work that isn't on GitHub ---------------------------------------------
# git, run against the install folder; no output (and no failure) when git
# isn't installed or the folder isn't a working repo, exactly as the Windows
# script's Invoke-Git treats those two cases: nothing to check, not an error.
in_git() {
  command -v git >/dev/null 2>&1 || return 1
  git -C "$INSTALL_DIR" "$@" 2>/dev/null
}

count_lines() {
  local text="$1"
  [ -n "$text" ] || { printf '0'; return 0; }
  printf '%s' "$text" | grep -c '' | tr -d ' '
}

# The same three kinds of unsaved work the Windows script asks about, in the
# same words. HEAD is listed as well as the branches: a release install sits on
# a tag with no branch ("detached"), and a commit made there is on no branch at
# all.
UNSAVED=()
collect_unsaved() {
  local changes unpushed stashes
  UNSAVED=()
  in_git rev-parse --git-dir >/dev/null 2>&1 || return 0
  changes="$(in_git status --porcelain || true)"
  if [ -n "$changes" ]; then UNSAVED+=("changed or new files ($(count_lines "$changes"))"); fi
  unpushed="$(in_git log HEAD --branches --not --remotes --tags --oneline || true)"
  if [ -n "$unpushed" ]; then UNSAVED+=("commits that aren't pushed ($(count_lines "$unpushed"))"); fi
  stashes="$(in_git stash list || true)"
  if [ -n "$stashes" ]; then UNSAVED+=("stashed changes ($(count_lines "$stashes"))"); fi
  return 0
}

# --- what belongs to THIS install ------------------------------------------
# Whether the LaunchAgent plist in place is the one for this install: its
# WorkingDirectory is the install's own scaffold folder (see granted-tray.sh's
# emit_plist). "none" | "own" | "other" -- and only "own" is ever removed, the
# same rule the Windows script applies to a shortcut before deleting it.
#
# Matched with the "<string>…</string>" delimiters around it rather than as a
# bare substring of the file. A bare one answers "own" for ANOTHER install
# whose path merely contains this one's: an install at "/granted" and one at
# "/Volumes/disk/granted" are different installs, and the second's plist does
# contain the first's path. Contrived, and the consequence is deleting another
# install's LaunchAgent, so the one character on each side is worth having.
launch_agent_owner() {
  [ -f "$PLIST_PATH" ] || { printf 'none'; return 0; }
  if grep -qF ">$SCAFFOLD_DIR<" "$PLIST_PATH" 2>/dev/null; then printf 'own'; else printf 'other'; fi
}

# The same question for the ~/Applications launcher: its executable has this
# install's own granted-tray.sh baked into it (see
# applications-launcher.sh's emit_launcher_script), as a single-quoted
# assignment -- so the quotes are the boundary here, for the reason above.
launcher_owner() {
  local exe="$APP_PATH/Contents/MacOS/Granted"
  [ -e "$APP_PATH" ] || { printf 'none'; return 0; }
  if [ -f "$exe" ] && grep -qF "TRAY_SCRIPT='$TRAY_SCRIPT'" "$exe" 2>/dev/null; then printf 'own'; else printf 'other'; fi
}

# --- the keys --------------------------------------------------------------
present_key_files() {
  local f
  for f in "${KEY_FILES[@]}"; do [ -f "$f" ] && printf '%s\n' "$f"; done
  return 0
}

# Copies the key files into $BACKUP_DIR. Deliberately not wrapped in a `|| true`
# anywhere: a backup the user asked for and that silently didn't happen is
# worse than a refused uninstall, so a failure here reaches the ERR trap and
# stops the run before anything has been deleted (the same point in the order
# as the Windows script's copy).
keep_keys_copy() {
  local files f
  files="$(present_key_files)"
  [ -n "$files" ] || return 0
  mkdir -p -- "$BACKUP_DIR"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cp -- "$f" "$BACKUP_DIR/$(basename -- "$f")"
  done <<EOF
$files
EOF
  KEPT_KEYS="$BACKUP_DIR"
}

# --- stopping Granted ------------------------------------------------------
# node and npm running from inside this install, and nothing else. Copied in
# shape from install-macos.sh's matching_pids, including why the process name
# is checked two ways rather than on `comm` alone: macOS's `ps` truncates the
# comm column to a short fixed width once it is combined with other -o fields,
# so a node invoked through a long Homebrew Cellar path shows up there as
# "/opt/homebrew/Ce". The process name is what keeps an editor, a `tail -f` or
# a `rg` with this folder in its arguments from being killed.
#
# One thing is stricter here than in install-macos.sh: the path has to appear
# as a whole folder, not as any substring. install-macos.sh tests
# `index(args, full)` alone, which also matches a SIBLING folder whose name
# merely starts the same way -- a `node` running in "<install>-dev" contains
# "<install>" as a substring. That is a false positive this script must not
# have: it would SIGKILL an unrelated program (the Windows script's own
# regression test covers exactly that case, "granted-test-install-dev"), and
# unlike there, it would happen while deleting things. So the character after
# the match has to end the path: a separator, a space, or the end of the line.
matching_pids() {
  local full="$1"
  ps -axo pid=,comm=,args= | awk -v full="$full" -v me="$$" '
    {
      pid = $1; comm = $2;
      args = "";
      for (i = 3; i <= NF; i++) args = args (i > 3 ? " " : "") $i;
      if (pid == me) next;
      split(args, argv0_parts, " ");
      exe = argv0_parts[1];
      n = split(exe, path_parts, "/");
      exe_base = path_parts[n];
      if (comm != "node" && comm != "npm" && exe_base != "node" && exe_base != "npm") next;
      pos = index(args, full);
      if (pos == 0) next;
      after = substr(args, pos + length(full), 1);
      if (after != "" && after != "/" && after != " ") next;
      print pid;
    }
  '
}

stop_granted() {
  local pids pid deadline
  # The menu-bar helper and the server under its LaunchAgent, through the one
  # script that owns all of that. A non-zero exit means there was nothing
  # running, which is not a failure here.
  if [ -f "$TRAY_SCRIPT" ]; then
    /bin/bash "$TRAY_SCRIPT" stop --port "$PORT" >/dev/null 2>&1 || true
  fi
  # Then anything still running Node from in here, e.g. `npm run dev` in a
  # terminal -- the counterpart of the Windows script's node.exe sweep.
  pids="$(matching_pids "$INSTALL_DIR" || true)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  deadline=$(( $(date +%s) + 15 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pids="$(matching_pids "$INSTALL_DIR" || true)"
    [ -n "$pids" ] || break
    sleep 0.5
  done
  pids="$(matching_pids "$INSTALL_DIR" || true)"
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  return 0
}

# --- --check ---------------------------------------------------------------
# Everything an uninstall would find, and nothing changed. This is what
# Settings -> About Granted asks before it offers the button, so that the page
# can do the asking itself (and pass --quiet, with --force only when the user
# was actually shown the unsaved work and said yes anyway) rather than this
# script popping dialogs behind a browser window.
if [ "$CHECK" = "1" ]; then
  collect_unsaved
  keys=()
  while IFS= read -r f; do [ -n "$f" ] && keys+=("$f"); done <<EOF
$(present_key_files)
EOF
  printf '{"check":true,"installDir":%s,"exists":%s,"isLink":%s,"grantedInstall":%s,"installerMade":%s,"unsaved":%s,"keyFiles":%s,"launchAgent":"%s","launcher":"%s","settingsPath":%s,"logDir":%s,"backupDir":%s}\n' \
    "$(json_string "$INSTALL_DIR")" \
    "$([ -d "$INSTALL_DIR" ] && printf true || printf false)" \
    "$([ -L "$INSTALL_DIR" ] && printf true || printf false)" \
    "$(is_granted_install "$INSTALL_DIR" && printf true || printf false)" \
    "$([ -f "$MARKER" ] && printf true || printf false)" \
    "$(json_list ${UNSAVED+"${UNSAVED[@]}"})" \
    "$(json_list ${keys+"${keys[@]}"})" \
    "$(launch_agent_owner)" \
    "$(launcher_owner)" \
    "$(json_string "$SETTINGS_PATH")" \
    "$(json_string "$LOG_DIR")" \
    "$(json_string "$BACKUP_DIR")"
  exit 0
fi

# --- refusals --------------------------------------------------------------
# Out of the folder about to be deleted: a process's own working directory
# inside it would keep this script's own `pwd` from resolving afterwards, and
# is the one case where the delete could report success having left the folder
# itself behind.
cd /

if [ -L "$INSTALL_DIR" ]; then
  notify "$INSTALL_DIR is a link to another folder, so it wasn't uninstalled. Delete the folder it points to yourself."
  refused "is-a-link"
  exit 2
fi

# Already deleted by hand: not a refusal, and not nothing to do either -- see
# the header. Everything the install put OUTSIDE its own folder is still here,
# so the run goes on to remove it and reports success; the two checks below are
# skipped because the folder they read is gone, and so is the move-and-delete.
ALREADY_GONE=0
if [ ! -d "$INSTALL_DIR" ]; then ALREADY_GONE=1; fi

if [ "$ALREADY_GONE" != "1" ]; then
  if ! is_granted_install "$INSTALL_DIR"; then
    notify "$INSTALL_DIR doesn't look like a Granted install, so nothing was deleted."
    refused "not-a-granted-install"
    exit 2
  fi

  # The marker install-macos.sh writes into the clones it makes. Without it
  # this is someone's own checkout that happens to sit here, and it is never
  # deleted -- not even with --force, whose job is the unsaved-work question
  # below and not this one.
  if [ ! -f "$MARKER" ]; then
    notify "$INSTALL_DIR wasn't installed by the Granted installer, so it wasn't deleted. Delete the folder yourself if you're sure."
    refused "not-made-by-installer"
    exit 2
  fi
fi

# --- asking ----------------------------------------------------------------
if [ "$QUIET" != "1" ] && [ "$CONFIRMED" != "1" ]; then
  if [ "$ALREADY_GONE" = "1" ]; then
    first_detail="$INSTALL_DIR is already gone. This removes what Granted left elsewhere on this Mac: its menu-bar icon's background job, its Applications launcher and Dock tile, and its settings and logs."
  else
    first_detail="This deletes $INSTALL_DIR, Granted's menu-bar icon, its Applications launcher and its settings. Git and Node stay installed."
  fi
  if ! ask "Uninstall Granted?" "$first_detail"; then
    refused "cancelled"
    exit 1
  fi
fi

collect_unsaved
if [ "${#UNSAVED[@]}" -gt 0 ]; then
  detail="$INSTALL_DIR has work that isn't saved to GitHub:"
  for item in "${UNSAVED[@]}"; do detail="$detail"$'\n'"  - $item"; done
  detail="$detail"$'\n\n'"Uninstalling deletes it permanently."
  if [ "$QUIET" = "1" ]; then
    if [ "$FORCE" != "1" ]; then
      printf '{"removed":false,"reason":"unsaved-work","unsaved":%s,"installDir":%s}\n' \
        "$(json_list "${UNSAVED[@]}")" "$(json_string "$INSTALL_DIR")"
      exit 4
    fi
  elif ! ask "Uninstall Granted anyway?" "$detail"; then
    printf '{"removed":false,"reason":"cancelled","unsaved":%s,"installDir":%s}\n' \
      "$(json_list "${UNSAVED[@]}")" "$(json_string "$INSTALL_DIR")"
    exit 1
  fi
fi

# --- the API keys ----------------------------------------------------------
# A caller that said --keep-keys or --no-keep-keys has already answered this,
# and is obeyed: the question is asked only by an interactive run that was
# given neither (KEEP_KEYS_GIVEN, above, is what tells those two apart). The
# dialog used to be asked unconditionally whenever this was not --quiet, which
# overwrote the flag -- so `--confirmed --no-keep-keys` copied the keys to the
# backup folder anyway whenever the dialog was answered "keep a copy". Writing
# secrets to disk against an explicit instruction not to is the wrong way round
# for that to fail.
if [ -n "$(present_key_files)" ]; then
  keep="$KEEP_KEYS"
  if [ "$QUIET" != "1" ] && [ "$KEEP_KEYS_GIVEN" = "0" ]; then
    # Default yes: the question is put the other way round so that the dialog's
    # safe default button is the one that keeps the copy.
    if ask "Delete your API keys with Granted?" "Granted can keep a copy of your API keys and settings in:"$'\n'"$BACKUP_DIR" "Delete them" "Keep a copy"; then
      keep=0
    else
      keep=1
    fi
  fi
  if [ "$keep" = "1" ]; then keep_keys_copy; fi
fi

# --- stopping, then moving aside -------------------------------------------
# Decided BEFORE anything moves: both answers are about paths inside the
# install folder, which is about to stop existing.
AGENT_OWNER="$(launch_agent_owner)"
LAUNCHER_OWNER="$(launcher_owner)"

stop_granted

# The move: a sibling folder, then deleted (see the header for why not the
# Trash, and for what this ordering does and does not buy on macOS). Tried a
# few times, because a process that was just stopped can take a moment to let
# go of things. Nothing to move when the folder was already deleted by hand, in
# which case TRASH stays empty and everything below reads that as "there was no
# folder".
TRASH=""
if [ "$ALREADY_GONE" != "1" ]; then
  # The name has to be one that doesn't exist yet: `mv dir existing-dir` moves
  # the folder INSIDE that one instead of renaming it, which would hide a whole
  # install inside whatever was there.
  for _ in 1 2 3 4 5; do
    candidate="$INSTALL_DIR.uninstalling-$$-$RANDOM"
    if [ ! -e "$candidate" ]; then TRASH="$candidate"; break; fi
  done
  if [ -z "$TRASH" ]; then
    printf '{"removed":false,"reason":"error","detail":%s,"installDir":%s}\n' \
      "$(json_string "couldn't find an unused name to move $INSTALL_DIR aside to")" "$(json_string "$INSTALL_DIR")"
    exit 1
  fi
  #
  # `mv`'s own message is kept in a temp FILE rather than captured with
  # `move_error="$(mv … 2>&1)"`. That shape looks tidier and is a trap: a
  # command substitution runs in a subshell, which inherits the ERR trap above
  # (that is what `set -o errtrace` is for), and the enclosing `if` does not
  # suppress it in there -- so a failing `mv` ran on_error INSIDE the
  # substitution and its whole JSON line ended up inside the message this
  # script then reported. The `if` below suppresses errexit for the `mv`
  # itself, which is not in a subshell at all.
  MOVE_ERROR_FILE="$(mktemp "${TMPDIR:-/tmp}/granted-uninstall-mv.XXXXXX")"
  move_error=""
  moved=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if mv -- "$INSTALL_DIR" "$TRASH" 2>"$MOVE_ERROR_FILE"; then
      moved=1
      break
    fi
    sleep 0.5
  done
  if [ "$moved" != "1" ]; then
    # One line, so it fits in the JSON message and in a dialog.
    move_error="$(tr '\n' ' ' < "$MOVE_ERROR_FILE" 2>/dev/null || true)"
    [ -n "$move_error" ] || move_error="mv $INSTALL_DIR failed"
  fi
  rm -f -- "$MOVE_ERROR_FILE"
  if [ -n "$move_error" ]; then
    # The two reasons the Windows script tells apart, for the same reason: what
    # the user has to do about it differs. Both exit 3, and both have changed
    # nothing.
    case "$move_error" in
      *"Permission denied"*|*"Operation not permitted"*|*"Read-only file system"*)
        move_reason="access-denied"
        move_message="macOS won't let this account move or delete $INSTALL_DIR, so nothing was deleted. Check that you can write to $(dirname -- "$INSTALL_DIR"), then uninstall again."
        ;;
      *)
        move_reason="files-in-use"
        move_message="Granted's folder couldn't be moved, so nothing was deleted. Close anything using $INSTALL_DIR (a terminal open in there, say), then uninstall again."
        ;;
    esac
    notify "$move_message"
    printf '{"removed":false,"reason":"%s","detail":%s,"installDir":%s,"keptKeys":%s}\n' \
      "$move_reason" "$(json_string "$move_error")" "$(json_string "$INSTALL_DIR")" \
      "$(kept_keys_json)"
    exit 3
  fi
fi

# --- from here on, Granted is going ---------------------------------------
# The script that does the removing moved with the folder, so it is run from
# where it is now -- or, for a folder that was already deleted by hand, from
# beside THIS script, which is the only copy left. It is the same file either
# way, and calling it is what keeps its "how do I remove this" logic in one
# place: the Dock round trip that preserves every other app's tile lives in
# applications-launcher.sh, and this script must not grow a second copy of it.
if [ -n "$TRASH" ]; then
  LAUNCHER_SCRIPT="$TRASH/scaffold/scripts/macos/applications-launcher.sh"
else
  LAUNCHER_SCRIPT="$SCRIPT_DIR/applications-launcher.sh"
fi

# Each of these says in the JSON whether it worked, and none of them stops the
# run: the folder has already gone, so a plist that could not be removed is
# something to report, not a reason to leave the rest half-done.
if [ "$AGENT_OWNER" = "own" ]; then
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f -- "$PLIST_PATH" 2>/dev/null || true
  [ -e "$PLIST_PATH" ] || REMOVED_LAUNCH_AGENT=true
fi

if [ "$LAUNCHER_OWNER" = "own" ] && [ -f "$LAUNCHER_SCRIPT" ]; then
  # The Dock entry first: removing it reads the launcher's path out of the Dock
  # preferences, and that is clearer to do while the bundle is still there.
  dock_out="$(/bin/bash "$LAUNCHER_SCRIPT" remove-from-dock 2>/dev/null || true)"
  case "$dock_out" in *'"removed"'*) REMOVED_FROM_DOCK=true ;; esac
  launcher_out="$(/bin/bash "$LAUNCHER_SCRIPT" remove 2>/dev/null || true)"
  case "$launcher_out" in *'"removed":true'*) REMOVED_LAUNCHER=true ;; esac
fi

if [ -n "$TRASH" ]; then
  rm -rf -- "$TRASH" || true
  if [ -e "$TRASH" ]; then LEFTOVER="$TRASH"; fi
fi

# The settings and the logs are shared by every Granted install on this Mac,
# so they go with the last one out -- the same rule the Windows script applies
# through its count of other registered installs. With no Installed-apps list
# to count, what stands in for it is whether anything else here still belongs
# to another install: a LaunchAgent plist or an ~/Applications launcher this
# install didn't write. Either one means there is another Granted, and the
# shared files stay.
SHARED_GO=1
if [ "$AGENT_OWNER" = "other" ] || [ "$LAUNCHER_OWNER" = "other" ]; then SHARED_GO=0; fi
# And for a folder deleted by hand there has to be some evidence that the path
# given really was a Granted install before the settings of a possibly
# different one are deleted -- see the header. The marker went with the folder,
# so what is left to go on is a LaunchAgent plist or a launcher that names this
# exact folder.
if [ "$ALREADY_GONE" = "1" ] && [ "$AGENT_OWNER" != "own" ] && [ "$LAUNCHER_OWNER" != "own" ]; then SHARED_GO=0; fi
if [ "$SHARED_GO" = "1" ]; then
  # Only ever a folder actually called Granted, however GRANTED_SETTINGS_PATH
  # and GRANTED_LOG_DIR were pointed: this is an `rm -rf` of a path the caller
  # chooses.
  if [ "$(basename -- "$SUPPORT_DIR")" = "Granted" ] && [ -d "$SUPPORT_DIR" ]; then
    rm -rf -- "$SUPPORT_DIR" || true
    [ -d "$SUPPORT_DIR" ] || REMOVED_SETTINGS=true
  fi
  if [ "$(basename -- "$LOG_DIR")" = "Granted" ] && [ -d "$LOG_DIR" ]; then
    rm -rf -- "$LOG_DIR" || true
    [ -d "$LOG_DIR" ] || REMOVED_LOGS=true
  fi
fi

if [ "$ALREADY_GONE" = "1" ]; then
  done_text="Granted's folder ($INSTALL_DIR) was already deleted. What it left elsewhere on this Mac has been removed."
else
  done_text="Granted was uninstalled."
fi
if [ -n "$LEFTOVER" ]; then
  done_text="$done_text"$'\n\n'"A few files couldn't be deleted. You can delete this folder yourself: $LEFTOVER"
fi
# The copy of the keys, checked against the disk rather than against what this
# run meant to do -- see kept_keys_json, which this is the deciding half of. A
# backup folder that was written and is not there now was inside something this
# uninstall deleted. The user asked for that copy, so this says so plainly
# rather than quietly reporting none; and clearing KEPT_KEYS here is what makes
# the JSON line below say null as well.
if [ -n "$KEPT_KEYS" ] && [ ! -d "$KEPT_KEYS" ]; then
  done_text="$done_text"$'\n\n'"A copy of your API keys couldn't be kept: $KEPT_KEYS was inside something this uninstall deleted, so it went too."
  KEPT_KEYS=""
fi
if [ -n "$KEPT_KEYS" ]; then
  done_text="$done_text"$'\n\n'"A copy of your API keys and settings is in: $KEPT_KEYS"
fi
notify "$done_text"

printf '{"removed":true,"alreadyGone":%s,"installDir":%s,"keptKeys":%s,"leftover":%s,"removedLaunchAgent":%s,"removedLauncher":%s,"removedFromDock":%s,"removedSettings":%s,"removedLogs":%s}\n' \
  "$([ "$ALREADY_GONE" = "1" ] && printf true || printf false)" \
  "$(json_string "$INSTALL_DIR")" \
  "$(kept_keys_json)" \
  "$([ -n "$LEFTOVER" ] && json_string "$LEFTOVER" || printf 'null')" \
  "$REMOVED_LAUNCH_AGENT" "$REMOVED_LAUNCHER" "$REMOVED_FROM_DOCK" "$REMOVED_SETTINGS" "$REMOVED_LOGS"
exit 0
