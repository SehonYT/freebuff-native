import assert from "node:assert/strict";
import test from "node:test";
import { patchBuffer } from "../patch-syscalls.mjs";
const SVC = 0xd4000001;
const ENOSYS = 0x928004a0;
const w8 = n => (0x52800008 | (n << 5)) >>> 0;
const x8 = n => (0xd2800008 | (n << 5)) >>> 0;
function elf(words, data = []) {
  const b = Buffer.alloc(1024);
  b.writeUInt32LE(0x464c457f, 0); b[4] = 2; b[5] = 1;
  b.writeUInt16LE(183, 18); b.writeBigUInt64LE(64n, 32);
  b.writeUInt16LE(56, 54); b.writeUInt16LE(2, 56);
  b.writeUInt32LE(1, 64); b.writeUInt32LE(5, 68);
  b.writeBigUInt64LE(256n, 72); b.writeBigUInt64LE(BigInt(words.length * 4), 96);
  b.writeUInt32LE(1, 120); b.writeUInt32LE(4, 124);
  b.writeBigUInt64LE(512n, 128); b.writeBigUInt64LE(BigInt(data.length * 4), 152);
  words.forEach((w,i) => b.writeUInt32LE(w >>> 0, 256+i*4));
  data.forEach((w,i) => b.writeUInt32LE(w >>> 0, 512+i*4));
  return b;
}
test("unsupported syscall returns raw -38 without issuing io_setup", () => {
  for (const mov of [w8, x8]) {
    const b = elf([mov(434), 0xaa0903e0, SVC, 0xb140041f]);
    const before = Buffer.from(b);
    assert.equal(patchBuffer(b).length, 1);
    assert.equal(b.readUInt32LE(256), before.readUInt32LE(256));
    assert.equal(b.readUInt32LE(264), ENOSYS);
    before.writeUInt32LE(ENOSYS, 264);
    assert.deepEqual(b, before);
    assert.equal(patchBuffer(b).length, 0);
  }
});
test("ordinary syscall zero and supported syscall remain untouched", () => {
  for (const nr of [0, 56, 260, 279]) {
    const b = elf([w8(nr), SVC]); const original = Buffer.from(b);
    assert.deepEqual(patchBuffer(b), []); assert.deepEqual(b, original);
  }
});
test("constants used in open flags must not disable openat", () => {
  const b = elf([w8(438), 0x2a08001a, w8(56), 0xaa1903e0, SVC]);
  const original = Buffer.from(b);
  assert.deepEqual(patchBuffer(b), []); assert.deepEqual(b, original);
});
test("an x8 overwrite invalidates a syscall-number candidate", () => {
  const b = elf([w8(436), 0x910003e8, SVC]); const original = Buffer.from(b);
  assert.deepEqual(patchBuffer(b), []); assert.deepEqual(b, original);
});
test("read-only data and executable range boundaries are respected", () => {
  const b = elf([w8(434)], [w8(434), SVC]); const original = Buffer.from(b);
  assert.deepEqual(patchBuffer(b), []); assert.deepEqual(b, original);
});
test("invalid and non-arm64 inputs are rejected without writes", () => {
  const b = Buffer.alloc(32); assert.throws(() => patchBuffer(b), /ELF/);
  const wrong = elf([w8(434), SVC]); wrong.writeUInt16LE(62, 18);
  assert.throws(() => patchBuffer(wrong), /AArch64/);
});

test("patchSsrfDns replaces SSRF pre-check with exact same byte length", () => {
  const original = Buffer.from(
    'async function b5J(J,_={}){let T=_.lookupHost??BRA,A=_.isBlocked??dC_,R;try{R=await T(J)}catch(P){throw new pk(`Could not resolve host "${J}": ${P instanceof Error?P.message:"unknown error"}`)}if(R.length===0)throw new pk(`Could not resolve host "${J}"`);for(let P of R)if(A(P))throw new pk(`Host "${J}" resolves to a private or reserved address (${P})`);return R}'
  );
  const b = elf([w8(56), SVC]); // valid elf with 1 code segment
  // Append data containing original SSRF snippet
  const full = Buffer.concat([b, original]);
  const fullLen = full.length;
  assert.equal(patchBuffer(full).length, 1);
  assert.equal(full.length, fullLen);
  assert.equal(full.indexOf(original), -1);
  assert.notEqual(full.indexOf(Buffer.from("hRA.setServers")), -1);
  assert.equal(patchBuffer(full).length, 0); // Idempotent
});

