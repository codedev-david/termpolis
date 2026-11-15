'use strict'
module.exports = {
  id: '001_init',
  up(store) {
    store.tables.customers = new Map()
    store.tables.invoices = new Map()
    store.tables.payments = new Map()
    store.tables.sequences = new Map()
  },
}
