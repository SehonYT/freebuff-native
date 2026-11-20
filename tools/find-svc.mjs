#!/usr/bin/env node
// Analyze every svc #0 site: how does x8 get its syscall number?
import fs from "node:fs"
const inPath = process.argv[2]
const buf = fs.readFileSync(inPath)
const SVC = 0xd4000001
const BACK = 64
const sites = []
for (let i = 0; i + 4 <= buf.length; i += 4) {
  if (buf.readUInt32LE(i) !== SVC) continue
  // walk back to find the instruction that last wrote x8 before the svc
  let setter = "unknown", setOff = -1, imm = -1
  for (let j = 1; j <= BACK && i - 4 * j >= 0; j++) {
    const w = buf.readUInt32LE(i - 4 * j)
    const rd = w & 0x1f
    if (rd !== 8) continue
    const base = w & 0xffe00000
    if (base === 0xd2800000) { setter = "movz"; imm = (w >> 5) & 0xffff; setOff = i - 4 * j; break }
    if (base === 0x52800000) { setter = "movzw"; imm = (w >> 5) & 0xffff; setOff = i - 4 * j; break }
    if ((w & 0xffe0fc00) === 0xaa000000) { setter = "mov-x8-x" + ((w >> 16) & 0x1f); setOff = i - 4 * j; break }
    if (base === 0xf9400000 && ((w >> 10) & 3) === 1) { setter = "ldr-x8"; setOff = i - 4 * j; break }
    if ((w & 0x7f800000) === 0x12000000 || (w & 0x7f800000) === 0x32000000) { setter = "orr-bitmask-8"; setOff = i - 4 * j; break }
    setter = "other-rd8-" + w.toString(16); setOff = i - 4 * j; break
  }
  sites.push({ svc: i, setter, imm, setOff })
}
const stats = {}
for (const s of sites) stats[s.setter.startsWith("other") ? "other" : s.setter] = (stats[s.setter.startsWith("other") ? "other" : s.setter] || 0) + 1
console.log("total svc sites: " + sites.length)
console.log("setter stats: " + JSON.stringify(stats))
console.log("-- movz sites with blocked nr (99,283,291,424,434-441):")
const blocked = new Set([99, 283, 291, 424, 434, 435, 436, 437, 438, 439, 440, 441])
for (const s of sites) if (blocked.has(s.imm)) console.log("  BLOCKED nr=" + s.imm + " svc=0x" + s.svc.toString(16) + " setter=0x" + s.setOff.toString(16) + " gap=" + ((s.svc - s.setOff) / 4))
console.log("-- non-movz setters (dynamic syscall nr):")
for (const s of sites) if (s.setter !== "movz" && s.setter !== "movzw") console.log("  svc=0x" + s.svc.toString(16) + " setter=" + s.setter)
console.log("-- svc sites at page offset 0xda4:")
for (const s of sites) if ((s.svc & 0xfff) === 0xda4) console.log("  svc=0x" + s.svc.toString(16) + " setter=" + s.setter + " imm=" + s.imm + " setter@0x" + s.setOff.toString(16))
