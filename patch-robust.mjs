#!/usr/bin/env node
// Patch Android-blocked set_robust_list (syscall 99) in glibc objects.
// SIGSYS instead of ENOSYS kills the process; rewriting the immediate to 0
// yields a harmless ENOSYS. Loose scan: mov x8/w8,#99 with svc within 64B.
import fs from "node:fs"

const SVC = 0xd4000001
const inPath = process.argv[2]
const outPath = process.argv[3] || inPath
if (!inPath) {
  console.error("usage: node patch-robust.mjs <in> [out]")
  process.exit(2)
}
const buf = fs.readFileSync(inPath)
let patched = 0
for (let i = 0; i + 4 <= buf.length; i += 4) {
  const w = buf.readUInt32LE(i)
  const base = (w & 0xffe0001f) >>> 0
  if (base !== 0xd2800008 && base !== 0x52800008) continue
  const nr = (w >> 5) & 0xffff
  if (nr !== 99) continue
  let found = false
  for (let j = 1; j <= 16; j++) {
    if (i + 4 * j + 4 > buf.length) break
    if (buf.readUInt32LE(i + 4 * j) === SVC) { found = true; break }
  }
  if (!found) continue
  buf.writeUInt32LE(base, i)
  patched++
  console.error("patch-robust: nr=99 at 0x" + i.toString(16))
}
fs.writeFileSync(outPath, buf)
console.log("patch-robust: " + patched + " site(s) patched in " + inPath)
