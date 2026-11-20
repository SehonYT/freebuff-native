// Native patch hook, invoked by the freebuff launcher right after every update
// install. Re-applies the binary patch (patchelf when available + blocked-
// syscall rewrites) and verifies before the launcher respawns; returning false
// makes the launcher roll back to the previous (still working) binary.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const DIR = __dirname
const GLIBC = path.join(DIR, "lib")
const CONF = path.join(os.homedir(), ".config", "manicode")
const BAK = path.join(DIR, "bak")
const MD5F = path.join(DIR, "freebuff.md5")
const TARGET = process.env.CODEBUFF_BINARY_TARGET || "linux-arm64"
const LOADER = TARGET === "linux-x64"
  ? path.join(GLIBC, "ld-linux-x86-64.so.2")
  : path.join(GLIBC, "ld-linux-aarch64.so.1")
const CHILD_ENV = { ...process.env, LD_LIBRARY_PATH: GLIBC }

function run(cmd, args, opts) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180000, ...opts })
    return true
  } catch (e) {
    return false
  }
}

function verify(bin) {
  try {
    const execArgs = fs.existsSync(LOADER) ? [LOADER, "--library-path", GLIBC, bin] : [bin]
    const go = (a) => execFileSync(execArgs[0], [...execArgs.slice(1), a],
      { stdio: 'ignore', timeout: 60000, env: CHILD_ENV })
    go("--version")
    go("--help")
    return true
  } catch (e) {
    console.error('freebuff hook: verification failed: ' + e.message)
    return false
  }
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

function applyNativePatch(bin) {
  try {
    if (!fs.existsSync(LOADER)) {
      console.error('freebuff hook: patched glibc set missing at ' + GLIBC + '; run install.sh again')
      return false
    }
    // Optional rewrite: makes direct exec work too; not required because the
    // launcher spawns through the loader (FREEBUFF_LOADER_PATH).
    if (!run('patchelf', ['--set-interpreter', LOADER, '--set-rpath', GLIBC, bin])) {
      console.error('freebuff hook: patchelf unavailable/failed; using loader-exec mode')
    }
    if (TARGET !== "linux-x64") {
      if (!run('node', [path.join(DIR, 'patch-syscalls.mjs'), bin])) return false
    }
    if (!verify(bin)) return false
    fs.mkdirSync(BAK, { recursive: true })
    fs.copyFileSync(bin, path.join(BAK, 'freebuff.bak'))
    for (const name of ['freebuff-metadata.json', 'tree-sitter.wasm']) {
      try { fs.copyFileSync(path.join(CONF, name), path.join(BAK, name)) } catch {}
    }
    fs.writeFileSync(MD5F, md5(bin))
    console.error('freebuff: update patched and verified (native, patched)')
    return true
  } catch (e) {
    console.error('freebuff hook error: ' + e.message)
    return false
  }
}

module.exports = { applyNativePatch }
