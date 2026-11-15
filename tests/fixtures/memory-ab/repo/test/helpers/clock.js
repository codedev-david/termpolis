'use strict'
const clock = require('../../src/lib/clock')
const { beforeEach } = require('../harness')

const DEFAULT_NOW = '2026-01-15T12:00:00Z'

// Freeze the clock before every test in the calling file.
function useFrozenClock(iso = DEFAULT_NOW) {
  beforeEach(() => clock.freeze(iso))
}

module.exports = { useFrozenClock, DEFAULT_NOW }
