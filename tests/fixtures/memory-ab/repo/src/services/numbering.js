'use strict'
// Invoice numbering. See docs/ARCHITECTURE.md ("Invoice numbers").
//
// Stubbed out in the billing-core split (2.4.0); the old implementation lived in the monolith.

// eslint-disable-next-line no-unused-vars
function nextInvoiceNumber(store, tenant) {
  throw new Error('nextInvoiceNumber: not implemented')
}

module.exports = { nextInvoiceNumber }
