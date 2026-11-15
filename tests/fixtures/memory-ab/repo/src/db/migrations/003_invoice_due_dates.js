'use strict'
module.exports = {
  id: '003_invoice_due_dates',
  up(store) {
    for (const invoice of store.tables.invoices.values()) {
      if (invoice.dueDate === undefined) invoice.dueDate = null
    }
  },
}
