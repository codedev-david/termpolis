// Sentry for the main (Node.js) process
// Catches uncaught exceptions and unhandled rejections in the Electron main process

const SENTRY_DSN = process.env.SENTRY_DSN || ''

export function initMainSentry() {
  if (!SENTRY_DSN) {
    console.log('Sentry (main): no DSN configured (set SENTRY_DSN to enable)')
    return
  }

  try {
    const Sentry = require('@sentry/electron/main')
    Sentry.init({
      dsn: SENTRY_DSN,
      release: `termpolis@${require('../../package.json').version}`,
      environment: process.env.NODE_ENV || 'production',
      sendDefaultPii: false,
    })
    console.log('Sentry (main) initialized')
  } catch (e) {
    console.log('Sentry (main) init failed (non-fatal):', (e as any).message)
  }
}
