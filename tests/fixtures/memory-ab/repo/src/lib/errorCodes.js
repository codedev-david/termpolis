'use strict'
// Every AppError code, with the HTTP status the route layer answers with.

const ERROR_CODES = {
  ERR_VALIDATION: { status: 400, message: 'Request is malformed' },
  ERR_UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  ERR_NOT_FOUND: { status: 404, message: 'Resource not found' },
  ERR_INVOICE_FINALIZED: { status: 409, message: 'Invoice is finalized and cannot be edited' },
  ERR_DUPLICATE: { status: 409, message: 'Resource already exists' },
  ERR_CREDIT_LIMIT: { status: 422, message: 'Customer credit limit exceeded' },
  ERR_CURRENCY_MISMATCH: { status: 422, message: 'Currency does not match the invoice' },
  ERR_INTERNAL: { status: 500, message: 'Internal error' },
}

module.exports = { ERROR_CODES }
