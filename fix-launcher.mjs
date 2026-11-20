#!/usr/bin/env node
// Re-apply the freebuff-native hooks into the freebuff npm launcher
// (idempotent, upgrades older shapes):
// 1. update hook: re-patch + verify each update install before commit.
// 2. loader-aware spawn with bionic LD_* stripped: runs the CLI through the
//    private glibc loader, immune to termux-exec LD_PRELOAD poisoning.
import fs from "node:fs"
import path from "node:path"

const PREFIX = process.env.FREEBUFF_PREFIX || process.env.PREFIX || '/data/data/com.termux/files/usr'
const LAUNCHER = path.join(PREFIX, 'lib', 'node_modules', 'freebuff', 'launcher.js')

let code
try {
  code = fs.readFileSync(LAUNCHER, 'utf8')
} catch (e) {
  console.error('fix-launcher: cannot read launcher.js: ' + e.message)
  process.exit(1)
}

let changed = false

// --- hook 1: native patch after each install, before commit/rollback ---
if (!code.includes("FREEBUFF_NATIVE_HOOK")) {
  const ANCHOR = '      commitReplacements(replacements)\n      installed = true'
  if (!code.includes(ANCHOR)) {
    console.error('fix-launcher: install anchor not found; launcher layout changed')
    process.exit(1)
  }
  const HOOK = [
    '      // Unsupported-platform support (freebuff-native): re-apply native',
    '      // patches before committing the install, while rollback backups',
    '      // still exist; a false return rolls this install back.',
    '      const nativeHookPath = process.env.FREEBUFF_NATIVE_HOOK',
    '      if (',
    '        nativeHookPath &&',
    '        fs.existsSync(nativeHookPath) &&',
    '        !require(nativeHookPath).applyNativePatch(CONFIG.binaryPath)',
    '      ) {',
    '        throw new Error(',
    '          "native patch hook failed; keeping the previous binary",',
    '        )',
    '      }',
    '      commitReplacements(replacements)\n      installed = true',
  ].join('\n')
  code = code.replace(ANCHOR, HOOK)
  changed = true
  console.log("fix-launcher: update hook installed")
}

// --- hook 2: spawn through the private loader, bionic LD_* stripped ---
const SPAWN_ANCHOR = 'child = spawn(CONFIG.binaryPath, process.argv.slice(2), {'
const SPAWN_NEW = [
  'const fbLoader = process.env.FREEBUFF_LOADER_PATH',
  '      const fbLibDir = process.env.FREEBUFF_LIB_DIR',
  '      // freebuff-native: strip bionic LD_* (termux-exec LD_PRELOAD drags',
  '      // bionic libc.so into the glibc loader) before spawning.',
  '      for (const fbK of Object.keys(process.env)) if (fbK.startsWith("LD_")) delete process.env[fbK]',
  '      const fbArgs = fbLoader ? [fbLibDir ? "--library-path" : null, fbLibDir, CONFIG.binaryPath, ...process.argv.slice(2)].filter(Boolean) : process.argv.slice(2)',
  '      child = spawn(fbLoader || CONFIG.binaryPath, fbArgs, {',
].join('\n')
const OLDER_SHAPES = [
  [
    'const fbLoader = process.env.FREEBUFF_LOADER_PATH',
    '      const fbLibDir = process.env.FREEBUFF_LIB_DIR',
    '      const fbArgs = fbLoader',
    '        ? [fbLibDir ? "--library-path" : null, fbLibDir, CONFIG.binaryPath, ...process.argv.slice(2)].filter(Boolean)',
    '        : process.argv.slice(2)',
    '      child = spawn(fbLoader || CONFIG.binaryPath, fbArgs, {',
  ].join('\n')
  ,
  [
    'const fbLoader = process.env.FREEBUFF_LOADER_PATH',
    '      const fbArgs = fbLoader ? [CONFIG.binaryPath, ...process.argv.slice(2)] : process.argv.slice(2)',
    '      child = spawn(fbLoader || CONFIG.binaryPath, fbArgs, {',
  ].join('\n')
  ,
]

if (!code.includes('fbK.startsWith("LD_")')) {
  for (const oldShape of OLDER_SHAPES) {
    if (code.includes(oldShape)) {
      code = code.replace(oldShape, SPAWN_ANCHOR)
      console.log("fix-launcher: reverting older spawn shape for upgrade")
      changed = true
      break
    }
  }
  if (code.includes(SPAWN_ANCHOR)) {
    code = code.replace(SPAWN_ANCHOR, SPAWN_NEW)
    changed = true
    console.log("fix-launcher: loader-aware spawn installed (LD_* stripped)")
  } else {
    console.error('fix-launcher: spawn anchor not found; launcher layout changed')
    process.exit(1)
  }
}

if (changed) fs.writeFileSync(LAUNCHER, code)
else console.log('fix-launcher: already patched')
