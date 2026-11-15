'use strict'
// A deliberately tiny test harness: test(), beforeEach(), and assert from node.

let tests = []
let hooks = []

function test(name, fn) {
  tests.push({ name, fn })
}

function beforeEach(fn) {
  hooks.push(fn)
}

function reset() {
  tests = []
  hooks = []
}

async function runCollected(file) {
  const results = []
  for (const t of tests) {
    try {
      for (const h of hooks) await h()
      await t.fn()
      results.push({ file, name: t.name, ok: true })
    } catch (e) {
      results.push({ file, name: t.name, ok: false, error: e })
    }
  }
  return results
}

module.exports = { test, beforeEach, reset, runCollected }
