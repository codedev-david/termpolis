// Every pattern here exists because a real Sentry issue was filed for something that was never a
// Termpolis defect. The strings below are the ACTUAL text Sentry received — if a regex stops
// matching one of them, that issue comes back.
import { describe, it, expect, vi } from 'vitest'
import { homedir } from 'os'
import {
  isMissingUpdateConfigError,
  isTransientNetworkError,
  isTransientHttpServerError,
  isReadOnlyVolumeError,
  isDiskFullError,
  isBenignUpdaterError,
  shouldDropSentryEvent,
  withoutResponseHeaders,
  scrubUpdaterText,
} from '../../src/main/updaterErrors'

// The real homedir, except where a test makes it throw (no HOME and no passwd entry). On `default`
// too: that is where the module under test's named import is read from.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = vi.fn(actual.homedir)
  return { ...actual, homedir, default: { ...actual, homedir } }
})

/** Verbatim from GitHub #21/#22 (Sentry ELECTRON-E/F). */
const READ_ONLY =
  'Cannot update while running on a read-only volume. The application is on a read-only volume. ' +
  "Please move the application and try again. If you're on macOS Sierra or later, you'll need to " +
  'move the application out of the Downloads directory.'

/** Verbatim from GitHub #14 (Sentry ELECTRON-8). */
const MISSING_CONFIG =
  "ENOENT: no such file or directory, open " +
  "'C:\\Users\\x\\AppData\\Local\\Programs\\termpolis\\resources\\app-update.yml'"

/**
 * Verbatim from GitHub #28 (Sentry ELECTRON-Y), cookie values elided. electron-updater's HttpError:
 * `<status> <statusMessage>` (empty over HTTP/2, hence "504 "), then the JSON-quoted description —
 * its `\n` are a literal backslash + n — then every response header, pretty-printed.
 */
const GATEWAY_TIMEOUT =
  '504 \n' +
  '"method: GET url: https://github.com/codedev-david/termpolis/releases.atom\\n\\n          Data:\\n' +
  "          <html><body><h1>504 Gateway Time-out</h1>\\nThe server didn't respond in time.\\n</body></html>\\n\\n          \"\n" +
  'Headers: {\n' +
  '  "cache-control": "no-cache",\n' +
  '  "content-length": "92",\n' +
  '  "content-type": "text/html",\n' +
  '  "date": "Mon, 21 Sep 2026 15:24:15 GMT",\n' +
  '  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",\n' +
  '  "x-frame-options": "DENY",\n' +
  '  "x-github-edge-region": "iad",\n' +
  '  "x-github-request-id": "DAFD:6F5C1:32B5AC:4328BE:6AB14C14",\n' +
  '  "set-cookie": [\n' +
  '    "_gh_sess=<elided>; path=/; HttpOnly; secure; SameSite=Lax",\n' +
  '    "_octo=<elided>; expires=Tue, 21 Sep 2027 15:24:04 GMT; domain=.github.com; path=/; secure; SameSite=Lax",\n' +
  '    "logged_in=no; expires=Tue, 21 Sep 2027 15:24:04 GMT; domain=.github.com; path=/; HttpOnly; secure; SameSite=Lax"\n' +
  '  ]\n' +
  '}'

/** Verbatim from GitHub #29/#30/#31 (Sentry ELECTRON-Z/10/11), user name elided — ONE full disk. */
const SHIPIT = 'ditto: /Users/x/Library/Caches/com.termpolis.app.ShipIt'
const PKZIP = "\nditto: Couldn't read pkzip signature."
const DISK_FULL_WASM =
  `${SHIPIT}/update.S3vDwnG/Termpolis.app/Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-web/dist/` +
  `ort-wasm-simd-threaded.wasm: No space left on device${PKZIP}`
const DISK_FULL_ASAR = `${SHIPIT}/update.uR4Dy5u/Termpolis.app/Contents/Resources/app.asar: No space left on device${PKZIP}`
const DISK_FULL_LOCALE =
  `${SHIPIT}/update.aGEVtm2/Termpolis.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/` +
  `mr.lproj/locale.pak: No space left on device${PKZIP}`

describe('isMissingUpdateConfigError', () => {
  it('matches the ENOENT app-update.yml shape and nothing else', () => {
    expect(isMissingUpdateConfigError(new Error(MISSING_CONFIG))).toBe(true)
    expect(isMissingUpdateConfigError(MISSING_CONFIG)).toBe(true)
    expect(isMissingUpdateConfigError(new Error('ENOENT: open other.txt'))).toBe(false)
    expect(isMissingUpdateConfigError(new Error('cannot read app-update.yml'))).toBe(false)
    expect(isMissingUpdateConfigError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isMissingUpdateConfigError(undefined)).toBe(false)
    expect(isMissingUpdateConfigError(null)).toBe(false)
  })
})

describe('isTransientNetworkError', () => {
  it.each([
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_NETWORK_IO_SUSPENDED', // #19 — the machine slept mid-check
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_TIMED_OUT',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_NETWORK_ACCESS_DENIED',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'getaddrinfo ENOTFOUND github.com',
    'getaddrinfo EAI_AGAIN github.com',
    'connect ETIMEDOUT 140.82.121.4:443',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connect ENETUNREACH',
    'connect EHOSTUNREACH',
    'connect ENETDOWN',
  ])('treats %s as transient', (msg) => {
    expect(isTransientNetworkError(new Error(msg))).toBe(true)
  })

  it('does NOT swallow genuine update failures', () => {
    expect(isTransientNetworkError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isTransientNetworkError(new Error('Unexpected token < in JSON'))).toBe(false)
    expect(isTransientNetworkError(new Error(MISSING_CONFIG))).toBe(false)
    expect(isTransientNetworkError(new Error(READ_ONLY))).toBe(false)
    // Substring-only matches must not count: the errno patterns are word-bounded.
    expect(isTransientNetworkError(new Error('SETIMEDOUTX'))).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
  })
})

describe('isReadOnlyVolumeError', () => {
  it('matches the Squirrel.Mac refusal, whatever its casing', () => {
    expect(isReadOnlyVolumeError(new Error(READ_ONLY))).toBe(true)
    expect(isReadOnlyVolumeError(READ_ONLY)).toBe(true)
    expect(isReadOnlyVolumeError(new Error('THE APPLICATION IS ON A READ-ONLY VOLUME'))).toBe(true)
  })

  it('does not match an unrelated read-only failure or a genuine error', () => {
    // A read-only *file system* on a write is a different problem and should still report.
    expect(isReadOnlyVolumeError(new Error('EROFS: read-only file system, open /x'))).toBe(false)
    expect(isReadOnlyVolumeError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isReadOnlyVolumeError(new Error(MISSING_CONFIG))).toBe(false)
    expect(isReadOnlyVolumeError(undefined)).toBe(false)
  })
})

describe('isTransientHttpServerError', () => {
  it('matches the #28 504 from GitHub, raw and as telemetry captured it', () => {
    expect(isTransientHttpServerError(new Error(GATEWAY_TIMEOUT))).toBe(true)
    expect(isTransientHttpServerError(`updater error: ${GATEWAY_TIMEOUT}`)).toBe(true)
  })

  it.each([408, 429, 500, 502, 503, 504])('treats a %i in any electron-updater shape as transient', (code) => {
    const feed = `${code} \n"method: GET url: https://github.com/o/r/releases.atom\\n\\n  Data:\\n  busy"\nHeaders: {}`
    expect(isTransientHttpServerError(new Error(feed))).toBe(true)
    expect(isTransientHttpServerError(new Error(`${code} Service Unavailable\nHeaders: {}`))).toBe(true)
    const download = `Cannot download "https://github.com/o/r/releases/download/v1/T.zip", status ${code}: `
    expect(isTransientHttpServerError(new Error(download))).toBe(true)
  })

  it('still reports a 404/403/501, and never matches a bare number', () => {
    // A missing release asset or latest.yml is a real release defect.
    const missing =
      '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest-mac.yml\\n\\n' +
      'Please double check that your authentication token is correct."\nHeaders: {}'
    expect(isTransientHttpServerError(new Error(missing))).toBe(false)
    expect(isTransientHttpServerError(new Error('403 Forbidden\nHeaders: {}'))).toBe(false)
    expect(isTransientHttpServerError(new Error('501 Not Implemented\nHeaders: {}'))).toBe(false)
    expect(isTransientHttpServerError(new Error('Cannot download "https://x/y.zip", status 404: Not Found'))).toBe(false)
    // Not electron-updater's shape: a status alone, a longer number, a number mid-sentence.
    expect(isTransientHttpServerError(new Error('504 Gateway Timeout'))).toBe(false)
    expect(isTransientHttpServerError(new Error('5040 \nHeaders: {}'))).toBe(false)
    expect(isTransientHttpServerError(new Error('sha512 mismatch after 503 bytes\nHeaders: {}'))).toBe(false)
    expect(isTransientHttpServerError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isTransientHttpServerError(undefined)).toBe(false)
  })

  it('reads the status off the first line, never out of the quoted body', () => {
    // A 403 whose body quotes an upstream 503 is still a 403, and still reports.
    const forbidden =
      '403 \n"method: GET url: https://github.com/o/r/releases.atom\\n\\n  Data:\\n  upstream said: 503 Service Unavailable"' +
      '\nHeaders: {}'
    expect(isTransientHttpServerError(new Error(forbidden))).toBe(false)
    expect(isTransientHttpServerError(`updater error: ${forbidden}`)).toBe(false)
    expect(shouldDropSentryEvent({ message: `updater error: ${forbidden}` })).toBe(false)
  })
})

describe('isDiskFullError', () => {
  it.each([
    ['#29', DISK_FULL_WASM],
    ['#30', DISK_FULL_ASAR],
    ['#31', DISK_FULL_LOCALE],
  ])('matches the Squirrel.Mac ditto failure from %s', (_issue, msg) => {
    expect(isDiskFullError(new Error(msg))).toBe(true)
    expect(isDiskFullError(msg)).toBe(true)
  })

  it("matches Node's ENOSPC (Windows / Linux)", () => {
    expect(isDiskFullError(new Error('ENOSPC: no space left on device, write'))).toBe(true)
    expect(isDiskFullError(new Error('ENOSPC'))).toBe(true)
  })

  it('does not match a corrupt download or any other genuine failure', () => {
    // Without the out-of-space cause, a bad zip is a real defect and must still report.
    expect(isDiskFullError(new Error("ditto: Couldn't read pkzip signature."))).toBe(false)
    expect(isDiskFullError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isDiskFullError(new Error('XENOSPCX'))).toBe(false)
    expect(isDiskFullError(undefined)).toBe(false)
  })

  it("ignores what the server's response says: a 507 is the server's disk, not the user's", () => {
    const insufficientStorage =
      '507 \n"method: GET url: https://github.com/o/r/releases/download/v1/T.zip\\n\\n  Data:\\n  No space left on device"' +
      '\nHeaders: {}'
    expect(isDiskFullError(new Error(insufficientStorage))).toBe(false)
    expect(isDiskFullError(new Error('500 \nHeaders: {\n  "x-error": "ENOSPC"\n}'))).toBe(false)
    // Not ours to explain away either: it still reports.
    expect(shouldDropSentryEvent({ message: `updater error: ${insufficientStorage}` })).toBe(false)
  })
})

describe('isBenignUpdaterError', () => {
  it('is the union of the four, and only those four', () => {
    expect(isBenignUpdaterError(new Error(READ_ONLY))).toBe(true)
    expect(isBenignUpdaterError(new Error(MISSING_CONFIG))).toBe(true)
    expect(isBenignUpdaterError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isBenignUpdaterError(new Error(GATEWAY_TIMEOUT))).toBe(true)
    expect(isBenignUpdaterError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isBenignUpdaterError(new Error('New version signature is invalid'))).toBe(false)
    expect(isBenignUpdaterError(undefined)).toBe(false)
  })

  it('leaves a full disk OUT: an update is pending and only the user can free the space', () => {
    expect(isBenignUpdaterError(new Error(DISK_FULL_ASAR))).toBe(false)
    expect(isBenignUpdaterError(new Error('ENOSPC: no space left on device, write'))).toBe(false)
  })
})

describe('shouldDropSentryEvent — the second reporting path (#22)', () => {
  it('drops the captureMessage form telemetry produces', () => {
    expect(shouldDropSentryEvent({ message: `updater error: ${READ_ONLY}` })).toBe(true)
    expect(shouldDropSentryEvent({ message: 'updater error: net::ERR_INTERNET_DISCONNECTED' })).toBe(true)
    expect(shouldDropSentryEvent({ message: `updater error: ${GATEWAY_TIMEOUT}` })).toBe(true) // #28
  })

  it("drops the updater's full disk (#29/#30/#31) by either path — and no other ENOSPC", () => {
    for (const msg of [DISK_FULL_WASM, DISK_FULL_ASAR, DISK_FULL_LOCALE]) {
      expect(shouldDropSentryEvent({ message: `updater error: ${msg}` })).toBe(true)
      expect(shouldDropSentryEvent({ exception: { values: [{ type: 'Error', value: msg }] } })).toBe(true)
    }
    expect(shouldDropSentryEvent({ message: 'updater error: ENOSPC: no space left on device, write' })).toBe(true)
    expect(shouldDropSentryEvent({ message: 'ShipIt: No space left on device' })).toBe(true)
    // A full disk hitting anything else in the main process is not the updater's to mute.
    expect(shouldDropSentryEvent({ message: 'ENOSPC: no space left on device, write' })).toBe(false)
    expect(
      shouldDropSentryEvent({
        exception: { values: [{ type: 'Error', value: "ENOSPC: no space left on device, open '/x/memory.jsonl'" }] },
      }),
    ).toBe(false)
  })

  it('drops the raw exception form Sentry captures on its own', () => {
    expect(
      shouldDropSentryEvent({ exception: { values: [{ type: 'Error', value: READ_ONLY }] } }),
    ).toBe(true)
  })

  it('drops it even when the benign error is a chained/inner exception', () => {
    expect(
      shouldDropSentryEvent({
        exception: {
          values: [
            { type: 'Error', value: 'update failed' },
            { type: 'Error', value: READ_ONLY },
          ],
        },
      }),
    ).toBe(true)
  })

  it('KEEPS a genuine crash — the filter must never become a mute button', () => {
    expect(shouldDropSentryEvent({ message: 'updater error: sha512 checksum mismatch' })).toBe(false)
    expect(
      shouldDropSentryEvent({
        exception: { values: [{ type: 'TypeError', value: "Cannot read properties of undefined" }] },
      }),
    ).toBe(false)
    expect(shouldDropSentryEvent({ message: 'UncleanExit: previous session ended without a clean exit' })).toBe(false)
  })

  it('survives every malformed event shape without throwing', () => {
    for (const bad of [null, undefined, 'a string', 42, [], {}, { message: 123 }, { message: '' }]) {
      expect(shouldDropSentryEvent(bad)).toBe(false)
    }
    expect(shouldDropSentryEvent({ exception: {} })).toBe(false)
    expect(shouldDropSentryEvent({ exception: { values: null } })).toBe(false)
    expect(shouldDropSentryEvent({ exception: { values: [null, undefined] } })).toBe(false)
    expect(shouldDropSentryEvent({ exception: { values: [{ value: 7 }] } })).toBe(false)
  })
})

describe('withoutResponseHeaders', () => {
  it('cuts the #28 header dump — cookies, dates, request ids — and keeps what failed, where', () => {
    const out = withoutResponseHeaders(GATEWAY_TIMEOUT)
    expect(out).toBe(GATEWAY_TIMEOUT.slice(0, GATEWAY_TIMEOUT.indexOf('\nHeaders: ')))
    expect(out).not.toMatch(/Headers:|set-cookie|_gh_sess|x-github-request-id|GMT/)
    expect(out).toMatch(/^504 \n"method: GET url: https:\/\/github\.com\/codedev-david\/termpolis\/releases\.atom/)
  })

  it('leaves every other message exactly as it was', () => {
    for (const msg of ['sha512 checksum mismatch', READ_ONLY, DISK_FULL_ASAR, '', 'Headers: only at the start']) {
      expect(withoutResponseHeaders(msg)).toBe(msg)
    }
  })
})

describe('scrubUpdaterText', () => {
  it("drops the #28 header dump and writes the #29–#31 user's home as ~", () => {
    expect(scrubUpdaterText(GATEWAY_TIMEOUT, '/Users/x')).toBe(withoutResponseHeaders(GATEWAY_TIMEOUT))
    expect(scrubUpdaterText(DISK_FULL_ASAR, '/Users/x')).toBe(
      'ditto: ~/Library/Caches/com.termpolis.app.ShipIt/update.uR4Dy5u/Termpolis.app/Contents/Resources/app.asar: ' +
        `No space left on device${PKZIP}`,
    )
  })

  it('finds a Windows home by either separator and in any case', () => {
    const home = 'C:\\Users\\Jo'
    expect(scrubUpdaterText("EPERM: rename 'C:\\Users\\Jo\\AppData\\Local\\termpolis-updater\\pending\\a.exe'", home)).toBe(
      "EPERM: rename '~\\AppData\\Local\\termpolis-updater\\pending\\a.exe'",
    )
    expect(scrubUpdaterText('file:///c:/users/jo/AppData/x and C:\\Users\\JO', home)).toBe('file:///~/AppData/x and ~')
  })

  it('never cuts into a longer name, and takes a trailing separator in its stride', () => {
    const others = '/Users/xavier/a and /Users/x.old/b and /Users/x-2/c'
    expect(scrubUpdaterText(others, '/Users/x')).toBe(others)
    expect(scrubUpdaterText('/Users/x/a', '/Users/x/')).toBe('~/a')
  })

  it('matches a home that looks like a regex literally', () => {
    expect(scrubUpdaterText('/home/a+b (c)/x and /home/aab (c)/x', '/home/a+b (c)')).toBe('~/x and /home/aab (c)/x')
  })

  it('scrubs no home at all when there is no usable one', () => {
    for (const home of ['', '/', 'C:', 'C:\\']) {
      expect(scrubUpdaterText('/Users/x/a C:\\b', home)).toBe('/Users/x/a C:\\b')
    }
  })

  it("defaults to this machine's home, and a home that can't be found is not an error", () => {
    const text = `ditto: ${homedir()}/Library/Caches: No space left on device`
    expect(scrubUpdaterText(text)).toBe('ditto: ~/Library/Caches: No space left on device')
    vi.mocked(homedir).mockImplementationOnce(() => {
      throw new Error('ENOENT: no such file or directory, uv_os_homedir')
    })
    expect(scrubUpdaterText(text)).toBe(text)
  })
})
