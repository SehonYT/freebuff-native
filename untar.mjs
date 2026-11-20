// Shared pure-node archive extraction (gunzip + minimal tar reader).
// Some devices ship tools that corrupt large members; this is byte-exact.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

function tarMembers(raw, wanted) {
  let off = 0
  let longName = null
  const out = []
  while (off + 512 <= raw.length) {
    const hdr = raw.subarray(off, off + 512)
    if (hdr.every((b) => b === 0)) break
    let name = longName || hdr.subarray(0, 100).toString("latin1").replace(/\0[\s\S]*$/, "")
    longName = null
    const sizeStr = hdr.subarray(124, 136).toString("latin1").replace(/[\s\0]/g, "")
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(hdr[156] || 0x30)
    const dataStart = off + 512
    if (type === "L") {
      longName = raw.subarray(dataStart, dataStart + size).toString("latin1").replace(/\0[\s\S]*$/, "")
    } else if (type === "x" || type === "g") {
      // pax metadata records: skipped
    } else if (type === "0" || type === "\0" || type === "7") {
      const base = path.posix.basename(name.replace(/^\.\//, ""))
      if (wanted.includes(base)) out.push({ name: base, data: raw.subarray(dataStart, dataStart + size) })
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return out
}

export function extractMembersToBuffers(archivePath, wanted) {
  const raw = zlib.gunzipSync(fs.readFileSync(archivePath))
  return tarMembers(raw, wanted)
}

export function extractMembers(archivePath, outDir, wanted) {
  const members = extractMembersToBuffers(archivePath, wanted)
  const extracted = []
  for (const m of members) {
    fs.writeFileSync(path.join(outDir, m.name), m.data)
    extracted.push(m.name)
  }
  return extracted
}
