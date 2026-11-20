// Native patch hook, invoked by the freebuff launcher right after every update
// install. Re-applies patchelf + blocked-syscall rewrites and verifies the
// binary before the launcher respawns it; returning false makes the launcher
// roll the install back to the previous (still working) binary.
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

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180000 })
    return true
  } catch (e) {
    console.error('freebuff hook: ' + cmd + ' failed: ' + e.message)
    return false
  }
}

function verify(bin) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 60000 })
    execFileSync(bin, ['--help'], { stdio: 'ignore', timeout: 60000 })
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
    if (!run('patchelf', ['--set-interpreter', LOADER, '--set-rpath', GLIBC, bin])) return false
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
