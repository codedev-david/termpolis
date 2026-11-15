'use strict'
const service = require('../../services/payments')

function create(store, _params, body) {
  return { status: 201, body: service.recordPayment(store, body || {}) }
}

module.exports = { create }
