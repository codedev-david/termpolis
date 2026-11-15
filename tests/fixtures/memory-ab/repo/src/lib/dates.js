'use strict'
// Dates are UTC ISO-8601 strings (YYYY-MM-DD for calendar dates).
const clock = require('./clock')

const DAY_MS = 86_400_000

function today() {
  return clock.now().toISOString().slice(0, 10)
}

function addDays(isoDate, days) {
  return new Date(Date.parse(isoDate + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / DAY_MS)
}

function isWeekend(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z').getUTCDay()
  return d === 0 || d === 6
}

function addBusinessDays(isoDate, days) {
  let d = isoDate
  let left = days
  while (left > 0) {
    d = addDays(d, 1)
    if (!isWeekend(d)) left--
  }
  return d
}

module.exports = { today, addDays, daysBetween, isWeekend, addBusinessDays }
