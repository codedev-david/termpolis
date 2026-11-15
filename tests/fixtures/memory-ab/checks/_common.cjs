'use strict'
// Shared by the task checks. A check runs in its own node process:
//   node checks/tN.cjs <runDir> <fixtureRepoDir>
// and prints one JSON line { ok, reasons, suite } to stdout. Exit code is always 0.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const runDir = path.resolve(process.argv[2] || '.')
const fixtureDir = path.resolve(process.argv[3] || path.join(__dirname, '..', 'repo'))
const reasons = []

function fail(msg) { reasons.push(msg) }

function expect(cond, msg) { if (!cond) fail(msg) }

// The repo's own suite and lint, as a developer would run them.
function suite() {
  const r = spawnSync(process.execPath, ['test/run.js'], { cwd: runDir, encoding: 'utf8', timeout: 120000 })
  const m = /RESULT passed=(\d+) failed=(\d+)/.exec(r.stdout || '')
  return { status: r.status, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : -1 }
}

function lint() {
  const r = spawnSync(process.execPath, ['scripts/lint.js'], { cwd: runDir, encoding: 'utf8', timeout: 60000 })
  return r.status === 0
}

// The fixture suite has 20 tests; a task must keep every one of them and pass.
function suiteAndLint(minPassed = 20) {
  const s = suite()
  expect(s.failed === 0 && s.status === 0, `npm test fails (passed=${s.passed} failed=${s.failed})`)
  expect(s.passed >= minPassed, `npm test ran ${s.passed} tests, expected at least ${minPassed}`)
  expect(lint(), 'npm run lint fails')
  return s
}

function sameAsFixture(rel) {
  try {
    return fs.readFileSync(path.join(runDir, rel)).equals(fs.readFileSync(path.join(fixtureDir, rel)))
  } catch {
    return false
  }
}

// Load a module from the run dir into this process.
function load(rel) {
  return require(path.join(runDir, rel))
}

// Freeze the clock the way the repo's tests do, so services that read "today" work.
function freezeClock(iso = '2026-01-15T12:00:00Z') {
  process.env.LEDGERLY_ENV = 'test'
  load('src/lib/clock.js').freeze(iso)
}

function attempt(label, fn) {
  try { fn() } catch (e) { fail(`${label}: ${e && e.message ? e.message : e}`) }
}

function report(s) {
  process.stdout.write(JSON.stringify({ ok: reasons.length === 0, reasons, suite: s || null }) + '\n')
}

module.exports = { runDir, fixtureDir, fail, expect, suite, lint, suiteAndLint, sameAsFixture, load, freezeClock, attempt, report }
