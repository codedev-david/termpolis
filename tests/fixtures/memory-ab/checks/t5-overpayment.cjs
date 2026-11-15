'use strict'
// T5: an overpayment is a broken business rule: an AppError with status 422, and nothing recorded.
const c = require('./_common.cjs')

const s = c.suiteAndLint(20)
c.attempt('overpayment', () => {
  c.freezeClock()
  const { openStore } = c.load('src/db/store.js')
  const { createCustomer } = c.load('src/services/customers.js')
  const { createInvoice } = c.load('src/services/invoices.js')
  const { recordPayment } = c.load('src/services/payments.js')
  const { invoiceOutstanding } = c.load('src/services/ledger.js')
  const { handle } = c.load('src/routes/index.js')
  const store = openStore()
  createCustomer(store, { id: 'c1', name: 'Acme' })
  const inv = createInvoice(store, { customerId: 'c1', lines: [{ description: 'x', amountCents: 10000 }] })
  recordPayment(store, { invoiceId: inv.id, amountCents: 6000 })
  let err = null
  try { recordPayment(store, { invoiceId: inv.id, amountCents: 5000 }) } catch (e) { err = e }
  c.expect(err !== null, 'an overpayment was accepted')
  c.expect(err && err.status === 422, `overpayment error status ${err && err.status}, expected 422`)
  c.expect(store.tables.payments.size === 1, `${store.tables.payments.size} payments recorded, expected 1`)
  c.expect(invoiceOutstanding(store, inv.id) === 4000, 'outstanding changed after a rejected payment')
  const viaRoute = handle(store, { method: 'POST', path: '/payments', body: { invoiceId: inv.id, amountCents: 4001 } })
  c.expect(viaRoute.status === 422, `POST /payments overpayment status ${viaRoute.status}, expected 422`)
  recordPayment(store, { invoiceId: inv.id, amountCents: 4000 })
  c.expect(invoiceOutstanding(store, inv.id) === 0, 'an exact payment of the remaining balance failed')
})
c.report(s)
