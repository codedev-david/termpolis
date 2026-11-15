'use strict'
// Structured logger. Billing core never writes to the console directly (scripts/lint.js).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const sink = { write: (line) => process.stdout.write(line + '\n') }

function createLogger(bindings = {}, level = process.env.LEDGERLY_LOG_LEVEL || 'info') {
  const min = LEVELS[level] ?? LEVELS.info
  const emit = (lvl, msg, extra) => {
    if (process.env.LEDGERLY_ENV === 'test') return
    if (LEVELS[lvl] < min) return
    sink.write(JSON.stringify({ level: lvl, msg, ...bindings, ...extra }))
  }
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: (more) => createLogger({ ...bindings, ...more }, level),
  }
}

module.exports = { createLogger, log: createLogger({ app: 'ledgerly' }) }
