// Every pattern here exists because a real Sentry issue was filed for something that was never a
// Termpolis defect. The strings below are the ACTUAL text Sentry received — if a regex stops
// matching one of them, that issue comes back.
import { describe, it, expect } from 'vitest'
import {
  isMissingUpdateConfigError,
  isTransientNetworkError,
  isReadOnlyVolumeError,
  isBenignUpdaterError,
  shouldDropSentryEvent,
} from '../../src/main/updaterErrors'

/** Verbatim from GitHub #21/#22 (Sentry ELECTRON-E/F). */
const READ_ONLY =
  'Cannot update while running on a read-only volume. The application is on a read-only volume. ' +
  "Please move the application and try again. If you're on macOS Sierra or later, you'll need to " +
  'move the application out of the Downloads directory.'

/** Verbatim from GitHub #14 (Sentry ELECTRON-8). */
const MISSING_CONFIG =
  "ENOENT: no such file or directory, open " +
  "'C:\\Users\\x\\AppData\\Local\\Programs\\termpolis\\resources\\app-update.yml'"

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

describe('isBenignUpdaterError', () => {
  it('is the union of the three, and only those three', () => {
    expect(isBenignUpdaterError(new Error(READ_ONLY))).toBe(true)
    expect(isBenignUpdaterError(new Error(MISSING_CONFIG))).toBe(true)
    expect(isBenignUpdaterError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isBenignUpdaterError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(isBenignUpdaterError(new Error('New version signature is invalid'))).toBe(false)
    expect(isBenignUpdaterError(undefined)).toBe(false)
  })
})

describe('shouldDropSentryEvent — the second reporting path (#22)', () => {
  it('drops the captureMessage form telemetry produces', () => {
    expect(shouldDropSentryEvent({ message: `updater error: ${READ_ONLY}` })).toBe(true)
    expect(shouldDropSentryEvent({ message: 'updater error: net::ERR_INTERNET_DISCONNECTED' })).toBe(true)
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
