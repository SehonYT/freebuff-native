#!/usr/bin/env bash
# freebuff-native installer — run the Freebuff CLI natively on unsupported
# platforms (Termux/Android: 32-bit userland arm64, aarch64, x86_64).
# One-liner: curl -fsSL <repo>/install.sh | bash
set -eu

REPO="https://github.com/SehonYT/freebuff-native"
NATIVE_DIR_DEFAULT="$HOME/freebuff-native"
GLIBC_VERSION="2.31-13+deb11u11"
GLIBC_ARM64_SHA256="baaa9aa184e2f21738c5819055e6740cc5b22f198e3f416e33f82b40ff6933d8"
GLIBC_AMD64_SHA256="05f7264da867b37f4c5ce49266b558ea1e81e05a9464f623152fca70f3550282"
GLIBC_MIRROR="https://deb.debian.org/debian/pool/main/g/glibc"

say() { printf "\033[1;32m[freebuff-native]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[freebuff-native] %s\033[0m\n" "$*" >&2; exit 1; }

# --- bootstrap: curl|bash runs from stdin; fetch the project first ---
if [ ! -f "$(dirname "$0")/install-binary.mjs" ]; then
  say "bootstrapping: cloning $REPO to $NATIVE_DIR_DEFAULT"
  command -v git >/dev/null 2>&1 || die "git is required for the one-liner; install it (pkg install git) and retry"
  if [ ! -d "$NATIVE_DIR_DEFAULT/.git" ]; then
    rm -rf "$NATIVE_DIR_DEFAULT"
    git clone --depth 1 "$REPO" "$NATIVE_DIR_DEFAULT"
  fi
  exec bash "$NATIVE_DIR_DEFAULT/install.sh" "$@"
fi

cd "$(dirname "$0")"
NATIVE_DIR="$(pwd)"

# --- platform detection ---
UNAME_M="$(uname -m)"
PREFIX="${FREEBUFF_PREFIX:-${PREFIX:-/data/data/com.termux/files/usr}}"
IS_TERMUX=0
case "$PREFIX" in *com.termux*) IS_TERMUX=1 ;; esac
if [ -n "${TERMUX_VERSION:-}" ]; then IS_TERMUX=1; fi

if [ "$IS_TERMUX" -ne 1 ]; then
  case "$UNAME_M" in
    x86_64|aarch64)
      say "native glibc Linux on $UNAME_M: the official install works directly:"
      say "  npm install -g freebuff"
      say "nothing to patch here; exiting."
      exit 0
      ;;
    *)
      die "unsupported architecture for native installs: $UNAME_M"
      ;;
  esac
fi

TARGET=""; LOADER=""
case "$UNAME_M" in
  aarch64|armv8l)
    TARGET="linux-arm64"; LOADER="ld-linux-aarch64.so.1"
    ;;
  x86_64)
    TARGET="linux-x64"; LOADER="ld-linux-x86-64.so.2"
    say "NOTE: x86_64 Termux is best-effort (loader fix only); arm64 is the tested path."
    ;;
  armv7l|armv7|arm)
    die "this device has a 32-bit ARM kernel; the freebuff binary is 64-bit and cannot run natively (qemu-user would be required, which is out of scope)"
    ;;
  *)
    die "unsupported Termux architecture: $UNAME_M (no matching freebuff release)"
    ;;
esac
export CODEBUFF_BINARY_TARGET="$TARGET"
say "platform: Termux ($UNAME_M), release target: $TARGET"

# --- dependencies ---
MISSING=""
for t in node npm curl tar xz dpkg-deb patchelf rg; do
  command -v "$t" >/dev/null 2>&1 || MISSING="$MISSING $t"
done
if [ -n "$MISSING" ]; then
  say "installing missing packages:$MISSING"
  pkg install -y nodejs-lts patchelf xz-utils binutils dpkg ripgrep 2>/dev/null || pkg install -y nodejs patchelf xz-utils binutils dpkg ripgrep
fi
# Auto-heal Termux patchelf libc++ symbol mismatch if present
if command -v patchelf >/dev/null 2>&1; then
  if ! patchelf --version >/dev/null 2>&1; then
    say "patchelf is broken on this device (Termux libc++ issue); running pkg upgrade..."
    pkg upgrade -y patchelf libc++ 2>/dev/null || true
  fi
fi
for t in node npm curl tar xz dpkg-deb patchelf rg; do
  command -v "$t" >/dev/null 2>&1 || die "missing dependency even after pkg install: $t"
done


# --- patched glibc runtime ---
LIBDIR="$NATIVE_DIR/lib"
mkdir -p "$NATIVE_DIR/cache" "$LIBDIR"
if [ "$TARGET" = "linux-arm64" ]; then
  # Deterministic: the prebuilt patched set ships in the repo as a bundle;
  # every file is md5-verified after writing. No device extraction tools.
  rm -rf "$LIBDIR"
  node "$NATIVE_DIR/extract-libs.mjs" \
    || die "glibc bundle verification failed; please report the output above"
  DEB_ARCH="arm64"
else
  # Experimental x64 path: plain (unpatched) glibc set from the pinned deb.
  DEB_ARCH="amd64"
  DEB_SHA="$GLIBC_AMD64_SHA256"
  DEB="libc6_${GLIBC_VERSION}_${DEB_ARCH}.deb"
  if [ ! -f "$LIBDIR/.patched" ]; then
    if [ ! -f "$NATIVE_DIR/cache/$DEB" ]; then
      say "downloading glibc ($DEB) from Debian..."
      curl -fsSL --retry 5 --retry-delay 3 -o "$NATIVE_DIR/cache/$DEB" "$GLIBC_MIRROR/$DEB"
    fi
    echo "$DEB_SHA  $NATIVE_DIR/cache/$DEB" | sha256sum -c - >/dev/null 2>&1 \
      || die "glibc package checksum mismatch; please report this with your device details"
    WORK="$(mktemp -d)"
    dpkg-deb -x "$NATIVE_DIR/cache/$DEB" "$WORK"
    for f in "$LOADER" libc.so.6 libpthread.so.0 libdl.so.2 libm.so.6 libresolv.so.2; do
      SRCF="$(find "$WORK" -name "$f" | head -1)"
      [ -n "$SRCF" ] || die "glibc file missing from package: $f"
      cp -L "$SRCF" "$LIBDIR/$f"
    done
    rm -f "$LIBDIR/libc.so"
    chmod 755 "$LIBDIR"/*
    touch "$LIBDIR/.patched"
    rm -rf "$WORK"
    say "glibc set installed in $LIBDIR"
  else
    say "glibc set already present in $LIBDIR"
  fi
fi

# --- verify the kernel can run 64-bit code (armv8l can be either) ---
# ld.so with no executable argument prints its usage; any output at all means
# the kernel executed the loader. A 32-bit-only kernel refuses the exec.
if ! env -u LD_PRELOAD -u LD_LIBRARY_PATH -u LD_AUDIT "$LIBDIR/$LOADER" --list 2>&1 | grep -q "ld.so"; then
  die "this kernel cannot execute ${DEB_ARCH} binaries (32-bit-only kernel?); native freebuff is not possible here"
fi

# --- official npm launcher package (npm refuses android/arm) ---
LAUNCHER_DIR="$PREFIX/lib/node_modules/freebuff"
mkdir -p "$NATIVE_DIR/cache"
curl -fsSL --max-time 60 https://registry.npmjs.org/freebuff/latest -o "$NATIVE_DIR/cache/freebuff-latest.json"
LATEST_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$NATIVE_DIR/cache/freebuff-latest.json" | head -1)"
INSTALLED_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LAUNCHER_DIR/package.json" 2>/dev/null | head -1)"
say "launcher package: installed=${INSTALLED_VER:-none} latest=$LATEST_VER"
if [ "$INSTALLED_VER" != "$LATEST_VER" ] || [ ! -f "$LAUNCHER_DIR/index.js" ]; then
  say "installing the freebuff npm launcher package (npm blocks android/arm, doing it manually)..."
  rm -rf "$LAUNCHER_DIR"
  VER="$LATEST_VER"
  [ -n "$VER" ] || die "cannot resolve latest freebuff version from npm"
  curl -fsSL --retry 3 -o "$NATIVE_DIR/cache/freebuff-npm.tgz" "https://registry.npmjs.org/freebuff/-/freebuff-$VER.tgz"
  mkdir -p "$LAUNCHER_DIR"
  tar -xzf "$NATIVE_DIR/cache/freebuff-npm.tgz" -C "$LAUNCHER_DIR" --strip-components=1
  (cd "$LAUNCHER_DIR" && npm install --omit=dev --force --no-audit --no-fund >/dev/null 2>&1) \
    || (cd "$LAUNCHER_DIR" && npm install --omit=dev --force --no-audit --no-fund)
fi
node "$NATIVE_DIR/fix-launcher.mjs" || true

# --- the binary itself (official release, patched for this device) ---
node "$NATIVE_DIR/install-binary.mjs" || die "binary install/patch failed"

# --- ripgrep setup for code_search ---
mkdir -p "$HOME/.config/manicode"
ln -sf "$PREFIX/bin/rg" "$HOME/.config/manicode/rg"

# --- wrapper ---
mkdir -p "$HOME/.local/bin"
sed -e "s|@NATIVE_DIR@|$NATIVE_DIR|g" -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@TARGET@|$TARGET|g" -e "s|@LOADER@|$LOADER|g" \
    "$NATIVE_DIR/wrapper.sh" > "$HOME/.local/bin/freebuff"
chmod 755 "$HOME/.local/bin/freebuff"
rm -f "$PREFIX/bin/freebuff"
bash -n "$HOME/.local/bin/freebuff" || die "generated wrapper failed syntax check"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "NOTE: add ~/.local/bin to PATH to use the freebuff command" ;;
esac

# --- final verification through the real entry point ---
if ! "$HOME/.local/bin/freebuff" --version >/dev/null 2>&1; then
  die "verification failed: the patched CLI did not run; please report this"
fi
VER="$(HOME="$HOME" "$HOME/.local/bin/freebuff" --version 2>/dev/null | tail -1)"
say "installed: freebuff $VER ($TARGET, native, patched)"
say "sign in with: freebuff login   — then start it in a project with: freebuff"
