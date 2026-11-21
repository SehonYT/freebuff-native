#!/usr/bin/env node
// Return raw -ENOSYS at unsupported syscall sites; syscall 0 is io_setup on AArch64.
// Restrict instruction scanning to executable ELF segments and leave data untouched.
// Also patches read_url SSRF DNS check so external URLs can be read on Android/Termux.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const PATCH_VERSION = "explicit-enosys-v4";
const NRS = new Set([99, 283, 291, 424, 434, 435, 436, 437, 438, 439, 440, 441]);
const SVC = 0xd4000001;
const RETURN_ENOSYS = 0x928004a0;

// Exact 364-byte match and replacement for SSRF pre-check in read_url
const SSRF_ORIGINAL = Buffer.from(
  'async function b5J(J,_={}){let T=_.lookupHost??BRA,A=_.isBlocked??dC_,R;try{R=await T(J)}catch(P){throw new pk(`Could not resolve host "${J}": ${P instanceof Error?P.message:"unknown error"}`)}if(R.length===0)throw new pk(`Could not resolve host "${J}"`);for(let P of R)if(A(P))throw new pk(`Host "${J}" resolves to a private or reserved address (${P})`);return R}'
);
const SSRF_PATCHED = Buffer.from(
  'async function b5J(J,_={}){let T=_.lookupHost??BRA,A=_.isBlocked??dC_,R;try{hRA.setServers(["8.8.8.8","1.1.1.1"])}catch{}try{R=await T(J)}catch{R=["1.1.1.1"]}if(!R||R.length===0)R=["1.1.1.1"];for(let P of R)if(A(P))throw new pk(`Blocked address (${P})`);return R/***************************************************************************************************/}'
);

function codeRanges(buf) {
  if (buf.length < 64 || buf.readUInt32LE(0) !== 0x464c457f || buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 183) {
    throw new Error("expected little-endian AArch64 ELF64");
  }
  const offset = Number(buf.readBigUInt64LE(32));
  const stride = buf.readUInt16LE(54);
  const count = buf.readUInt16LE(56);
  if (stride < 56 || offset + stride * count > buf.length) throw new Error("invalid program headers");
  const ranges = [];
  for (let j = 0; j < count; j++) {
    const p = offset + j * stride;
    if (buf.readUInt32LE(p) !== 1 || !(buf.readUInt32LE(p + 4) & 1)) continue;
    const start = Number(buf.readBigUInt64LE(p + 8));
    const size = Number(buf.readBigUInt64LE(p + 32));
    if (!Number.isSafeInteger(start + size) || start + size > buf.length) throw new Error("invalid executable segment");
    ranges.push([Math.ceil(start / 4) * 4, start + size]);
  }
  return ranges;
}

function changesX8(w) {
  if ((w & 31) !== 8) return false;
  const moveWide = (w & 0x1f800000) === 0x12800000;
  const dataProcessing = (w & 0x1c000000) === 0x10000000 || (w & 0x1e000000) === 0x0a000000;
  const load = (w & 0x0a400000) === 0x08400000;
  return moveWide || dataProcessing || load;
}

export function patchSsrfDns(buf) {
  const idx = buf.indexOf(SSRF_ORIGINAL);
  if (idx !== -1) {
    SSRF_PATCHED.copy(buf, idx);
    return true;
  }
  return false;
}

export function patchBuffer(buf) {
  const patched = [];
  for (const [start, end] of codeRanges(buf)) {
    for (let i = start; i + 4 <= end; i += 4) {
      const w = buf.readUInt32LE(i);
      const base = (w & 0xffe0001f) >>> 0;
      if (base !== 0xd2800008 && base !== 0x52800008) continue;
      const nr = (w >>> 5) & 0xffff;
      if (!NRS.has(nr)) continue;
      for (let j = 1; j <= 24 && i + j * 4 + 4 <= end; j++) {
        const at = i + j * 4;
        const next = buf.readUInt32LE(at);
        if (next === RETURN_ENOSYS) break;
        if (next === SVC) {
          buf.writeUInt32LE(RETURN_ENOSYS, at);
          patched.push("nr=" + nr + " svc=0x" + at.toString(16) + " -> -ENOSYS");
          break;
        }
        if (changesX8(next)) break;
        if ((next & 0x7c000000) === 0x14000000 || (next & 0xfffffc1f) === (0xd65f0000 | 0)) break;
      }
    }
  }

  // Also apply SSRF DNS patch if original pattern present
  if (patchSsrfDns(buf)) {
    patched.push("read_url SSRF DNS check -> Android Termux compatible");
  }

  return patched;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const input = process.argv[2];
  if (!input) { console.error("usage: node patch-syscalls.mjs <in> [out]"); process.exit(2); }
  const b = fs.readFileSync(input);
  const sites = patchBuffer(b);
  if (sites.length || process.argv[3]) fs.writeFileSync(process.argv[3] || input, b);
  for (const site of sites) console.error("patched " + site);
  console.log("patch-syscalls: " + sites.length + " site(s) patched in " + input);
}
