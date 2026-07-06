#!/usr/bin/env node
// Copy the web-tree-sitter core runtime + the language grammar WASMs from node_modules into
// resources/grammars/, which electron-builder bundles as extraResources (→ process.resourcesPath/
// grammars in the packaged app). Kept out of git (like resources/models) and regenerated from the
// devDependency tree-sitter-wasms on every build — so CI, which runs `npm ci`, always has them.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'resources', 'grammars')
const GRAMMAR_SRC = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out')
const CORE_SRC = path.join(ROOT, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')

// The languages we extract at AST precision. HCL/Terraform + Bicep intentionally stay on the
// heuristic extractor (surface-level), so they are not listed here.
const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'c_sharp', 'ruby', 'swift']

fs.mkdirSync(OUT, { recursive: true })
let copied = 0
const missing = []
for (const g of GRAMMARS) {
  const name = `tree-sitter-${g}.wasm`
  const src = path.join(GRAMMAR_SRC, name)
  if (!fs.existsSync(src)) { missing.push(name); continue }
  fs.copyFileSync(src, path.join(OUT, name))
  copied++
}
if (fs.existsSync(CORE_SRC)) {
  fs.copyFileSync(CORE_SRC, path.join(OUT, 'tree-sitter.wasm'))
  copied++
} else {
  missing.push('tree-sitter.wasm')
}

if (missing.length) {
  console.error(`copy-grammars: MISSING ${missing.length} file(s): ${missing.join(', ')} — did you run npm install?`)
  process.exit(1)
}
console.log(`copy-grammars: copied ${copied} files → resources/grammars/`)
