import * as Sentry from '@sentry/react'

// Sentry DSN — set via environment variable or replace with your actual DSN
// To enable: set VITE_SENTRY_DSN in your .env file or environment
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || ''

export function initSentry() {
  if (!SENTRY_DSN) {
    console.log('Sentry: no DSN configured (set VITE_SENTRY_DSN to enable crash reporting)')
    return
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE || 'production',
    release: `termpolis@${import.meta.env.VITE_APP_VERSION || '1.2.0'}`,

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
}

export { Sentry }
