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
//     `captureMessage('updater error: <msg>')`.  Prevented at the source: the updater records only
//     what `classifyUpdaterError` calls `'genuine'`.
//   • the Error object itself, reaching Sentry's global handlers.  Caught by `shouldDropSentryEvent`
//     in `initMainSentry`'s beforeSend, because we don't own the throw site.
// Both are needed: fixing only the first still leaves the second filing an issue.

import { homedir } from 'os'

// Where builder-util-runtime's HttpError starts quoting the response: the JSON description
// (`"method: GET url: …`), or straight into `Headers: …` when there is none.
const HTTP_RESPONSE_DUMP = /\n(?:"method: [A-Z]+ url: |Headers: )/
// Where electron-updater quotes a whole document it fetched but couldn't use: the releases feed
// (`Cannot parse releases feed: <why>,\nXML:\n<feed>` — also how a failed /releases/latest request
// arrives) or a channel file (`…: <why>, rawData: <yml>`). The feed holds the last ten releases'
// notes, and notes name the very errors classified here ("no more reports of a read-only volume").
const FETCHED_DOCUMENT = /,\nXML:\n|, rawData: /

/** All but the document a failed feed or channel-file read quotes. */
function withoutFetchedDocument(text: string): string {
  return text.split(FETCHED_DOCUMENT, 1)[0]
}

/** The error's own words: the response or document it quotes — what the SERVER said — cut off. */
function ownText(text: string): string {
  return withoutFetchedDocument(text).split(HTTP_RESPONSE_DUMP, 1)[0]
}

// electron-updater reads `resources/app-update.yml` at the start of every checkForUpdates(). When
// that file is absent — an interrupted/partial install, an antivirus quarantine, a manual delete —
// it emits an ENOENT 'error'. Auto-update genuinely cannot run without it and there is nothing the
// app can do about it at runtime, so this is a benign, unactionable environmental state, NOT a
// production crash (was Sentry issue ELECTRON-8 / GitHub #14).
export function isMissingUpdateConfigError(err: unknown): boolean {
  const msg = ownText(messageOf(err))
  return /ENOENT/i.test(msg) && /app-update\.yml/i.test(msg)
}

// "Couldn't reach the server", and nothing more: Chromium's net errors (electron-updater requests
// through `electron.net`) and Node's socket errnos.
const NET_ERROR =
  /net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NETWORK_ACCESS_DENIED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_(?:RESET|REFUSED|CLOSED|TIMED_OUT|ABORTED|FAILED)|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)\b/i
const SOCKET_ERRNO = /\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/
// What Node's and builder-util-runtime's HTTP clients say when a connection drops or stalls. Too
// generic to mute on sight: it only counts when it is known to be the updater's (isUpdaterNoise).
const DROPPED_REQUEST = /\bsocket hang up\b|\bRequest timed out\b|\bRequest has been aborted by the server\b/

// A transient network failure during an update check: the user is offline, on a flaky/captive-portal
// connection, or the update host is briefly unreachable. electron-updater surfaces these as Chromium
// net errors (net::ERR_*), Node socket errnos (also as the error's `code`), or its HTTP client's own
// "socket hang up" / "Request timed out". Auto-update simply can't reach the server — there's
// nothing to fix and the user did nothing wrong — so it must NEVER be reported to Sentry as a
// production error (was Sentry issue ELECTRON-9 / GitHub #15:
// "updater error: net::ERR_INTERNET_DISCONNECTED"; and GitHub #19 / ELECTRON-B:
// "net::ERR_NETWORK_IO_SUSPENDED" — the machine slept mid-check). Matches only connectivity
// failures, so genuine errors (e.g. sha512 mismatch) still report — and only in the error's own
// words: a 404 whose page happens to mention ECONNRESET is a 404.
export function isTransientNetworkError(err: unknown): boolean {
  const code = fieldOf(err, 'code')
  if (typeof code === 'string' && SOCKET_ERRNO.test(code)) return true
  const own = ownText(messageOf(err))
  return hasNetworkErrorCode(own) || DROPPED_REQUEST.test(own)
}

function hasNetworkErrorCode(text: string): boolean {
  return NET_ERROR.test(text) || SOCKET_ERRNO.test(text)
}

// macOS only: the .app is running from a read-only location — still inside the mounted .dmg, or in
// ~/Downloads under Gatekeeper's app translocation. Squirrel cannot swap a bundle it can't write to,
// so it refuses (after electron-updater has already downloaded the update). Nothing is broken and
// there is no code fix: the user simply has to drag Termpolis to /Applications (Squirrel's own
// message says exactly that). Filing it as a production crash is noise — Sentry ELECTRON-E/F,
// GitHub #21/#22.
export function isReadOnlyVolumeError(err: unknown): boolean {
  return /read-only volume/i.test(ownText(messageOf(err)))
}

// The two shapes electron-updater reports an HTTP status in, never a bare number:
//   • an HttpError (feed / channel-file request): `<status> <statusMessage>` alone on the first line,
//     then the JSON-quoted `"method: GET url: …"` description, or straight into `Headers: …`;
//   • a failed download: `Cannot download "<url>", status <status>: <statusMessage>`.
// The status message can't hold a quote or a backslash, so the first can't match inside the
// JSON-quoted body: a 403 whose body quotes an upstream 503 is a 403.
const HTTP_FEED_FAILURE = /(?:^|: )(?:408|429|5\d\d) [^\n"\\]*\n(?:"method: [A-Z]+ url: |Headers: )/
const HTTP_DOWNLOAD_FAILURE = /\bCannot download "https?:\/\/[^"]*", status (?:408|429|5\d\d):/

// The update host answered, but with a transient server-side failure: GitHub's edge timing out, a bad
// gateway, maintenance, an internal error, rate limiting. The network is fine and so is Termpolis —
// the next scheduled check simply retries (was Sentry ELECTRON-Y / GitHub #28: "updater error: 504"
// for releases.atom). Any 5xx, a 429 or a 408, read off the HttpError's own `statusCode` / `code`
// when it still has them, else off its text. A 404 (a release or latest.yml genuinely missing) or a
// 403 is a real release defect and still reports.
export function isTransientHttpServerError(err: unknown): boolean {
  const status = httpStatusOf(err)
  if (status !== null && isTransientHttpStatus(status)) return true
  // The dump marker is part of the shape, so this keeps the HttpError's response — never a document.
  const msg = withoutFetchedDocument(messageOf(err))
  return HTTP_FEED_FAILURE.test(msg) || HTTP_DOWNLOAD_FAILURE.test(msg)
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/** builder-util-runtime's HttpError carries its status twice: `statusCode`, and `code: 'HTTP_ERROR_<n>'`. */
function httpStatusOf(err: unknown): number | null {
  const statusCode = fieldOf(err, 'statusCode')
  if (typeof statusCode === 'number') return statusCode
  const code = fieldOf(err, 'code')
  const match = typeof code === 'string' ? /^HTTP_ERROR_(\d{3})$/.exec(code) : null
  return match ? Number(match[1]) : null
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
  const msg = ownText(messageOf(err))
  return /no space left on device/i.test(msg) || /\bENOSPC\b/.test(msg)
}

/**
 * What an updater failure IS, which decides everything the updater does with it:
 *   • 'missing-config' — no app-update.yml: this copy can't update at all (a broken install).
 *   • 'read-only'      — Squirrel.Mac refused: the app runs from a read-only location.
 *   • 'disk-full'      — the user's disk is full; only they can free the space.
 *   • 'transient'      — offline, a flaky connection, the update host briefly failing: retry later.
 *   • 'genuine'        — anything else. The only kind that is ever reported.
 * The order only matters for text that fits two kinds; the reading that tells the user more wins.
 */
export type UpdaterErrorKind = 'missing-config' | 'read-only' | 'disk-full' | 'transient' | 'genuine'

export function classifyUpdaterError(err: unknown): UpdaterErrorKind {
  if (isMissingUpdateConfigError(err)) return 'missing-config'
  if (isReadOnlyVolumeError(err)) return 'read-only'
  if (isDiskFullError(err)) return 'disk-full'
  if (isTransientNetworkError(err) || isTransientHttpServerError(err)) return 'transient'
  return 'genuine'
}

// What the user is told instead of the raw failure: the raw text names cache paths the user never
// chose, quotes HTTP internals, and never says what — if anything — to do.
export const DISK_FULL_MESSAGE =
  'Not enough free disk space to download the update. Free up some space and Termpolis will try again automatically.'
export const UPDATE_SERVER_UNREACHABLE_MESSAGE =
  "Couldn't reach the update server right now. Termpolis will try again automatically."
export const NO_UPDATE_FEED_MESSAGE =
  "This copy of Termpolis can't update itself: its update configuration file is missing. Reinstalling Termpolis restores it."

/**
 * Why an update check failed, fit to show the user: plain words for every kind that isn't a real
 * failure, and a genuine failure's own (scrubbed) text. `readOnlyHint` says where the app is running
 * from — the updater's location check knows that, this module doesn't.
 */
export function updaterFailureMessage(err: unknown, readOnlyHint: string): string {
  switch (classifyUpdaterError(err)) {
    case 'missing-config':
      return NO_UPDATE_FEED_MESSAGE
    case 'read-only':
      return readOnlyHint
    case 'disk-full':
      return DISK_FULL_MESSAGE
    case 'transient':
      return UPDATE_SERVER_UNREACHABLE_MESSAGE
    case 'genuine':
      return scrubUpdaterText(messageOf(err))
  }
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
 * A Sentry event (main process) that is really updater noise, arriving by a path we don't own — an
 * uncaught exception, an unhandled rejection, or a captureMessage.
 *
 * Deliberately narrow: it only looks at the message/exception text. Text that says it is the
 * updater's own capture (`updater error: …`) is dropped unless classifyUpdaterError calls it
 * genuine. Any other text is dropped only for what is the updater's or noise wherever it comes
 * from: a missing app-update.yml, Squirrel's read-only refusal, an update-host 5xx, a network error
 * code, and a full disk that is visibly the updater's (isUpdaterDiskFullText). A genuine updater
 * bug (sha512 mismatch, a bad signature) still reports, and so do a "socket hang up" or an ENOSPC
 * from anywhere else in the main process.
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
  return texts.some((t) => typeof t === 'string' && t.length > 0 && isUpdaterNoise(t))
}

// How telemetry.recordUpdaterEvent files an updater failure: captureMessage(`updater error: <msg>`).
const UPDATER_CAPTURE_PREFIX = 'updater error: '

function isUpdaterNoise(text: string): boolean {
  if (text.startsWith(UPDATER_CAPTURE_PREFIX)) {
    return classifyUpdaterError(text.slice(UPDATER_CAPTURE_PREFIX.length)) !== 'genuine'
  }
  return (
    isMissingUpdateConfigError(text) ||
    isReadOnlyVolumeError(text) ||
    isTransientHttpServerError(text) ||
    hasNetworkErrorCode(ownText(text)) ||
    isUpdaterDiskFullText(text)
  )
}

// A full disk that is visibly the UPDATER's: Squirrel.Mac's ShipIt/ditto extraction. The same errno
// from anywhere else in the main process is not ours to mute — a store that corrupts instead of
// degrading on a full disk is a real bug.
function isUpdaterDiskFullText(text: string): boolean {
  return isDiskFullError(text) && /\bditto: |\bShipIt\b/.test(text)
}

/** A property of a thrown object — Node and builder-util-runtime hang `code` / `statusCode` on theirs. */
function fieldOf(err: unknown, key: 'code' | 'statusCode'): unknown {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined
}

/** An Error's message, anything else stringified — never throws, never returns undefined. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '')
}
