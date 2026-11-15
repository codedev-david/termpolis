'use strict'
const service = require('../../services/customers')

function list(store) {
  return { status: 200, body: { customers: service.listCustomers(store) } }
}

function get(store, { id }) {
  return { status: 200, body: service.getCustomer(store, id) }
}

function create(store, _params, body) {
  return { status: 201, body: service.createCustomer(store, body || {}) }
}

module.exports = { list, get, create }
