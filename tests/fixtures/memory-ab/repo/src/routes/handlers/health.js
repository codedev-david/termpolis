'use strict'
const { SCHEMA_VERSION } = require('../../db/schema')

function get(store) {
  return { status: 200, body: { ok: true, schemaVersion: store.schemaVersion, expected: SCHEMA_VERSION } }
}

module.exports = { get }
