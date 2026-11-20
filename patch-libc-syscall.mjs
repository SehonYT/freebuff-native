#!/usr/bin/env node
// Rewrite glibc's generic syscall() in a private libc.so.6: blocked arm64
// syscall numbers (SIGSYS under Android app seccomp) return ENOSYS via
// glibc's own errno path; everything else forwards via inline svc.
// Symbol-driven with shape verification: safe across glibc builds.
import fs from "node:fs"

const inPath = process.argv[2]
const outPath = process.argv[3] || inPath
if (!inPath) { console.error("usage: node patch-libc-syscall.mjs <in> [out]"); process.exit(2) }
const buf = fs.readFileSync(inPath)

function fail(msg) { console.error("patch-libc-syscall: " + msg); process.exit(1) }
if (buf.readUInt32LE(0) !== 0x464c457f || buf[4] !== 2) fail("not an ELF64 file")
if (buf.readUInt16LE(18) !== 0xb7) fail("not an aarch64 ELF")
const e_shoff = Number(buf.readBigUInt64LE(0x28))
const e_shentsize = buf.readUInt16LE(0x3a)
const e_shnum = buf.readUInt16LE(0x3c)

function shdr(i) {
  const o = e_shoff + i * e_shentsize
  return {
    type: buf.readUInt32LE(o + 4),
    offset: Number(buf.readBigUInt64LE(o + 0x18)),
    size: Number(buf.readBigUInt64LE(o + 0x20)),
    link: buf.readUInt32LE(o + 0x28),
  }
}

function cstr(off) {
  let end = off
  while (end < buf.length && buf[end] !== 0) end++
  return buf.toString("latin1", off, end)
}

let symEntry = null
for (let i = 0; i < e_shnum; i++) {
  const s = shdr(i)
  if (s.type !== 11) continue // SHT_DYNSYM
  const strs = shdr(s.link)
  const count = Math.floor(s.size / 24)
  for (let k = 0; k < count; k++) {
    const so = s.offset + k * 24
    if (cstr(strs.offset + buf.readUInt32LE(so)) !== "syscall") continue
    const info = buf[so + 4]
    const value = Number(buf.readBigUInt64LE(so + 8))
    if ((info & 0xf) === 2 && value) symEntry = value // STT_FUNC
  }
}
if (!symEntry) fail("syscall() symbol not found in .dynsym")

const e_phoff = Number(buf.readBigUInt64LE(0x20))
const e_phentsize = buf.readUInt16LE(0x36)
const e_phnum = buf.readUInt16LE(0x38)
let execEnd = 0
function vaddrToOff(v) {
  for (let i = 0; i < e_phnum; i++) {
    const o = e_phoff + i * e_phentsize
    if (buf.readUInt32LE(o) !== 1) continue // PT_LOAD
    const p_offset = Number(buf.readBigUInt64LE(o + 8))
    const p_vaddr = Number(buf.readBigUInt64LE(o + 16))
    const p_filesz = Number(buf.readBigUInt64LE(o + 32))
    if (buf.readUInt32LE(o + 4) & 1) execEnd = Math.max(execEnd, p_offset + p_filesz)
    if (v >= p_vaddr && v < p_vaddr + p_filesz) return p_offset + (v - p_vaddr)
  }
  return -1
}

const FN = vaddrToOff(symEntry)
if (FN < 0) fail("syscall() vaddr not mapped")

function branchTarget(off) {
  const w = buf.readUInt32LE(off)
  if ((w & 0xfc000000) >>> 0 !== 0x14000000) return -1
  let imm = w & 0x3ffffff
  if (imm >= 0x2000000) imm -= 0x4000000
  return off + imm * 4
}

// already patched? entry is a branch whose target starts with our filter
const w0 = buf.readUInt32LE(FN)
if ((w0 & 0xfc000000) >>> 0 === 0x14000000) {
  const t = branchTarget(FN)
  if (t >= 0 && buf.readUInt32LE(t) === ((0x51000000 | (434 << 10) | 9) >>> 0)) {
    console.log("patch-libc-syscall: already patched (syscall() at 0x" + FN.toString(16) + ")")
    process.exit(0)
  }
}

// verify glibc syscall() shape: mov w8,w0; ...; svc; cmn; b.hs err
if (w0 !== 0x2a0003e8) fail("unexpected instruction at syscall() entry: 0x" + w0.toString(16))
let SVC_AT = -1
for (let j = 1; j <= 16; j++) {
  if (buf.readUInt32LE(FN + 4 * j) === 0xd4000001) { SVC_AT = FN + 4 * j; break }
}
if (SVC_AT < 0) fail("no svc after syscall() entry")
const CMN = buf.readUInt32LE(SVC_AT + 4)
if ((CMN & 0xff000000) >>> 0 !== 0xb1000000) fail("expected cmn (adds) after svc, got 0x" + CMN.toString(16))
const BHS = buf.readUInt32LE(SVC_AT + 8)
if ((BHS & 0xffe0001f) !== 0x54000002) fail("expected b.hs after cmn")
let imm19 = (BHS >> 5) & 0x7ffff
if (imm19 >= 0x40000) imm19 -= 0x80000
const ERR = SVC_AT + 8 + imm19 * 4
if (ERR <= 0) fail("bad b.hs target")
console.error("syscall() at 0x" + FN.toString(16) + ", svc 0x" + SVC_AT.toString(16) + ", error entry 0x" + ERR.toString(16))

// find a cave: highest run of >= 28 consecutive zero words inside exec range
const NEED = 28
let cave = -1
outer: for (let i = execEnd - 4 * NEED; i > 0x1000; i -= 4) {
  for (let j = 0; j < NEED; j++) if (buf.readUInt32LE(i + 4 * j) !== 0) continue outer
  cave = i; break
}
if (cave < 0) fail("no code cave found in exec segment")
console.error("cave at 0x" + cave.toString(16))

const E = {
  subW: (rd, rn, imm) => (0x51000000 | (imm << 10) | (rn << 5) | rd) >>> 0,
  cmpW: (rn, imm) => (0x7100001f | (imm << 10) | (rn << 5)) >>> 0,
  bcond: (off, cond) => (0x54000000 | (((off >> 2) & 0x7ffff) << 5) | cond) >>> 0,
  b: (off) => (0x14000000 | ((off >> 2) & 0x3ffffff)) >>> 0,
  movW: (rd, rn) => (0x2a000000 | (rn << 16) | 0x3e0 | rd) >>> 0,
  movX: (rd, rn) => (0xaa000000 | (rn << 16) | 0x3e0 | rd) >>> 0,
  svc: 0xd4000001,
  cmnX: (rn, imm) => (0xb1000000 | (imm << 10) | (rn << 5) | 0x1f) >>> 0,
  ret: 0xd65f03c0,
  movnX: (rd, imm) => (0x92800000 | (imm << 5) | rd) >>> 0,
}

const code = []
const at = (idx) => cave + idx * 4
const BLOCKED = 23 * 4
code.push(E.subW(9, 0, 434))            // 0  sub w9, w0, #434
code.push(E.cmpW(9, 7))                 // 1  cmp w9, #7  (nr 434..441)
code.push(E.bcond(BLOCKED - 8, 9))      // 2  b.ls blocked
code.push(E.cmpW(0, 99))                // 3  cmp w0, #99
code.push(E.bcond(BLOCKED - 16, 0))     // 4  b.eq blocked
code.push(E.cmpW(0, 283))               // 5  cmp w0, #283
code.push(E.bcond(BLOCKED - 24, 0))     // 6  b.eq blocked
code.push(E.cmpW(0, 291))               // 7  cmp w0, #291
code.push(E.bcond(BLOCKED - 32, 0))     // 8  b.eq blocked
code.push(E.cmpW(0, 424))               // 9  cmp w0, #424
code.push(E.bcond(BLOCKED - 40, 0))     // 10 b.eq blocked
code.push(E.movW(8, 0))                 // 11 mov w8, w0
code.push(E.movX(0, 1))                 // 12 mov x0, x1
code.push(E.movX(1, 2))                 // 13 mov x1, x2
code.push(E.movX(2, 3))                 // 14 mov x2, x3
code.push(E.movX(3, 4))                 // 15 mov x3, x4
code.push(E.movX(4, 5))                 // 16 mov x4, x5
code.push(E.movX(5, 6))                 // 17 mov x5, x6
code.push(E.movX(6, 7))                 // 18 mov x6, x7
code.push(E.svc)                         // 19 svc #0
code.push(E.cmnX(0, 4095))              // 20 cmn x0, #4095
code.push(E.bcond(ERR - at(21), 2))    // 21 b.hs err
code.push(E.ret)                         // 22 ret
if (BLOCKED !== 23 * 4) fail("internal: blocked label misplaced")
code.push(E.movnX(0, 37))               // 23 blocked: mov x0, #-38
code.push(E.b(ERR - at(24)))            // 24 b err

code.forEach((w, idx) => buf.writeUInt32LE(w, cave + idx * 4))
buf.writeUInt32LE(E.b(cave - FN), FN)
fs.writeFileSync(outPath, buf)
console.log("patch-libc-syscall: syscall() hooked via cave 0x" + cave.toString(16) + " in " + outPath)
