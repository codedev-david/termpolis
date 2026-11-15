'use strict'
const { openStore } = require('../../src/db/store')
const { createCustomer } = require('../../src/services/customers')

function freshStore() {
  return openStore()
}

function seedCustomers(store) {
  createCustomer(store, { id: 'c1', name: 'Acme Corp', currency: 'USD', creditLimitCents: 500000 })
  createCustomer(store, { id: 'c2', name: 'Maple Ltd', currency: 'CAD' })
  return store
}

module.exports = { freshStore, seedCustomers }
