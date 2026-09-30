// Telemetry coordinator for the main process.
//
// Two tiers, each with its own consent, both OFF until the user turns them on (the tour's privacy
// step, the launch review, Settings ▸ Privacy):
//   1. crash — error reports: main Sentry (src/main/sentry.ts gates on isCrashEnabled()), updater
//      failures (recordUpdaterEvent), unclean exits, swarm errors.
//   2. usage — the once-a-day "launch" ping, so we can count live installs, and recordEvent()
//      breadcrumbs, which only ever travel inside a crash report.
//
// Privacy contract:
//   - Consent is persisted in userData/telemetry.json so the gate holds from the first line of
//     main, without the renderer. A missing, corrupt or pre-CONSENT_VERSION file is "not asked":
//     both tiers off, needsReview true.
//   - With a tier off, its record* functions are no-ops: nothing for it leaves the machine.
//   - What does leave is scrubbed first (src/shared/sentryScrub.ts): user paths become <home>, the
//     OS user name <user>, stack frames app:/// paths.
//
// Sentry routing is intentionally lazy via require() so unit tests don't
// pull in the @sentry/electron native binding.
//
// v1.26 — DO NOT re-add `import { app } from 'electron'` here. It was a DEAD import (nothing in this
// file ever referenced `app`), and it was silently fatal: swarmMemory imports this module, swarmMemory
// now runs in a utilityProcess, and a utilityProcess's `electron` exports only { default, net,
// systemPreferences } — no `app`, no `safeStorage`. Under CJS a missing export is merely `undefined`;
// under ESM (this app is "type": "module") it is a LINK-TIME SyntaxError that kills the whole child at
// load. The memory host would fall back to the main thread forever, silently. See the guard test in
// tests/electron/memoryHostImportGraph.test.ts, which fails the build if any electron named import
// reappears in this graph. Need something from electron in main-only code? Inject it (setSafeStorage).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { CONSENT_VERSION } from '../shared/telemetryConsent'
import type { TelemetryConsentChoice } from '../shared/telemetryConsent'
import { normalizeUpdaterSignature } from '../shared/sentryScrub'

// `export … from`, not `export { CONSENT_VERSION }`: vitest's module runner leaves the bare form
// pointing at a binding that doesn't exist in its output, and the export reads undefined.
export { CONSENT_VERSION } from '../shared/telemetryConsent'

/** The consent as main holds it: the effective tiers, and whether the user still has to answer. */
export interface TelemetryConsent extends TelemetryConsentChoice {
  consentVersion: number
  needsReview: boolean
}

interface UpdaterReports {
  /** The app version the signatures were reported on: a new version may report them again. */
  version: string
  signatures: string[]
}

interface PersistedState extends TelemetryConsentChoice {
  consentVersion: number
  lastLaunchPingDate?: string
  updaterReports?: UpdaterReports
}

// Distinct updater failures one app version may report. Bounds the file, and a pathological run of
// ever-different errors.
const MAX_UPDATER_REPORTS = 20

let telemetryFilePath: string | null = null
let appVersion = ''
let state: PersistedState = notAsked()
const listeners = new Set<(consent: TelemetryConsent) => void>()

function notAsked(): PersistedState {
  return { crash: false, usage: false, consentVersion: 0 }
}

function isUpdaterReports(value: unknown): value is UpdaterReports {
  const r = value as UpdaterReports | null
  return typeof r === 'object' && r !== null && typeof r.version === 'string'
    && Array.isArray(r.signatures) && r.signatures.every((s) => typeof s === 'string')
}

function readPersisted(filePath: string): PersistedState {
  try {
    if (!existsSync(filePath)) return notAsked()
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return notAsked()
    // The v1 file held one `optIn`, which the tour pre-ticked: an answer to a question we no longer
    // ask, so it reads as version 1 — never honoured, always re-asked.
    const consentVersion = typeof parsed.consentVersion === 'number' ? parsed.consentVersion : 'optIn' in parsed ? 1 : 0
    return {
      crash: parsed.crash === true,
      usage: parsed.usage === true,
      consentVersion,
      ...(typeof parsed.lastLaunchPingDate === 'string' ? { lastLaunchPingDate: parsed.lastLaunchPingDate } : {}),
      ...(isUpdaterReports(parsed.updaterReports) ? { updaterReports: parsed.updaterReports } : {}),
    }
  } catch {
    return notAsked()
  }
}

function writePersisted(): void {
  if (!telemetryFilePath) return
  try {
    mkdirSync(dirname(telemetryFilePath), { recursive: true })
    writeFileSync(telemetryFilePath, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // Best-effort — losing the file just means the user is asked again next
    // launch, with both tiers off until then. Worth not crashing for.
  }
}

// Initialize from disk. Called once at app startup before any record* call.
// userDataDir is passed explicitly so tests don't need a real Electron app;
// version keys the per-version updater de-dup.
export function initTelemetry(userDataDir: string, version = ''): void {
  const filePath = join(userDataDir, 'telemetry.json')
  telemetryFilePath = filePath
  appVersion = version
  state = readPersisted(filePath)
}

// An answer below CONSENT_VERSION was given to a different question: it switches nothing on.
function consentIsCurrent(): boolean {
  return state.consentVersion >= CONSENT_VERSION
}

export function isCrashEnabled(): boolean {
  return state.crash && consentIsCurrent()
}

export function isUsageEnabled(): boolean {
  return state.usage && consentIsCurrent()
}

export function getConsent(): TelemetryConsent {
  return {
    crash: isCrashEnabled(),
    usage: isUsageEnabled(),
    consentVersion: state.consentVersion,
    needsReview: !consentIsCurrent(),
  }
}

/**
 * getConsent() for the renderer. Under the e2e bridge (NODE_ENV=test) the launch review is never
 * requested: every spec starts on a fresh profile with no answer on file, and a modal over the app
 * would break every spec that isn't about it. TERMPOLIS_E2E_CONSENT_REVIEW=1 lets one that is see it.
 */
export function getConsentForRenderer(env: NodeJS.ProcessEnv = process.env): TelemetryConsent {
  const consent = getConsent()
  if (env.NODE_ENV === 'test' && env.TERMPOLIS_E2E_CONSENT_REVIEW !== '1') return { ...consent, needsReview: false }
  return consent
}

/**
 * Record the user's answer and apply it at once (listeners: main Sentry). A tier left out keeps its
 * current effective value; anything but `true` is off. Stamped CONSENT_VERSION, so the user is not
 * asked again until what a tier sends changes. Persisted immediately so the next launch honours it
 * even if this one crashes before a clean shutdown.
 */
export function setConsent(choice: Partial<TelemetryConsentChoice>): TelemetryConsent {
  state = {
    ...state,
    crash: choice.crash === undefined ? isCrashEnabled() : choice.crash === true,
    usage: choice.usage === undefined ? isUsageEnabled() : choice.usage === true,
    consentVersion: CONSENT_VERSION,
  }
  writePersisted()
  const consent = getConsent()
  for (const listener of listeners) {
    try {
      listener(consent)
    } catch {
      // one broken listener must not keep the others (or the IPC reply) from the new answer
    }
  }
  return consent
}

/** Called with the new consent after every setConsent(). Returns an unsubscribe. */
export function onConsentChange(listener: (consent: TelemetryConsent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Lazy Sentry sender. Returns null if the tier is off, there is no DSN, or Sentry won't load (the
// provider throwing is caught below) — caller should treat null as "no-op".
//
// Resolved through an injectable provider so tests can stub it without
// vi.mock() needing to intercept lazy require()s (which it doesn't).
let sentryProvider: () => any = () => require('@sentry/electron/main')

function sentryOrNull(tier: 'crash' | 'usage'): any | null {
  if (!(tier === 'crash' ? isCrashEnabled() : isUsageEnabled())) return null
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
  /**
   * `false` = an error only the user can fix (a full disk): kept as a warning breadcrumb, but never
   * filed as a Sentry issue.
   */
  report?: boolean
}

// The updater retries every 4 h, and a machine that can't update fails the same way each time. One
// report per failure mode per app version is the signal; the rest is noise and quota. Persisted, so
// a relaunch doesn't file it again.
function claimUpdaterReport(signature: string): boolean {
  const seen = state.updaterReports?.version === appVersion ? state.updaterReports.signatures : []
  if (seen.includes(signature) || seen.length >= MAX_UPDATER_REPORTS) return false
  state = { ...state, updaterReports: { version: appVersion, signatures: [...seen, signature] } }
  writePersisted()
  return true
}

// Tier 1 (crash): auto-update health. We don't open a Sentry issue per event —
// we use breadcrumbs so the next captured exception carries the recent
// updater history, plus a captureMessage for a hard error's first occurrence.
export function recordUpdaterEvent(payload: UpdaterEventPayload): void {
  const Sentry = sentryOrNull('crash')
  if (!Sentry) return
  try {
    Sentry.addBreadcrumb?.({
      category: 'updater',
      level: payload.status !== 'error' ? 'info' : payload.report === false ? 'warning' : 'error',
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
    if (payload.status === 'error' && payload.error && payload.report !== false) {
      const signature = normalizeUpdaterSignature(payload.error)
      if (!claimUpdaterReport(signature)) return
      // Grouped by the signature, not the text: its paths, sizes and URLs differ on every machine,
      // which split one failure into an issue per user. The `updater error: ` prefix is what
      // updaterErrors.shouldDropSentryEvent keys on — keep it.
      Sentry.captureMessage?.(`updater error: ${payload.error}`, {
        level: 'error',
        fingerprint: ['updater', signature],
        tags: { updater: 'error' },
      })
    }
  } catch {
    // never let telemetry crash the app
  }
}

// Tier 2 (usage): anonymous usage events. Caller picks the name (e.g. "swarm.start",
// "report-problem.submit"). props must be free of PII — no paths, no inputs. A breadcrumb only:
// it leaves the machine inside a crash report, so it needs both tiers on to go anywhere.
export function recordEvent(name: string, props?: Record<string, unknown>): void {
  const Sentry = sentryOrNull('usage')
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

/**
 * Report that the PREVIOUS session ended without a clean exit — i.e. it died hard: a V8 fatal, an
 * OOM kill, a power cut.
 *
 * Why this exists: a native abort never becomes a JS exception, so @sentry/electron's JS layer never
 * sees it, and the Sentry→GitHub "Auto-file Production crashes" alert — which matches catchable JS
 * errors — files NOTHING. That is exactly how the v1.27.4 crash-loop (`ReadFileUtf8` →
 * `ToLocalChecked` → abort, the app unusable for hours) opened ZERO issues while sitting in Sentry
 * the whole time as an untriaged native crash. Captured here as an ordinary exception so the
 * existing alert DOES file it. A short uptime is the crash-loop signature — v1.27.4's was ~3 s.
 * Minidumps are no longer uploaded (they hold process memory), so this is now the only trace of one.
 */
export function recordUncleanExit(ctx: { prevVersion: string; uptimeMs: number }): void {
  const Sentry = sentryOrNull('crash')
  if (!Sentry) return
  try {
    const secs = Math.round(ctx.uptimeMs / 1000)
    const err = new Error(
      `Previous session ended without a clean exit (native crash) after ~${secs}s on v${ctx.prevVersion}`,
    )
    err.name = 'UncleanExit'
    Sentry.captureException?.(err, {
      tags: { uncleanExit: 'true', prevVersion: ctx.prevVersion },
      extra: {
        ...ctx,
        hint: 'No JS exception accompanies a native fatal, and minidumps are not uploaded — this event is the only record.',
      },
    })
  } catch {
    /* telemetry must never break startup */
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
  const Sentry = sentryOrNull('crash')
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

// All a launch ping carries: that some copy of this version opened today.
const LAUNCH_PING_FIELDS = ['event_id', 'timestamp', 'platform', 'level', 'message', 'logentry', 'release', 'environment', 'sdk']

/** A launch-ping event cut down to LAUNCH_PING_FIELDS, tagged so it never reads as a crash. */
export function launchPingOnly(event: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const field of LAUNCH_PING_FIELDS) {
    if (field in event) kept[field] = event[field]
  }
  kept.tags = { tier: 'usage' }
  return kept
}

// The ping goes out on a client of its own, not the crash client: it has to flow with crash reports
// off, and must carry nothing a crash scope gathers — breadcrumbs, OS and device contexts, tags,
// attachments. No integrations, so nothing is collected in the first place; beforeSend keeps only
// LAUNCH_PING_FIELDS, and re-checks consent in case it was withdrawn while the event was queued.
function sendLaunchPing(Sentry: any, version: string): void {
  const client = new Sentry.NodeClient({
    dsn: process.env.SENTRY_DSN,
    release: `termpolis@${version}`,
    environment: process.env.NODE_ENV || 'production',
    integrations: [],
    transport: Sentry.makeElectronTransport,
    stackParser: Sentry.defaultStackParser,
    sendDefaultPii: false,
    includeServerName: false,
    sendClientReports: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event: Record<string, unknown>, hint: { attachments?: unknown[] }) => {
      hint.attachments = []
      return isUsageEnabled() ? launchPingOnly(event) : null
    },
  })
  const scope = new Sentry.Scope()
  scope.setClient(client)
  client.init()
  scope.captureMessage(`launch ${version}`, 'info')
}

// Tier 2 (usage): a "launch" message at most once per UTC day.
// This is the heartbeat: it's how we count "still installed and opening".
// De-duped via persisted lastLaunchPingDate so reopening the app five times
// in one day still only sends one ping. Returns whether a ping was sent.
export function dailyLaunchPing(version: string, now: Date = new Date()): boolean {
  if (!isUsageEnabled()) return false
  const key = todayKey(now)
  if (state.lastLaunchPingDate === key) return false
  // Marked before sending: a missing DSN or a failed send must not retry on every relaunch today.
  state = { ...state, lastLaunchPingDate: key }
  writePersisted()
  const Sentry = sentryOrNull('usage')
  if (!Sentry) return false
  try {
    sendLaunchPing(Sentry, version)
    return true
  } catch {
    return false
  }
}

// Test-only: reset module state between tests.
export function __resetTelemetryForTests(): void {
  telemetryFilePath = null
  appVersion = ''
  state = notAsked()
  listeners.clear()
}
