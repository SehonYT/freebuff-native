// Minimal ELF64 little-endian DT_NEEDED parser, no dependencies.
export function neededList(buf) {
  if (buf.readUInt32LE(0) !== 0x464c457f || buf[4] !== 2) return null
  const e_phoff = Number(buf.readBigUInt64LE(0x20))
  const e_phentsize = buf.readUInt16LE(0x36)
  const e_phnum = buf.readUInt16LE(0x38)
  let dyn = null
  const loads = []
  for (let i = 0; i < e_phnum; i++) {
    const o = e_phoff + i * e_phentsize
    const type = buf.readUInt32LE(o)
    if (type === 2) dyn = { off: Number(buf.readBigUInt64LE(o + 8)), size: Number(buf.readBigUInt64LE(o + 32)) }
    if (type === 1) loads.push({ vaddr: Number(buf.readBigUInt64LE(o + 16)), filesz: Number(buf.readBigUInt64LE(o + 32)), off: Number(buf.readBigUInt64LE(o + 8)) })
  }
  if (!dyn) return []
  const v2o = (v) => {
    for (const l of loads) if (v >= l.vaddr && v < l.vaddr + l.filesz) return l.off + (v - l.vaddr)
    return -1
  }
  const entries = []
  const n = Math.floor(dyn.size / 16)
  for (let i = 0; i < n; i++) {
    const tag = Number(buf.readBigUInt64LE(dyn.off + i * 16))
    const val = Number(buf.readBigUInt64LE(dyn.off + i * 16 + 8))
    entries.push([tag, val])
    if (tag === 0) break
  }
  const strtab = entries.find(([t]) => t === 5)
  if (!strtab) return []
  const strOff = v2o(strtab[1])
  if (strOff < 0) return []
  const needed = []
  for (const [t, v] of entries) {
    if (t !== 1) continue
    let end = strOff + v
    while (end < buf.length && buf[end] !== 0) end++
    needed.push(buf.toString("latin1", strOff + v, end))
  }
  return needed
}
