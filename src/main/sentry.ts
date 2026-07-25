// Sentry for the main (Node.js) process.
//
// Catches uncaught exceptions and unhandled rejections in the Electron main
// process. The opt-in gate is read from src/main/telemetry, which itself
// hydrates from userData/telemetry.json — so the gate works on first launch
// (before the renderer has mounted) and across crashes.

import { isEnabled as isTelemetryEnabled } from './telemetry'
import { shouldDropSentryEvent } from './updaterErrors'

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
      // Last line of defence for benign auto-updater states. The updater's own 'error' handler
      // already converts them to "not available", but the Error object can still reach Sentry's
      // global handlers by a path we don't own — which is how ONE macOS read-only-volume refusal
      // filed two GitHub issues (#21 as a captureMessage, #22 as the raw exception).
      beforeSend(event: unknown) {
        try {
          return shouldDropSentryEvent(event) ? null : event
        } catch {
          return event // a filter that throws must never swallow a real crash report
        }
      },
    })
    console.log('Sentry (main) initialized')
    return true
  } catch (e) {
    console.log('Sentry (main) init failed (non-fatal):', (e as any).message)
    return false
  }
}
