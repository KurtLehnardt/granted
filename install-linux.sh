#!/usr/bin/env bash
# Granted — one-shot Linux installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh)"
#
# Deliberately not `curl ... | bash`: this script shells out to the system
# package manager (apt/dnf/yum), which can read from stdin during its own
# install -- when this script's own source is arriving on that same stdin
# pipe, the package manager can silently steal bytes meant for the rest of
# the script (bash reads a piped script incrementally, not all at once),
# truncating everything after that point with no error and a 0 exit code.
# `bash -c "$(curl ...)"` hands the whole script to bash as an already-fully-
# read string argument instead, so it's never competing with anything for
# stdin. Don't revert this.
#
# Installs git + Node.js 22+ if missing (apt/dnf/yum), clones the repo, and
# runs `npm ci` (installs exactly what's pinned in package-lock.json, and never
# rewrites it). Safe to re-run: skips anything already present/done (npm ci does
# remove and reinstall node_modules each time, which is expected).
#
# After this finishes, `cd granted/scaffold` and run `npm run setup` (an
# OpenAI or Claude key for scoring; search needs no key) or `npm run
# setup:local -- --yes` (fully local via Ollama), then `npm run dev`.
set -euo pipefail

REPO_URL="https://github.com/KurtLehnardt/granted.git"
TARGET_DIR="${GRANTED_INSTALL_DIR:-granted}"
NODE_MAJOR_MIN=22

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

log "Granted — Linux install"

# 1) Package manager.
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v pacman >/dev/null 2>&1; then PM=pacman
else
  die "No supported package manager found (need apt-get, dnf, yum, or pacman). Install Node.js ${NODE_MAJOR_MIN}+ and git manually — see the README's Linux section."
fi
ok "Detected package manager: $PM"

SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "Need root or sudo to install packages."
  fi
fi

# Runs "$@" as root, preserving the environment (-E) — but only passes -E when
# actually invoking sudo. `$SUDO -E "$@"` breaks when SUDO is empty (already
# root): the bare "-E" is left as the first word and bash tries to execute a
# program named "-E".
as_root() {
  if [ -n "$SUDO" ]; then sudo -E "$@"; else "$@"; fi
}

# 2) git.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
else
  log "Installing git..."
  case "$PM" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y git ;;
    dnf) $SUDO dnf install -y git ;;
    yum) $SUDO yum install -y git ;;
    pacman) $SUDO pacman -Sy --needed --noconfirm git ;;
  esac
  ok "git installed ($(git --version))"
fi

# 3) Node.js 22+.
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
  log "Installing Node.js ${NODE_MAJOR_MIN}..."
  case "$PM" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO dnf install -y nodejs
      ;;
    yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | as_root bash -
      $SUDO yum install -y nodejs
      ;;
    pacman)
      # Arch is rolling-release and its `nodejs` package tracks current
      # upstream, already well above NODE_MAJOR_MIN -- no nodesource-style
      # version-pinned setup script needed here.
      $SUDO pacman -Sy --needed --noconfirm nodejs npm
      ;;
  esac
  ok "node installed ($(node -v))"
fi

# 4) Clone (skip if already present). Checked via scaffold/package.json, not a
# bare .git dir — a clone interrupted mid-checkout leaves .git present but no
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

# 5) npm ci -- never rewrites package-lock.json (unlike npm install).
cd "$TARGET_DIR/scaffold"
log "Installing npm dependencies..."
# onnxruntime-node (the built-in search model's runtime) otherwise downloads
# its CUDA GPU add-on on linux/x64, several hundred MB that search never uses.
export ONNXRUNTIME_NODE_INSTALL=skip
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

log "Done. Next steps:"
echo "  cd $TARGET_DIR/scaffold"
echo "  npm run setup                  # an OpenAI or Claude key for scoring (search needs none), or"
echo "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
echo "  npm run dev                    # -> http://localhost:3000"
