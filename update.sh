#!/usr/bin/env bash
# update.sh - update the freebuff-native patch from GitHub, then re-apply it.
#
# Two modes:
#   --manual      check, pull and reinstall; prints what it is doing
#   --background  cheap throttled check used on launch; silent unless it updates
#
# git on Termux is a bionic binary and resolves DNS natively, so it must NOT be
# forced through the local CONNECT proxy (that proxy only serves glibc CLIs and
# may not even be running yet). Direct first, proxy only as a retry.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:---manual}"
PORT="${FREEBUFF_PROXY_PORT:-8975}"

say()  { printf "\033[1;32m[freebuff-native]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[freebuff-native]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m[freebuff-native] %s\033[0m\n" "$*" >&2; exit 1; }
quiet() { [ "$MODE" = "--manual" ] || return 0; "$@"; }

# --- prerequisites -----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is not installed (pkg install git)"

if [ ! -d "$DIR/.git" ]; then
  if [ "$MODE" = "--manual" ]; then
    die "$DIR is not a git checkout, so it cannot self-update.
Reinstall it with:
  curl -fsSL https://raw.githubusercontent.com/SehonYT/freebuff-native/main/install.sh | bash"
  fi
  exit 0
fi

# --- throttling (background mode only) ---------------------------------------
if [ "$MODE" = "--background" ]; then
  CHECK_FILE="$DIR/.last_update_check"
  INTERVAL="${FREEBUFF_UPDATE_INTERVAL:-21600}"
  NOW="$(date +%s 2>/dev/null || echo 0)"
  if [ -f "$CHECK_FILE" ] && [ "$NOW" -gt 0 ]; then
    LAST="$(cat "$CHECK_FILE" 2>/dev/null || echo 0)"
    case "$LAST" in ""|*[!0-9]*) LAST=0 ;; esac
    if [ $((NOW - LAST)) -lt "$INTERVAL" ] 2>/dev/null; then exit 0; fi
  fi
  [ "$NOW" -gt 0 ] 2>/dev/null && printf "%s" "$NOW" > "$CHECK_FILE" 2>/dev/null
fi

# --- fetch, direct first then via the local proxy ----------------------------
# Report the real git error instead of a bare exit code.
git_fetch() {
  # $1 = "" for direct, "proxy" to force the local CONNECT proxy
  if [ "$1" = "proxy" ]; then
    HTTPS_PROXY="http://127.0.0.1:$PORT" HTTP_PROXY="http://127.0.0.1:$PORT" \
      GIT_TERMINAL_PROMPT=0 timeout 45 git -C "$DIR" fetch --quiet origin main
  else
    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
      -u ALL_PROXY -u all_proxy GIT_TERMINAL_PROMPT=0 \
      timeout 45 git -C "$DIR" fetch --quiet origin main
  fi
}

FETCH_LOG="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/fb-fetch.$$")"
FETCH_OK=0
if git_fetch "" 2>"$FETCH_LOG"; then
  FETCH_OK=1
elif (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && git_fetch proxy 2>>"$FETCH_LOG"; then
  # proxy path only matters when direct DNS is unavailable
  FETCH_OK=1
fi

if [ "$FETCH_OK" -ne 1 ]; then
  ERRTXT="$(tail -n 3 "$FETCH_LOG" 2>/dev/null)"
  rm -f "$FETCH_LOG"
  if [ "$MODE" = "--background" ]; then exit 0; fi
  warn "could not reach GitHub to check for patch updates."
  [ -n "$ERRTXT" ] && printf "  git said: %s\n" "$ERRTXT" >&2
  # Network trouble must not block using the CLI: reinstall from the local copy.
  say "Continuing with the locally installed patch (nothing was changed)."
  exit 0
fi
rm -f "$FETCH_LOG"

LOCAL="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo none)"
REMOTE="$(git -C "$DIR" rev-parse origin/main 2>/dev/null || echo none)"
if [ "$LOCAL" = "none" ] || [ "$REMOTE" = "none" ]; then
  [ "$MODE" = "--manual" ] && warn "could not read local/remote revisions; skipping."
  exit 0
fi

# --- up to date? -------------------------------------------------------------
if [ "$LOCAL" = "$REMOTE" ]; then
  if [ "$MODE" = "--manual" ]; then
    say "patch is already up to date ($(git -C "$DIR" rev-parse --short HEAD))."
    say "checking the Freebuff CLI release..."
    bash "$DIR/install.sh"
  fi
  exit 0
fi

# --- apply the update --------------------------------------------------------
# Never let an unexpected local edit wedge the checkout: stash it, then try.
if [ "$MODE" = "--background" ]; then
  git -C "$DIR" pull --ff-only --quiet origin main >/dev/null 2>&1 || exit 0
  NEW_SHORT="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo latest)"
  bash "$DIR/install.sh" >/dev/null 2>&1 || true
  printf "[freebuff-native] Patch updated to %s (applied on next launch).\n" "$NEW_SHORT" > "$DIR/.update_notice"
  exit 0
fi

say "new patch available ($(git -C "$DIR" rev-parse --short HEAD) -> $(git -C "$DIR" rev-parse --short origin/main))."
if ! git -C "$DIR" pull --ff-only origin main; then
  warn "fast-forward failed - the checkout has local changes."
  if git -C "$DIR" stash push --include-untracked -m "freebuff-native autoupdate" >/dev/null 2>&1; then
    say "stashed local changes; retrying..."
    git -C "$DIR" pull --ff-only origin main \
      || die "git pull failed even after stashing. Run: git -C \"$DIR\" reset --hard origin/main"
    say "your stashed changes are kept; restore with: git -C \"$DIR\" stash pop"
  else
    die "git pull failed. Run: git -C \"$DIR\" reset --hard origin/main"
  fi
fi

say "re-applying patch and installing..."
bash "$DIR/install.sh"
say "updated to $(git -C "$DIR" rev-parse --short HEAD)."