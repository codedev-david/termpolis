'use strict'
// Ordered list of migrations. A store at schemaVersion N has run the first N of these.
module.exports = {
  MIGRATIONS: [
    require('./001_init'),
    require('./002_customer_currency'),
    require('./003_invoice_due_dates'),
  ],
}
