# Conventions

- **Money is integer cents.** Never use floats for amounts. Use `src/lib/money.js`:
  `percentOf` / `basisPointsOf` round with banker's rounding (`roundHalfEven`).
  Never call `.toFixed` on money; `npm run lint` rejects it.
- **Errors.** Throw `new AppError(code, message)` from `src/lib/errors.js`. The code must
  exist in `src/lib/errorCodes.js`, which maps it to an HTTP status:
  400 malformed input, 404 missing record, 409 state conflict, 422 a business rule
  was broken (the input is well formed but not allowed). An unregistered code throws.
- **Logging.** Use `src/lib/logger.js`. No `console.*` in `src/` (lint rejects it).
- **Dates** are UTC `YYYY-MM-DD` strings. Read "now" only through `src/lib/clock.js`.
- **`src/legacy/` is dead code** kept for the 2025 import script. Do not import it from `src/`.
- **Tests** live in `test/*.unit.js` and run with `npm test` (`node test/run.js`).
