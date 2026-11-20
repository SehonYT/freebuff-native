#!/usr/bin/env node
// Fetch, patch and install the freebuff CLI binary from official releases.
// Resumable download (offline cache supported), npm-published sha256
// verification, native patch, verification, then install to ~/.config.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const DIR = path.dirname(fileURLToPath(import.meta.url))
const CONF = path.join(os.homedir(), ".config", "manicode")
const BAK = path.join(DIR, "bak")
const MD5F = path.join(DIR, "freebuff.md5")
const CACHE = path.join(DIR, "cache")
const TARGET = process.env.CODEBUFF_BINARY_TARGET || "linux-arm64"
const GLIBC = path.join(DIR, "lib")
const LOADER = TARGET === "linux-x64" ? path.join(GLIBC, "ld-linux-x86-64.so.2") : path.join(GLIBC, "ld-linux-aarch64.so.1")
const ORIGIN = process.env.FREEBUFF_DOWNLOAD_ORIGIN || "https://codebuff.com"

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], timeout: 600000, ...opts })
}
function curl(url, out) {
  sh("curl", ["-fsSL", "--retry", "3", "--retry-delay", "3", "-o", out, url])
}
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex")

const existing = path.join(CONF, "freebuff")
if (fs.existsSync(existing) && fs.existsSync(MD5F)) {
  if (md5(existing) === fs.readFileSync(MD5F, "utf8").trim()) {
    console.log("install-binary: already installed and patched (" + TARGET + ")")
    process.exit(0)
  }
}

if (!fs.existsSync(LOADER)) {
  console.error("install-binary: patched glibc set missing at " + GLIBC + "; run install.sh first")
  process.exit(1)
}

console.log("install-binary: resolving latest freebuff release...")
const manifest = JSON.parse(sh("curl", ["-fsSL", "--max-time", "60", "https://registry.npmjs.org/freebuff/latest"], { stdio: ["ignore", "pipe", "inherit"] }).toString())
const version = manifest.version
const expected = manifest.binaryChecksums && manifest.binaryChecksums[TARGET]
if (!expected) {
  console.error("install-binary: no published checksum for target " + TARGET + " in freebuff@" + version)
  process.exit(1)
}

const fileName = "freebuff-" + TARGET + ".tar.gz"
fs.mkdirSync(CACHE, { recursive: true })
const archive = path.join(CACHE, "freebuff-" + TARGET + "-" + version + ".tar.gz")
const url = ORIGIN + "/api/releases/download/" + version + "/" + fileName

if (!(fs.existsSync(archive) && sha256(archive) === expected)) {
  console.log("install-binary: downloading " + url)
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      sh("curl", ["-fsSL", "-C", "-", "--max-time", "600", "-o", archive, url])
      break
    } catch (e) {
      if (attempt === 30) throw e
      console.error("install-binary: retry " + attempt + " (" + (e.message || e) + ")")
    }
  }
}
if (sha256(archive) !== expected) {
  console.error("install-binary: sha256 mismatch for " + archive)
  fs.rmSync(archive, { force: true })
  process.exit(1)
}
console.log("install-binary: archive verified (sha256 ok), extracting...")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-"))
sh("tar", ["-xzf", archive, "-C", tmp])
const bin = path.join(tmp, "freebuff")
if (!fs.existsSync(bin)) {
  console.error("install-binary: binary not found in archive")
  process.exit(1)
}
fs.chmodSync(bin, 0o755)

sh("patchelf", ["--set-interpreter", LOADER, "--set-rpath", GLIBC, bin])
if (TARGET !== "linux-x64") {
  sh("node", [path.join(DIR, "patch-syscalls.mjs"), bin])
}

const verify = () => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 60000 })
    execFileSync(bin, ["--help"], { stdio: "ignore", timeout: 60000 })
    return true
  } catch { return false }
}
if (!verify()) {
  console.error("install-binary: patched binary failed verification on this device")
  process.exit(1)
}

fs.mkdirSync(CONF, { recursive: true })
fs.mkdirSync(BAK, { recursive: true })
if (fs.existsSync(existing)) fs.copyFileSync(existing, path.join(BAK, "freebuff.bak"))
fs.copyFileSync(bin, existing)
fs.chmodSync(existing, 0o755)
const wasm = path.join(tmp, "tree-sitter.wasm")
if (fs.existsSync(wasm)) fs.copyFileSync(wasm, path.join(CONF, "tree-sitter.wasm"))
fs.writeFileSync(path.join(CONF, "freebuff-metadata.json"), JSON.stringify({ version, target: TARGET }, null, 2))
for (const name of ["freebuff-metadata.json", "tree-sitter.wasm"]) {
  try { fs.copyFileSync(path.join(CONF, name), path.join(BAK, name)) } catch {}
}
fs.writeFileSync(MD5F, md5(existing))
fs.rmSync(tmp, { recursive: true, force: true })
console.log("install-binary: freebuff " + version + " (" + TARGET + ") installed, patched and verified")
