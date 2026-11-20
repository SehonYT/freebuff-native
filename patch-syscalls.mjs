#!/usr/bin/env node
// Patch Android-10-blocked arm64 syscall numbers in a Bun/Zig binary.
// Rewrites movz x8/w8,#NR (and w8) to #0 when an svc #0 follows within 96
// bytes. Blocked on this class of devices: unknown arm64 NRs raise SIGSYS.
import fs from "node:fs"

const NRS = new Set([99, 283, 291, 424, 434, 435, 436, 437, 438, 439, 440, 441])
const SVC = 0xd4000001
const WIN = 24

export function patchBuffer(buf) {
  const patched = []
  for (let i = 0; i + 4 * (WIN + 1) <= buf.length; i += 4) {
    const w = buf.readUInt32LE(i)
    const base = (w & 0xffe0001f) >>> 0
    if (base !== 0xd2800008 && base !== 0x52800008) continue
    const nr = (w >> 5) & 0xffff
    if (!NRS.has(nr)) continue
    let svcAt = -1
    for (let j = 1; j <= WIN; j++) {
      if (buf.readUInt32LE(i + 4 * j) === SVC) { svcAt = i + 4 * j; break }
    }
    if (svcAt < 0) continue
    buf.writeUInt32LE(base, i)
    patched.push("nr=" + nr + " at 0x" + i.toString(16))
  }
  return patched
}

import { pathToFileURL } from "node:url"
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const inPath = process.argv[2]
  if (!inPath) { console.error("usage: node patch-syscalls.mjs <in> [out]"); process.exit(2) }
  const outPath = process.argv[3] || inPath
  const buf = fs.readFileSync(inPath)
  const patched = patchBuffer(buf)
  fs.writeFileSync(outPath, buf)
  for (const p of patched) console.error("patched " + p)
  console.log("patch-syscalls: " + patched.length + " site(s) patched in " + inPath)
}
