#!/usr/bin/env bash
# Granted -- the per-user ~/Applications launcher, and its Dock entry (macOS).
#
# The macOS counterpart of scripts/windows/shortcuts.ps1. Windows gets a
# Desktop and a Start-menu .lnk; macOS gets one small Granted.app in the
# per-user ~/Applications folder (no admin rights needed, nothing written
# outside the user's home folder) plus, if the user wants it, an entry in the
# Dock.
#
# The bundle is deliberately minimal and holds no logic of its own. Its
# executable is a tiny shell script that runs
#
#   granted-tray.sh start --open-browser --port <this install's port>
#
# detached, so one double-click from Finder or one click in the Dock starts
# the background server under its LaunchAgent, puts the menu-bar icon up and
# opens Granted the way the user prefers -- all of which already live in
# granted-tray.sh and open-granted.sh, and none of which is reimplemented
# here. The launcher process itself exits immediately; what it started is
# launchd's, so it keeps running.
#
#   applications-launcher.sh install [--port N] [--add-to-dock]
#                                        create (or overwrite) the launcher,
#                                        and optionally add it to the Dock
#   applications-launcher.sh add-to-dock      add an existing launcher to the Dock
#   applications-launcher.sh remove-from-dock remove it from the Dock again
#   applications-launcher.sh remove           delete the launcher bundle
#   applications-launcher.sh path             print the launcher's path
#   applications-launcher.sh in-dock          one JSON line: {"inDock":true|false}
#   applications-launcher.sh icns --out FILE  convert the repo's .ico to an .icns
#
# Each command prints exactly one JSON line, read by the installer
# (installer/src/main/ipcPure.ts's parseLauncherOutput):
#
#   install           {"launcher":"<path>","icon":true|false,
#                      "dock":"added"|"already"|"skipped"|"failed"}
#   add-to-dock       {"dock":"added"|"already"|"failed"}
#   remove-from-dock  {"dock":"removed"|"absent"|"failed"}
#   remove            {"removed":true|false}
#
# Exit codes: 0 on success, 1 when the launcher itself could not be created
# (or a standalone Dock command failed), 64 for bad input. `install` exits 0
# even when the Dock part fails, because the two are not equally important:
# the work order makes the launcher unconditional and only the Dock placement
# optional, so a Dock failure is reported in the JSON as "failed" and the
# installer shows it as a note rather than as a failed step.
#
# The icon is the repo's own scripts/windows/granted.ico, converted here with
# macOS's own sips and iconutil -- no new dependency, and nothing committed
# that a build step would have to keep in sync with the .ico. See make_icns.
#
# Adding to the Dock is `defaults write <dock domain> persistent-apps
# -array-add <tile>` followed by a Dock restart, which is the mechanism
# dockutil and every other scripted Dock change uses: macOS has no public API
# for it. The two alternatives were rejected on purpose. Editing
# ~/Library/Preferences/com.apple.dock.plist directly (with PlistBuddy, say)
# fights cfprefsd, which caches that file and can write its own copy back over
# the edit; going through `defaults` hands the change to cfprefsd instead, so
# it cannot be lost that way. AppleScript UI scripting ("drag the icon into the
# Dock") needs Accessibility permission the installer does not have, prompts
# the user for it, and breaks whenever the Dock's view hierarchy changes.
#
# Test-only overrides, so nothing here ever touches the real ~/Applications or
# the real Dock:
#   GRANTED_APPLICATIONS_DIR  where the launcher is created (default ~/Applications)
#   GRANTED_DOCK_DOMAIN       the `defaults` domain to change. A path (with no
#                             .plist extension) is a throwaway plist file of
#                             its own, which is how the tests change "a Dock"
#                             without touching the real com.apple.dock.
#   GRANTED_DOCK_RELOAD_CMD   what reloads the Dock ("none" = don't; the tests
#                             must never restart the user's real Dock)
#   GRANTED_LAUNCHER_ICO      the .ico to convert (default scripts/windows/granted.ico)
#   GRANTED_LOG_DIR           the log folder the launcher writes to
#   GRANTED_LAUNCHER_ALERT    "none" = the launcher shows no alert when the
#                             install folder has gone (an osascript alert
#                             would block a test run forever)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCAFFOLD_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
TRAY_SCRIPT="$SCRIPT_DIR/granted-tray.sh"
ICO_PATH="${GRANTED_LAUNCHER_ICO:-$SCAFFOLD_DIR/scripts/windows/granted.ico}"

APPLICATIONS_DIR="${GRANTED_APPLICATIONS_DIR:-$HOME/Applications}"
APP_PATH="$APPLICATIONS_DIR/Granted.app"
DOCK_DOMAIN="${GRANTED_DOCK_DOMAIN:-com.apple.dock}"

# This bundle's identity. `remove` refuses to delete anything whose
# Info.plist does not carry exactly this identifier, so a stray rm -rf can
# never take someone else's Granted.app (or an unrelated folder that happens
# to be sitting at that path) with it.
BUNDLE_ID="io.github.kurtlehnardt.granted.launcher"

ADD_TO_DOCK=0
PORT=""
OUT=""

# An option that takes a value must actually have been given one, and must say
# so when it wasn't -- the same guard, for the same reason, as
# granted-tray.sh's and open-granted.sh's: with `set -u` a bare `--port` at the
# end of the line would otherwise die on `$2: unbound variable`, which exits 1
# with a raw shell diagnostic instead of this script's own message and its own
# exit 64 for bad input.
need_value() {
  [ "$1" -ge 2 ] && return 0
  printf 'applications-launcher.sh: %s needs a value\n' "$2" >&2
  exit 64
}

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --port) need_value "$#" --port; PORT="$2"; shift 2 ;;
    --out) need_value "$#" --out; OUT="$2"; shift 2 ;;
    --add-to-dock) ADD_TO_DOCK=1; shift ;;
    *) printf 'applications-launcher.sh: unknown option %s\n' "$1" >&2; exit 64 ;;
  esac
done

if [ -z "$PORT" ]; then PORT="${GRANTED_PORT:-3000}"; fi
case "$PORT" in
  ''|*[!0-9]*) printf 'applications-launcher.sh: --port must be a number (got %s)\n' "$PORT" >&2; exit 64 ;;
esac

LOG_DIR="${GRANTED_LOG_DIR:-$HOME/Library/Logs/Granted}"

note() {
  mkdir -p -- "$LOG_DIR" 2>/dev/null || true
  printf '[granted-launcher %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_DIR/launcher.log" 2>/dev/null || true
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

# Single-quoted POSIX shell literal, for baking a path into the launcher
# script -- the shell counterpart of installer/src/main/ipcPure.ts's
# shSingleQuoted, and the same POSIX trick for an embedded single quote
# (close the quoted string, emit an escaped quote, reopen), so an install
# folder with an apostrophe in its name still produces a launcher that runs.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
}

# --- the icon --------------------------------------------------------------
# scripts/windows/granted.ico -> $1, an .icns, using only tools macOS already
# has: sips reads the .ico (ImageIO hands it the largest representation in the
# file -- 256x256 here, confirmed with `sips -g pixelWidth`), scales that into
# an .iconset of the sizes Finder and the Dock ask for, and iconutil packs the
# folder into the single .icns a bundle's CFBundleIconFile names.
#
# The set stops at 256 on purpose. The source .ico's largest image IS 256x256,
# so icon_256x256@2x (512) and icon_512x512@2x (1024) could only ever be an
# upscale of it -- a blurrier picture, a much bigger file, and no more detail
# than macOS gets by scaling the 256 itself. 256 is already the size the Dock
# asks for at its largest (128pt at 2x), so nothing the launcher is actually
# used through is affected.
#
# The intermediate full-size PNG is written OUTSIDE the .iconset folder:
# iconutil rejects an iconset containing a file whose name isn't one of the
# ones it knows.
#
# Returns non-zero if anything is missing or fails, and never prints a
# diagnostic to stdout (the caller's JSON line is the only thing on stdout):
# a launcher with no icon still works, it just shows the generic app icon.
ICON_SIZES='16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256'

make_icns() {
  local out="$1" work base iconset size name
  [ -f "$ICO_PATH" ] || { note "no icon at $ICO_PATH: the launcher will show the generic app icon"; return 1; }
  command -v sips >/dev/null 2>&1 || return 1
  command -v iconutil >/dev/null 2>&1 || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/granted-icns.XXXXXX")" || return 1
  base="$work/base.png"
  iconset="$work/granted.iconset"
  mkdir -p -- "$iconset"
  if ! sips -s format png "$ICO_PATH" --out "$base" >/dev/null 2>&1; then
    rm -rf -- "$work"
    note "sips couldn't read $ICO_PATH: the launcher will show the generic app icon"
    return 1
  fi
  while IFS=' ' read -r size name; do
    [ -n "$size" ] || continue
    sips -z "$size" "$size" "$base" --out "$iconset/$name.png" >/dev/null 2>&1 || true
  done <<EOF
$ICON_SIZES
EOF
  mkdir -p -- "$(dirname -- "$out")"
  if ! iconutil -c icns "$iconset" -o "$out" >/dev/null 2>&1; then
    rm -rf -- "$work"
    note "iconutil couldn't build an .icns: the launcher will show the generic app icon"
    return 1
  fi
  rm -rf -- "$work"
  [ -s "$out" ]
}

# --- the bundle ------------------------------------------------------------
# This install's version, for the bundle's version keys. Read out of
# scaffold/package.json with sed rather than node, because creating the
# launcher must not need node to be on PATH; an unreadable version is simply
# left at 0.
#
# The pattern is deliberately not anchored to the start of a line, so a
# package.json written on one line reads the same as a pretty-printed one. The
# first "version" in the file is the top-level one: npm puts it in the first
# few keys, and the dependency entries that follow are "<name>": "<range>"
# pairs, which this cannot match.
install_version() {
  local v=""
  if [ -f "$SCAFFOLD_DIR/package.json" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCAFFOLD_DIR/package.json" | head -1)"
  fi
  printf '%s' "${v:-0}"
}

# The bundle's Info.plist.
#
# LSUIElement true is load-bearing, and was found by testing this on real
# hardware rather than reasoned about (macOS 26, Apple Silicon): when an
# ordinary .app launched through LaunchServices -- a Finder double-click or a
# Dock click -- exits, launchd tears the whole job down a second or two later
# and kills everything that app had started. Measured four ways with the same
# bundle and the same child: `nohup cmd &`, `( cmd & )` and `launchctl submit`
# were each killed about a second after the launcher exited, and only the
# variant whose Info.plist said LSUIElement kept its child running.
#
# That is exactly the shape of this launcher: it starts granted-tray.sh
# detached and exits at once. Without this key the menu-bar helper would
# appear and vanish, and Granted would never open at all -- the tray script
# would be killed while it was still waiting for the server's first compile.
# (The server itself survives either way; it is launchd's own child under the
# LaunchAgent, which is why this was not obvious from the server alone.)
#
# Being a UI element is also the honest description of this bundle: a shim
# with no window and no menus, which macOS then gives no Dock bounce and no
# app-switcher entry for the second it runs. A Dock TILE in persistent-apps is
# unaffected -- it still shows the icon, and clicking it still launches this.
emit_info_plist() {
  local version
  version="$(install_version)"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Granted</string>
  <key>CFBundleDisplayName</key>
  <string>Granted</string>
  <key>CFBundleIdentifier</key>
  <string>$(xml_escape "$BUNDLE_ID")</string>
  <key>CFBundleExecutable</key>
  <string>Granted</string>
  <key>CFBundleIconFile</key>
  <string>granted</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>$(xml_escape "$version")</string>
  <key>CFBundleVersion</key>
  <string>$(xml_escape "$version")</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <!-- Load-bearing, not cosmetic: see the note above emit_info_plist. -->
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST
}

# The bundle's executable: one small script, with this install's tray script
# and port baked in.
#
# The port is baked rather than read from the environment because an app
# launched from Finder or the Dock gets none of the user's shell environment --
# no GRANTED_PORT, no PATH additions. Everything else (the log folder, the
# alert) still honours an override if one is set, which is what lets the tests
# run this exact script against throwaway paths.
#
# `nohup ... &` and an immediate exit, rather than waiting: granted-tray.sh's
# `start --open-browser` waits for the server to answer before opening
# Granted, which on a first run is a Next.js cold compile of up to a few
# minutes, and a launcher that stayed alive for all of it would be a shim
# process sitting in the app switcher for minutes. The menu-bar icon appears
# within seconds of the click, which is the feedback that matters.
#
# This only works because the bundle declares LSUIElement -- see the note
# above emit_info_plist. Without it macOS kills everything this script starts
# a second after it exits, nohup or not.
emit_launcher_script() {
  cat <<LAUNCHER
#!/bin/bash
# Granted -- the ~/Applications/Granted.app launcher.
#
# Written by scaffold/scripts/macos/applications-launcher.sh for one specific
# install; the paths below are that install's own. Don't edit this file: the
# installer overwrites it whenever it creates the launcher again.
set -u
TRAY_SCRIPT=$(sh_quote "$TRAY_SCRIPT")
LOG_DIR="\${GRANTED_LOG_DIR:-\$HOME/Library/Logs/Granted}"
mkdir -p -- "\$LOG_DIR" 2>/dev/null || true
LOG="\$LOG_DIR/launcher.log"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }
if [ ! -f "\$TRAY_SCRIPT" ]; then
  printf '[granted-launcher %s] %s is gone -- Granted was moved or deleted\n' "\$(stamp)" "\$TRAY_SCRIPT" >> "\$LOG" 2>/dev/null || true
  if [ "\${GRANTED_LAUNCHER_ALERT:-}" != "none" ]; then
    osascript -e 'display alert "Granted has moved" message "Granted is no longer in the folder it was installed in, so this shortcut can'"'"'t start it. Install Granted again, or delete this launcher from your Applications folder." as critical' >/dev/null 2>&1 || true
  fi
  exit 1
fi
printf '[granted-launcher %s] starting Granted on port $PORT\n' "\$(stamp)" >> "\$LOG" 2>/dev/null || true
nohup /bin/bash "\$TRAY_SCRIPT" start --open-browser --port $PORT >> "\$LOG" 2>&1 &
exit 0
LAUNCHER
}

# Is $1 a Granted launcher this script created?
#
# Read with PlistBuddy from the bundle's own Info.plist. Only a "yes" here
# allows the bundle to be replaced or deleted, so the test must be about the
# identifier and nothing else.
is_our_bundle() {
  local plist id
  plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 1
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)"
  [ "$id" = "$BUNDLE_ID" ]
}

# Creates (or replaces) the launcher bundle, printing nothing. Returns 1 with a
# message on stderr if it can't.
#
# Built in a temporary folder beside the final one and moved into place, so a
# half-written bundle is never left somewhere a user could click it. The old
# bundle is removed only after the new one is complete, and only once
# is_our_bundle has confirmed what it is -- anything else at that path is
# refused rather than deleted, because this runs `rm -rf` on a path the user
# can point anywhere with GRANTED_APPLICATIONS_DIR.
create_bundle() {
  local staging contents icon_ok=1
  if [ -e "$APP_PATH" ] && ! is_our_bundle "$APP_PATH"; then
    printf "applications-launcher.sh: %s already exists and isn't Granted's launcher -- leaving it alone\n" "$APP_PATH" >&2
    return 1
  fi
  mkdir -p -- "$APPLICATIONS_DIR" || return 1
  staging="$(mktemp -d "$APPLICATIONS_DIR/.granted-launcher.XXXXXX")" || return 1
  contents="$staging/Granted.app/Contents"
  mkdir -p -- "$contents/MacOS" "$contents/Resources" || { rm -rf -- "$staging"; return 1; }
  emit_info_plist > "$contents/Info.plist" || { rm -rf -- "$staging"; return 1; }
  emit_launcher_script > "$contents/MacOS/Granted" || { rm -rf -- "$staging"; return 1; }
  chmod 755 "$contents/MacOS/Granted" || { rm -rf -- "$staging"; return 1; }
  # The classic companion of Info.plist. Not strictly required for a modern
  # bundle, but it is what makes Finder treat the folder as an application
  # without waiting for LaunchServices to read the plist.
  printf 'APPL????' > "$contents/PkgInfo" || true
  make_icns "$contents/Resources/granted.icns" || icon_ok=0
  if [ -e "$APP_PATH" ]; then rm -rf -- "$APP_PATH"; fi
  if ! mv -f -- "$staging/Granted.app" "$APP_PATH"; then
    rm -rf -- "$staging"
    return 1
  fi
  rm -rf -- "$staging"
  # LaunchServices notices a new bundle on its own; touching the bundle makes
  # Finder pick the icon up straight away rather than after its next sweep.
  touch -- "$APP_PATH" 2>/dev/null || true
  ICON_OK="$icon_ok"
  return 0
}

# --- the Dock --------------------------------------------------------------
# One Dock tile for $1, as the XML `defaults write -array-add` takes.
#
# _CFURLStringType 0 means "_CFURLString is a plain POSIX path", which is why
# nothing here has to be percent-encoded; the Dock rewrites the tile into its
# own URL form (type 15) the next time it saves its preferences, which is why
# dock_index below has to understand both spellings.
dock_tile() {
  printf '<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>%s</string><key>_CFURLStringType</key><integer>0</integer></dict><key>file-label</key><string>Granted</string></dict><key>tile-type</key><string>file-tile</string></dict>' \
    "$(xml_escape "$1")"
}

# A Dock tile's path, however the Dock happens to have spelled it: a plain
# POSIX path (what this script writes), or a percent-encoded file:// URL (what
# the Dock writes back). Trailing slash removed, so the two forms of the same
# bundle compare equal.
normalize_dock_path() {
  local s="$1"
  case "$s" in file://*) s="${s#file://}" ;; esac
  case "$s" in
    *%*)
      # Backslashes first, so printf '%b' can't reinterpret one that was
      # already in the path, then every %XX into the escape %b understands.
      s="$(printf '%s' "$s" | sed 's/\\/\\\\/g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')"
      s="$(printf '%b' "$s")"
      ;;
  esac
  while [ "${s%/}" != "$s" ]; do s="${s%/}"; done
  printf '%s' "$s"
}

# The Dock's preferences as a plain XML plist file, or failure if there are
# none yet (a brand-new test domain). `defaults export`, not a read of
# ~/Library/Preferences/com.apple.dock.plist: the file on disk can be stale
# while cfprefsd holds newer values, and only `defaults` sees what the Dock
# will actually use.
export_dock() {
  defaults export "$DOCK_DOMAIN" "$1" >/dev/null 2>&1 || return 1
  [ -s "$1" ]
}

# The index of $1's tile in persistent-apps, printed on stdout; non-zero if
# it isn't there. Walks the array by index with PlistBuddy and stops at the
# first index that doesn't exist, so a tile with no file-data at all (the
# Dock's folder and stack tiles live in persistent-others, but a hand-edited
# plist can hold anything) is skipped rather than ending the search.
dock_index() {
  local wanted="$1" exported i=0 url
  wanted="$(normalize_dock_path "$wanted")"
  exported="$(mktemp "${TMPDIR:-/tmp}/granted-dock.XXXXXX")" || return 1
  if ! export_dock "$exported"; then rm -f -- "$exported"; return 1; fi
  while /usr/libexec/PlistBuddy -c "Print :persistent-apps:$i" "$exported" >/dev/null 2>&1; do
    url="$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$exported" 2>/dev/null || true)"
    if [ -n "$url" ] && [ "$(normalize_dock_path "$url")" = "$wanted" ]; then
      rm -f -- "$exported"
      printf '%s' "$i"
      return 0
    fi
    i=$(( i + 1 ))
  done
  rm -f -- "$exported"
  return 1
}

# Makes the Dock pick up a preference change, and does not return until it
# has. `killall Dock` (a SIGTERM; launchd restarts the Dock immediately) is
# how every scripted Dock change does this: no windows and no other apps are
# affected, and the user sees their Dock redraw once.
#
# The wait is the part that matters, and it was found on real hardware
# (macOS 26) rather than reasoned about. A running Dock watches its own
# preferences and writes its copy of persistent-apps back when it is asked to
# quit. A Dock that is still STARTING UP has not seen the latest change yet,
# so the next `killall` makes it save its startup copy over that change. In
# practice: add a tile, restart the Dock, and immediately remove the tile
# again, and the removal is silently undone a second later — exactly what a
# first real-Dock test of this script did, reported as "failed" by the
# read-back in remove_from_dock. Waiting for the new Dock process, and then
# for it to settle, makes both operations reliable back to back.
#
# With no Dock running at all (a CI runner with no GUI session) there is
# nothing to wait for, and this returns as soon as the command has run.
DOCK_SETTLE_SECONDS=2
DOCK_RESTART_WAIT=20

reload_dock() {
  local cmd="${GRANTED_DOCK_RELOAD_CMD-killall Dock}" before after deadline
  [ "$cmd" = "none" ] && return 0
  [ -n "$cmd" ] || return 0
  before="$(pgrep -x Dock 2>/dev/null | head -1 || true)"
  # Deliberately unquoted: the override is a command line ("killall Dock"),
  # not a single program name.
  # shellcheck disable=SC2086
  $cmd >/dev/null 2>&1 || true
  [ -n "$before" ] || return 0
  deadline=$(( $(date +%s) + DOCK_RESTART_WAIT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    after="$(pgrep -x Dock 2>/dev/null | head -1 || true)"
    [ -n "$after" ] && [ "$after" != "$before" ] && break
    sleep 0.25
  done
  sleep "$DOCK_SETTLE_SECONDS"
}

# Whether the Dock holds this launcher's tile, allowing a few seconds for a
# just-restarted Dock and cfprefsd to agree. `want` is "yes" or "no"; returns
# non-zero if the Dock never got there.
dock_settles_to() {
  local want="$1" deadline
  deadline=$(( $(date +%s) + 5 ))
  while :; do
    if dock_index "$APP_PATH" >/dev/null; then
      [ "$want" = "yes" ] && return 0
    else
      [ "$want" = "no" ] && return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 0.5
  done
}

# "added" | "already" | "failed"
add_to_dock() {
  if dock_index "$APP_PATH" >/dev/null; then printf 'already'; return 0; fi
  if ! defaults write "$DOCK_DOMAIN" persistent-apps -array-add "$(dock_tile "$APP_PATH")" >/dev/null 2>&1; then
    note "couldn't add $APP_PATH to the Dock ($DOCK_DOMAIN)"
    printf 'failed'
    return 1
  fi
  reload_dock
  # Confirmed by reading it back, not assumed from the write's exit code: this
  # is a preference change the Dock itself also writes to, so the only honest
  # answer comes from asking what is in there now.
  if dock_settles_to yes; then printf 'added'; return 0; fi
  note "the Dock entry for $APP_PATH didn't stick"
  printf 'failed'
  return 1
}

# "removed" | "absent" | "failed"
#
# Removal is the export/delete/import round trip rather than a `defaults
# write` of the whole array: persistent-apps tiles the Dock has saved contain
# binary bookmark data, which cannot survive being rebuilt from a shell string
# (and would be destroyed for every OTHER app in the Dock if the array were
# rewritten). Exporting, deleting exactly one index with PlistBuddy and
# importing the result back through `defaults` leaves every other tile byte for
# byte as it was.
remove_from_dock() {
  local index exported
  index="$(dock_index "$APP_PATH")" || { printf 'absent'; return 0; }
  exported="$(mktemp "${TMPDIR:-/tmp}/granted-dock.XXXXXX")" || { printf 'failed'; return 1; }
  if ! export_dock "$exported"; then rm -f -- "$exported"; printf 'failed'; return 1; fi
  if ! /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$index" "$exported" >/dev/null 2>&1; then
    rm -f -- "$exported"
    printf 'failed'
    return 1
  fi
  if ! defaults import "$DOCK_DOMAIN" "$exported" >/dev/null 2>&1; then
    rm -f -- "$exported"
    printf 'failed'
    return 1
  fi
  rm -f -- "$exported"
  reload_dock
  if ! dock_settles_to no; then printf 'failed'; return 1; fi
  printf 'removed'
  return 0
}

# --- subcommands -----------------------------------------------------------
ICON_OK=0

cmd_install() {
  local dock="skipped"
  create_bundle || {
    printf '{"launcher":null,"icon":false,"dock":"failed"}\n'
    return 1
  }
  note "created $APP_PATH (port $PORT, icon $([ "$ICON_OK" = "1" ] && printf yes || printf no))"
  if [ "$ADD_TO_DOCK" = "1" ]; then
    dock="$(add_to_dock || true)"
  fi
  printf '{"launcher":%s,"icon":%s,"dock":"%s"}\n' \
    "$(json_string "$APP_PATH")" \
    "$([ "$ICON_OK" = "1" ] && printf true || printf false)" \
    "$dock"
  return 0
}

cmd_remove() {
  if [ ! -e "$APP_PATH" ]; then printf '{"removed":false}\n'; return 0; fi
  if ! is_our_bundle "$APP_PATH"; then
    printf "applications-launcher.sh: %s isn't Granted's launcher -- leaving it alone\n" "$APP_PATH" >&2
    printf '{"removed":false}\n'
    return 1
  fi
  rm -rf -- "$APP_PATH" || { printf '{"removed":false}\n'; return 1; }
  printf '{"removed":true}\n'
}

case "$COMMAND" in
  install) cmd_install ;;
  add-to-dock)
    state="$(add_to_dock || true)"
    printf '{"dock":"%s"}\n' "$state"
    [ "$state" = "failed" ] && exit 1 || exit 0
    ;;
  remove-from-dock)
    state="$(remove_from_dock || true)"
    printf '{"dock":"%s"}\n' "$state"
    [ "$state" = "failed" ] && exit 1 || exit 0
    ;;
  remove) cmd_remove ;;
  path) printf '%s\n' "$APP_PATH" ;;
  in-dock)
    if dock_index "$APP_PATH" >/dev/null; then printf '{"inDock":true}\n'; else printf '{"inDock":false}\n'; fi
    ;;
  icns)
    [ -n "$OUT" ] || { printf 'applications-launcher.sh: icns needs --out FILE\n' >&2; exit 64; }
    make_icns "$OUT" || { printf "applications-launcher.sh: couldn't convert %s to an .icns\n" "$ICO_PATH" >&2; exit 1; }
    printf '%s\n' "$OUT"
    ;;
  *)
    printf 'usage: applications-launcher.sh {install|add-to-dock|remove-from-dock|remove|path|in-dock|icns} [--port N] [--add-to-dock] [--out FILE]\n' >&2
    exit 64
    ;;
esac
