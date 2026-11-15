'use strict'
const assert = require('assert')
const { test } = require('./harness')
const { useFrozenClock } = require('./helpers/clock')
const { freshStore, seedCustomers } = require('./helpers/fixtures')
const { handle } = require('../src/routes')

useFrozenClock()

test('GET /health reports the schema version', () => {
  const res = handle(freshStore(), { method: 'GET', path: '/health' })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.schemaVersion, res.body.expected)
})

test('GET /customers/:id returns 404 with the standard error body', () => {
  const res = handle(seedCustomers(freshStore()), { method: 'GET', path: '/customers/nope' })
  assert.strictEqual(res.status, 404)
  assert.strictEqual(res.body.error, 'ERR_NOT_FOUND')
})

test('POST /invoices then GET /invoices/:id', () => {
  const store = seedCustomers(freshStore())
  const created = handle(store, { method: 'POST', path: '/invoices', body: { customerId: 'c2', lines: [{ description: 'x', amountCents: 250000 }] } })
  assert.strictEqual(created.status, 201)
  const got = handle(store, { method: 'GET', path: `/invoices/${created.body.id}` })
  assert.strictEqual(got.body.totalFormatted, 'CA$2,500.00')
})
