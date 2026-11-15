'use strict'
const { AppError } = require('../lib/errors')
const { newId } = require('../lib/ids')
const dates = require('../lib/dates')
const { getInvoice } = require('./invoices')
const { withTransaction } = require('../db/store')

function recordPayment(store, { invoiceId, amountCents, currency, method = 'card' }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new AppError('ERR_VALIDATION', 'amountCents must be a positive integer')
  }
  return withTransaction(store, () => {
    const invoice = getInvoice(store, invoiceId)
    if (currency && currency !== invoice.currency) throw new AppError('ERR_CURRENCY_MISMATCH')
    const payment = { id: newId('pay'), invoiceId, amountCents, currency: invoice.currency, method, receivedOn: dates.today() }
    store.tables.payments.set(payment.id, payment)
    return payment
  })
}

function listPayments(store) {
  return [...store.tables.payments.values()]
}

module.exports = { recordPayment, listPayments }
