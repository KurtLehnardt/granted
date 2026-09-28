#!/usr/bin/env bash
# Granted — one-shot macOS installer.
#
#   curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh | bash
#
# Installs git + Node.js 22+ if missing, clones the repo, runs `npm install`,
# and (optionally) installs Ollama for a fully local run. Safe to re-run: skips
# anything already present/done.
#
# After this finishes, `cd granted/scaffold` and run `npm run setup` (cloud
# API keys) or `npm run setup:local -- --yes` (fully local via Ollama), then
# `npm run dev`.
set -euo pipefail

REPO_URL="https://github.com/KurtLehnardt/granted.git"
TARGET_DIR="${GRANTED_INSTALL_DIR:-granted}"
NODE_MAJOR_MIN=22
# Lowest macOS major version Ollama's .app/.dmg (and the Homebrew cask) support.
# Keep in sync with OLLAMA_MIN_MACOS in scaffold/scripts/setup-local.mjs.
OLLAMA_MIN_MACOS=14
OLLAMA_TGZ_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
OLLAMA_PREFIX="${GRANTED_OLLAMA_PREFIX:-$HOME/.local/ollama}"

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

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
# non-login shell (which is what `curl ... | bash` gets). Look in both places so
# we don't wrongly conclude brew is missing and send the user down a slower path.
if ! command -v brew >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && eval "$("$candidate" shellenv)" && break
  done
fi
if command -v brew >/dev/null 2>&1; then
  HAVE_BREW=1
  ok "Homebrew found ($(brew --prefix))"
else
  HAVE_BREW=0
  warn "Homebrew not found — will use Apple's tools and nodejs.org instead"
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
    # This needs sudo, so it only works in an interactive shell — a piped
    # `curl | bash` has no TTY to prompt on.
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

# 3) Clone (skip if already present). Checked via scaffold/package.json, not a
# bare .git dir — a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet.
if [ -f "$TARGET_DIR/scaffold/package.json" ]; then
  ok "$TARGET_DIR already cloned"
else
  log "Cloning $REPO_URL into ./$TARGET_DIR ..."
  git clone "$REPO_URL" "$TARGET_DIR"
  ok "cloned"
fi

# 4) npm install.
cd "$TARGET_DIR/scaffold"
log "Installing npm dependencies..."
npm install
ok "dependencies installed"

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

log "Done. Next steps:"
echo "  cd $TARGET_DIR/scaffold"
echo "  npm run setup                  # cloud API keys (OpenAI + Anthropic), or"
echo "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
echo "  npm run dev                    # -> http://localhost:3000"
if [ "$MACOS_MAJOR" -gt 0 ] && [ "$MACOS_MAJOR" -lt "$OLLAMA_MIN_MACOS" ]; then
  echo
  echo "  Going local on this macOS? Start the daemon first, in another terminal:"
  echo "    ollama serve"
fi
