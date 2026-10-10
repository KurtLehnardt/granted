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
# Installs git + Node.js 22+ if missing (apt/dnf/yum), clones the repo, and runs
# `npm ci` (installs exactly what's pinned in package-lock.json, and never
# rewrites it) and `npm run build` (the production build Granted is served
# from). Safe to re-run: skips anything already present/done (npm ci does
# remove and reinstall node_modules each time, and the build runs each time,
# which is expected).
#
# After this finishes, `cd granted/scaffold` and run `npm run setup` (an
# OpenAI or Claude key for scoring; search needs no key) or `npm run
# setup:local -- --yes` (fully local via Ollama), then `npm run build` (setup
# can change build-time NEXT_PUBLIC_* flags) and `npm run start`.
set -euo pipefail
set -o errtrace

# GRANTED_REPO_URL: lets this be pointed at a different repo (a fork, a
# mirror, or a local path for tests) -- same override install-macos.sh and
# install-windows.ps1 support, kept at this exact name so it works
# identically across all three installers.
REPO_URL="${GRANTED_REPO_URL:-https://github.com/KurtLehnardt/granted.git}"
TARGET_DIR="${GRANTED_INSTALL_DIR:-granted}"
NODE_MAJOR_MIN=22

# The nodesource setup script that deb.nodesource.com/rpm.nodesource.com
# serve dynamically -- the live URLs can serve different bytes tomorrow than
# they do today, so pinning to this fixed commit of nodesource/distributions
# instead: a raw.githubusercontent.com URL that names a commit SHA (rather
# than a branch like `main`) serves that commit's content, immutably, forever
# -- which is what makes recording a hash of it meaningful. NODE_SETUP_COMMIT
# is that commit; NODE_SETUP_DEB_SHA256 and NODE_SETUP_RPM_SHA256 are the
# SHA-256 of the two scripts it serves, verified byte-identical to what
# deb.nodesource.com/setup_22.x and rpm.nodesource.com/setup_22.x served on
# 2026-10-10. NODE_SETUP_COMMIT, both hashes, and NODE_MAJOR_MIN must all be
# bumped together: the pinned path embeds the Node major version
# (scripts/deb/setup_22.x), so changing NODE_MAJOR_MIN alone points at a path
# that may not exist at this commit, and the two hashes recorded here would
# be for the wrong version either way.
NODE_SETUP_COMMIT="9b431d8ae0f10df272598585855c6eca6c0e1bd2"
NODE_SETUP_DEB_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
NODE_SETUP_RPM_SHA256="b0ed2b9b66002e7ee802e8777cf3a92b25f1ecc0129812dc6f59a43a536810cc"

log()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

# Catches anything die() doesn't -- a command that fails outright (set -e's
# trigger) would otherwise unwind straight out of the script with no
# explanation of which step died. Deliberately NOT the JSON status-file
# mechanism install-macos.sh/install-windows.ps1 also write here: the
# Electron GUI doesn't drive install-linux.sh through any status-polling
# flow (it only copies the one-liner to the clipboard for the user to paste
# by hand), so that machinery would have no consumer on Linux. This is just
# the plain-text half of that fix.
on_error() {
  local line="$1"
  printf '  \033[31mx\033[0m %s\n' "Failed at line $line: $BASH_COMMAND" >&2
  exit 1
}
trap 'on_error $LINENO' ERR

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

# Computes a file's SHA-256 portably across distros: not every apt/dnf/yum/
# pacman system ships the same hashing tool. sha256sum (coreutils) is the
# first choice -- it's on every one of them by default -- then shasum -a 256,
# then openssl dgst -sha256. Returns non-zero (printing nothing) if none of
# the three is on PATH, rather than dying from inside here: this runs inside
# a `$(...)` command substitution at its call site, a subshell, so a die()
# called from here would only exit that subshell -- its message would still
# print (die's printf goes to stderr, unaffected by the subshell boundary),
# but the script would then rely on `set -e` to propagate the subshell's
# exit status back out, which also re-fires the ERR trap added above for
# what already got a clear message, printing the failure twice. Letting the
# caller check this function's own exit status and call die() directly,
# itself, in the main shell avoids that entirely.
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    return 1
  fi
}

# Downloads a nodesource setup script to a temp file, verifies its SHA-256
# against the expected hash, and only then runs it as root -- never piping
# curl straight into `as_root bash -`, which would execute whatever bytes
# the server returns with no integrity check at all. $1: URL (the pinned
# raw.githubusercontent.com one, see NODE_SETUP_COMMIT above). $2: expected
# SHA-256.
run_verified_setup_script() {
  local url="$1" expected="$2" tmp actual status
  tmp="$(mktemp)" || die "Couldn't create a temp file to download the Node.js setup script into."
  # curl's exit status is checked explicitly here, not relied on implicitly:
  # `curl ... -o "$tmp"` on its own, un-checked, would leave a failed
  # download's half-written (or empty) $tmp to fail the hash check below for
  # an unrelated-looking reason instead of curl's own clear failure (same
  # false-economy install-macos.sh's fetch-into-a-variable-first comment
  # warns about for `$(...)` specifically -- the underlying trap, a failure
  # not tripping `set -e`, is the same one here).
  if ! curl -fsSL "$url" -o "$tmp"; then
    rm -f "$tmp"
    die "Couldn't download the Node.js setup script from $url."
  fi
  if ! actual="$(sha256_of "$tmp")"; then
    rm -f "$tmp"
    die "Can't verify the Node.js setup script's checksum: no sha256sum, shasum, or openssl found on PATH. Install coreutils (for sha256sum) and re-run -- this script won't run unverified root-level code as a fallback."
  fi
  if [ "$actual" != "$expected" ]; then
    rm -f "$tmp"
    die "Node.js setup script from $url failed its checksum check (expected $expected, got $actual) -- refusing to run it as root. This can mean nodesource changed the script at that commit (shouldn't happen -- it's pinned) or the download was corrupted/tampered with."
  fi
  as_root bash "$tmp"
  status=$?
  rm -f "$tmp"
  return "$status"
}

# Stops a Granted this script is about to overwrite, so npm ci never runs
# under a server that holds its own files open. Ported from
# install-macos.sh's matching_pids/stop_granted_in -- both are written with
# POSIX-portable `ps`/`awk`, not anything macOS-specific, and verified
# directly against real Linux (procps-ng, the `ps` on every apt/dnf/yum/
# pacman distro) rather than assumed: `ps -axo pid=,comm=,args=` runs clean
# there, exit 0, no warnings, with comm holding the full, untruncated command
# name. Both checks (comm AND argv[0]'s basename, read from the untruncated
# args field) are still kept even though the macOS comment's reason for the
# fallback -- `ps`'s comm column there gets truncated to a short fixed width
# -- doesn't reproduce on Linux: keeping the same two checks costs nothing
# and keeps the two scripts easy to keep in sync. Defensive either way: if
# `ps` ever fails or produces no output (an unexpected PATH, a minimal
# container image, whatever), matching_pids prints nothing, so
# stop_granted_in's `[ -z "$pids" ] && return 0` just lets the install
# proceed rather than aborting it.
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
      run_verified_setup_script \
        "https://raw.githubusercontent.com/nodesource/distributions/${NODE_SETUP_COMMIT}/scripts/deb/setup_${NODE_MAJOR_MIN}.x" \
        "$NODE_SETUP_DEB_SHA256"
      $SUDO apt-get install -y nodejs
      ;;
    dnf)
      run_verified_setup_script \
        "https://raw.githubusercontent.com/nodesource/distributions/${NODE_SETUP_COMMIT}/scripts/rpm/setup_${NODE_MAJOR_MIN}.x" \
        "$NODE_SETUP_RPM_SHA256"
      $SUDO dnf install -y nodejs
      ;;
    yum)
      run_verified_setup_script \
        "https://raw.githubusercontent.com/nodesource/distributions/${NODE_SETUP_COMMIT}/scripts/rpm/setup_${NODE_MAJOR_MIN}.x" \
        "$NODE_SETUP_RPM_SHA256"
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
  # Marks this clone as made by install-linux.sh (inside .git, so git never
  # sees it) -- same marker install-macos.sh and install-windows.ps1 write,
  # for parity and in case a future Linux updater wants it. It does NOT do
  # anything on its own today: scaffold/lib/appUpdate/install.ts's UPDATERS
  # table has no `linux` entry, so installInfo() already returns
  # "unsupported-platform" before this marker would ever be checked, and
  # self-uninstall is explicitly macOS-only there too. Writing it now is
  # just future-proofing, not a working self-update feature.
  printf 'Cloned by install-linux.sh on %s\n' "$(date +"%Y-%m-%dT%H:%M:%S")" > "$TARGET_DIR/.git/granted-installer"
  ok "cloned"
fi

# 5) npm ci -- never rewrites package-lock.json (unlike npm install). Stop a
# Granted that might already be running out of $TARGET_DIR first: npm ci
# removes and reinstalls node_modules, which a running dev server holds
# files open in. Called unconditionally (not gated behind an
# "already existed" flag the way install-macos.sh's EXISTING_INSTALL is) --
# matching_pids/stop_granted_in already no-op cleanly when nothing matches
# (including right after a fresh clone, when nothing could be running yet),
# so there's no need to track that state here too.
stop_granted_in "$TARGET_DIR"
cd "$TARGET_DIR/scaffold"
log "Installing npm dependencies..."
# onnxruntime-node (the built-in search model's runtime) otherwise downloads
# its CUDA GPU add-on on linux/x64, several hundred MB that search never uses.
export ONNXRUNTIME_NODE_INSTALL=skip
npm ci
ok "dependencies installed"

# 6) The production build Granted is served from. `npm run start` (`next start`)
# serves what this produces; nothing runs `npm run dev` any more. Built here
# rather than at first start so a build error stops the install with a message
# instead of reaching the user as Next's error overlay in the browser.
#
# Fatal, like npm ci above: an install with no build is an install that cannot
# run. A `next build` that fails leaves NO .next/BUILD_ID behind (it clears the
# folder before compiling -- verified against Next 14.2), so a failed build
# here can never be mistaken later for a usable one.
#
# It needs the network, like the clone and npm ci before it: app/layout.tsx
# uses next/font/google, so `next build` fetches the three font families and
# self-hosts them (`next dev` fetches them on first render instead -- the
# dependency is not new, only earlier and louder).
log "Building Granted (a minute or two)..."
npm run build || die "Granted couldn't be built -- see the output above for the underlying error."
ok "built"

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
# Built again after setup on purpose: setup writes .env.local, and Next bakes its
# NEXT_PUBLIC_* flags into the client bundle at build time, so a flag set after
# this install's build only takes effect once it is rebuilt.
echo "  npm run build                  # after changing .env.local"
echo "  npm run start                  # -> http://localhost:3000"
