'use strict'
const assert = require('assert')
const { test } = require('./harness')
const money = require('../src/lib/money')

test('roundHalfEven rounds .5 to even', () => {
  assert.strictEqual(money.roundHalfEven(0.5), 0)
  assert.strictEqual(money.roundHalfEven(1.5), 2)
  assert.strictEqual(money.roundHalfEven(2.5), 2)
  assert.strictEqual(money.roundHalfEven(2.51), 3)
})

test('percentOf works in cents', () => {
  assert.strictEqual(money.percentOf(1000, 15), 150)
  assert.strictEqual(money.percentOf(1005, 10), 100)
})

test('formatCents', () => {
  assert.strictEqual(money.formatCents(123456, 'USD'), '$1,234.56')
  assert.strictEqual(money.formatCents(-5, 'CAD'), '-CA$0.05')
  assert.strictEqual(money.formatCents(100, 'CHF'), 'CHF 1.00')
})

test('allocate never loses a cent', () => {
  const parts = money.allocate(100, [1, 1, 1])
  assert.deepStrictEqual(parts, [34, 33, 33])
})

test('assertCents rejects floats', () => {
  assert.throws(() => money.assertCents(1.5), TypeError)
})
