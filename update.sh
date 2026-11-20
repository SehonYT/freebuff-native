#!/usr/bin/env bash
# update.sh — update freebuff-native patch and runtime from GitHub
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:---manual}"

say() { printf "\033[1;32m[freebuff-native]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[freebuff-native]\033[0m %s\n" "$*" >&2; }
die() { printf "\033[1;31m[freebuff-native] %s\033[0m\n" "$*" >&2; exit 1; }

if [ ! -d "$DIR/.git" ]; then
  if [ "$MODE" = "--manual" ]; then
    die "$DIR is not a git repository; cannot auto-update."
  fi
  exit 0
fi

# Ensure proxy and certificate environment are present if running on Termux
PORT="${FREEBUFF_PROXY_PORT:-8975}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:$PORT}"
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:$PORT}"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"
if [ -f "/data/data/com.termux/files/usr/etc/tls/cert.pem" ]; then
  export SSL_CERT_FILE="/data/data/com.termux/files/usr/etc/tls/cert.pem"
  export SSL_CERT_DIR="/data/data/com.termux/files/usr/etc/tls"
fi

if [ "$MODE" = "--background" ]; then
  CHECK_FILE="$DIR/.last_update_check"
  INTERVAL="${FREEBUFF_UPDATE_INTERVAL:-21600}" # 6 hours by default
  NOW="$(date +%s 2>/dev/null || echo 0)"

  if [ -f "$CHECK_FILE" ] && [ "$NOW" -gt 0 ]; then
    LAST="$(cat "$CHECK_FILE" 2>/dev/null || echo 0)"
    ELAPSED=$((NOW - LAST))
    if [ "$ELAPSED" -ge 0 ] && [ "$ELAPSED" -lt "$INTERVAL" ]; then
      exit 0
    fi
  fi
  printf "%s" "$NOW" > "$CHECK_FILE" 2>/dev/null || true

  # Fetch changes silently with a timeout
  timeout 30 git -C "$DIR" fetch --quiet origin main 2>/dev/null || exit 0

  LOCAL="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo '')"
  REMOTE="$(git -C "$DIR" rev-parse origin/main 2>/dev/null || echo '')"

  if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    # Pull fast-forward
    if git -C "$DIR" pull --ff-only --quiet origin main 2>/dev/null; then
      NEW_SHORT="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo 'latest')"
      # Re-apply installer quietly to update wrapper/loader/binary
      bash "$DIR/install.sh" >/dev/null 2>&1 || true
      echo "[freebuff-native] Patch automatically updated to $NEW_SHORT." > "$DIR/.update_notice"
    fi
  fi
  exit 0
fi

# Manual mode
say "Checking for freebuff-native patch updates..."
git -C "$DIR" fetch origin main

LOCAL="$(git -C "$DIR" rev-parse HEAD)"
REMOTE="$(git -C "$DIR" rev-parse origin/main)"

if [ "$LOCAL" != "$REMOTE" ]; then
  say "New patch version found. Updating from GitHub..."
  if ! git -C "$DIR" pull --ff-only origin main; then
    die "git pull --ff-only failed. If you modified files locally, run 'git stash' or 'git reset --hard origin/main'."
  fi
  say "Applying latest patch updates..."
  bash "$DIR/install.sh"
  NEW_SHORT="$(git -C "$DIR" rev-parse --short HEAD)"
  say "Successfully updated freebuff-native to $NEW_SHORT!"
else
  say "freebuff-native is already at latest version ($(git -C "$DIR" rev-parse --short HEAD))."
  say "Checking for Freebuff CLI updates..."
  bash "$DIR/install.sh"
fi
