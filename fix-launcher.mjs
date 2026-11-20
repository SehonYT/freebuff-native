#!/usr/bin/env node
// Re-apply the native patch hook into the freebuff npm launcher (idempotent).
// Needed after "npm install -g freebuff" reinstalls the launcher package.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PREFIX = process.env.FREEBUFF_PREFIX || process.env.PREFIX || '/data/data/com.termux/files/usr'
const LAUNCHER = path.join(PREFIX, 'lib', 'node_modules', 'freebuff', 'launcher.js')
const MARK = 'FREEBUFF_NATIVE_HOOK'

let code
try {
  code = fs.readFileSync(LAUNCHER, 'utf8')
} catch (e) {
  console.error('fix-launcher: cannot read launcher.js: ' + e.message)
  process.exit(1)
}

if (code.includes(MARK)) {
  console.log('fix-launcher: hook already present')
  process.exit(0)
}

const ANCHOR = '      commitReplacements(replacements)\n      installed = true'
if (!code.includes(ANCHOR)) {
  console.error('fix-launcher: anchor not found; launcher layout changed, hook not applied')
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

fs.writeFileSync(LAUNCHER, code.replace(ANCHOR, HOOK))
console.log('fix-launcher: hook installed into launcher.js')
