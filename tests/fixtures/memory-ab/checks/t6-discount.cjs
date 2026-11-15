'use strict'
// T6: applyDiscount(invoice, percent) returns a new invoice with a negative 'discount' line,
// rounded with the project's banker's rounding (percentOf), and leaves the input untouched.
const c = require('./_common.cjs')

const s = c.suiteAndLint(20)
c.attempt('applyDiscount', () => {
  c.freezeClock()
  const invoices = c.load('src/services/invoices.js')
  c.expect(typeof invoices.applyDiscount === 'function', 'src/services/invoices.js does not export applyDiscount')
  if (typeof invoices.applyDiscount !== 'function') return
  const make = (cents) => ({
    id: 'inv_000001', customerId: 'c1', currency: 'USD', status: 'open', issuedOn: '2026-01-15', dueDate: '2026-02-14',
    lines: [{ description: 'Plan', type: 'item', amountCents: cents }], totalCents: cents,
  })
  const cases = [[1005, 10, -100, 905], [1015, 10, -102, 913], [1025, 10, -102, 923], [2000, 15, -300, 1700]]
  for (const [cents, pct, line, total] of cases) {
    const input = make(cents)
    const before = JSON.stringify(input)
    const out = invoices.applyDiscount(input, pct)
    c.expect(JSON.stringify(input) === before, `applyDiscount mutated its input (${cents} @ ${pct}%)`)
    c.expect(out && out !== input, `applyDiscount must return a new invoice (${cents} @ ${pct}%)`)
    const last = out && Array.isArray(out.lines) ? out.lines[out.lines.length - 1] : null
    c.expect(last && last.type === 'discount', `last line type ${JSON.stringify(last && last.type)}, expected "discount"`)
    c.expect(last && last.amountCents === line, `${cents} @ ${pct}%: discount line ${JSON.stringify(last && last.amountCents)}, expected ${line}`)
    c.expect(out && out.totalCents === total, `${cents} @ ${pct}%: total ${JSON.stringify(out && out.totalCents)}, expected ${total}`)
    c.expect(out && Array.isArray(out.lines) && out.lines.length === input.lines.length + 1, 'applyDiscount must append exactly one line')
  }
})
c.report(s)
