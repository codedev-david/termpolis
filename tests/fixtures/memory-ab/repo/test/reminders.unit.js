'use strict'
const assert = require('assert')
const { test } = require('./harness')
const { freshStore, seedCustomers } = require('./helpers/fixtures')
const invoices = require('../src/services/invoices')
const payments = require('../src/services/payments')
const { remindersDue } = require('../src/services/reminders')

test('an invoice due in two days gets an upcoming reminder', () => {
  const store = seedCustomers(freshStore())
  const inv = invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'x', amountCents: 500 }], termsDays: 2 })
  assert.strictEqual(inv.dueDate, '2026-01-17')
  assert.deepStrictEqual(remindersDue(store), [{ invoiceId: inv.id, kind: 'upcoming', days: 2 }])
})

test('an overdue invoice is reported with days overdue', () => {
  const store = seedCustomers(freshStore())
  const inv = invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'x', amountCents: 500 }], termsDays: -5 })
  assert.strictEqual(inv.dueDate, '2026-01-10')
  assert.deepStrictEqual(remindersDue(store), [{ invoiceId: inv.id, kind: 'overdue', days: 5 }])
})

test('paid and far-off invoices get no reminder', () => {
  const store = seedCustomers(freshStore())
  const paid = invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'x', amountCents: 500 }], termsDays: 1 })
  payments.recordPayment(store, { invoiceId: paid.id, amountCents: 500 })
  invoices.createInvoice(store, { customerId: 'c1', lines: [{ description: 'y', amountCents: 500 }], termsDays: 30 })
  assert.deepStrictEqual(remindersDue(store), [])
})
