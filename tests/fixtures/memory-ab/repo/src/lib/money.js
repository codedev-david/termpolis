'use strict'
// Money helpers. Amounts are integer minor units (cents) everywhere in billing core.

const SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£' }

function assertCents(n, label = 'amount') {
  if (!Number.isInteger(n)) throw new TypeError(`${label} must be integer cents, got ${n}`)
}

// Banker's rounding: .5 goes to the nearest even integer.
function roundHalfEven(x) {
  const floor = Math.floor(x)
  const diff = x - floor
  const EPS = 1e-9
  if (diff > 0.5 + EPS) return floor + 1
  if (diff < 0.5 - EPS) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function percentOf(cents, percent) {
  assertCents(cents)
  return roundHalfEven((cents * percent) / 100)
}

function basisPointsOf(cents, bps) {
  assertCents(cents)
  return roundHalfEven((cents * bps) / 10000)
}

function sumCents(list) {
  return list.reduce((acc, n) => {
    assertCents(n)
    return acc + n
  }, 0)
}

function formatCents(cents, currency = 'USD') {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const units = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = `${units}.${String(abs % 100).padStart(2, '0')}`
  const symbol = SYMBOLS[currency] ?? `${currency} `
  return `${sign}${symbol}${body}`
}

// Split `cents` across `ratios` without losing a cent (largest remainder).
function allocate(cents, ratios) {
  assertCents(cents)
  const total = ratios.reduce((a, b) => a + b, 0)
  const raw = ratios.map((r) => (cents * r) / total)
  const out = raw.map(Math.floor)
  let left = cents - out.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]] += 1
  return out
}

module.exports = { assertCents, roundHalfEven, percentOf, basisPointsOf, sumCents, formatCents, allocate }
