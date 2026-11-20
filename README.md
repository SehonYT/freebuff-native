# freebuff-native

Run the [Freebuff CLI](https://freebuff.com) **natively** on devices it does
not support — Android/Termux first of all — with no qemu, no proot, and no
emulation. Tested on a Redmi 9A: an arm64 kernel behind a 32-bit userland.

> Unofficial community project. Not affiliated with Freebuff or CodebuffAI.
> No Freebuff binaries are redistributed here — everything is fetched from
> official sources (npm registry, codebuff.com releases, Debian) at install
> time and verified against published checksums.

## Supported devices

| Platform | Status | Notes |
|---|---|---|
| Termux, arm64 kernel + 32-bit userland (armv8l) | **tested** | the reason this project exists |
| Termux, arm64 kernel + 64-bit userland (aarch64) | **works** | same pipeline |
| Termux x86_64 | experimental | loader fix only; seccomp returns ENOSYS on x86_64 |
| Termux/arm, 32-bit kernel (armv7l) | not possible | the CLI ships only 64-bit binaries |
| Desktop Linux (x86_64 / aarch64) | not needed | official `npm install -g freebuff` works |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/SehonYT/freebuff-native/main/install.sh | bash
```

or, from a clone:

```bash
git clone https://github.com/SehonYT/freebuff-native ~/freebuff-native
bash ~/freebuff-native/install.sh
```

Then sign in and go:

```bash
freebuff login   # once
freebuff         # in any project directory
```

The installer is idempotent — re-run it any time to repair.

## What it patches, and why

The Freebuff CLI is a Bun-compiled glibc-linked arm64 binary. Four things
stop it from running on Android:

### 1. No 64-bit dynamic loader
Android userland has no `/lib/ld-linux-aarch64.so.1`. The installer writes
the prebuilt patched glibc 2.31 set from a bundle committed to the repo
(`runtime/linux-arm64-libs.tar.gz`, md5-verified per file) into `lib/`, and
the launcher runs the CLI **through that loader directly**
(`ld.so --library-path lib freebuff`), which sidesteps the binary's
interpreter and rpath entirely — no patchelf, no ELF rewriting. This works
identically on 32-bit-userland devices (armv8l): the arm64 kernel executes
the loader natively regardless of the shell's bitness.

Release archives are unpacked in Node and the runtime bundle is verified
per file. Earlier reports of extraction or ROM corruption were incorrect:
the `libc.so` error was caused by inherited Termux `LD_PRELOAD`. The wrapper
and launcher remove `LD_*` settings before starting the glibc process.

### 2. Android app seccomp raises SIGSYS instead of ENOSYS
For arm64 syscall numbers the sandbox filter does not know, the process is
killed with `Bad system call` rather than handed `ENOSYS` — so the usual
runtime fallbacks never engage. Three patchers fix this:

- `patch-libc-syscall.mjs` — rewrites glibc's generic `syscall()` in the
  private libc copy (located via `.dynsym`, shape-verified, injected into a
  padding cave) so blocked numbers {99, 283, 291, 424, 434-441} return
  `ENOSYS` through glibc's own errno path; everything else forwards
  untouched via an inline `svc`.
- `patch-robust.mjs` — rewrites inline `set_robust_list` (99) call sites in
  the bundled glibc objects to a harmless `ENOSYS`.
- `patch-syscalls.mjs` — rewrites the CLI binary's own inline syscall
  sites (`movz x8/w8,#NR` followed by `svc #0`) for the same numbers.

### 3. No DNS and the npm platform gate
Bun cannot resolve names on Android (no `/etc/resolv.conf`), so the wrapper
starts a tiny local CONNECT proxy and exports `HTTP(S)_PROXY` (TLS is
end-to-end). npm itself refuses to install the package on `android/arm`, so
the installer lays the npm package down by hand and the wrapper exports
`CODEBUFF_BINARY_TARGET` so the official launcher manages the correct
`linux-arm64` release.

### 4. A TUI watchdog deadlock
With a real terminal on stdout, the CLI arms a detached watchdog shell
(a dead-man's switch for terminal reset) whose exit-reap path deadlocks
against the watchdog's own pipe on Android — a blank screen with no error.
The wrapper disables it via the app's own switch
(`CODEBUFF_NO_TERMINAL_WATCHDOG=1`); the npm launcher still resets the
terminal on exit.

### 5. Correct syscall error handling during subprocess startup
The first patch substituted syscall number zero for unsupported syscalls.
On AArch64, zero is `io_setup`, not an ENOSYS stub: `pidfd_open` probes can
receive the wrong error, causing Bun to synchronously reap a newly spawned
child before its output readers attach. A child writing to stderr can then
block the entire CLI.

The corrected patch replaces the actual `svc #0` with `mov x0, #-38`
(raw `-ENOSYS`), while retaining the original syscall-number instruction.
It only scans executable ELF segments and stops if x8 is overwritten.
This also prevents file-open flags that happen to equal syscall numbers
from being modified. Git runs normally; no shim hides errors or changes
exit codes. Re-running `install.sh` rebuilds older patched binaries from
the cached verified archive using a patch-version marker.

### 6. Code search (ripgrep) on Android
Freebuff's SDK embeds a vendored glibc `rg` binary at `~/.config/manicode/rg`.
On Android/Termux, this glibc binary fails with `cannot execute: required file not found` (exit 127).
The project configures Freebuff via `CODEBUFF_RG_PATH` to use Termux's native,
optimized `ripgrep` (`rg`), and symlinks `~/.config/manicode/rg` to it as well,
enabling full code search functionality without errors.

## Automatic patch & CLI updates

### Automatic background checks
When you launch `freebuff`, the wrapper starts a non-blocking background check
for patch updates from GitHub (throttled to once every 6 hours, configurable via
`FREEBUFF_UPDATE_INTERVAL=21600` in seconds, or disabled with `FREEBUFF_AUTO_UPDATE=0`).
When a new commit is detected on GitHub, it quietly fast-forwards the repository
and re-applies any updated patch logic. A notification is displayed on your next launch.

### Manual update command
You can also update both the patch and the CLI binary on demand at any time:
```bash
freebuff update
```
This checks for GitHub updates to the patch repository, pulls latest changes,
verifies all components, and checks for official Freebuff CLI updates.

## Update safety

The CLI self-updates: the official npm launcher downloads releases
mid-session, installs them on exit, then **respawns** the binary. An
unpatched update would crash on the next spawn, so this project hooks
`installStagedBinary()` inside the official launcher: every install is
re-patched, verified (`--version` + `--help`), and only then respawned. If
patching or verification fails, the hook throws *before* the install
commits and the launcher rolls back to the previous binary — the CLI never
ends up dead. `fix-launcher.mjs` re-applies the hook automatically (e.g.
after `npm install -g freebuff`), and the wrapper keeps a last-known-good
backup plus an md5-triggered re-patch as a second line of defense.

## Layout

```
install.sh            one-liner installer / repair
update.sh             manual & background patch updater from GitHub
wrapper.sh            launcher template (installed to ~/.local/bin/freebuff)
install-binary.mjs    fetch + verify + patch + install the CLI binary
hooks.js              patch hook used by the official launcher on updates
fix-launcher.mjs      re-inject the hook into the npm launcher (idempotent)
patch-libc-syscall.mjs  glibc syscall() filter (symbol-driven)
patch-robust.mjs      glibc set_robust_list neutralizer
patch-syscalls.mjs    CLI binary inline-syscall neutralizer
proxy.mjs             local CONNECT proxy for Android DNS
tools/                ELF analysis helpers, PTY TUI probe
```

Device state (`lib/`, `bak/`, `cache/`, md5 markers) is created at install
time and never committed.

## Troubleshooting

- The pipeline does not require patchelf. A `libc.so` loading error is usually
  an inherited bionic `LD_PRELOAD`; use the generated `freebuff` command,
  which cleans the loader environment, rather than launching the ELF by hand.
- To repair an existing installation without deleting sign-in state:
  `git pull --ff-only && bash install.sh` from the project clone.
- `Bad system call` after an update: re-run `install.sh`; if it persists,
  the release likely uses a new blocked syscall — please open an issue.
- A future release requiring glibc newer than 2.31 will fail verification
  and stay rolled back; the pinned set can be bumped in `install.sh`.
- `freebuff doctor` is your friend; notes about git/node/dns checks are
  expected on Android.

## License

MIT — see [LICENSE](LICENSE).

The `runtime/` bundle contains unmodified and patched files from Debian's
`libc6_2.31-13+deb11u11_arm64.deb` (LGPL-2.1+). It is committed so installs
use a verified, reproducible runtime set. Reproduce it
byte-for-byte: download the pinned .deb (URL and checksum in `install.sh`),
extract, then run `patch-robust.mjs` over the lib set and
`patch-libc-syscall.mjs` on `libc.so.6` — the same scripts that built it.
