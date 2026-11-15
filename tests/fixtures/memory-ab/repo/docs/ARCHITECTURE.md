# Ledgerly architecture

_Last reviewed: 2025-11 (before the billing-core split)._

## Layout

- `src/lib/` - shared helpers (money, dates, errors, ids, logger, clock).
- `src/db/` - the in-memory store and its migrations.
- `src/services/` - business logic. Services take the store as their first argument.
- `src/routes/` - the HTTP route table and thin handlers.
- `src/legacy/` - code carried over from the monolith.

## Invoice numbers

Invoices are numbered `INV-YYYY-NNNN`: the year the invoice was issued and a
four-digit counter that resets every January. See ADR-0004 and
`src/legacy/billing.js` for the reference implementation.

## Requests

`src/routes/index.js` matches a method and path to a handler. Handlers return
`{ status, body }`. Errors thrown as `AppError` become a JSON error body.
