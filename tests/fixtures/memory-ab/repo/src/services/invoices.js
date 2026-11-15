'use strict'
const { AppError } = require('../lib/errors')
const { assertCents, sumCents } = require('../lib/money')
const { newId } = require('../lib/ids')
const dates = require('../lib/dates')
const { getCustomer } = require('./customers')

const DEFAULT_TERMS_DAYS = 30

function createInvoice(store, { customerId, lines, termsDays = DEFAULT_TERMS_DAYS }) {
  const customer = getCustomer(store, customerId)
  if (!Array.isArray(lines) || lines.length === 0) throw new AppError('ERR_VALIDATION', 'an invoice needs at least one line')
  for (const line of lines) {
    if (!line || typeof line.description !== 'string') throw new AppError('ERR_VALIDATION', 'each line needs a description')
    assertCents(line.amountCents, 'line amountCents')
  }
  const issuedOn = dates.today()
  const invoice = {
    id: newId('inv'),
    customerId,
    currency: customer.currency,
    lines: lines.map((l) => ({ description: l.description, type: l.type || 'item', amountCents: l.amountCents })),
    totalCents: sumCents(lines.map((l) => l.amountCents)),
    status: 'open',
    issuedOn,
    dueDate: dates.addDays(issuedOn, termsDays),
  }
  store.tables.invoices.set(invoice.id, invoice)
  return invoice
}

function getInvoice(store, id) {
  const invoice = store.tables.invoices.get(id)
  if (!invoice) throw new AppError('ERR_NOT_FOUND', `invoice ${id} not found`)
  return invoice
}

function finalizeInvoice(store, id) {
  const invoice = getInvoice(store, id)
  if (invoice.status === 'finalized') throw new AppError('ERR_INVOICE_FINALIZED')
  invoice.status = 'finalized'
  return invoice
}

function addLine(store, id, line) {
  const invoice = getInvoice(store, id)
  if (invoice.status === 'finalized') throw new AppError('ERR_INVOICE_FINALIZED')
  assertCents(line.amountCents, 'line amountCents')
  invoice.lines.push({ description: line.description, type: line.type || 'item', amountCents: line.amountCents })
  invoice.totalCents = sumCents(invoice.lines.map((l) => l.amountCents))
  return invoice
}

function invoicesForCustomer(store, customerId) {
  return [...store.tables.invoices.values()].filter((i) => i.customerId === customerId)
}

module.exports = { createInvoice, getInvoice, finalizeInvoice, addLine, invoicesForCustomer, DEFAULT_TERMS_DAYS }
