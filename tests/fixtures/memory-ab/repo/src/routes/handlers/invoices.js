'use strict'
const service = require('../../services/invoices')
const { formatCents } = require('../../lib/money')

function present(invoice) {
  return { ...invoice, totalFormatted: formatCents(invoice.totalCents, invoice.currency) }
}

function get(store, { id }) {
  return { status: 200, body: present(service.getInvoice(store, id)) }
}

function create(store, _params, body) {
  return { status: 201, body: present(service.createInvoice(store, body || {})) }
}

function finalize(store, { id }) {
  return { status: 200, body: present(service.finalizeInvoice(store, id)) }
}

module.exports = { get, create, finalize }
