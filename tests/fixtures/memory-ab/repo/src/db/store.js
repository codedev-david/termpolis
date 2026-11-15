'use strict'
// In-memory store. Tables are Maps keyed by id; a migration shapes them.
const { MIGRATIONS } = require('./migrations')
const { SCHEMA_VERSION } = require('./schema')

function createStore() {
  return { schemaVersion: 0, tables: {} }
}

// Apply pending migrations, in order, up to `to` (default: all of them).
function migrate(store, { to } = {}) {
  if (MIGRATIONS.length !== SCHEMA_VERSION) {
    throw new Error(`schema drift: ${MIGRATIONS.length} migrations but SCHEMA_VERSION=${SCHEMA_VERSION}`)
  }
  const target = to ?? MIGRATIONS.length
  for (let i = store.schemaVersion; i < target; i++) {
    MIGRATIONS[i].up(store)
    store.schemaVersion = i + 1
  }
  return store
}

function openStore() {
  return migrate(createStore())
}

// Run `fn` against the store; if it throws, every table is restored as it was.
function withTransaction(store, fn) {
  const snapshot = {}
  for (const [name, table] of Object.entries(store.tables)) {
    snapshot[name] = new Map([...table].map(([k, v]) => [k, structuredClone(v)]))
  }
  try {
    return fn(store)
  } catch (e) {
    store.tables = snapshot
    throw e
  }
}

module.exports = { createStore, migrate, openStore, withTransaction }
