// Sentry for the main (Node.js) process.
//
// Catches uncaught exceptions and unhandled rejections in the Electron main process — only while the
// user has crash reports on. The gate is read from src/main/telemetry, which itself hydrates from
// userData/telemetry.json — so the gate works on first launch (before the renderer has mounted) and
// across crashes — and it follows every change at once: off disables the client, on starts it (or
// re-enables it). A client is never torn down and made again: the SDK sets OpenTelemetry up once
// per process.
//
// A report carries the error and what explains it, nothing more: no minidumps (they hold process
// memory), screenshots, sessions, console lines, local variables, source lines or trace headers, and
// every string in it is scrubbed of the user's home, user name and machine name
// (src/shared/sentryScrub.ts).

import { homedir, userInfo } from 'os'
import { isCrashEnabled, isUsageEnabled, onConsentChange } from './telemetry'
import type { TelemetryConsent } from './telemetry'
import { shouldDropSentryEvent } from './updaterErrors'
import { scrubBreadcrumb, scrubEvent } from '../shared/sentryScrub'
import type { ScrubOptions } from '../shared/sentryScrub'

// Default integrations that collect more than an error report needs.
export const DROPPED_INTEGRATIONS: ReadonlySet<string> = new Set([
  'SentryMinidump', 'ElectronMinidump', // native crash dumps: raw process memory
  'Screenshots', // the user's screen
  'MainProcessSession', 'BrowserWindowSession', // session pings: usage, not crashes
  'Console', // whatever the app logged: terminal text, prompts, paths
  'ContextLines', 'LocalVariables', // source lines and variable values
  'NodeFetch', 'Http', 'ElectronNet', // every request's URL, and trace headers on it
  'RendererProfiling', 'StartupTracing', // performance data
])

// Resolved through an injectable provider so tests can stub it without vi.mock() needing to
// intercept a lazy require() (which it doesn't).
const requireSdk = (): any => require('@sentry/electron/main')
let sdkProvider: () => any = requireSdk
// The SDK, once init() has been called on it: at most once per process.
let sdk: any = null
let started = false
let subscribed = false

let osIdentity: { homedir: () => string; userInfo: () => { username: string } } = { homedir, userInfo }
let identity: ScrubOptions | null = null

// The user's home and name as the OS knows them, so the scrubber also catches a home the path shapes
// miss (D:\Profiles\jdoe). Read once. Either may be unknowable — os.userInfo() throws for a user with
// no passwd entry — which leaves the shapes to do the work.
function scrubIdentity(): ScrubOptions {
  if (identity) return identity
  identity = {}
  try {
    identity.homeDir = osIdentity.homedir()
  } catch {
    // no home directory to name
  }
  try {
    identity.userName = osIdentity.userInfo().username
  } catch {
    // no passwd entry to name
  }
  return identity
}

/**
 * The main process's beforeSend: nothing leaves with crash reports off, and what does leave is cut
 * to the error and scrubbed. An event that can't be scrubbed is not sent.
 */
export function mainBeforeSend(event: any, hint?: { attachments?: unknown[] }): any {
  if (!isCrashEnabled()) return null
  // Last line of defence for benign auto-updater states. The updater's own 'error' handler
  // already converts them to "not available", but the Error object can still reach Sentry's
  // global handlers by a path we don't own — which is how ONE macOS read-only-volume refusal
  // filed two GitHub issues (#21 as a captureMessage, #22 as the raw exception).
  try {
    if (shouldDropSentryEvent(event)) return null
  } catch {
    // a filter that throws must never swallow a real crash report
  }
  try {
    if (hint) hint.attachments = []
    // recordEvent() breadcrumbs are usage statistics: they ride along only while that tier is on.
    if (!isUsageEnabled() && Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.filter((crumb: any) => crumb?.category !== 'event')
    }
    // Locale and time zone say where the user is; the boot time singles out their machine.
    if (event.contexts) {
      delete event.contexts.culture
      if (event.contexts.device) delete event.contexts.device.boot_time
    }
    return scrubEvent(event, scrubIdentity())
  } catch {
    return null
  }
}

/** The main process's beforeBreadcrumb: the same gates, applied as each breadcrumb is recorded. */
export function mainBeforeBreadcrumb(crumb: any): any {
  if (!isCrashEnabled()) return null
  if (crumb?.category === 'event' && !isUsageEnabled()) return null
  try {
    return scrubBreadcrumb(crumb, scrubIdentity())
  } catch {
    return null
  }
}

/** Sentry.init's `integrations`: the defaults, less DROPPED_INTEGRATIONS. */
export function keepIntegrations<T extends { name: string }>(defaults: T[]): T[] {
  return defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name))
}

// Consent changed in the app: follow it now, not at the next launch.
function applyCrashConsent(consent: TelemetryConsent): void {
  if (!sdk) {
    if (consent.crash) initMainSentry()
    return
  }
  const client = sdk.getClient?.()
  // The same switch the SDK's own close() flips; unlike close(), it can be flipped back.
  if (client) client.getOptions().enabled = consent.crash
}

export function initMainSentry(): boolean {
  if (!subscribed) {
    subscribed = true
    onConsentChange(applyCrashConsent)
  }
  if (sdk) return started
  if (!process.env.SENTRY_DSN) {
    console.log('Sentry (main): no DSN configured (set SENTRY_DSN to enable)')
    return false
  }
  if (!isCrashEnabled()) {
    console.log('Sentry (main): crash reports are off')
    return false
  }

  try {
    const Sentry = sdkProvider()
    sdk = Sentry
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: `termpolis@${require('../../package.json').version}`,
      environment: process.env.NODE_ENV || 'production',
      sendDefaultPii: false,
      sendClientReports: false,
      attachScreenshot: false,
      includeLocalVariables: false,
      tracePropagationTargets: [],
      // Classic IPC only: the protocol mode registers a scheme, which Electron allows only before
      // `ready` — and crash reports turned on in the app start long after it.
      ipcMode: Sentry.IPCMode.Classic,
      // Not the default offline transport: it keeps reports on disk and sends them later, even
      // after the user has turned crash reports off.
      transport: Sentry.makeElectronTransport,
      integrations: keepIntegrations,
      beforeSend: mainBeforeSend,
      beforeBreadcrumb: mainBeforeBreadcrumb,
    })
    started = true
    console.log('Sentry (main) initialized')
    return true
  } catch (e) {
    console.log('Sentry (main) init failed (non-fatal):', (e as any).message)
    return false
  }
}

// Test-only: swap the SDK for a stub.
export function __setMainSentrySdkForTests(fn: () => any): void {
  sdkProvider = fn
}

// Test-only: stand in for os.homedir() / os.userInfo().
export function __setOsIdentityForTests(source: typeof osIdentity): void {
  osIdentity = source
  identity = null
}

// Test-only: reset module state between tests.
export function __resetMainSentryForTests(): void {
  sdkProvider = requireSdk
  sdk = null
  started = false
  subscribed = false
  osIdentity = { homedir, userInfo }
  identity = null
}
