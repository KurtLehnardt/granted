#!/usr/bin/env bash
# Granted — one-shot Linux installer.
#
#   curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh | bash
#
# Installs git + Node.js 20+ if missing (apt/dnf/yum), clones the repo, and
# runs `npm install`. Safe to re-run: skips anything already present/done.
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

log "Granted — Linux install"

# 1) Package manager.
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else
  die "No supported package manager found (need apt-get, dnf, or yum). Install Node.js ${NODE_MAJOR_MIN}+ and git manually — see the README's Linux section."
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

# 2) git.
if command -v git >/dev/null 2>&1; then
  ok "git already installed ($(git --version))"
else
  log "Installing git..."
  case "$PM" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y git ;;
    dnf) $SUDO dnf install -y git ;;
    yum) $SUDO yum install -y git ;;
  esac
  ok "git installed ($(git --version))"
fi

# 3) Node.js 20+.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ]; then
    ok "node already installed ($(node -v))"
    NODE_OK=1
  else
    warn "node $(node -v) is older than ${NODE_MAJOR_MIN} — installing a newer one"
  fi
fi
if [ "$NODE_OK" -ne 1 ]; then
  log "Installing Node.js ${NODE_MAJOR_MIN}..."
  case "$PM" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | $SUDO -E bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | $SUDO -E bash -
      $SUDO dnf install -y nodejs
      ;;
    yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | $SUDO -E bash -
      $SUDO yum install -y nodejs
      ;;
  esac
  ok "node installed ($(node -v))"
fi

# 4) Clone (skip if already present).
if [ -d "$TARGET_DIR/.git" ]; then
  ok "$TARGET_DIR already cloned"
else
  log "Cloning $REPO_URL into ./$TARGET_DIR ..."
  git clone "$REPO_URL" "$TARGET_DIR"
  ok "cloned"
fi

# 5) npm install.
cd "$TARGET_DIR/scaffold"
log "Installing npm dependencies..."
npm install
ok "dependencies installed"

log "Done. Next steps:"
echo "  cd $TARGET_DIR/scaffold"
echo "  npm run setup                  # hosted API keys (OpenAI + Anthropic), or"
echo "  npm run setup:local -- --yes   # fully local via Ollama, no API keys"
echo "  npm run dev                    # -> http://localhost:3000"
