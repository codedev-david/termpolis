// Telemetry coordinator for the main process.
//
// Three tiers of signal, all gated by a single user opt-in:
//   1. Crash reports (Sentry init in src/main/sentry.ts honors the same gate)
//   2. Auto-updater health pings — recordUpdaterEvent() called from autoUpdater.ts
//   3. Anonymous usage events — recordEvent() called from feature code, plus a
//      once-per-day "launch" ping so we know how many real installs are alive.
//
// Privacy contract:
//   - No file paths, no terminal contents, no user identifiers ever leave.
//   - Opt-in is persisted in userData/telemetry.json so the gate survives
//     across launches without depending on the renderer being alive.
//   - When opt-in is false, every record* function is a no-op.
//
// Sentry routing is intentionally lazy via require() so unit tests don't
// pull in the @sentry/electron native binding.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

let telemetryFilePath: string | null = null
let optInState = false
let lastLaunchPingDate: string | null = null

interface PersistedState {
  optIn: boolean
  lastLaunchPingDate?: string
}

function readPersisted(): PersistedState | null {
  if (!telemetryFilePath) return null
  try {
    if (!existsSync(telemetryFilePath)) return null
    const raw = readFileSync(telemetryFilePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      optIn: parsed.optIn === true,
      lastLaunchPingDate: typeof parsed.lastLaunchPingDate === 'string'
        ? parsed.lastLaunchPingDate
        : undefined,
    }
  } catch {
    return null
  }
}

function writePersisted(state: PersistedState): void {
  if (!telemetryFilePath) return
  try {
    mkdirSync(dirname(telemetryFilePath), { recursive: true })
    writeFileSync(telemetryFilePath, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // Best-effort — losing the persisted opt-in just means the user gets
    // re-prompted via onboarding next launch. Worth not crashing for.
  }
}

// Initialize from disk. Called once at app startup before any record* call.
// userDataDir is passed explicitly so tests don't need a real Electron app.
export function initTelemetry(userDataDir: string): void {
  telemetryFilePath = join(userDataDir, 'telemetry.json')
  const persisted = readPersisted()
  optInState = persisted?.optIn === true
  lastLaunchPingDate = persisted?.lastLaunchPingDate ?? null
}

export function isEnabled(): boolean {
  return optInState
}

// Called from the IPC handler when the renderer toggles the opt-in.
// Persists immediately so the next launch gets the latest state even if
// the app crashes before clean shutdown.
export function setOptIn(value: boolean): void {
  optInState = value === true
  writePersisted({
    optIn: optInState,
    ...(lastLaunchPingDate ? { lastLaunchPingDate } : {}),
  })
}

// Lazy Sentry sender. Returns null if Sentry isn't installed/initialized
// or telemetry is off — caller should treat null as "no-op".
//
// Resolved through an injectable provider so tests can stub it without
// vi.mock() needing to intercept lazy require()s (which it doesn't).
let sentryProvider: () => any = () => {
  try { return require('@sentry/electron/main') } catch { return null }
}

function sentryOrNull(): any | null {
  if (!optInState) return null
  if (!process.env.SENTRY_DSN) return null
  try {
    return sentryProvider()
  } catch {
    return null
  }
}

// Test-only: swap the Sentry resolver for a stub.
export function __setSentryProviderForTests(fn: () => any): void {
  sentryProvider = fn
}

export interface UpdaterEventPayload {
  status: string
  version?: string
  error?: string
  downloadedBytes?: number
  totalBytes?: number
}

// Tier 2: auto-update health. We don't open a Sentry issue per event —
// we use breadcrumbs so the next captured exception carries the recent
// updater history, plus a one-shot captureMessage for hard errors.
export function recordUpdaterEvent(payload: UpdaterEventPayload): void {
  const Sentry = sentryOrNull()
  if (!Sentry) return
  try {
    Sentry.addBreadcrumb?.({
      category: 'updater',
      level: payload.status === 'error' ? 'error' : 'info',
      message: `updater: ${payload.status}${payload.version ? ` -> ${payload.version}` : ''}`,
      data: {
        status: payload.status,
        ...(payload.version ? { version: payload.version } : {}),
        ...(payload.error ? { error: payload.error } : {}),
        ...(typeof payload.downloadedBytes === 'number'
          ? { downloadedBytes: payload.downloadedBytes }
          : {}),
        ...(typeof payload.totalBytes === 'number'
          ? { totalBytes: payload.totalBytes }
          : {}),
      },
    })
    if (payload.status === 'error' && payload.error) {
      Sentry.captureMessage?.(`updater error: ${payload.error}`, 'error')
    }
  } catch {
    // never let telemetry crash the app
  }
}

// Tier 3: anonymous usage events. Caller picks the name (e.g. "swarm.start",
// "report-problem.submit"). props must be free of PII — no paths, no inputs.
export function recordEvent(name: string, props?: Record<string, unknown>): void {
  const Sentry = sentryOrNull()
  if (!Sentry) return
  try {
    Sentry.addBreadcrumb?.({
      category: 'event',
      level: 'info',
      message: name,
      data: props ?? {},
    })
  } catch {
    // swallow
  }
}

// Swarm-specific error reporter. Used in catch blocks where the failure
// indicates a real bug (data loss, comms broken, monitoring loop crash) —
// NOT for expected silent fallbacks like "embedder not ready". Adds a
// breadcrumb AND captures an exception so we get a stack trace.
//
// Why a dedicated helper instead of recordEvent: we want stack traces and
// the `swarm` tag so these errors are easy to filter in Sentry.
export function recordSwarmError(
  name: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  const Sentry = sentryOrNull()
  if (!Sentry) return
  try {
    Sentry.addBreadcrumb?.({
      category: 'swarm',
      level: 'error',
      message: name,
      data: { ...(ctx ?? {}), errorMessage: errMessage(err) },
    })
    const error = err instanceof Error ? err : new Error(`${name}: ${errMessage(err)}`)
    Sentry.captureException?.(error, {
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

// Today's date as YYYY-MM-DD. Exposed for tests so they can stub time.
export function todayKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Tier 3: fires a captureMessage("launch") at most once per UTC day.
// This is the heartbeat: it's how we count "still installed and opening".
// De-duped via persisted lastLaunchPingDate so reopening the app five times
// in one day still only sends one ping.
export function dailyLaunchPing(version: string, now: Date = new Date()): boolean {
  if (!optInState) return false
  const key = todayKey(now)
  if (lastLaunchPingDate === key) return false
  const Sentry = sentryOrNull()
  if (!Sentry) {
    // We still mark the day so we don't re-attempt on every relaunch
    // when the DSN is just missing.
    lastLaunchPingDate = key
    writePersisted({ optIn: optInState, lastLaunchPingDate })
    return false
  }
  try {
    Sentry.captureMessage?.(`launch ${version}`, 'info')
  } catch {
    // swallow
  }
  lastLaunchPingDate = key
  writePersisted({ optIn: optInState, lastLaunchPingDate })
  return true
}

// Test-only: reset module state between tests.
export function __resetTelemetryForTests(): void {
  telemetryFilePath = null
  optInState = false
  lastLaunchPingDate = null
}
