#!/usr/bin/env node
// Fetch, patch and install the freebuff CLI binary from official releases.
// Deterministic pipeline: archive sha256 -> in-memory extraction -> in-memory
// patch -> verified write (read-back md5 must equal the memory image, fresh
// inode per retry) -> loader-exec verification. No device tools touch it.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { extractMembersToBuffers } from "./untar.mjs"
import { patchBuffer } from "./patch-syscalls.mjs"
import { neededList } from "./elf.mjs"

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
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
const md5buf = (b) => crypto.createHash("md5").update(b).digest("hex")
const md5 = (f) => md5buf(fs.readFileSync(f))
// Strip bionic-oriented LD_* vars (termux-exec LD_PRELOAD drags bionic
// libc.so into the glibc loader with fatal results on some devices).
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LD_")))

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
console.log("install-binary: archive verified (sha256 ok), extracting in memory...")

const members = extractMembersToBuffers(archive, ["freebuff", "tree-sitter.wasm"])
const binBuf = members.find((m) => m.name === "freebuff")?.data
const wasmBuf = members.find((m) => m.name === "tree-sitter.wasm")?.data
if (!binBuf) {
  console.error("install-binary: freebuff member not found in archive")
  process.exit(1)
}
console.log("install-binary: extracted freebuff (" + binBuf.length + " bytes, md5 " + md5buf(binBuf) + "), in-memory NEEDED: " + (neededList(binBuf) || []).join(", "))

if (TARGET !== "linux-x64") {
  const sites = patchBuffer(binBuf)
  for (const s of sites) console.error("patched " + s)
  console.log("install-binary: patch-syscalls rewrote " + sites.length + " site(s) in memory")
}
const groundTruth = md5buf(binBuf)
console.log("install-binary: patched memory image md5 " + groundTruth)

// verified write: the file read back from disk must equal the memory image
fs.mkdirSync(CONF, { recursive: true })
let finalPath = null
for (let attempt = 1; attempt <= 3; attempt++) {
  const candidate = path.join(CONF, "freebuff.installing." + process.pid + "." + attempt)
  const fd = fs.openSync(candidate, "w")
  fs.writeSync(fd, binBuf)
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.chmodSync(candidate, 0o755)
  const back = fs.readFileSync(candidate)
  const backMd5 = md5buf(back)
  const backNeeded = neededList(back)
  console.log("install-binary: write attempt " + attempt + ": read-back md5 " + backMd5 + ", NEEDED " + (backNeeded || []).join(", "))
  if (backMd5 === groundTruth) {
    fs.renameSync(candidate, existing)
    finalPath = existing
    break
  }
  console.error("install-binary: read-back differs from the memory image; storage layer fault, retrying on a fresh inode")
  fs.rmSync(candidate, { force: true })
}
if (!finalPath) {
  console.error("install-binary: could not write a verifiable binary; the device filesystem returns altered data on read-back. This is a kernel/ROM fault; please report the output above.")
  process.exit(1)
}

if (wasmBuf) {
  const wasmTruth = md5buf(wasmBuf)
  fs.writeFileSync(path.join(CONF, "tree-sitter.wasm"), wasmBuf)
  if (md5(path.join(CONF, "tree-sitter.wasm")) !== wasmTruth) console.error("install-binary: WARNING tree-sitter.wasm read-back mismatch")
}
fs.writeFileSync(path.join(CONF, "freebuff-metadata.json"), JSON.stringify({ version, target: TARGET }, null, 2))

fs.mkdirSync(BAK, { recursive: true })
fs.copyFileSync(finalPath, path.join(BAK, "freebuff.bak"))
for (const name of ["freebuff-metadata.json", "tree-sitter.wasm"]) {
  try { fs.copyFileSync(path.join(CONF, name), path.join(BAK, name)) } catch {}
}
fs.writeFileSync(MD5F, md5(finalPath))

// final independent check: run the CLI through the private loader
const verify = () => {
  try {
    const execArgs = fs.existsSync(LOADER) ? [LOADER, "--library-path", GLIBC, finalPath] : [finalPath]
    const go = (a) => execFileSync(execArgs[0], [...execArgs.slice(1), a], { stdio: "ignore", timeout: 60000, env: cleanEnv })
    go("--version")
    go("--help")
    return true
  } catch { return false }
}
if (!verify()) {
  console.error("install-binary: loader-exec verification failed even though the file read back identical to the patched memory image; diagnostics:")
  const show = (label, fn) => {
    console.error("--- " + label + " ---")
    try { fn(); console.error("(exit 0)") }
    catch (e) { console.error("(exit " + (e.status ?? "?") + (e.signal ? " signal " + e.signal : "") + (e.code ? " code " + e.code : "") + ")") }
  }
  show("loader --list", () => execFileSync(LOADER, ["--library-path", GLIBC, "--list", finalPath], { stdio: ["ignore", 1, 2], timeout: 60000, env: cleanEnv }))
  show("loader exec --version", () => execFileSync(LOADER, ["--library-path", GLIBC, finalPath, "--version"], { stdio: ["ignore", 1, 2], timeout: 60000, env: cleanEnv }))
  console.error("--- disk view now: md5 " + md5(finalPath) + " (memory image was " + groundTruth + "), NEEDED " + (neededList(fs.readFileSync(finalPath)) || []).join(", ") + " ---")
  console.error("install-binary: if the disk view matches but the loader view differs, the ROM page-cache/FS is altering reads; report the output above")
  process.exit(1)
}
console.log("install-binary: freebuff " + version + " (" + TARGET + ") installed, patched and verified")
