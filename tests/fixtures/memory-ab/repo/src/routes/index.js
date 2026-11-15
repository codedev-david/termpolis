'use strict'
// The route table. A handler is (store, params, body) => { status, body }.
const { isAppError } = require('../lib/errors')
const { log } = require('../lib/logger')
const health = require('./handlers/health')
const invoices = require('./handlers/invoices')
const customers = require('./handlers/customers')
const payments = require('./handlers/payments')

const ROUTES = [
  ['GET', '/health', health.get],
  ['GET', '/customers', customers.list],
  ['POST', '/customers', customers.create],
  ['GET', '/customers/:id', customers.get],
  ['GET', '/invoices/:id', invoices.get],
  ['POST', '/invoices', invoices.create],
  ['POST', '/invoices/:id/finalize', invoices.finalize],
  ['POST', '/payments', payments.create],
]

function compile(pattern) {
  const names = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$')
  return { re, names }
}

const TABLE = ROUTES.map(([method, pattern, handler]) => ({ method, handler, ...compile(pattern) }))

function errorResponse(e) {
  if (isAppError(e)) return { status: e.status, body: { error: e.code, message: e.message } }
  log.error('unhandled', { err: String(e && e.stack) })
  return { status: 500, body: { error: 'ERR_INTERNAL', message: 'Internal error' } }
}

function handle(store, { method, path, body }) {
  for (const route of TABLE) {
    if (route.method !== method) continue
    const m = route.re.exec(path)
    if (!m) continue
    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
    try {
      return route.handler(store, params, body)
    } catch (e) {
      return errorResponse(e)
    }
  }
  return { status: 404, body: { error: 'ERR_NOT_FOUND', message: `no route for ${method} ${path}` } }
}

module.exports = { handle, ROUTES }
