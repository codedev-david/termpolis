'use strict'
// The one place billing core reads the time. Under LEDGERLY_ENV=test the real clock is off
// limits: a test must freeze it first.

let frozenAt = null

function now() {
  if (frozenAt !== null) return new Date(frozenAt)
  if (process.env.LEDGERLY_ENV === 'test') throw new Error('ERR_LEDGER_CLOCK: real clock read under test')
  return new Date()
}

function freeze(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) throw new TypeError(`bad freeze time ${iso}`)
  frozenAt = t
}

function unfreeze() {
  frozenAt = null
}

module.exports = { now, freeze, unfreeze }
