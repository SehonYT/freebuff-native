// Patch and verify every staged update before the launcher commits it.
// A false return preserves the prior working binary through launcher rollback.
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
// Strip bionic-oriented LD_* vars (termux-exec LD_PRELOAD drags bionic
// libc.so into the glibc loader with fatal results on some devices).
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LD_")))

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
    const go = (a) => execFileSync(bin, [a],
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
    run('patchelf', ['--set-interpreter', LOADER, '--set-rpath', GLIBC, bin])
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
