#!/usr/bin/env bash
# Granted -- one-shot macOS installer.
#
#   curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh | bash
#
# Installs Homebrew (if missing), then git + Node.js 20+ via brew if missing,
# clones the repo, and runs `npm install`. Safe to re-run: skips anything
# already present/done.
#
# After this finishes, `cd granted/scaffold` and run `npm run setup` (hosted
# API keys) or `npm run setup:local -- --yes` (fully local via Ollama), then
# `npm run dev`.
set -euo pipefail

REPO_URL="https://github.com/KurtLehnardt/granted.git"
TARGET_DIR="${GRANTED_INSTALL_DIR:-granted}"
NODE_MAJOR_MIN=20

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

log "Granted -- macOS install"

if [ "$(uname -s)" != "Darwin" ]; then
  die "This script is for macOS. See the README's Linux/Windows sections instead."
fi

# Homebrew's own install path differs by chip (Apple Silicon vs Intel); once
# installed it prints/symlinks into one of these -- if brew is already on
# PATH we don't care which.
BREW_BIN=""
if command -v brew >/dev/null 2>&1; then
  BREW_BIN="$(command -v brew)"
elif [ -x /opt/homebrew/bin/brew ]; then
  BREW_BIN=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
  BREW_BIN=/usr/local/bin/brew
fi

if [ -n "$BREW_BIN" ]; then
  ok "Homebrew already installed ($($BREW_BIN --version | head -1))"
else
  log "Installing Homebrew..."
  # NONINTERACTIVE=1 is Homebrew's own documented unattended-install switch --
  # without it the installer waits on a RETURN keypress even with stdin piped.
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then
    BREW_BIN=/opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then
    BREW_BIN=/usr/local/bin/brew
  else
    die "Homebrew install finished but brew isn't at /opt/homebrew/bin or /usr/local/bin -- open a new shell and re-run."
  fi
  # Homebrew's own installer prints a "next steps" eval line to add itself to
  # PATH permanently (for future shells); make it available in THIS process too.
  eval "$($BREW_BIN shellenv)"
  ok "Homebrew installed ($($BREW_BIN --version | head -1))"
fi

# eval shellenv again even if brew pre-existed -- harmless if already on PATH,
# and guarantees `brew`-installed git/node land on PATH for the rest of this
# script without requiring a new shell.
eval "$($BREW_BIN shellenv)"

# Persist brew on PATH for the user's NEXT shell too. Homebrew's own installer
# only does this when it detects an interactive TTY -- under `curl | bash`
# (this script's own documented usage) stdin is the pipe, not a TTY, so it
# silently skips it. Without this, `eval $(brew shellenv)` only ever applied
# to this script's own short-lived subshell: the moment it exits, a brand new
# terminal (exactly what a user opens right after running this) has no brew,
# git, or node on PATH at all, despite the "next steps" message below telling
# them to just run npm commands.
SHELL_PROFILE=""
case "${SHELL:-}" in
  */zsh) SHELL_PROFILE="$HOME/.zprofile" ;;
  */bash) SHELL_PROFILE="$HOME/.bash_profile" ;;
esac
if [ -n "$SHELL_PROFILE" ]; then
  SHELLENV_LINE="eval \"\$($BREW_BIN shellenv)\""
  if [ ! -f "$SHELL_PROFILE" ] || ! grep -qF "brew shellenv" "$SHELL_PROFILE"; then
    printf '\n# Added by the Granted installer\n%s\n' "$SHELLENV_LINE" >> "$SHELL_PROFILE"
    ok "added Homebrew to PATH in $SHELL_PROFILE (open a new terminal, or run: source $SHELL_PROFILE)"
  fi
else
  warn "unrecognized \$SHELL ($SHELL) -- add 'eval \"\$($BREW_BIN shellenv)\"' to your shell's profile manually"
fi

# 1) git.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
else
  log "Installing git..."
  "$BREW_BIN" install git
  if ! command -v git >/dev/null 2>&1; then die "git install finished but 'git' still isn't on PATH -- open a new shell and re-run."; fi
  ok "git installed ($(git --version))"
fi

# 2) Node.js 20+.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  case "$NODE_MAJOR" in
    ''|*[!0-9]*)
      warn "couldn't parse a version from 'node -v' ($(node -v)) -- installing ${NODE_MAJOR_MIN} to be safe"
      ;;
    *)
      if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ]; then
        ok "node already installed ($(node -v))"
        NODE_OK=1
      else
        warn "node $(node -v) is older than ${NODE_MAJOR_MIN} -- installing a newer one"
      fi
      ;;
  esac
fi
if [ "$NODE_OK" -ne 1 ]; then
  log "Installing Node.js..."
  "$BREW_BIN" install node
  if ! command -v node >/dev/null 2>&1; then die "node install finished but 'node' still isn't on PATH -- open a new shell and re-run."; fi
  ok "node installed ($(node -v))"
fi

# 3) Clone (skip if already present). Checked via scaffold/package.json, not a
# bare .git dir -- a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet. If $TARGET_DIR exists but isn't a finished clone,
# `git clone` below fails with its own clear "already exists" error rather
# than this script guessing whether it's safe to delete.
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

log "Done. Next steps:"
if [ -n "$SHELL_PROFILE" ]; then
  echo "  Open a new terminal window (or run: source $SHELL_PROFILE) so 'npm' is on PATH, then:"
fi
echo "  cd $TARGET_DIR/scaffold"
echo "  npm run setup                  # hosted API keys (OpenAI + Anthropic), or"
echo "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
echo "  npm run dev                    # -> http://localhost:3000"
