'use strict'
module.exports = {
  id: '002_customer_currency',
  up(store) {
    for (const customer of store.tables.customers.values()) {
      if (customer.currency === undefined) customer.currency = 'USD'
    }
  },
}
