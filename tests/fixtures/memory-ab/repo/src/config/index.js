'use strict'
// Settings: config/defaults.json, overridden by LEDGERLY_* environment variables.
const path = require('path')
const fs = require('fs')

const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'defaults.json'), 'utf8'))

function fromEnv(name, fallback) {
  const v = process.env[`LEDGERLY_${name}`]
  return v === undefined ? fallback : v
}

module.exports = {
  port: Number(fromEnv('PORT', defaults.port)),
  defaultCurrency: fromEnv('DEFAULT_CURRENCY', defaults.defaultCurrency),
  termsDays: Number(fromEnv('TERMS_DAYS', defaults.termsDays)),
}
