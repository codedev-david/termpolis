// Sentry for the main (Node.js) process.
//
// Catches uncaught exceptions and unhandled rejections in the Electron main
// process. The opt-in gate is read from src/main/telemetry, which itself
// hydrates from userData/telemetry.json — so the gate works on first launch
// (before the renderer has mounted) and across crashes.

import { isEnabled as isTelemetryEnabled } from './telemetry'

const SENTRY_DSN = process.env.SENTRY_DSN || ''

export function initMainSentry(): boolean {
  if (!SENTRY_DSN) {
    console.log('Sentry (main): no DSN configured (set SENTRY_DSN to enable)')
    return false
  }
  if (!isTelemetryEnabled()) {
    console.log('Sentry (main): user has not opted in — crash reporting off')
    return false
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
    return true
  } catch (e) {
    console.log('Sentry (main) init failed (non-fatal):', (e as any).message)
    return false
  }
}
