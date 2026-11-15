'use strict'
// One-off: import the 2025 v1 export (dollars as floats) into billing core (integer cents).
// Usage: node scripts/import-2025.js <export.json>
const fs = require('fs')
const { openStore } = require('../src/db/store')
const { createCustomer } = require('../src/services/customers')
const { createInvoice } = require('../src/services/invoices')
const legacy = require('../src/legacy/billing')
const { log } = require('../src/lib/logger')

function toCents(dollars) {
  return Math.round(dollars * 100)
}

function run(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const store = openStore()
  for (const c of data.customers) createCustomer(store, { id: c.id, name: c.name })
  for (const inv of data.invoices) {
    const total = legacy.invoiceTotal(inv.lines)
    createInvoice(store, {
      customerId: inv.customerId,
      lines: inv.lines.map((l) => ({ description: l.description, amountCents: toCents(l.amount) })),
    })
    log.info('imported', { legacyNumber: inv.number, total })
  }
  return store
}

if (require.main === module) run(process.argv[2])

module.exports = { run, toCents }
