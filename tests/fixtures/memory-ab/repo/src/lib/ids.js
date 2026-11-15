'use strict'
let counter = 0

function newId(prefix) {
  counter += 1
  return `${prefix}_${counter.toString(36).padStart(6, '0')}`
}

function _resetIds() {
  counter = 0
}

module.exports = { newId, _resetIds }
