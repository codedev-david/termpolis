#!/usr/bin/env node
// One-off: fire a test error at Sentry via the same SDK the app ships.
// Run with: node scripts/sentry-test-event.cjs

const Sentry = require('@sentry/node')

const DSN = process.env.SENTRY_DSN ||
  'https://2936886eb88fb55cec4b933395eebccf@o4511288682741760.ingest.us.sentry.io/4511288686084096'

Sentry.init({
  dsn: DSN,
  environment: 'production',
  release: 'v1.11.17',
  beforeSend(event) {
    return event
  },
})

const err = new Error('TEST EVENT — verifying Sentry → GitHub issue pipeline. Safe to close.')
err.name = 'PipelineTestError'

const eventId = Sentry.captureException(err)
console.log('captured event id:', eventId)

Sentry.flush(5000).then((ok) => {
  console.log('flush ok:', ok)
  process.exit(ok ? 0 : 1)
})
