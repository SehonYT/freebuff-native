#!/usr/bin/env node
// Install the prebuilt patched glibc runtime set from the committed bundle
// (runtime/linux-arm64-libs.tar.gz). Deterministic on every device: no
// dpkg-deb, no tar, no find/cp - and every file is md5-verified.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { extractMembers } from "./untar.mjs"

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LIBDIR = path.join(DIR, "lib")
const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex")

const EXPECTED = {
  "ld-linux-aarch64.so.1": "1fae6629c40a12ec665a2cf1ab978ea3",
  "libc.so.6": "03a02999fe25c1481ef24df5e87489a0",
  "libpthread.so.0": "69978f9c0dac73813d33c25b259b4b08",
  "libdl.so.2": "86f263dad16e8de33d5cafe46ade8c31",
  "libm.so.6": "6534e5b22d062a2ef692cd109e30e7f2",
  "libresolv.so.2": "5c89afcd06d890c45ee7425d43105bb8",
}

fs.rmSync(LIBDIR, { recursive: true, force: true })
fs.mkdirSync(LIBDIR, { recursive: true })
for (const name of extractMembers(path.join(DIR, "runtime", "linux-arm64-libs.tar.gz"), LIBDIR, Object.keys(EXPECTED))) {
  console.log("extract-libs: " + name)
}

let ok = true
for (const [name, sum] of Object.entries(EXPECTED)) {
  const f = path.join(LIBDIR, name)
  if (!fs.existsSync(f)) {
    console.error("extract-libs: missing " + name)
    ok = false
    continue
  }
  const got = md5(f)
  if (got !== sum) {
    console.error("extract-libs: md5 mismatch for " + name + ": " + got + " (expected " + sum + ")")
    ok = false
  }
  fs.chmodSync(f, 0o755)
}
if (!ok) {
  console.error("extract-libs: bundle verification failed; report this output")
  process.exit(1)
}
console.log("extract-libs: patched glibc set verified in " + LIBDIR)
