'use strict'
// House rules for src/ (outside src/legacy): no console output, no float money helpers.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'src')
const problems = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'legacy') walk(full)
    } else if (entry.name.endsWith('.js')) {
      check(full)
    }
  }
}

function check(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const where = `${path.relative(path.join(root, '..'), file)}:${i + 1}`
    if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line)) problems.push(`${where} console output (use src/lib/logger.js)`)
    if (/require\(['"][./]*legacy\//.test(line)) problems.push(`${where} imports from src/legacy`)
    if (/\.toFixed\(/.test(line)) problems.push(`${where} toFixed on money (use formatCents)`)
  })
}

walk(root)
if (problems.length) {
  process.stdout.write(problems.join('\n') + '\n')
  process.exit(1)
}
process.stdout.write('lint ok\n')
