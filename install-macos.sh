#!/usr/bin/env bash
# Granted — one-shot macOS installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh)"
#
# Deliberately not `curl ... | bash`: this script shells out
# to `brew install` more than once, and Homebrew's own progress renderer reads
# from stdin -- when this script's own source is arriving on that same stdin
# pipe, brew can silently steal bytes meant for the rest of the script (bash
# reads a piped script incrementally, not all at once), truncating everything
# after that point with no error and a 0 exit code. `bash -c "$(curl ...)"`
# hands the whole script to bash as an already-fully-read string argument
# instead, so it's never competing with anything for stdin. Don't revert this.
#
# Installs git + Node.js 22+ if missing, clones the repo, runs `npm ci`
# (installs exactly what's pinned in package-lock.json, and never rewrites it),
# and (optionally) installs Ollama for a fully local run. Safe to re-run: skips
# anything already present/done (npm ci does remove and reinstall node_modules
# each time, which is expected).
#
# After this finishes, `cd granted/scaffold` and run `npm run setup` (an
# OpenAI or Claude key for scoring; search needs no key) or `npm run
# setup:local -- --yes` (fully local via Ollama), then `npm run dev`.
#
# Set GRANTED_REF to a release tag (v1.2.3) to install that release instead
# of main.
set -euo pipefail
set -o errtrace

# Reports real progress back to the Electron GUI, the same mechanism and for
# the same reason as install-windows.ps1's (see that script's own header
# comment for the full story): $GRANTED_STATUS_FILE is set by the GUI to a
# path it's already polling; this falls back to a fixed name so the script
# still no-ops safely run standalone (copy-pasted into a terminal by hand, as
# the README documents). write_status's JSON shape -- {state,message,pid} --
# is read by the exact same installer/src/main/ipcPure.ts
# parseInstallStatusJson Windows's does.
STATUS_PATH="${GRANTED_STATUS_FILE:-${TMPDIR:-/tmp}/granted-install-status.json}"
# macOS ships no flock(1) (a Linux util-linux tool, not part of the base
# system) to hold a real exclusive lock the way install-windows.ps1 does
# with a file handle, so a directory stands in for it: `mkdir` either
# creates it or fails if it's already there, atomically, with no race
# window either way. Removed in the EXIT trap below, so it comes down the
# moment this process ends, however it ends (done, error, or the Terminal
# window closed outright, which sends SIGTERM) -- except SIGKILL, which no
# trap can catch; a poller that finds the directory still there then falls
# back to checking the recorded pid directly (see openGranted.ts's
# isStatusWindowAlive). Must stay in sync with installer/src/main/ipcPure.ts's
# macStatusLockPath -- a test checks.
STATUS_LOCK_DIR="${STATUS_PATH}.lock.d"
mkdir "$STATUS_LOCK_DIR" 2>/dev/null || true

write_status() {
  local state="$1" message="$2" tmp escaped
  tmp="$(mktemp "${STATUS_PATH}.XXXXXX" 2>/dev/null)" || return 0
  escaped="null"
  if [ -n "$message" ]; then
    escaped="\"$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
  fi
  if printf '{"state":"%s","message":%s,"pid":%d}' "$state" "$escaped" "$$" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATUS_PATH" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
    printf '  \033[33m!\033[0m %s\n' "Couldn't write install status to $STATUS_PATH" >&2
  fi
}

cleanup() { rmdir "$STATUS_LOCK_DIR" 2>/dev/null || true; }
# NOTE (non-blocking, flagged in review): this rmdir's unconditional,
# regardless of whether this process's own mkdir above actually succeeded.
# If two installs ever shared the exact same fixed STATUS_PATH (never
# happens from the real GUI flow, which always mints a fresh UUID path per
# launch), the second one's cleanup would remove the FIRST one's still-held
# lock out from under it. Low real-world risk given the fixed-name path is
# only ever hit when run standalone outside the GUI; not fixed here since
# that's a bigger change (tracking whether our own mkdir won) than this
# review round called for.
trap cleanup EXIT

# Catches anything die() doesn't -- a command that fails outright (set -e's
# trigger) would otherwise unwind straight out of the script with the status
# file still stuck on "running" forever. bash's nearest equivalent to
# PowerShell's $ErrorActionPreference = "Stop" + trap (install-windows.ps1
# has both; this script had neither before). `exit 1` inside die() does NOT
# re-trigger this (confirmed: bash does not run the ERR trap for an explicit
# `exit`, only for a command whose own nonzero status would trip `set -e`),
# so there's no risk of a double report -- same as install-windows.ps1's Die().
on_error() {
  local line="$1"
  write_status "error" "Failed at line $line: $BASH_COMMAND"
  printf '  \033[31mx\033[0m %s\n' "Failed: $BASH_COMMAND" >&2
  exit 1
}
trap 'on_error $LINENO' ERR

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { write_status "error" "$1"; printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

write_status "running" ""

# GRANTED_REPO_URL: tests point this at a local repo (mirrors
# install-windows.ps1's identical override).
REPO_URL="${GRANTED_REPO_URL:-https://github.com/KurtLehnardt/granted.git}"
TARGET_DIR="${GRANTED_INSTALL_DIR:-granted}"
NODE_MAJOR_MIN=22
# Lowest macOS major version Ollama's .app/.dmg (and the Homebrew cask) support.
# Keep in sync with OLLAMA_MIN_MACOS in scaffold/scripts/setup-local.mjs.
OLLAMA_MIN_MACOS=14
OLLAMA_TGZ_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
OLLAMA_PREFIX="${GRANTED_OLLAMA_PREFIX:-$HOME/.local/ollama}"

# GRANTED_REF: install this release (a tag like v1.2.3) instead of the
# latest code on main -- same rule as install-windows.ps1's. An install made
# by this script is moved to it on a re-run.
GRANTED_REF="${GRANTED_REF:-}"
if [ -n "$GRANTED_REF" ] && [[ ! "$GRANTED_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "GRANTED_REF must be a release tag like v1.2.3 (got '$GRANTED_REF')."
fi

log "Granted — macOS install"

# 0) Confirm we're actually on macOS, and learn the version/arch. Everything
#    below (Homebrew prefix, the Ollama split) keys off these two facts.
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux use install-linux.sh; on Windows use install-windows.ps1."

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo "")"
MACOS_MAJOR="$(printf '%s' "$MACOS_VERSION" | cut -d. -f1)"
case "$MACOS_MAJOR" in ''|*[!0-9]*) MACOS_MAJOR=0 ;; esac
ARCH="$(uname -m)"
if [ "$MACOS_MAJOR" -gt 0 ]; then
  ok "macOS $MACOS_VERSION ($ARCH)"
else
  warn "couldn't read a macOS version from sw_vers — continuing with generic guidance"
fi

# Homebrew lives at a different prefix per architecture and is NOT on PATH in a
# non-login shell (which is what this one-liner runs as, even when pasted into
# an interactive terminal). Look in both places so
# we don't wrongly conclude brew is missing and send the user down a slower path.
# (Used both here and after a fresh bootstrap below -- kept as one function so
# the two call sites can't drift apart.)
find_and_activate_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      return 0
    fi
  done
  return 1
}

find_and_activate_brew || true
if command -v brew >/dev/null 2>&1; then
  HAVE_BREW=1
  ok "Homebrew found ($(brew --prefix))"
elif [ -t 0 ]; then
  # No Homebrew, but we're attached to a real terminal -- e.g. the documented
  # one-liner (`bash -c "$(curl -fsSL ...)"`) run interactively, which
  # inherits the caller's own stdin rather than a pipe: the git/Node
  # fallbacks below can prompt for a sudo password and actually get an
  # answer, so it's fine to skip Homebrew here if the user would rather not
  # install it.
  HAVE_BREW=0
  warn "Homebrew not found — will use Apple's tools and nodejs.org instead"
else
  # No Homebrew AND no TTY -- a genuinely non-interactive invocation (CI, a
  # cron job, a non-tty SSH session, or the one-liner piped/redirected rather
  # than run interactively). The fallbacks below need sudo to prompt on a
  # real terminal, which none of those have, so without Homebrew this path
  # cannot finish unattended at all. Bootstrap Homebrew instead of dying with
  # a "re-run this by hand"
  # message -- but its own NONINTERACTIVE installer still needs *some* sudo
  # access to create /opt/homebrew (Apple Silicon) or use /usr/local (Intel)
  # on a brand new Mac; it just refuses to prompt for it (`sudo -n`) rather
  # than skipping the requirement entirely. Check that up front so a Mac with
  # no cached/passwordless sudo gets a clear, actionable message instead of
  # Homebrew's own context-free "Insufficient permissions" abort.
  if ! sudo -n true 2>/dev/null; then
    die "Installing Homebrew (needed to finish this without a terminal to prompt on) needs sudo, and this session has no cached sudo credential. Either run 'sudo -v' once in this terminal first and re-run this one-liner within a few minutes, or don't pipe it -- download and run it directly so it has a terminal to prompt through: curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh -o install-macos.sh && bash install-macos.sh"
  fi
  log "No Homebrew and no terminal to prompt through — installing Homebrew (needed for an unattended install)..."
  # Fetched into a variable first and checked explicitly: a failure INSIDE a
  # $(...) substitution doesn't trip `set -e` on its own -- it would just
  # silently hand bash an empty string to run as a no-op.
  INSTALL_SCRIPT="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Couldn't download the Homebrew installer -- check your network connection and re-run."
  NONINTERACTIVE=1 /bin/bash -c "$INSTALL_SCRIPT"
  find_and_activate_brew || true
  command -v brew >/dev/null 2>&1 || die "Homebrew install finished but brew isn't on PATH -- open a new terminal and re-run."
  HAVE_BREW=1
  ok "Homebrew installed ($(brew --prefix))"

  # Persist it for the user's NEXT shell too -- otherwise the moment this
  # script exits, a brand new terminal (what the final "next steps" message
  # below assumes) has no brew/git/node on PATH at all, since Homebrew's own
  # installer only offers to do this when it detects an interactive TTY.
  SHELL_PROFILE=""
  case "${SHELL:-}" in
    */zsh) SHELL_PROFILE="$HOME/.zprofile" ;;
    */bash) SHELL_PROFILE="$HOME/.bash_profile" ;;
  esac
  if [ -n "$SHELL_PROFILE" ]; then
    SHELLENV_LINE="eval \"\$($(command -v brew) shellenv)\""
    if [ ! -f "$SHELL_PROFILE" ] || ! grep -qF "$SHELLENV_LINE" "$SHELL_PROFILE"; then
      printf '\n# Added by the Granted installer\n%s\n' "$SHELLENV_LINE" >> "$SHELL_PROFILE"
      ok "added Homebrew to PATH in $SHELL_PROFILE (open a new terminal, or run: source $SHELL_PROFILE)"
    fi
  else
    warn "unrecognized \$SHELL (${SHELL:-<unset>}) -- add 'eval \"\$(brew shellenv)\"' to your shell's profile manually"
  fi
fi

# 1) git. Ships with the Xcode Command Line Tools; `xcode-select --install`
#    opens a GUI installer we can't drive from here, so we trigger it and stop
#    rather than pretending to continue.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
elif [ "$HAVE_BREW" -eq 1 ]; then
  log "Installing git via Homebrew..."
  brew install git
  ok "git installed ($(git --version))"
else
  log "Installing the Xcode Command Line Tools (provides git)..."
  xcode-select --install >/dev/null 2>&1 || true
  die "Finish the 'Command Line Tools' install dialog that just opened, then re-run this script."
fi

# 2) Node.js 22+.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  case "$NODE_MAJOR" in
    ''|*[!0-9]*)
      warn "couldn't parse a version from 'node -v' ($(node -v)) — installing ${NODE_MAJOR_MIN} to be safe"
      ;;
    *)
      if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ]; then
        ok "node already installed ($(node -v))"
        NODE_OK=1
      else
        warn "node $(node -v) is older than ${NODE_MAJOR_MIN} — installing a newer one"
      fi
      ;;
  esac
fi
if [ "$NODE_OK" -ne 1 ]; then
  if [ "$HAVE_BREW" -eq 1 ]; then
    log "Installing Node.js via Homebrew..."
    brew install node
  else
    # No Homebrew: use Apple's own installer with the official universal .pkg.
    # This needs sudo, so it only works in an interactive shell — a
    # non-interactive invocation has no TTY to prompt on.
    log "Installing Node.js ${NODE_MAJOR_MIN}+ from nodejs.org..."
    [ -t 0 ] || die "Node.js ${NODE_MAJOR_MIN}+ is required and installing it needs sudo, which can't prompt through a pipe. Install Node from https://nodejs.org (or install Homebrew), then re-run this script."
    PKG_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR_MIN}.x/"
    # Fetched into a variable first, and the first match taken with `sed -n 1p`
    # rather than `head -1`: under `set -o pipefail`, head closing the pipe
    # early can SIGPIPE the upstream process and abort the whole script.
    PKG_INDEX="$(curl -fsSL "$PKG_URL")" || die "Couldn't reach $PKG_URL — install Node from https://nodejs.org and re-run."
    # nodejs.org lists hrefs as ABSOLUTE paths ("/dist/latest-v22.x/node-v22.23.3.pkg"),
    # so match any leading directory and keep only the basename.
    PKG_NAME="$(printf '%s\n' "$PKG_INDEX" | sed -n 's|.*href="[^"]*/\(node-v[0-9.]*\.pkg\)".*|\1|p' | sed -n '1p')"
    [ -n "$PKG_NAME" ] || die "Couldn't find a Node .pkg at $PKG_URL — install Node from https://nodejs.org and re-run."
    TMP_PKG="$(mktemp -d)/$PKG_NAME"
    curl -fsSL -o "$TMP_PKG" "${PKG_URL}${PKG_NAME}"
    sudo installer -pkg "$TMP_PKG" -target /
    rm -f "$TMP_PKG"
    export PATH="/usr/local/bin:$PATH"
  fi
  command -v node >/dev/null 2>&1 || die "Node still isn't on PATH after installing. Open a new terminal and re-run this script."
  ok "node installed ($(node -v))"
fi

# The first x.y.z-shaped version number found anywhere in $1 (e.g. "v1.2.3"
# or the "0.2.0" a package.json's .version holds), empty if there isn't one.
# REGRESSION (review), reproduced live: under `set -o pipefail`, a `grep`
# that matches nothing (a missing/non-numeric installed version, e.g.
# "unknown") makes the whole pipeline exit nonzero even though `head`
# itself succeeded -- and a bare `HAVE="$(version_number ...)"` assignment
# is NOT exempt from `set -e`, so that alone aborted the entire script via
# the ERR trap, defeating the very next line's `[ -n "$HAVE" ] && ...`
# guard, which exists specifically to tolerate this. `|| true` here (not
# just at each call site) protects every current and future caller.
version_number() {
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
}
# Whether version $1 is newer than version $2 (both plain x.y.z strings from
# version_number -- this machine's sort -V, verified, handles the compare).
version_gt() {
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# PIDs of node/npm processes whose command line mentions $1 (an absolute
# path), excluding our own pid. REGRESSION (review): `pgrep -f` alone
# matches ANY process whose args happen to contain the path at all -- an
# editor with the folder open, a `tail -f`, `rg` -- and kill -9 on an
# editor can lose unsaved work. Narrowed the same way install-windows.ps1's
# Stop-GrantedIn is scoped: filtered to Name='powershell.exe'/
# Name='node.exe' AND the install path as a specific argument, not just
# anywhere in the command line -- here, the process name is checked on its
# own (via ps's columns) rather than folded into one pgrep pattern against
# the whole line.
#
# Checked two ways, not just `comm`: macOS's `ps` truncates the `comm`
# column to a short fixed width once it's combined with other `-o` fields
# (verified live -- a Homebrew node invoked via its real, long Cellar path
# showed up there as "/opt/homebrew/Ce", not "node"), which would silently
# never match a real node/npm process invoked that way. argv[0]'s basename,
# read from the (untruncated) args field instead, is the fallback.
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
      if (index(args, full) == 0) next;
      print pid;
    }
  '
}

# Stops a Granted this script is about to overwrite, so npm ci never runs
# under a server that holds its own files open. Lower-stakes than
# install-windows.ps1's Stop-GrantedIn (POSIX lets you replace a file a
# process still has open -- the old data just stays open under the old
# inode until that process closes it), but done explicitly anyway rather
# than relied on implicitly: matched the same way Stop-GrantedIn matches --
# by command line mentioning this install's own path, not by port (which
# may not even be known here) -- so it also catches a `npm run dev` left
# running in a plain terminal, not just a tray.
stop_granted_in() {
  local dir="$1" full pids deadline
  full="$(cd "$dir" 2>/dev/null && pwd -P)" || return 0
  pids="$(matching_pids "$full")"
  [ -z "$pids" ] && return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  deadline=$(($(date +%s) + 15))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pids="$(matching_pids "$full")"
    [ -z "$pids" ] && break
    sleep 1
  done
  pids="$(matching_pids "$full")"
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  ok "stopped the Granted that was running (it starts again when you open it)"
}

# 3) Clone (skip if already present). Checked via scaffold/package.json, not a
# bare .git dir — a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet.
EXISTING_INSTALL=0
if [ -f "$TARGET_DIR/scaffold/package.json" ]; then
  EXISTING_INSTALL=1
  ok "$TARGET_DIR already cloned"
  # Asked for a specific release: move an install THIS script made to it (an
  # update) -- never someone's own checkout (no marker), never over changes
  # made in the folder, and never backwards: an older installer run again
  # (or one whose update check failed) must not replace newer code. Same
  # rules as install-windows.ps1's.
  if [ -n "$GRANTED_REF" ]; then
    if [ ! -f "$TARGET_DIR/.git/granted-installer" ]; then
      warn "Not changing $TARGET_DIR to $GRANTED_REF -- it wasn't installed by this installer (your own checkout?)."
    elif [ -n "$(git -C "$TARGET_DIR" status --porcelain --untracked-files=no)" ]; then
      warn "Not changing $TARGET_DIR to $GRANTED_REF -- it has local changes."
    else
      # Just this tag, forced: a release tag that was moved on GitHub
      # (re-tagged after a fix) must not break updates, and a stale local
      # copy of it must not be what's installed.
      git -C "$TARGET_DIR" fetch --quiet --force origin "+refs/tags/${GRANTED_REF}:refs/tags/${GRANTED_REF}" \
        || die "Couldn't download Granted $GRANTED_REF (git fetch failed)."
      if git -C "$TARGET_DIR" merge-base --is-ancestor "refs/tags/$GRANTED_REF" HEAD; then
        ok "already includes Granted $GRANTED_REF -- nothing to update"
      else
        # REGRESSION (review): the installed version used to be read via
        # `node -p "require('./${TARGET_DIR}/...)...` -- string-interpolated
        # straight into the JS source. That breaks (throws, caught, and
        # $HAVE degrades to empty) whenever GRANTED_INSTALL_DIR is an
        # absolute path (require() only treats a BARE relative path like
        # "granted/scaffold/..." as a file path when it's given a leading
        # "./" -- an absolute GRANTED_INSTALL_DIR has neither) or contains a
        # quote character -- and an empty $HAVE silently skips the very
        # no-backwards-move guard two lines below promises never happens.
        # Resolved to an absolute path first, then passed through argv
        # (never spliced into the JS source), so neither can break it.
        ABS_TARGET_DIR="$(cd "$TARGET_DIR" 2>/dev/null && pwd -P)" || ABS_TARGET_DIR=""
        HAVE_RAW=""
        if [ -n "$ABS_TARGET_DIR" ]; then
          HAVE_RAW="$(node -e 'console.log(require(process.argv[1]).version)' "$ABS_TARGET_DIR/scaffold/package.json" 2>/dev/null)" || HAVE_RAW=""
        fi
        HAVE="$(version_number "$HAVE_RAW")"
        WANT="$(version_number "$GRANTED_REF")"
        if [ -n "$HAVE" ] && [ -n "$WANT" ] && version_gt "$HAVE" "$WANT" && [ "${GRANTED_ALLOW_DOWNGRADE:-}" != "1" ]; then
          warn "Not changing $TARGET_DIR to $GRANTED_REF -- it already has a newer Granted ($HAVE)."
        else
          log "Updating $TARGET_DIR to Granted $GRANTED_REF ..."
          stop_granted_in "$TARGET_DIR"
          git -C "$TARGET_DIR" -c advice.detachedHead=false checkout --quiet "refs/tags/$GRANTED_REF" \
            || die "Couldn't switch $TARGET_DIR to $GRANTED_REF (git checkout failed)."
          ok "now at $GRANTED_REF"
        fi
      fi
    fi
  fi
else
  log "Cloning $REPO_URL into ./$TARGET_DIR ..."
  if [ -n "$GRANTED_REF" ]; then
    # Clone, then check out the release tag -- not `clone --branch <tag>`,
    # which can warn about a tag not being a branch for an annotated tag, as
    # releases are (install-windows.ps1 avoids the same thing the same way).
    git clone --no-checkout "$REPO_URL" "$TARGET_DIR" \
      || die "git clone failed. If $TARGET_DIR was partially created, remove it before re-running."
    if ! git -C "$TARGET_DIR" -c advice.detachedHead=false checkout --quiet "refs/tags/$GRANTED_REF"; then
      # This run just created the folder (it held no install): remove it,
      # so a re-run isn't blocked by a half-made clone.
      rm -rf "$TARGET_DIR"
      die "Couldn't check out Granted $GRANTED_REF (is it a published release?)."
    fi
  else
    git clone "$REPO_URL" "$TARGET_DIR" \
      || die "git clone failed. If $TARGET_DIR was partially created, remove it before re-running."
  fi
  # Marks this clone as made by the installer (inside .git, so git never
  # sees it) -- same purpose as install-windows.ps1's marker.
  printf 'Cloned by install-macos.sh on %s\n' "$(date +"%Y-%m-%dT%H:%M:%S")" > "$TARGET_DIR/.git/granted-installer"
  ok "cloned"
fi

# 4) npm ci -- never rewrites package-lock.json (unlike npm install). A
# re-run (an update, say) while Granted is running: quit it first -- its
# server holds files in node_modules that npm ci is about to replace.
if [ "$EXISTING_INSTALL" = "1" ]; then stop_granted_in "$TARGET_DIR"; fi
cd "$TARGET_DIR/scaffold"
log "Installing npm dependencies..."
npm ci
ok "dependencies installed"

# The built-in search model (about 275 MB), so search works offline and needs
# no API key. Idempotent: verifies what's already there and downloads only
# what's missing. Never fatal: if it can't download now, Granted fetches the
# model the first time someone searches. GRANTED_MODEL_URL points it at a mirror.
if [ -f scripts/fetch-model.mjs ]; then
  log "Downloading the built-in search model (about 275 MB)..."
  if node scripts/fetch-model.mjs; then
    ok "search model ready"
  else
    warn "Couldn't download the search model now. Granted will download it the first time you search."
  fi
fi

# 5) Ollama (only needed for the fully-local path, so never fatal).
#
# This is the one step that genuinely differs on macOS. Ollama's .app/.dmg and
# its Homebrew cask are built for macOS 14+ (OLLAMA_MIN_MACOS); on an older Mac the
# download page hands you an app that won't launch, and Homebrew has dropped
# those releases entirely (no bottles), so `brew install ollama` fails too. The
# release's CLI tarball is a universal binary that DOES run there — it just has
# no .app wrapper, so the daemon must be started by hand and won't survive a
# reboot. We pick the right one instead of letting the user hit the wall.
log "Ollama (for the fully local, no-API-key path)"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama already installed ($(ollama --version 2>&1 | tail -1))"
elif [ "$MACOS_MAJOR" -gt 0 ] && [ "$MACOS_MAJOR" -lt "$OLLAMA_MIN_MACOS" ]; then
  warn "macOS $MACOS_VERSION is older than Ollama's app requires (${OLLAMA_MIN_MACOS}+) — installing the CLI build instead"
  mkdir -p "$OLLAMA_PREFIX"
  TMP_TGZ="$(mktemp -d)/ollama-darwin.tgz"
  curl -fsSL -o "$TMP_TGZ" "$OLLAMA_TGZ_URL"
  tar xzf "$TMP_TGZ" -C "$OLLAMA_PREFIX"
  rm -f "$TMP_TGZ"
  # Link into whichever bin dir is already writable, so this needs no sudo.
  LINKED=""
  for bindir in /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$bindir" ] && [ -w "$bindir" ]; then
      ln -sf "$OLLAMA_PREFIX/ollama" "$bindir/ollama"
      LINKED="$bindir"
      break
    fi
  done
  if [ -n "$LINKED" ]; then
    ok "ollama installed to $OLLAMA_PREFIX (linked into $LINKED)"
  else
    warn "installed to $OLLAMA_PREFIX but no writable bin dir to link into"
    warn "add it to PATH:  export PATH=\"$OLLAMA_PREFIX:\$PATH\""
  fi
  warn "no .app on this macOS — start the daemon yourself: 'ollama serve' (re-run after each reboot)"
elif [ "$HAVE_BREW" -eq 1 ]; then
  log "Installing Ollama via Homebrew..."
  if brew install ollama; then
    ok "ollama installed ($(ollama --version 2>&1 | tail -1))"
  else
    warn "brew install ollama failed — install it from https://ollama.com/download if you want the local path"
  fi
else
  warn "ollama not installed — get it from https://ollama.com/download if you want the fully local path"
fi

write_status "done" ""
# Run by the Granted installer app (it set GRANTED_STATUS_FILE): it takes it
# from here -- keys, local models, opening Granted -- so no terminal commands.
if [ -n "${GRANTED_STATUS_FILE:-}" ]; then
  log "Done. Granted is installed -- carry on in the Granted installer."
else
  log "Done. Next steps:"
  echo "  cd $TARGET_DIR/scaffold"
  echo "  npm run setup                  # an OpenAI or Claude key for scoring (search needs none), or"
  echo "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
  echo "  npm run dev                    # -> http://localhost:3000"
  if [ "$MACOS_MAJOR" -gt 0 ] && [ "$MACOS_MAJOR" -lt "$OLLAMA_MIN_MACOS" ]; then
    echo
    echo "  Going local on this macOS? Start the daemon first, in another terminal:"
    echo "    ollama serve"
  fi
fi
