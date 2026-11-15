'use strict'
const assert = require('assert')
const { test } = require('./harness')
const { useFrozenClock } = require('./helpers/clock')
const { freshStore, seedCustomers } = require('./helpers/fixtures')
const invoices = require('../src/services/invoices')
const payments = require('../src/services/payments')
const ledger = require('../src/services/ledger')

useFrozenClock()

function setup() {
  const store = seedCustomers(freshStore())
  const inv = invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'Plan', amountCents: 10000 }] })
  return { store, inv }
}

test('recordPayment reduces the outstanding amount', () => {
  const { store, inv } = setup()
  payments.recordPayment(store, { invoiceId: inv.id, amountCents: 4000 })
  assert.strictEqual(ledger.invoiceOutstanding(store, inv.id), 6000)
})

test('recordPayment rejects non-integer amounts as malformed', () => {
  const { store, inv } = setup()
  assert.throws(() => payments.recordPayment(store, { invoiceId: inv.id, amountCents: 10.5 }), (e) => e.status === 400)
})

test('recordPayment rejects a currency mismatch', () => {
  const { store, inv } = setup()
  assert.throws(() => payments.recordPayment(store, { invoiceId: inv.id, amountCents: 100, currency: 'EUR' }), (e) => e.code === 'ERR_CURRENCY_MISMATCH')
  assert.strictEqual(store.tables.payments.size, 0)
})
