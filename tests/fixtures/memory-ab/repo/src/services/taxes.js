'use strict'
// Sales tax. Rates are basis points (1300 = 13%) loaded from config/tax-rates.json.
const path = require('path')
const fs = require('fs')
const { basisPointsOf } = require('../lib/money')
const { AppError } = require('../lib/errors')

let rates = null
function loadRates() {
  if (!rates) rates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'tax-rates.json'), 'utf8'))
  return rates
}

function taxFor(cents, region) {
  const bps = loadRates()[region]
  if (bps === undefined) throw new AppError('ERR_VALIDATION', `unknown tax region ${region}`)
  return basisPointsOf(cents, bps)
}

module.exports = { taxFor }
