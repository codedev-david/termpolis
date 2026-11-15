'use strict'
const assert = require('assert')
const { test } = require('./harness')
const { useFrozenClock } = require('./helpers/clock')
const { freshStore, seedCustomers } = require('./helpers/fixtures')
const invoices = require('../src/services/invoices')

useFrozenClock()

test('createInvoice totals lines and sets terms', () => {
  const store = seedCustomers(freshStore())
  const inv = invoices.createInvoice(store, {
    customerId: 'c1',
    lines: [{ description: 'Widget', amountCents: 1999 }, { description: 'Setup', amountCents: 5000 }],
  })
  assert.strictEqual(inv.totalCents, 6999)
  assert.strictEqual(inv.currency, 'USD')
  assert.strictEqual(inv.issuedOn, '2026-01-15')
  assert.strictEqual(inv.dueDate, '2026-02-14')
})

test('createInvoice rejects float amounts', () => {
  const store = seedCustomers(freshStore())
  assert.throws(() => invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'x', amountCents: 10.5 }] }))
})

test('finalized invoices cannot be edited', () => {
  const store = seedCustomers(freshStore())
  const inv = invoices.createInvoice(store, { customerId: 'c2', lines: [{ description: 'x', amountCents: 100 }] })
  invoices.finalizeInvoice(store, inv.id)
  assert.throws(() => invoices.addLine(store, inv.id, { description: 'y', amountCents: 1 }), (e) => e.code === 'ERR_INVOICE_FINALIZED')
})
