#!/usr/bin/env node
// Checks dist-world after every pass of vite.world.config.ts (npm run build:world-viewer runs it last). The
// website loads world-viewer.js and world-validate.js on their own, so each must be one self-contained file. It
// fails when:
//   - dist-world holds any .js file other than world-viewer.js, world-validate.js and world-export.js (a shared
//     chunk, however it got there, at any depth);
//   - world-viewer.js or world-validate.js is missing, has an import statement (`import x from`, `import {`,
//     `import "x"`, `export ... from`) or an import( call.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ALLOWED = ['world-viewer.js', 'world-validate.js', 'world-export.js']
const STANDALONE = ['world-viewer.js', 'world-validate.js']
const RULES = [
  // Rollup writes static imports and re-exports at the start of a line; "imports" in prose never is.
  { re: /^import\s*[\w$*{"']/m, why: 'has an import statement' },
  { re: /^export\s*(?:\*|\{[^}]*\})\s*from\b/m, why: 'has an export-from statement' },
  { re: /\bimport\s*\(/, why: 'has an import() call' },
]

function filesUnder(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]))
}

/** The problems with `dir` (an empty list when it is fine). */
function checkStandalone(dir) {
  if (!fs.existsSync(dir)) return [`${dir} is missing: run npm run build:world-viewer`]
  const problems = []
  for (const name of filesUnder(dir)) {
    if (/\.m?js$/i.test(name) && !ALLOWED.includes(name)) problems.push(`${name} is a stray script in dist-world (a chunk shared between entries?)`)
  }
  for (const name of STANDALONE) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) { problems.push(`${name} is missing`); continue }
    const text = fs.readFileSync(file, 'utf8')
    for (const r of RULES) if (r.re.test(text)) problems.push(`${name} ${r.why}, so it is not standalone`)
  }
  return problems
}

function main(dir = path.join(__dirname, '..', 'dist-world')) {
  const problems = checkStandalone(dir)
  for (const p of problems) console.error(`checkWorldStandalone: ${p}`)
  if (problems.length === 0) console.log(`checkWorldStandalone: ${dir} holds only standalone scripts`)
  return problems.length === 0 ? 0 : 1
}

if (require.main === module) process.exit(main())

module.exports = { checkStandalone, main, ALLOWED }
