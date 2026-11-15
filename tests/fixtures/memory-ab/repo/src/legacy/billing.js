// v1 billing engine (monolith era). Kept for scripts/import-2025.js.
const { round2 } = require('./money')

const yearSeq = {}

function nextInvoiceNumber(year) {
  yearSeq[year] = (yearSeq[year] || 0) + 1
  return `INV-${year}-${String(yearSeq[year]).padStart(4, '0')}`
}

function invoiceTotal(lines) {
  return round2(lines.reduce((a, l) => a + l.amount, 0))
}

function overpaid(total, paid) {
  return paid > total
}

module.exports = { nextInvoiceNumber, invoiceTotal, overpaid }
