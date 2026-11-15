'use strict'
const { ERROR_CODES } = require('./errorCodes')

class AppError extends Error {
  constructor(code, message, details) {
    const def = ERROR_CODES[code]
    if (!def) throw new Error(`Unregistered error code ${code}`)
    super(message || def.message)
    this.name = 'AppError'
    this.code = code
    this.status = def.status
    this.details = details
  }
}

function isAppError(e) {
  return e instanceof AppError
}

module.exports = { AppError, isAppError }
