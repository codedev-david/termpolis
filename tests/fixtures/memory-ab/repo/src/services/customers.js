'use strict'
const { AppError } = require('../lib/errors')
const { assertCents } = require('../lib/money')

const CURRENCIES = new Set(['USD', 'CAD', 'EUR', 'GBP'])

function createCustomer(store, { id, name, currency = 'USD', creditLimitCents = 0, tenant = 'ACME' }) {
  if (!id || typeof id !== 'string') throw new AppError('ERR_VALIDATION', 'customer id is required')
  if (!name || typeof name !== 'string') throw new AppError('ERR_VALIDATION', 'customer name is required')
  if (!CURRENCIES.has(currency)) throw new AppError('ERR_VALIDATION', `unsupported currency ${currency}`)
  assertCents(creditLimitCents, 'creditLimitCents')
  if (store.tables.customers.has(id)) throw new AppError('ERR_DUPLICATE', `customer ${id} exists`)
  const customer = { id, name, currency, creditLimitCents, tenant }
  store.tables.customers.set(id, customer)
  return customer
}

function getCustomer(store, id) {
  const customer = store.tables.customers.get(id)
  if (!customer) throw new AppError('ERR_NOT_FOUND', `customer ${id} not found`)
  return customer
}

function listCustomers(store) {
  return [...store.tables.customers.values()]
}

module.exports = { createCustomer, getCustomer, listCustomers, CURRENCIES }
