// v1 billing engine helpers (amounts in dollars, as floats).
// Kept for scripts/import-2025.js, which reads the v1 export.

function round2(x) {
  return Math.round(x * 100) / 100
}

function applyDiscount(amount, pct) {
  return round2(amount * (1 - pct / 100))
}

function addTax(amount, ratePct) {
  return round2(amount * (1 + ratePct / 100))
}

function format(amount) {
  return '$' + amount.toFixed(2)
}

module.exports = { round2, applyDiscount, addTax, format }
