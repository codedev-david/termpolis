import * as Sentry from '@sentry/react'

// Sentry DSN — set via environment variable or replace with your actual DSN
// To enable: set VITE_SENTRY_DSN in your .env file or environment
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || ''

// Opt-in gate. Onboarding writes this key; if the user opted out (or never
// made a choice), crash reporting stays off even if a DSN is configured.
function telemetryEnabled(): boolean {
  try { return localStorage.getItem('termpolis.telemetry.optIn') === '1' } catch { return false }
}

export function initSentry() {
  if (!SENTRY_DSN) {
    console.log('Sentry: no DSN configured (set VITE_SENTRY_DSN to enable crash reporting)')
    return
  }
  if (!telemetryEnabled()) {
    console.log('Sentry: disabled (user has not opted in to crash reporting)')
    return
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE || 'production',
    release: `termpolis@${import.meta.env.VITE_APP_VERSION || 'unknown'}`,

    // Only send errors, not performance data
    tracesSampleRate: 0,

    // Don't send PII
    sendDefaultPii: false,

    // Filter out noisy errors
    beforeSend(event) {
      // Don't report if user has no internet
      if (!navigator.onLine) return null
      // Strip file paths from breadcrumbs (privacy)
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map(b => {
          if (b.message && b.message.includes('\\Users\\')) {
            b.message = b.message.replace(/[A-Z]:\\Users\\[^\\]+/gi, 'C:\\Users\\<redacted>')
          }
          return b
        })
      }
      return event
    },

    integrations: [
      Sentry.browserTracingIntegration({ enableInp: false }),
    ],
  })

  console.log('Sentry initialized for crash reporting')

  // Catch unhandled promise rejections + window errors not caught by React.
  window.addEventListener('unhandledrejection', (e) => {
    try {
      Sentry.captureException(e.reason ?? new Error('unhandledrejection (no reason)'))
    } catch { /* noop */ }
  })
  window.addEventListener('error', (e) => {
    try {
      Sentry.captureException(e.error ?? new Error(e.message || 'window.onerror'))
    } catch { /* noop */ }
  })
}

export { Sentry }

// Swarm-specific error reporter. Mirrors src/main/telemetry.ts:recordSwarmError
// but runs in the renderer using the renderer Sentry SDK. Used in catch blocks
// where the failure indicates a real bug (bridge polling broken, monitoring
// loop crashed) — NOT for expected silent fallbacks.
//
// Safe no-op when Sentry isn't initialized (i.e. user opted out, or no DSN).
export function recordSwarmError(
  name: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  try {
    const error = err instanceof Error
      ? err
      : new Error(`${name}: ${errMessage(err)}`)
    Sentry.addBreadcrumb({
      category: 'swarm',
      level: 'error',
      message: name,
      data: { ...(ctx ?? {}), errorMessage: errMessage(err) },
    })
    Sentry.captureException(error, {
      tags: { swarm: name },
      extra: ctx,
    })
  } catch {
    // never let telemetry crash the swarm
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}
