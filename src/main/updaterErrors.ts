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

import { homedir } from 'os'

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

// The update host answered, but with a transient server-side failure: GitHub's edge timing out, a bad
// gateway, maintenance, an internal error, rate limiting. The network is fine and so is Termpolis —
// the next scheduled check simply retries (was Sentry ELECTRON-Y / GitHub #28: "updater error: 504"
// for releases.atom). Only electron-updater's own shapes count, never a bare number:
//   • an HttpError (feed / channel-file request): `<status> <statusMessage>` alone on the first line,
//     then the JSON-quoted `"method: GET url: …"` description, or straight into `Headers: …`;
//   • a failed download: `Cannot download "<url>", status <status>: <statusMessage>`.
// Only 408/429/500/502/503/504. A 404 (a release or latest.yml genuinely missing) or a 403 is a real
// release defect and still reports. The status message can't hold a quote or a backslash, so the
// match can't start inside the JSON-quoted body: a 403 whose body quotes an upstream 503 is a 403.
export function isTransientHttpServerError(err: unknown): boolean {
  const msg = messageOf(err)
  return (
    /(?:^|: )(?:408|429|50[0234]) [^\n"\\]*\n(?:"method: [A-Z]+ url: |Headers: )/.test(msg) ||
    /\bCannot download "https?:\/\/[^"]*", status (?:408|429|50[0234]):/.test(msg)
  )
}

/** Any updater failure the user can neither cause nor fix. */
export function isBenignUpdaterError(err: unknown): boolean {
  return (
    isMissingUpdateConfigError(err) ||
    isTransientNetworkError(err) ||
    isTransientHttpServerError(err) ||
    isReadOnlyVolumeError(err)
  )
}

// Where builder-util-runtime's HttpError starts quoting the response: the JSON description
// (`"method: GET url: …`), or straight into `Headers: …` when there is none.
const HTTP_RESPONSE_DUMP = /\n(?:"method: [A-Z]+ url: |Headers: )/

// The disk is full. On macOS, Squirrel.Mac unpacks the downloaded update with `ditto` into
// ~/Library/Caches/com.termpolis.app.ShipIt/update.<random>/ and a full volume kills it mid-extract
// ("ditto: …: No space left on device", then "ditto: Couldn't read pkzip signature."); elsewhere it
// is Node's ENOSPC. Not a Termpolis defect, so it must never be filed as a crash: Sentry
// ELECTRON-Z/10/11 = GitHub #29/#30/#31 were ONE user's full disk, filed three times because every
// 4-hourly retry extracts into a fresh random update.XXXXXXX directory. Deliberately NOT part of
// isBenignUpdaterError: an update really is pending and only the user can free the space, so the
// updater says so rather than claiming there is no update. Only the text before an HttpError's
// response dump counts: a server that says IT is out of space (a 507, a proxy's error page) is not
// the user's disk.
export function isDiskFullError(err: unknown): boolean {
  const msg = messageOf(err).split(HTTP_RESPONSE_DUMP, 1)[0]
  return /no space left on device/i.test(msg) || /\bENOSPC\b/.test(msg)
}

/**
 * The text of an updater error, fit to show the user and to report. electron-updater's HttpError
 * appends every response header (`\nHeaders: {…}`, always last). They diagnose nothing, they make
 * each report unique (a date, a request id) so Sentry can't group them, and #28 shows they carry
 * cookies: GitHub's `set-cookie: _gh_sess=…` went to Sentry and on into a public GitHub issue.
 */
export function withoutResponseHeaders(message: string): string {
  return message.replace(/\nHeaders: [\s\S]*$/, '')
}

/**
 * Updater text fit to show the user, log, and report: withoutResponseHeaders, and the user's home
 * directory as `~`. Every path the updater names — Squirrel's ShipIt cache, electron-updater's
 * pending download — sits under it, so unscrubbed, each report and log line names the user (#29–#31
 * took a macOS user name into public GitHub issues). `home` is injectable for tests.
 */
export function scrubUpdaterText(text: string, home: string = homeDirOrEmpty()): string {
  const out = withoutResponseHeaders(text)
  const root = home.replace(/[\\/]+$/, '')
  // Too short to be a real home ("/", "C:"): it would match all over the text.
  if (root.length < 3) return out
  // Either separator and any case (the Windows and macOS default volumes ignore case), and never
  // the prefix of a longer name: home /Users/x leaves /Users/xavier alone.
  const pattern = root
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]')
  return out.replace(new RegExp(`${pattern}(?![\\w.-])`, 'gi'), '~')
}

function homeDirOrEmpty(): string {
  try {
    return homedir()
  } catch {
    return '' // no HOME and no passwd entry: nothing to scrub, and a logger must never throw
  }
}

/**
 * A Sentry event (main process) that is really one of the benign updater states above, arriving by
 * a path we don't own — an uncaught exception, an unhandled rejection, or a captureMessage.
 *
 * Deliberately narrow: it only looks at the message/exception text, and only drops text that one of
 * the predicates above already recognises. A genuine updater bug (sha512 mismatch, a bad signature)
 * still reports. A full disk is dropped only when the text is visibly the updater's (see
 * isUpdaterDiskFullText) — ENOSPC anywhere else in the main process still reports.
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
  return texts.some(
    (t) => typeof t === 'string' && t.length > 0 && (isBenignUpdaterError(t) || isUpdaterDiskFullText(t)),
  )
}

// A full disk that is visibly the UPDATER's: our own `updater error:` capture, or Squirrel.Mac's
// ShipIt/ditto extraction. The same errno from anywhere else in the main process is not ours to mute —
// a store that corrupts instead of degrading on a full disk is a real bug.
function isUpdaterDiskFullText(text: string): boolean {
  return isDiskFullError(text) && /^updater error: |\bditto: |\bShipIt\b/.test(text)
}

/** An Error's message, anything else stringified — never throws, never returns undefined. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '')
}
