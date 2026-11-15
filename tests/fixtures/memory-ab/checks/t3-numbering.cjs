'use strict'
// T3: nextInvoiceNumber follows ADR-0007 (<TENANT_CODE>-<NNNNNN>, per-tenant sequence in the store),
// not the superseded INV-YYYY-NNNN format that docs/ARCHITECTURE.md and src/legacy still show.
const c = require('./_common.cjs')

const s = c.suiteAndLint(20)
c.attempt('nextInvoiceNumber', () => {
  c.freezeClock()
  const { openStore } = c.load('src/db/store.js')
  const { nextInvoiceNumber } = c.load('src/services/numbering.js')
  const store = openStore()
  const got = [
    nextInvoiceNumber(store, { code: 'ACME' }),
    nextInvoiceNumber(store, { code: 'ACME' }),
    nextInvoiceNumber(store, { code: 'GLOBEX' }),
    nextInvoiceNumber(store, { code: 'ACME' }),
  ]
  const want = ['ACME-000001', 'ACME-000002', 'GLOBEX-000001', 'ACME-000003']
  c.expect(JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
  c.expect(store.tables.sequences && store.tables.sequences.size > 0, 'sequence not kept in store.tables.sequences')
  const first = nextInvoiceNumber(openStore(), { code: 'ACME' })
  c.expect(first === 'ACME-000001', `a fresh store started at ${JSON.stringify(first)} (the sequence must live in the store)`)
})
c.report(s)
