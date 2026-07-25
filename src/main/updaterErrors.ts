// Which auto-updater failures are BENIGN — i.e. environmental facts about the machine, not defects
// in Termpolis — and must therefore never be filed as production crashes.
//
// This lives in its own module, free of any `electron` import, for two reasons:
//   1. `sentry.ts` needs it during early main-process init, before the updater is wired up at all.
//   2. It is pure, so every pattern here is unit-testable against the exact strings Sentry filed.
//
// Two reporting paths reach Sentry, which is why one bad launch can file TWO issues for one event
// (GitHub #21 + #22 were the same macOS read-only-volume refusal):
//   • `autoUpdater.on('error')` → state `'error'` → `telemetry.recordUpdaterEvent` →
//     `captureMessage('updater error: <msg>')`.  Prevented at the source by `isBenignUpdaterError`.
//   • the Error object itself, reaching Sentry's global handlers.  Caught by `shouldDropSentryEvent`
//     in `initMainSentry`'s beforeSend, because we don't own the throw site.
// Both are needed: fixing only the first still leaves the second filing an issue.

// electron-updater reads `resources/app-update.yml` at the start of every checkForUpdates(). When
// that file is absent — an interrupted/partial install, an antivirus quarantine, a manual delete —
// it emits an ENOENT 'error'. Auto-update genuinely cannot run without it and there is nothing the
// app can do about it at runtime, so this is a benign, unactionable environmental state, NOT a
// production crash (was Sentry issue ELECTRON-8 / GitHub #14).
export function isMissingUpdateConfigError(err: unknown): boolean {
  const msg = messageOf(err)
  return /ENOENT/i.test(msg) && /app-update\.yml/i.test(msg)
}

// A transient network failure during an update check: the user is offline, on a flaky/captive-portal
// connection, or the update host is briefly unreachable. electron-updater surfaces these as Chromium
// net errors (net::ERR_*) or Node socket errnos. Auto-update simply can't reach the server — there's
// nothing to fix and the user did nothing wrong — so it must NEVER be reported to Sentry as a
// production error (was Sentry issue ELECTRON-9 / GitHub #15:
// "updater error: net::ERR_INTERNET_DISCONNECTED"; and GitHub #19 / ELECTRON-B:
// "net::ERR_NETWORK_IO_SUSPENDED" — the machine slept mid-check). Matches only connectivity
// failures, so genuine errors (e.g. sha512 mismatch) still report.
export function isTransientNetworkError(err: unknown): boolean {
  const msg = messageOf(err)
  return (
    /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|CONNECTION_(RESET|REFUSED|CLOSED|TIMED_OUT)|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED)/i.test(
      msg,
    ) || /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/.test(msg)
  )
}

// macOS only: the .app is running from a read-only location — still inside the mounted .dmg, or in
// ~/Downloads under Gatekeeper's app translocation. Squirrel cannot swap a bundle it can't write to,
// so it refuses before downloading anything. Nothing is broken and there is no code fix: the user
// simply has to drag Termpolis to /Applications (Squirrel's own message says exactly that). Filing
// it as a production crash is noise — Sentry ELECTRON-E/F, GitHub #21/#22.
export function isReadOnlyVolumeError(err: unknown): boolean {
  return /read-only volume/i.test(messageOf(err))
}

/** Any updater failure the user can neither cause nor fix. */
export function isBenignUpdaterError(err: unknown): boolean {
  return isMissingUpdateConfigError(err) || isTransientNetworkError(err) || isReadOnlyVolumeError(err)
}

/**
 * A Sentry event (main process) that is really one of the benign updater states above, arriving by
 * a path we don't own — an uncaught exception, an unhandled rejection, or a captureMessage.
 *
 * Deliberately narrow: it only looks at the message/exception text, and only drops text that one of
 * the predicates above already recognises. A genuine updater bug (sha512 mismatch, a bad signature)
 * still reports.
 */
export function shouldDropSentryEvent(event: unknown): boolean {
  const e = event as
    | { message?: unknown; exception?: { values?: Array<{ value?: unknown; type?: unknown }> } }
    | null
    | undefined
  if (!e || typeof e !== 'object') return false
  const texts: unknown[] = [e.message]
  const values = e.exception?.values
  if (Array.isArray(values)) {
    for (const v of values) texts.push(v?.value)
  }
  return texts.some((t) => typeof t === 'string' && t.length > 0 && isBenignUpdaterError(t))
}

/** An Error's message, anything else stringified — never throws, never returns undefined. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '')
}
