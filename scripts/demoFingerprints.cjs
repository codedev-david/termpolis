#!/usr/bin/env node
// Prints the demoCleanup fingerprint of every .yml workflow in a directory.
// Used to refresh DEMO_FINGERPRINTS in src/main/workflow/demoCleanup.ts when the
// demo/screenshot tooling changes the sample workflows it generates.
//
//   node scripts/demoFingerprints.cjs <dir>
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const YAML = require('yaml')

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/demoFingerprints.cjs <dir-of-workflow-yml>')
  process.exit(2)
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yml')).sort()) {
  const wf = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const steps = (wf.steps ?? []).map(({ id, ...rest }) => rest)
  const fp = createHash('sha256')
    .update(stableStringify({ name: wf.name, version: wf.version, trigger: wf.trigger, steps }))
    .digest('hex')
    .slice(0, 32)
  console.log(`  '${fp}', // ${wf.name}`)
}
