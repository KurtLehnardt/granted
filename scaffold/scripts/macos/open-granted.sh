#!/usr/bin/env bash
# Granted -- open Granted in its own window, or in a browser tab (macOS).
#
# The macOS counterpart of scripts/windows/open-granted.ps1, with the same
# subcommands, the same JSON output, and the same preference in the same
# settings file.
#
# "Its own window" is Chrome's (or Edge's) app mode: `<browser> --app=<url>`
# opens the page in a window with no tabs, no address bar and its own Dock
# entry, so Granted looks and feels like a desktop app. With neither browser
# installed (or when the user prefers it) Granted opens in the default
# browser, which on a stock Mac is Safari.
#
#   open-granted.sh --url http://localhost:3000       open it, the way the user prefers
#   open-granted.sh --url ... --no-browser-fallback   never open a browser tab itself
#                                                     (the GUI installer does that part)
#   open-granted.sh --set-open-in window|browser      save the preference
#   open-granted.sh --get-open-in                     print the preference
#   open-granted.sh --find-browser                    print the app-mode browser it would
#                                                     use, or nothing (also: which one, when
#                                                     troubleshooting a Mac with both)
#
# Opening prints one JSON line: {"openedIn":"window"|"browser"|"none","browser":<path>|null}
# ("none" only with --no-browser-fallback, or when nothing could be opened at
# all), and exits non-zero only when nothing was opened -- so a caller may
# safely fall back to its own `open` on a failure without ever opening Granted
# twice (scripts/macos/granted-tray.sh's open_granted does exactly that).
#
# The preference lives in ~/Library/Application Support/Granted/settings.json
# as { "openIn": "window" | "browser" } (default: window) -- the same file,
# and the same key, Windows keeps in %LOCALAPPDATA%\Granted\settings.json.
# The GUI installer (installer/src/main/ipcPure.ts), the app
# (scaffold/lib/appUpdate/install.ts settingsPath()) and the menu-bar helper
# all read and write that one file.
#
# Test-only overrides:
#   GRANTED_SETTINGS_PATH       the settings file
#   GRANTED_APP_BROWSER         the app-mode browser ("none" = pretend there isn't one)
#   GRANTED_APP_BROWSER_DIRS    colon-separated folders to look for browsers in,
#                               instead of /Applications and ~/Applications
#   GRANTED_APP_BROWSER_MDFIND  the mdfind to ask Spotlight with ("none" = don't)
#   GRANTED_OPEN_CMD            what opens a browser tab (instead of `open`)
#   GRANTED_NODE                the node binary used to read and write the settings JSON
set -euo pipefail

SETTINGS_PATH="${GRANTED_SETTINGS_PATH:-$HOME/Library/Application Support/Granted/settings.json}"

URL=""
NO_BROWSER_FALLBACK=0
SET_OPEN_IN=""
GET_OPEN_IN=0
FIND_BROWSER=0

usage() {
  printf 'usage: open-granted.sh --url <http(s) URL> [--no-browser-fallback]\n' >&2
  printf '       open-granted.sh --set-open-in window|browser | --get-open-in | --find-browser\n' >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --no-browser-fallback) NO_BROWSER_FALLBACK=1; shift ;;
    --set-open-in) SET_OPEN_IN="${2:-}"; shift 2 ;;
    --get-open-in) GET_OPEN_IN=1; shift ;;
    --find-browser) FIND_BROWSER=1; shift ;;
    *) printf 'open-granted.sh: unknown option %s\n' "$1" >&2; usage; exit 64 ;;
  esac
done

# --- the settings file -----------------------------------------------------
# Read and written with node, not with sed or plutil, for one reason: the
# installer and the app parse this file with JSON.parse, and this script must
# never disagree with them about a hand-edited one. Node's JSON.parse here IS
# theirs, so `{"openIn":["browser"]}`, `{"OpenIn":"browser"}` and
# `{"openIn":"Browser"}` all mean "window" in every reader at once, and a
# nested setting survives a write. (plutil, the only JSON tool guaranteed to
# be in the base system, parses JSON by its own rules -- close, but not the
# same program, which is exactly the drift the Windows script's own comment
# warns about.) Node is always present in a Granted install: the server it
# opens is `npm run dev`.
node_bin() {
  if [ -n "${GRANTED_NODE:-}" ]; then printf '%s' "$GRANTED_NODE"; return 0; fi
  command -v node 2>/dev/null || true
}

READ_OPEN_IN_JS='
const fs = require("node:fs");
let value = null;
try {
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed.openIn;
} catch {}
process.stdout.write(value === "browser" ? "browser" : "window");
'

# The settings file with openIn set, everything else in it kept -- the
# installer's withOpenInSetting, in the installer's own JSON. Written to a
# temp file in the same folder and renamed over the target, so a reader (the
# app, the tray, another copy of this script) can never see a half-written
# file; the rename is atomic within a folder.
WRITE_OPEN_IN_JS='
const fs = require("node:fs");
const path = require("node:path");
const [file, mode] = process.argv.slice(1);
let settings = {};
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
} catch {}
fs.mkdirSync(path.dirname(file), { recursive: true });
const temp = file + ".tmp" + process.pid;
fs.writeFileSync(temp, JSON.stringify({ ...settings, openIn: mode }), "utf8");
fs.renameSync(temp, file);
'

# "window" unless the file says, in exactly those letters, "browser" --
# including when there is no file, no node, or nothing readable in it, which
# is the same default Windows falls back to on an unreadable file.
read_open_in() {
  local node out
  node="$(node_bin)"
  if [ -z "$node" ]; then printf 'window'; return 0; fi
  out="$("$node" -e "$READ_OPEN_IN_JS" "$SETTINGS_PATH" 2>/dev/null || true)"
  case "$out" in
    browser) printf 'browser' ;;
    *) printf 'window' ;;
  esac
}

write_open_in() {
  local node
  node="$(node_bin)"
  if [ -z "$node" ]; then
    printf 'open-granted.sh: node is needed to save that setting, and is not on PATH\n' >&2
    return 1
  fi
  "$node" -e "$WRITE_OPEN_IN_JS" "$SETTINGS_PATH" "$1"
}

# --- finding Chrome or Edge ------------------------------------------------
# Chrome first, then Edge -- the reverse of the Windows script's order, on
# purpose. There, Edge comes first because it ships with Windows 10/11, so it
# is the one that is certainly there. On macOS neither browser is
# pre-installed and Chrome is by far the more common of the two, which is also
# the order the work order names them in ("Chrome or Edge").
#
# Each candidate is "<path inside the .app>|<bundle id>".
BROWSERS='Google Chrome.app/Contents/MacOS/Google Chrome|com.google.Chrome
Microsoft Edge.app/Contents/MacOS/Microsoft Edge|com.microsoft.edgemac'

# Where to look. /Applications is where both installers put themselves;
# ~/Applications is the per-user folder a Chrome installed without admin
# rights lands in. Both are standard macOS locations, so a plain path test
# covers every ordinary install, needs no Spotlight and cannot be slow.
app_dirs() {
  if [ -n "${GRANTED_APP_BROWSER_DIRS:-}" ]; then
    printf '%s' "$GRANTED_APP_BROWSER_DIRS" | tr ':' '\n'
  else
    printf '/Applications\n%s\n' "${HOME:-}/Applications"
  fi
}

# Spotlight, for a browser that lives somewhere else entirely (moved to a
# subfolder of /Applications, run from an external disk, ...). Secondary and
# best effort on purpose: Spotlight indexing can be turned off, and an
# unanswered query is not an error -- the fixed paths above are the primary
# mechanism. Not `lsregister`, which is a private binary inside
# CoreServices.framework with no stable path or output.
mdfind_bundle() {
  local md
  md="${GRANTED_APP_BROWSER_MDFIND:-mdfind}"
  [ "$md" = "none" ] && return 1
  command -v "$md" >/dev/null 2>&1 || return 1
  "$md" -0 "kMDItemCFBundleIdentifier == '$1'" 2>/dev/null | tr '\0' '\n' | sed -n '1p'
}

# The app-mode browser to use, or failure if there is none.
find_app_browser() {
  local dirs entry relative bundle dir candidate app
  if [ -n "${GRANTED_APP_BROWSER:-}" ]; then
    [ "$GRANTED_APP_BROWSER" = "none" ] && return 1
    printf '%s' "$GRANTED_APP_BROWSER"
    return 0
  fi
  dirs="$(app_dirs)"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    relative="${entry%%|*}"
    bundle="${entry##*|}"
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      candidate="$dir/$relative"
      if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    done <<EOF
$dirs
EOF
    app="$(mdfind_bundle "$bundle" || true)"
    if [ -n "$app" ]; then
      # "Google Chrome.app/Contents/MacOS/Google Chrome" -> "Contents/MacOS/Google Chrome"
      candidate="$app/${relative#*.app/}"
      if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    fi
  done <<EOF
$BROWSERS
EOF
  return 1
}

# Start the browser detached, holding none of this script's handles: a freshly
# started browser lives on, and must not keep the caller's stdout pipe open
# (the installer waits for this script's output). The macOS counterpart of
# Windows's Start-Process/ShellExecute.
#
# The argument is one argv entry, `--app=<url>`, passed straight to execve --
# it is never re-parsed by a shell, so the URL cannot turn into further
# browser arguments however it is spelled (and valid_url below has already
# refused anything with whitespace or quotes in it anyway).
open_app_window() {
  [ -x "$1" ] || return 1
  nohup "$1" "--app=$URL" >/dev/null 2>&1 </dev/null &
  return 0
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# --- the preference subcommands --------------------------------------------
if [ -n "$SET_OPEN_IN" ]; then
  case "$SET_OPEN_IN" in
    window|browser) ;;
    *) printf 'open-granted.sh: --set-open-in must be window or browser\n' >&2; exit 64 ;;
  esac
  write_open_in "$SET_OPEN_IN"
  exit 0
fi

if [ "$GET_OPEN_IN" = "1" ]; then
  printf '{"openIn":"%s"}\n' "$(read_open_in)"
  exit 0
fi

if [ "$FIND_BROWSER" = "1" ]; then
  find_app_browser || true
  printf '\n'
  exit 0
fi

# --- opening Granted -------------------------------------------------------
# A whole, absolute http(s) URL with nothing in it that could become another
# browser argument or confuse `open`. Exactly what the Windows script refuses:
# anything that isn't http(s), and anything containing whitespace or a quote.
if [ -z "$URL" ]; then usage; exit 64; fi
case "$URL" in
  http://*|https://*) ;;
  *) printf 'open-granted.sh: --url must be an http(s) URL\n' >&2; exit 64 ;;
esac
case "$URL" in
  *[[:space:]]*|*'"'*|*"'"*|*'\'*|*'`'*|*'$'*)
    printf 'open-granted.sh: --url must be an http(s) URL\n' >&2; exit 64 ;;
esac

OPENED_IN="none"
BROWSER=""
if [ "$(read_open_in)" = "window" ]; then
  BROWSER="$(find_app_browser || true)"
  if [ -n "$BROWSER" ]; then
    if open_app_window "$BROWSER"; then OPENED_IN="window"; else BROWSER=""; fi
  fi
fi
if [ "$OPENED_IN" = "none" ] && [ "$NO_BROWSER_FALLBACK" != "1" ]; then
  # The user's default browser, in an ordinary tab -- Safari on a stock Mac.
  if "${GRANTED_OPEN_CMD:-open}" "$URL" >/dev/null 2>&1; then OPENED_IN="browser"; fi
fi

if [ -n "$BROWSER" ]; then
  printf '{"openedIn":"%s","browser":%s}\n' "$OPENED_IN" "$(json_string "$BROWSER")"
else
  printf '{"openedIn":"%s","browser":null}\n' "$OPENED_IN"
fi

# Non-zero only when nothing was opened AND opening something was asked for,
# so a caller's own fallback never opens Granted a second time.
if [ "$OPENED_IN" = "none" ] && [ "$NO_BROWSER_FALLBACK" != "1" ]; then exit 1; fi
exit 0
