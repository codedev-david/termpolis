import * as Sentry from '@sentry/react'
import { CONSENT_VERSION } from '../../../shared/telemetryConsent'
import type { TelemetryConsentChoice } from '../../../shared/telemetryConsent'
import { scrubBreadcrumb, scrubEvent } from '../../../shared/sentryScrub'
import type { TelemetryConsentView } from '../types'

// Sentry DSN — baked in at build time (VITE_SENTRY_DSN); a build without one reports nothing.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || ''

// The renderer's copy of the consent main holds (src/main/telemetry.ts). Read synchronously at
// startup — Sentry has to be up before the first render can throw — and re-synced from main at
// startup and after every change.
export const CONSENT_VERSION_KEY = 'termpolis.consent.version'
export const CRASH_KEY = 'termpolis.telemetry.crash'
export const USAGE_KEY = 'termpolis.telemetry.usage'
// The pre-v2 single opt-in. Ignored — the old onboarding pre-ticked it — and removed on first sync.
export const LEGACY_OPT_IN_KEY = 'termpolis.telemetry.optIn'

// Default integrations that collect more than an error report needs: session pings (usage, not
// crashes) and the user's locale and time zone.
const DROPPED_INTEGRATIONS = new Set(['BrowserSession', 'CultureContext'])

const BOTH_OFF: TelemetryConsentView = { crash: false, usage: false, consentVersion: 0, needsReview: true }

let started = false
let listening = false

/** The consent as last mirrored from main. Both off until the user has answered under this version. */
export function readConsentMirror(): TelemetryConsentChoice {
  try {
    // `!(v >= …)`, not `v < …`: a garbled version reads NaN, and NaN < 2 is false.
    if (!(Number(localStorage.getItem(CONSENT_VERSION_KEY)) >= CONSENT_VERSION)) return { crash: false, usage: false }
    return { crash: localStorage.getItem(CRASH_KEY) === 'true', usage: localStorage.getItem(USAGE_KEY) === 'true' }
  } catch {
    return { crash: false, usage: false }
  }
}

export function crashReportingAllowed(): boolean {
  return readConsentMirror().crash
}

function writeConsentMirror(consent: TelemetryConsentView): void {
  try {
    localStorage.setItem(CONSENT_VERSION_KEY, String(consent.consentVersion))
    localStorage.setItem(CRASH_KEY, String(consent.crash === true))
    localStorage.setItem(USAGE_KEY, String(consent.usage === true))
    localStorage.removeItem(LEGACY_OPT_IN_KEY)
  } catch {
    // no storage: the mirror keeps its old value, and main still gates its own side
  }
}

/** Follow `consent` in the renderer now: start Sentry when crash reports are on, stop it when off. */
export function applyRendererConsent(consent: TelemetryConsentView): void {
  writeConsentMirror(consent)
  if (crashReportingAllowed()) initSentry()
  else stopSentry()
}

/** Re-read the consent from main, the source of truth, and follow it. Null when main can't say. */
export async function syncConsentFromMain(): Promise<TelemetryConsentView | null> {
  try {
    const res = await window.termpolis.telemetryGetConsent()
    if (!res.success) return null
    applyRendererConsent(res.data)
    return res.data
  } catch {
    return null
  }
}

/**
 * Record the user's answer: main persists it and applies it there, and the renderer follows what
 * main then holds. A tier left out keeps its value. When main can't be reached nothing was saved,
 * and both tiers read as off.
 */
export async function saveConsent(choice: Partial<TelemetryConsentChoice>): Promise<TelemetryConsentView> {
  try {
    const res = await window.termpolis.telemetrySetConsent(choice)
    if (res.success) {
      applyRendererConsent(res.data)
      return res.data
    }
  } catch {
    // main unreachable: fall through to both off
  }
  const off = { ...BOTH_OFF }
  applyRendererConsent(off)
  return off
}

/** The renderer's beforeSend: nothing leaves with crash reports off, and what does is scrubbed. */
export function rendererBeforeSend<T extends Sentry.ErrorEvent>(event: T): T | null {
  if (!crashReportingAllowed()) return null
  // Don't report if user has no internet
  if (!navigator.onLine) return null
  try {
    return scrubEvent(event)
  } catch {
    // an event that can't be scrubbed is not sent
    return null
  }
}

/** The renderer's beforeBreadcrumb: the same gate, then the UI scrub and the shared one. */
export function rendererBeforeBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (!crashReportingAllowed()) return null
  try {
    return scrubBreadcrumb(scrubUiBreadcrumb(breadcrumb))
  } catch {
    return null
  }
}

export function initSentry() {
  if (started) return
  if (!SENTRY_DSN) {
    console.log('Sentry: no DSN configured (set VITE_SENTRY_DSN to enable crash reporting)')
    return
  }
  if (!crashReportingAllowed()) {
    console.log('Sentry: crash reports are off')
    return
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE || 'production',
    release: `termpolis@${import.meta.env.VITE_APP_VERSION || 'unknown'}`,

    // Only send errors: no performance data, no trace headers on the app's requests
    tracesSampleRate: 0,
    tracePropagationTargets: [],

    // Don't send PII
    sendDefaultPii: false,
    sendClientReports: false,

    beforeBreadcrumb: rendererBeforeBreadcrumb,
    beforeSend: rendererBeforeSend,

    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
  })
  started = true

  console.log('Sentry initialized for crash reporting')

  // Catch unhandled promise rejections + window errors not caught by React. Installed once:
  // with crash reports off there is no enabled client, and a capture goes nowhere.
  if (listening) return
  listening = true
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const normalized = normalizeRejection(e.reason)
      if (!normalized) return
      Sentry.captureException(normalized)
    } catch { /* noop */ }
  })
  window.addEventListener('error', (e) => {
    try {
      Sentry.captureException(e.error ?? new Error(e.message || 'window.onerror'))
    } catch { /* noop */ }
  })
}

/**
 * Crash reports turned off: nothing more is sent from this moment (the switch close() flips, set
 * now rather than after its flush), and the client is closed. Turning them on again starts a new one.
 */
export function stopSentry(): void {
  if (!started) return
  started = false
  const client = Sentry.getClient()
  if (client) client.getOptions().enabled = false
  Sentry.close().catch(() => { /* already off */ })
}

// A click or input breadcrumb names its element with a CSS-like path that copies the element's
// aria-label, title, alt and name attributes verbatim — and those can carry what the user was
// looking at: a command line, a file path, a terminal's name. Everything from the first such
// attribute to the last closing `"]` goes. Greedy on purpose: the values are not escaped, so a
// value holding `"]` would end a lazy match early and leak the rest of itself.
export function scrubUiBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  if (breadcrumb.category?.startsWith('ui.') && breadcrumb.message) {
    breadcrumb.message = breadcrumb.message.replace(/\[(?:aria-label|title|alt|name)="[\s\S]*"\]/, '[…]')
  }
  return breadcrumb
}

// Normalize a Promise rejection reason into an Error suitable for Sentry.
// Browsers sometimes reject promises with raw DOM `Event` objects (image
// loads, fetch failures, addon init). Sentry can't symbolicate those — they
// arrive as the unhelpful "Event `Event` (type=error)" issue. We extract
// whatever context exists (event type, target tag/src) into a real Error,
// and drop completely empty events so they don't burn issue tracker noise.
export function normalizeRejection(reason: unknown): Error | null {
  if (reason instanceof Error) return reason
  if (typeof Event !== 'undefined' && reason instanceof Event) {
    const target = reason.target as (HTMLElement & { src?: string; href?: string }) | null
    const tag = target?.tagName?.toLowerCase()
    const src = target?.src || target?.href
    // No target + plain "error" event = nothing actionable. Skip.
    if (!tag && reason.type === 'error') return null
    const parts = [`DOM ${reason.type} event`]
    if (tag) parts.push(`on <${tag}>`)
    if (src) parts.push(`(${src})`)
    return new Error(parts.join(' '))
  }
  if (typeof reason === 'string') return new Error(reason)
  if (reason == null) return new Error('unhandledrejection (no reason)')
  try {
    return new Error(`unhandledrejection: ${JSON.stringify(reason)}`)
  } catch {
    return new Error(`unhandledrejection: ${String(reason)}`)
  }
}

export { Sentry }

// Swarm-specific error reporter. Mirrors src/main/telemetry.ts:recordSwarmError
// but runs in the renderer using the renderer Sentry SDK. Used in catch blocks
// where the failure indicates a real bug (bridge polling broken, monitoring
// loop crashed) — NOT for expected silent fallbacks.
//
// Safe no-op with crash reports off, and when Sentry isn't initialized (no DSN).
export function recordSwarmError(
  name: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  if (!crashReportingAllowed()) return
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
