#!/usr/bin/env node
// Checks dist-world/world-export.js, the runtime an exported Lumopolis page inlines in ONE classic <script>
// (npm run build:world-viewer runs it after the export pass of vite.world.config.ts). It fails when the script:
//   - contains "</script" in any case: the HTML parser would end the inline script there;
//   - contains "import(" or "import.meta": a classic inline script has no module loader and no import.meta,
//     and the page's CSP allows no request a dynamic import could make;
//   - is bigger than MAX_BYTES: the keyword-only page has a size budget, and a jump means something new got bundled.
// It also fails when dist-world holds a .wasm file: the page carries the ORT wasm as a data block, so a wasm the
// build emitted beside the script means ORT is still looking for it by URL.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** The size bound in bytes: 723,740 measured on 2026-11-21 (Three.js, the engine, ORT glue, the runtime), plus about 10%. */
const MAX_BYTES = 800_000

const RULES = [
  { re: /<\/script/i, why: 'contains "</script", which would end the inline <script> early' },
  { re: /import\(/, why: 'contains "import(", and a classic inline script has no module loader' },
  { re: /import\.meta/, why: 'contains "import.meta", which a classic script does not have' },
]

/** The problems with `dir`/world-export.js (an empty list when it is fine). */
function checkBundle(dir, maxBytes = MAX_BYTES) {
  const file = path.join(dir, 'world-export.js')
  if (!fs.existsSync(file)) return [`${file} is missing: run the export pass (vite build -c vite.world.config.ts --mode export)`]
  const text = fs.readFileSync(file, 'utf8')
  const problems = RULES.filter((r) => r.re.test(text)).map((r) => `world-export.js ${r.why}`)
  const size = Buffer.byteLength(text, 'utf8')
  if (size > maxBytes) problems.push(`world-export.js is ${size} bytes, over the ${maxBytes}-byte bound`)
  for (const name of fs.readdirSync(dir)) {
    if (/\.wasm$/i.test(name)) problems.push(`${name} was emitted beside the script: the page carries the wasm itself`)
  }
  return problems
}

function main(dir = path.join(__dirname, '..', 'dist-world')) {
  const problems = checkBundle(dir)
  for (const p of problems) console.error(`checkWorldExportBundle: ${p}`)
  if (problems.length === 0) console.log(`checkWorldExportBundle: ${path.join(dir, 'world-export.js')} is fine`)
  return problems.length === 0 ? 0 : 1
}

if (require.main === module) process.exit(main())

module.exports = { checkBundle, main, MAX_BYTES }
