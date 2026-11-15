'use strict'
const assert = require('assert')
const { test } = require('./harness')
const { createStore, migrate, withTransaction } = require('../src/db/store')
const { SCHEMA_VERSION } = require('../src/db/schema')

test('migrate brings a new store to SCHEMA_VERSION', () => {
  const store = migrate(createStore())
  assert.strictEqual(store.schemaVersion, SCHEMA_VERSION)
})

test('migrate backfills customer currency', () => {
  const store = migrate(createStore(), { to: 1 })
  store.tables.customers.set('old', { id: 'old', name: 'Old Co' })
  migrate(store)
  assert.strictEqual(store.tables.customers.get('old').currency, 'USD')
})

test('withTransaction rolls back on error', () => {
  const store = migrate(createStore())
  store.tables.customers.set('a', { id: 'a' })
  assert.throws(() => withTransaction(store, (s) => {
    s.tables.customers.set('b', { id: 'b' })
    throw new Error('boom')
  }))
  assert.strictEqual(store.tables.customers.has('b'), false)
})
