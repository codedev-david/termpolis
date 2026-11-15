'use strict'
// Balances. Everything that answers "how much is still owed" goes through here.
const { sumCents } = require('../lib/money')
const { getInvoice, invoicesForCustomer } = require('./invoices')

function paymentsForInvoice(store, invoiceId) {
  return [...store.tables.payments.values()].filter((p) => p.invoiceId === invoiceId)
}

function invoiceOutstanding(store, invoiceId) {
  const invoice = getInvoice(store, invoiceId)
  const paid = sumCents(paymentsForInvoice(store, invoiceId).map((p) => p.amountCents))
  return invoice.totalCents - paid
}

function outstandingFor(store, customerId) {
  return sumCents(invoicesForCustomer(store, customerId).map((i) => invoiceOutstanding(store, i.id)))
}

module.exports = { paymentsForInvoice, invoiceOutstanding, outstandingFor }
