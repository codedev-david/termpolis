'use strict'
// Runs every test/*.unit.js file in order. Each file starts with a thawed clock and fresh ids.
process.env.LEDGERLY_ENV = 'test'

const fs = require('fs')
const path = require('path')
const harness = require('./harness')
const clock = require('../src/lib/clock')
const { _resetIds } = require('../src/lib/ids')

async function main() {
  const dir = __dirname
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.unit.js')).sort()
  const all = []
  for (const f of files) {
    harness.reset()
    clock.unfreeze()
    _resetIds()
    require(path.join(dir, f))
    all.push(...(await harness.runCollected(f)))
  }
  for (const r of all) {
    if (r.ok) process.stdout.write(`  ok   ${r.file} > ${r.name}\n`)
    else process.stdout.write(`  FAIL ${r.file} > ${r.name}\n       ${(r.error && r.error.message) || r.error}\n`)
  }
  const failed = all.filter((r) => !r.ok).length
  process.stdout.write(`RESULT passed=${all.length - failed} failed=${failed}\n`)
  process.exit(failed ? 1 : 0)
}

main()
