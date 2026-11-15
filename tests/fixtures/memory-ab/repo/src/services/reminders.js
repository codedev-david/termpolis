'use strict'
// Payment reminders: which open invoices are coming due or overdue today.
const dates = require('../lib/dates')
const { invoiceOutstanding } = require('./ledger')

const UPCOMING_DAYS = 3

function remindersDue(store) {
  const today = dates.today()
  const out = []
  for (const invoice of store.tables.invoices.values()) {
    if (invoiceOutstanding(store, invoice.id) <= 0 || !invoice.dueDate) continue
    const days = dates.daysBetween(today, invoice.dueDate)
    if (days < 0) out.push({ invoiceId: invoice.id, kind: 'overdue', days: -days })
    else if (days <= UPCOMING_DAYS) out.push({ invoiceId: invoice.id, kind: 'upcoming', days })
  }
  return out.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
}

module.exports = { remindersDue, UPCOMING_DAYS }
