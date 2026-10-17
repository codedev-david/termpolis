import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir, tmpdir } from 'os'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UpdaterHost } from '../../src/main/autoUpdater'
import { MOVE_FAILED_DIALOG, MOVE_OFFER_DIALOG, updateBlockerHint } from '../../src/main/updaterLocation'
import { DISK_FULL_MESSAGE, NO_UPDATE_FEED_MESSAGE, UPDATE_SERVER_UNREACHABLE_MESSAGE } from '../../src/main/updaterErrors'
import { NO_NEW_PRIVS_UPDATE_MESSAGE } from '../../src/main/autoUpdater'
import { hasNoNewPrivs } from '../../src/main/noNewPrivs'
import {
  DEB_BUSY_MESSAGE,
  DEB_CANCELLED_MESSAGE,
  DEB_NOT_STARTED_LEAD,
  DEB_RESULT_FILE,
  debManualInstallMessage,
  type DebInstallStart,
} from '../../src/main/debUpdate'

// Capture event handlers + IPC handlers registered by initAutoUpdater
const eventHandlers: Record<string, Function> = {}
const ipcHandlers = new Map<string, Function>()

const mockAutoUpdater = {
  on: vi.fn((event: string, handler: Function) => {
    eventHandlers[event] = handler
  }),
  checkForUpdates: vi.fn((): Promise<unknown> => Promise.resolve()),
  quitAndInstall: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  logger: null as null | Record<'info' | 'warn' | 'error' | 'debug', (message?: unknown) => void>,
}

// One `app` for every fresh copy of the module, so a test can give it the macOS-only methods.
const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true, // skip the dev-mode short-circuit
  } as Record<string, unknown>,
  showMessageBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: electron.app,
  dialog: { showMessageBox: (...args: unknown[]) => electron.showMessageBox(...args) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler)
    }),
  },
}))

// Mock telemetry — autoUpdater forwards events here.
const mockRecordUpdaterEvent = vi.fn()
vi.mock('../../src/main/telemetry', () => ({
  recordUpdaterEvent: (...args: any[]) => mockRecordUpdaterEvent(...args),
}))

/** Verbatim from GitHub #21/#22 (Sentry ELECTRON-E/F): Squirrel.Mac's refusal. */
const READ_ONLY =
  'Cannot update while running on a read-only volume. The application is on a read-only volume. ' +
  "Please move the application and try again. If you're on macOS Sierra or later, you'll need to " +
  'move the application out of the Downloads directory.'

const missingConfigErr = () =>
  new Error(
    "ENOENT: no such file or directory, open " +
      "'C:\\Users\\x\\AppData\\Local\\Programs\\termpolis\\resources\\app-update.yml'",
  )

// #28: GitHub's edge timed out serving releases.atom. Transient — the next check retries.
const gatewayTimeout = () =>
  new Error(
    '504 \n"method: GET url: https://github.com/codedev-david/termpolis/releases.atom\\n\\n          Data:\\n' +
      '          <html><body><h1>504 Gateway Time-out</h1>\\n</body></html>\\n\\n          "\n' +
      'Headers: {\n  "set-cookie": [\n    "_gh_sess=<elided>; path=/"\n  ]\n}',
  )
// #30: Squirrel.Mac ran out of disk while unpacking the downloaded update.
const diskFull = () =>
  new Error(
    'ditto: /Users/x/Library/Caches/com.termpolis.app.ShipIt/update.uR4Dy5u/Termpolis.app/Contents/Resources/app.asar: ' +
      "No space left on device\nditto: Couldn't read pkzip signature.",
  )

// Deterministic whatever OS runs the suite: no macOS location check, no Move offer. An AppImage,
// which installs through electron-updater's quitAndInstall as macOS and Windows do.
// The .deb pieces are pinned too, for every test that switches to a .deb: a CI container can run
// the suite with no_new_privs set, and nothing here may ever start the real install runner (it
// would wait for the test runner to exit, ask for the administrator password, then start it
// again), quit the test runner, or read the real userData.
const LINUX_HOST: Partial<UpdaterHost> = {
  platform: 'linux',
  exePath: '/opt/Termpolis/termpolis',
  appImage: true,
  noNewPrivs: () => false,
  installDeb: () => ({ started: false, message: 'a test reached the .deb install' }),
  takeDebNotice: () => null,
  debInstallerRunning: () => false,
  quit: () => {},
}
/** The .deb, Termpolis's Linux system package (debUpdate.ts). */
const DEB_HOST: Partial<UpdaterHost> = { ...LINUX_HOST, appImage: false }
const DEB = '/home/d/.cache/termpolis-updater/pending/termpolis_9.9.9_amd64.deb'

/** A fresh copy of the module, wired to the fake updater, on the host a test picks. */
async function freshAutoUpdater(host: Partial<UpdaterHost> = LINUX_HOST) {
  vi.resetModules()
  for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
  ipcHandlers.clear()
  // vi.mock can't intercept lazy require() inside the SUT, so we inject the
  // fake autoUpdater via __setUpdaterProviderForTests instead.
  const mod = await import('../../src/main/autoUpdater')
  mod.__setUpdaterProviderForTests(() => mockAutoUpdater)
  mod.__setUpdaterHostForTests(host)
  return mod
}

async function loadAutoUpdater(opts?: { onBeforeQuitAndInstall?: (armed?: boolean) => void }) {
  const mod = await freshAutoUpdater()
  const fakeWindow = { webContents: { send: vi.fn() } } as any
  mod.initAutoUpdater(() => fakeWindow, opts)
  return { fakeWindow, mod }
}

/** Every unhandled rejection raised while `run` runs and the event loop turns once more. */
async function unhandledRejectionsDuring(run: () => unknown): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}

beforeEach(() => {
  // Vitest defaults NODE_ENV to 'test', which the updater treats as a
  // skip signal. Force a non-test value so event listeners get registered.
  process.env.NODE_ENV = 'production'
  delete process.env.TERMPOLIS_SKIP_UPDATER
  mockRecordUpdaterEvent.mockReset()
  mockAutoUpdater.on.mockClear()
  mockAutoUpdater.checkForUpdates.mockClear()
  electron.showMessageBox.mockReset()
})

describe('updater:quit-and-install — agents-running close guard bypass', () => {
  it('arms the bypass BEFORE quitAndInstall fires, so the close guard cannot interject', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const calls: string[] = []
    mockAutoUpdater.quitAndInstall.mockImplementation(() => calls.push('quitAndInstall'))
    const onBefore = vi.fn(() => calls.push('bypass'))
    await loadAutoUpdater({ onBeforeQuitAndInstall: onBefore })
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    const res = ipcHandlers.get('updater:quit-and-install')!()
    expect(res).toEqual({ success: true })
    expect(onBefore).toHaveBeenCalledTimes(1)
    expect(onBefore).toHaveBeenCalledWith(true)
    expect(calls).toEqual(['bypass', 'quitAndInstall']) // bypass armed first
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('does not arm the bypass (or quit) when no update is ready', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const onBefore = vi.fn()
    await loadAutoUpdater({ onBeforeQuitAndInstall: onBefore })
    const res = ipcHandlers.get('updater:quit-and-install')!()
    expect(res).toEqual({ success: false, error: 'no update ready' })
    expect(onBefore).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('still installs when the bypass hook itself throws', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    await loadAutoUpdater({ onBeforeQuitAndInstall: () => { throw new Error('boom') } })
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    const res = ipcHandlers.get('updater:quit-and-install')!()
    expect(res).toEqual({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('lets the guard guard again when the quit "Restart" asked for is not coming', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const onBefore = vi.fn()
    await loadAutoUpdater({ onBeforeQuitAndInstall: onBefore })
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
    // Squirrel.Mac hadn't unpacked it yet, and now it can't: the quit it was waiting for never comes.
    eventHandlers['error']?.(diskFull())
    eventHandlers['error']?.(diskFull())
    expect(onBefore.mock.calls).toEqual([[true], [false]])
  })

  it('disarms the bypass when quitAndInstall throws', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("No update available, can't quit and install")
    })
    const onBefore = vi.fn()
    await loadAutoUpdater({ onBeforeQuitAndInstall: onBefore })
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({
      success: false,
      error: "No update available, can't quit and install",
    })
    expect(onBefore.mock.calls).toEqual([[true], [false]])
  })

  it('leaves the guard alone on an error when no restart is pending', async () => {
    const onBefore = vi.fn()
    await loadAutoUpdater({ onBeforeQuitAndInstall: onBefore })
    eventHandlers['error']?.(new Error('sha512 checksum mismatch'))
    expect(onBefore).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdater event forwarding', () => {
  it('forwards checking-for-update to recordUpdaterEvent', async () => {
    await loadAutoUpdater()
    eventHandlers['checking-for-update']?.()
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({ status: 'checking' })
  })

  it('forwards update-available with version', async () => {
    await loadAutoUpdater()
    eventHandlers['update-available']?.({ version: '1.2.3', releaseNotes: 'notes' })
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'available',
      version: '1.2.3',
    })
  })

  it('forwards update-not-available', async () => {
    await loadAutoUpdater()
    eventHandlers['update-not-available']?.({ version: '1.2.3' })
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'not-available',
      version: '1.2.3',
    })
  })

  it('forwards download-progress with byte counts', async () => {
    await loadAutoUpdater()
    // First need to set version via update-available so currentState carries it
    eventHandlers['update-available']?.({ version: '1.2.3' })
    mockRecordUpdaterEvent.mockReset()
    eventHandlers['download-progress']?.({ transferred: 100, total: 1000 })
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'downloading',
      version: '1.2.3',
      downloadedBytes: 100,
      totalBytes: 1000,
    })
  })

  it('forwards update-downloaded with version', async () => {
    await loadAutoUpdater()
    eventHandlers['update-downloaded']?.({ version: '1.2.3', releaseNotes: 'changes' })
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'downloaded',
      version: '1.2.3',
    })
  })

  it('forwards error events with the message', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(new Error('sha512 mismatch'))
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'error',
      error: 'sha512 mismatch',
    })
  })

  it('skips forwarding when telemetry throws (must not crash updater)', async () => {
    await loadAutoUpdater()
    mockRecordUpdaterEvent.mockImplementationOnce(() => {
      throw new Error('telemetry blew up')
    })
    expect(() => eventHandlers['checking-for-update']?.()).not.toThrow()
  })

  it('also sends state to the renderer (regression: telemetry must not displace IPC)', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['update-available']?.({ version: '2.0.0' })
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith(
      'updater:state',
      expect.objectContaining({ status: 'available', version: '2.0.0' })
    )
  })
})

describe('initAutoUpdater — missing app-update.yml is benign (Sentry ELECTRON-8)', () => {
  it('does NOT report a missing-config ENOENT as a production error', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(missingConfigErr())
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    )
  })

  it('leaves the state where it was on a missing-config ENOENT, and records nothing', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(missingConfigErr())
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', { status: 'idle' })
  })

  it('still reports genuine updater errors (sha512 mismatch) to telemetry', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(new Error('sha512 checksum mismatch'))
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'error',
      error: 'sha512 checksum mismatch',
    })
  })

  it('isMissingUpdateConfigError matches only the ENOENT app-update.yml shape', async () => {
    vi.resetModules()
    const mod = await import('../../src/main/autoUpdater')
    expect(mod.isMissingUpdateConfigError(missingConfigErr())).toBe(true)
    expect(mod.isMissingUpdateConfigError(new Error('ENOENT: open other.txt'))).toBe(false)
    expect(mod.isMissingUpdateConfigError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(mod.isMissingUpdateConfigError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(mod.isMissingUpdateConfigError(undefined)).toBe(false)
  })

  it('goes back to where it was when offline: no error, nothing recorded, the next check retries', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['update-not-available']?.({ version: '1.2.3' })
    eventHandlers['checking-for-update']?.()
    mockRecordUpdaterEvent.mockReset()
    eventHandlers['error']?.(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'not-available',
      version: '1.2.3',
    })
    expect(await ipcHandlers.get('updater:status')!()).toEqual({ status: 'not-available', version: '1.2.3' })
  })

  it.each([
    'getaddrinfo ENOTFOUND github.com',
    'getaddrinfo EAI_AGAIN github.com',
    'read ECONNRESET',
    'connect ECONNREFUSED 140.82.121.4:443',
    'connect ETIMEDOUT 140.82.121.4:443',
    'connect ENETUNREACH',
    'connect EHOSTUNREACH',
    'socket hang up',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_SOCKET_NOT_CONNECTED', // GitHub #37
    '429 Too Many Requests\nHeaders: {}',
    '503 \n"method: GET url: https://github.com/o/r/releases.atom"\nHeaders: {}',
  ])('shows no error and reports nothing for %j', async (message) => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(new Error(message))
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'idle' })
  })

  it('isTransientNetworkError matches connectivity failures but not genuine errors', async () => {
    vi.resetModules()
    const mod = await import('../../src/main/autoUpdater')
    for (const m of [
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NETWORK_IO_SUSPENDED', // GitHub #19 — machine slept mid update-check
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_TIMED_OUT',
      'getaddrinfo ENOTFOUND github.com',
      'connect ETIMEDOUT 140.82.121.4:443',
      'read ECONNRESET',
    ]) {
      expect(mod.isTransientNetworkError(new Error(m)), m).toBe(true)
    }
    // Genuine, actionable errors must still report — never suppressed.
    expect(mod.isTransientNetworkError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(mod.isTransientNetworkError(missingConfigErr())).toBe(false)
    expect(mod.isTransientNetworkError(new Error('Unexpected token < in JSON'))).toBe(false)
    expect(mod.isTransientNetworkError(undefined)).toBe(false)
  })

  it('turns a read-only volume refusal (macOS .dmg) into one plain hint, never a report', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(new Error(READ_ONLY))
    // Never recorded: an 'error' is what telemetry.ts turns into a Sentry
    // captureMessage, which is how one launch filed BOTH #21 and #22.
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'error',
      error: updateBlockerHint('read-only'),
      reason: 'read-only-location',
    })
  })

  it('isReadOnlyVolumeError matches the Squirrel refusal but not genuine errors', async () => {
    vi.resetModules()
    const mod = await import('../../src/main/autoUpdater')
    expect(mod.isReadOnlyVolumeError(new Error('Cannot update while running on a read-only volume.'))).toBe(true)
    // Squirrel's own casing varies across versions; the match is case-insensitive.
    expect(mod.isReadOnlyVolumeError(new Error('The application is on a READ-ONLY VOLUME'))).toBe(true)
    expect(mod.isReadOnlyVolumeError('Cannot update while running on a read-only volume')).toBe(true)
    expect(mod.isReadOnlyVolumeError(new Error('sha512 checksum mismatch'))).toBe(false)
    expect(mod.isReadOnlyVolumeError(new Error('EROFS: read-only file system, open'))).toBe(false)
    expect(mod.isReadOnlyVolumeError(missingConfigErr())).toBe(false)
    expect(mod.isReadOnlyVolumeError(undefined)).toBe(false)
  })

  it('skips scheduling periodic checks when app-update.yml is absent, but keeps an error listener', async () => {
    mockAutoUpdater.on.mockClear()
    const mod = await freshAutoUpdater()
    mod.__setUpdateConfigExistsForTests(() => false)
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    // The error listener MUST still be registered so a manual updater:check
    // (or any stray emit) can't crash the process with an unhandled 'error'.
    expect(typeof eventHandlers['error']).toBe('function')
    // ...but no pointless periodic checks are scheduled.
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  it('schedules periodic checks when app-update.yml is present', async () => {
    const mod = await freshAutoUpdater()
    mod.__setUpdateConfigExistsForTests(() => true)
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    expect(setIntervalSpy).toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})

describe('initAutoUpdater — a GitHub 5xx and a full disk (Sentry ELECTRON-Y, ELECTRON-Z/10/11)', () => {
  it('treats a 504 from GitHub as if the check never happened: no error, nothing recorded', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(gatewayTimeout())
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', { status: 'idle' })
  })

  it('does not stand down for a read-only volume that only the quoted release notes mention', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    // GitHubProvider quotes the whole releases feed after a failed /releases/latest request.
    eventHandlers['error']?.(
      new Error(
        'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), ' +
          'please ensure a production release exists: HttpError: 503 \nHeaders: {}\n    at createHttpError (x.js:1:1),\n' +
          `XML:\n<feed><entry><content type="html">No more reports of: ${READ_ONLY}</content></entry></feed>`,
      ),
    )
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', { status: 'idle' })
    // Still checking: a Windows or Linux copy has no Applications folder to be moved into.
    mockAutoUpdater.checkForUpdates.mockClear()
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: true })
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('keeps a downloaded update ready to install when a later check fails through nobody’s fault', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    eventHandlers['checking-for-update']?.()
    eventHandlers['error']?.(new Error('read ECONNRESET'))
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'downloaded', version: '9.9.9' })
    // 'downloaded' and 'checking' were recorded; going back to 'downloaded' is not news.
    expect(mockRecordUpdaterEvent).toHaveBeenCalledTimes(2)
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('does not bring "Restart" back for an update that a newer, failed download replaced', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    eventHandlers['checking-for-update']?.()
    eventHandlers['update-available']?.({ version: '9.9.10' })
    eventHandlers['download-progress']?.({ transferred: 1, total: 10 })
    // electron-updater empties its cache when a download fails: 9.9.9's installer is gone with it.
    eventHandlers['error']?.(new Error('read ECONNRESET'))
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'idle' })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: 'no update ready' })
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('tells the user their disk is full, without reporting it at all', async () => {
    const { fakeWindow, mod } = await loadAutoUpdater()
    // On macOS Squirrel fails right AFTER electron-updater announced the download.
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    mockRecordUpdaterEvent.mockReset()
    eventHandlers['error']?.(diskFull())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'error',
      error: mod.DISK_FULL_MESSAGE,
      reason: 'disk-full',
    })
    expect(mod.DISK_FULL_MESSAGE).toMatch(/^Not enough free disk space to download the update/)
    // The user's own full disk is nothing to report — not even as a breadcrumb (#29/#30/#31).
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    // Squirrel never staged it, so there is nothing to restart into.
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: 'no update ready' })
  })

  it("treats Node's ENOSPC (Windows / Linux download) the same way", async () => {
    const { fakeWindow, mod } = await loadAutoUpdater()
    eventHandlers['error']?.(new Error('ENOSPC: no space left on device, write'))
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'error',
      error: mod.DISK_FULL_MESSAGE,
      reason: 'disk-full',
    })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
  })

  it('still reports a genuine HTTP failure (a 404), minus the response-header dump', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(
      new Error(
        '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest-mac.yml"\n' +
          'Headers: {\n  "set-cookie": [\n    "_gh_sess=<elided>; path=/"\n  ]\n}',
      ),
    )
    const error = '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest-mac.yml"'
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({ status: 'error', error })
    // A genuine failure is no hint: no reason, so the banner stays out of it.
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'error', error })
  })

  it('a failed manual check says why in plain words — or, when genuine, in its own scrubbed words', async () => {
    await loadAutoUpdater()
    const check = async (err: Error) => {
      mockAutoUpdater.checkForUpdates.mockImplementationOnce(() => Promise.reject(err))
      return ipcHandlers.get('updater:check')!()
    }
    expect(await check(gatewayTimeout())).toEqual({ success: false, error: UPDATE_SERVER_UNREACHABLE_MESSAGE })
    expect(await check(new Error('net::ERR_INTERNET_DISCONNECTED'))).toEqual({
      success: false,
      error: UPDATE_SERVER_UNREACHABLE_MESSAGE,
    })
    expect(await check(missingConfigErr())).toEqual({ success: false, error: NO_UPDATE_FEED_MESSAGE })
    expect(await check(diskFull())).toEqual({ success: false, error: DISK_FULL_MESSAGE })
    expect(await check(new Error(READ_ONLY))).toEqual({ success: false, error: updateBlockerHint('read-only') })
    const notFound = new Error(
      '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest.yml"\nHeaders: {\n  "set-cookie": "_gh_sess=x"\n}',
    )
    expect(await check(notFound)).toEqual({
      success: false,
      error: '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest.yml"',
    })
  })

  it('re-exports the new predicates alongside the old ones', async () => {
    vi.resetModules()
    const mod = await import('../../src/main/autoUpdater')
    expect(mod.isTransientHttpServerError(gatewayTimeout())).toBe(true)
    expect(mod.isBenignUpdaterError(gatewayTimeout())).toBe(true)
    expect(mod.isDiskFullError(diskFull())).toBe(true)
    expect(mod.isBenignUpdaterError(diskFull())).toBe(false)
    expect(mod.classifyUpdaterError(diskFull())).toBe('disk-full')
    expect(mod.classifyUpdaterError(gatewayTimeout())).toBe('transient')
    expect(mod.DISK_FULL_MESSAGE).toBe(DISK_FULL_MESSAGE)
    expect(mod.UPDATE_SERVER_UNREACHABLE_MESSAGE).toBe(UPDATE_SERVER_UNREACHABLE_MESSAGE)
    expect(mod.NO_UPDATE_FEED_MESSAGE).toBe(NO_UPDATE_FEED_MESSAGE)
  })

  it('a reported failure names no home directory, and neither does a failed manual check', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(new Error(`EPERM: operation not permitted, rename '${homedir()}/AppData/Local/u/a.exe'`))
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'error',
      error: "EPERM: operation not permitted, rename '~/AppData/Local/u/a.exe'",
    })
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(() =>
      Promise.reject(new Error(`EACCES: permission denied, open '${homedir()}/Library/Caches/u/update-info.json'`)),
    )
    expect(await ipcHandlers.get('updater:check')!()).toEqual({
      success: false,
      error: "EACCES: permission denied, open '~/Library/Caches/u/update-info.json'",
    })
  })
})

describe('initAutoUpdater — a failure is news of its own attempt, never where to go back to (the stale error banner)', () => {
  const DISK_FULL_HINT = { status: 'error', error: DISK_FULL_MESSAGE, reason: 'disk-full' }
  const noSpace = () => new Error('ENOSPC: no space left on device, write')

  it.each<[string, () => Error]>([
    ['offline', () => new Error('net::ERR_INTERNET_DISCONNECTED')],
    ['GitHub timing out', gatewayTimeout],
    ['no app-update.yml', missingConfigErr],
  ])('does not bring a full-disk hint back when the next check fails through nobody’s fault (%s)', async (_why, failure) => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['update-available']?.({ version: '9.9.9' })
    eventHandlers['download-progress']?.({ transferred: 1, total: 10 })
    eventHandlers['error']?.(noSpace())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', DISK_FULL_HINT)
    // The user frees some space. Four hours later the next check never gets an answer.
    eventHandlers['checking-for-update']?.()
    mockRecordUpdaterEvent.mockReset()
    eventHandlers['error']?.(failure())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'idle' })
    expect(await ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle' })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
  })

  it('does not bring back, or report again, a genuine failure from an earlier check', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['checking-for-update']?.()
    eventHandlers['error']?.(new Error('sha512 checksum mismatch'))
    eventHandlers['checking-for-update']?.()
    mockRecordUpdaterEvent.mockReset()
    eventHandlers['error']?.(new Error('read ECONNRESET'))
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'idle' })
    expect(await ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle' })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
  })

  it('brings back neither the hint nor "Restart" for an update Squirrel could not unpack', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    const { fakeWindow } = await loadAutoUpdater()
    // macOS: the disk fills up while Squirrel unpacks what electron-updater downloaded (#29–#31).
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    eventHandlers['error']?.(diskFull())
    eventHandlers['checking-for-update']?.()
    eventHandlers['error']?.(gatewayTimeout())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', { status: 'idle' })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: 'no update ready' })
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it.each<[string, string, unknown, Record<string, unknown>]>([
    ['a later check starts', 'checking-for-update', undefined, { status: 'checking' }],
    ['a check finds nothing newer', 'update-not-available', { version: '1.2.3' }, { status: 'not-available', version: '1.2.3' }],
    ['a check finds the update', 'update-available', { version: '9.9.9' }, { status: 'available', version: '9.9.9' }],
    ['the download resumes', 'download-progress', { transferred: 5, total: 10 }, { status: 'downloading', downloadedBytes: 5, totalBytes: 10 }],
    ['the update arrives', 'update-downloaded', { version: '9.9.9' }, { status: 'downloaded', version: '9.9.9' }],
  ])('clears a failure as soon as %s', async (_when, event, info, next) => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(noSpace())
    eventHandlers[event]?.(info)
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', next)
    expect(await ipcHandlers.get('updater:status')!()).toEqual(next)
  })

  it('still shows a full disk that the next attempt runs into again', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(noSpace())
    eventHandlers['checking-for-update']?.()
    eventHandlers['update-available']?.({ version: '9.9.9' })
    eventHandlers['download-progress']?.({ transferred: 1, total: 10 })
    eventHandlers['error']?.(noSpace())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', DISK_FULL_HINT)
    expect(await ipcHandlers.get('updater:status')!()).toEqual(DISK_FULL_HINT)
  })

  it('starts every launch clean: nothing about a failure in the last run is kept', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(noSpace())
    expect(await ipcHandlers.get('updater:status')!()).toEqual(DISK_FULL_HINT)
    // Relaunched, or relaunched into the update: a new main process.
    const { fakeWindow } = await loadAutoUpdater()
    expect(await ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle' })
    expect(fakeWindow.webContents.send).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdater — nothing leaks: download rejections, cookies and home paths in the log', () => {
  // A download that dies on a full disk: electron-updater emits 'error' AND rejects the
  // downloadPromise that checkForUpdates() resolved with.
  const checkThatStartsAFailingDownload = () =>
    Promise.resolve({ downloadPromise: Promise.reject(new Error('ENOSPC: no space left on device, write')) })

  it('handles the download a manual check starts, so its failure is reported once, not twice', async () => {
    await loadAutoUpdater()
    const results: unknown[] = []
    const check = async () => results.push(await ipcHandlers.get('updater:check')!())
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(checkThatStartsAFailingDownload)
    expect(await unhandledRejectionsDuring(check)).toEqual([])
    // No update, autoDownload off, or the updater inactive: nothing to handle.
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(() => Promise.resolve({ downloadPromise: null }))
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(() => Promise.resolve(null))
    await check()
    await check()
    expect(results).toEqual([{ success: true }, { success: true }, { success: true }])
  })

  it('handles the download a scheduled check starts, at launch and every 4 hours', async () => {
    const mod = await freshAutoUpdater()
    mod.__setUpdateConfigExistsForTests(() => true)
    const scheduled: Array<() => unknown> = []
    const capture = ((fn: () => unknown) => {
      scheduled.push(fn)
      return 0
    }) as never
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(capture)
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(capture)
    try {
      mod.initAutoUpdater(() => null)
    } finally {
      setTimeoutSpy.mockRestore()
      setIntervalSpy.mockRestore()
    }
    expect(scheduled).toHaveLength(2)
    for (const check of scheduled) {
      mockAutoUpdater.checkForUpdates.mockImplementationOnce(checkThatStartsAFailingDownload)
      expect(await unhandledRejectionsDuring(check)).toEqual([])
      // A failed check itself was always handled: on('error') reports it.
      mockAutoUpdater.checkForUpdates.mockImplementationOnce(() => Promise.reject(new Error('net::ERR_TIMED_OUT')))
      expect(await unhandledRejectionsDuring(check)).toEqual([])
    }
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it("scrubs electron-updater's own log: no response headers, no home directory", async () => {
    await loadAutoUpdater()
    const logger = mockAutoUpdater.logger!
    const home = homedir()
    const logged = {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    }
    try {
      // What electron-updater's on('error') logs for #28: `Error: ${error.stack || error.message}`.
      logger.error(`Error: ${gatewayTimeout().stack}`)
      // What MacUpdater logs for #29–#31: Squirrel's Error itself.
      logger.warn(new Error(`ditto: ${home}/Library/Caches/com.termpolis.app.ShipIt/u/app.asar: No space left on device`))
      logger.info(`Update has been downloaded to ${home}/Library/Caches/termpolis-updater/pending/T.zip`)
      logger.debug(`Checking for update in ${home}`)
      const stackless = new Error('stackless')
      stackless.stack = undefined
      logger.error(stackless)
      logger.info()

      const [first, second] = logged.error.mock.calls.map(([line]) => String(line))
      expect(first).toMatch(/^Error: Error: 504 \n"method: GET url: https:\/\/github\.com\/codedev-david\/termpolis\/releases\.atom/)
      expect(first).not.toMatch(/Headers:|set-cookie|_gh_sess/)
      expect(second).toBe('stackless')
      expect(String(logged.warn.mock.calls[0][0]).split('\n')[0]).toBe(
        'Error: ditto: ~/Library/Caches/com.termpolis.app.ShipIt/u/app.asar: No space left on device',
      )
      expect(logged.info.mock.calls.map(([line]) => line)).toEqual([
        'Update has been downloaded to ~/Library/Caches/termpolis-updater/pending/T.zip',
        '',
      ])
      expect(logged.debug).toHaveBeenCalledWith('Checking for update in ~')
      for (const spy of Object.values(logged)) {
        for (const [line] of spy.mock.calls) expect(String(line)).not.toContain(home)
      }
    } finally {
      for (const spy of Object.values(logged)) spy.mockRestore()
    }
  })
})

describe('initAutoUpdater on macOS — where the app runs decides whether it can update (#21/#22)', () => {
  const DMG_EXE = '/Volumes/Termpolis 1.49.0-arm64/Termpolis.app/Contents/MacOS/Termpolis'
  const TRANSLOCATED_EXE =
    '/private/var/folders/xy/abc123/T/AppTranslocation/0F1E2D3C-4B5A-6978/d/Termpolis.app/Contents/MacOS/Termpolis'
  const APPS_EXE = '/Applications/Termpolis.app/Contents/MacOS/Termpolis'
  const FOUR_HOURS = 4 * 60 * 60 * 1000
  const writable = async () => {}
  const readOnlyDisk = async () => {
    throw Object.assign(new Error('EROFS: read-only file system, access'), { code: 'EROFS' })
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  let dir: string
  let prefsFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'termpolis-autoupdater-'))
    prefsFile = join(dir, 'updater-prefs.json')
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Starts the updater on a Mac (unless the host says otherwise) and lets the location check settle. */
  async function start(
    host: Partial<UpdaterHost>,
    opts?: { onBeforeQuitAndInstall?: (armed?: boolean) => void; noWindow?: boolean },
  ) {
    const mod = await freshAutoUpdater({ platform: 'darwin', ...host })
    mod.__setUpdateConfigExistsForTests(() => true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const fakeWindow = { webContents: { send: vi.fn() } } as any
    mod.initAutoUpdater(() => (opts?.noWindow ? null : fakeWindow), opts)
    await settle()
    return { mod, fakeWindow }
  }

  /** Lets the launch-time Move offer run to its end. */
  async function runOffer() {
    await vi.advanceTimersByTimeAsync(0)
    await settle()
  }

  /** A host that can make the Move offer, with every Electron call a spy. */
  function offeringHost(overrides: Partial<UpdaterHost> = {}) {
    return {
      exePath: DMG_EXE,
      probe: readOnlyDisk,
      prefsPath: () => prefsFile,
      isInApplicationsFolder: vi.fn(() => false),
      moveToApplicationsFolder: vi.fn(() => true),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      ...overrides,
    } satisfies Partial<UpdaterHost>
  }

  it('stands down at launch when run from the disk image: one hint, no checks, nothing reported', async () => {
    const { fakeWindow } = await start({ exePath: DMG_EXE, probe: readOnlyDisk })
    const hint = { status: 'error', error: updateBlockerHint('disk-image'), reason: 'read-only-location' }
    expect(fakeWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', hint)
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3 * FOUR_HOURS)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(await ipcHandlers.get('updater:status')!()).toEqual(hint)
    // A manual check would only download the update to be refused again: it says why instead.
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: false, error: hint.error })
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('knows App Translocation from the path, without probing', async () => {
    const probe = vi.fn(writable)
    const { fakeWindow } = await start({ exePath: TRANSLOCATED_EXE, probe })
    expect(probe).not.toHaveBeenCalled()
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', {
      status: 'error',
      error: updateBlockerHint('translocated'),
      reason: 'read-only-location',
    })
    await vi.advanceTimersByTimeAsync(FOUR_HOURS)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it("says so when the user's account can't write where the app is", async () => {
    const noPermission = async () => {
      throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' })
    }
    const { fakeWindow } = await start({ exePath: APPS_EXE, probe: noPermission })
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', {
      status: 'error',
      error: updateBlockerHint('no-permission'),
      reason: 'read-only-location',
    })
  })

  it('checks as usual where it can write: shortly after launch, then every 4 hours', async () => {
    const probe = vi.fn(writable)
    const { fakeWindow } = await start({ exePath: APPS_EXE, probe })
    expect(probe).toHaveBeenCalledWith('/Applications')
    expect(fakeWindow.webContents.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FOUR_HOURS)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('stands down when Squirrel refuses after all, and stops checking', async () => {
    mockAutoUpdater.quitAndInstall.mockReset()
    // The up-front probe can't know everything: say it saw a writable disk.
    const { fakeWindow } = await start({ exePath: DMG_EXE, probe: writable })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    mockRecordUpdaterEvent.mockReset()
    // Squirrel's refusal arrives twice: its own 'error', and the download promise rejecting.
    eventHandlers['error']?.(new Error(READ_ONLY))
    eventHandlers['error']?.(new Error(READ_ONLY))
    const hint = updateBlockerHint('disk-image')
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'error',
      error: hint,
      reason: 'read-only-location',
    })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    // The 4-hourly check is gone, not just skipped.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * FOUR_HOURS)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: false, error: hint })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: 'no update ready' })
    // A later transient failure (an in-flight check) keeps the hint.
    eventHandlers['error']?.(new Error('read ECONNRESET'))
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', expect.objectContaining({ error: hint }))
  })

  it('skips a scheduled check that comes due after standing down', async () => {
    await start({ exePath: APPS_EXE, probe: writable })
    eventHandlers['error']?.(new Error(READ_ONLY))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('offers, once, at launch, to move to Applications — arming the close-guard bypass before the move', async () => {
    const calls: string[] = []
    const host = offeringHost({
      moveToApplicationsFolder: vi.fn(() => {
        calls.push('move')
        return true
      }),
    })
    const onBefore = vi.fn((armed?: boolean) => {
      calls.push(`bypass ${armed}`)
    })
    const { fakeWindow } = await start(host, { onBeforeQuitAndInstall: onBefore })
    await runOffer()
    expect(host.showMessageBox).toHaveBeenCalledWith(fakeWindow, MOVE_OFFER_DIALOG)
    expect(calls).toEqual(['bypass true', 'move'])
    expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).toEqual({ moveOffer: 'moved' })
    // The location hint still went up: a move that works relaunches from Applications anyway.
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', expect.objectContaining({ reason: 'read-only-location' }))
  })

  it('remembers "Not now" across launches', async () => {
    const first = offeringHost({ showMessageBox: vi.fn(async () => ({ response: 1 })) })
    await start(first)
    await runOffer()
    expect(first.showMessageBox).toHaveBeenCalledTimes(1)
    expect(first.moveToApplicationsFolder).not.toHaveBeenCalled()
    vi.useRealTimers()

    const next = offeringHost()
    await start(next)
    await runOffer()
    expect(next.showMessageBox).not.toHaveBeenCalled()
  })

  it('disarms the bypass when the move does not happen (the password prompt was cancelled)', async () => {
    const onBefore = vi.fn()
    await start(offeringHost({ moveToApplicationsFolder: vi.fn(() => false) }), { onBeforeQuitAndInstall: onBefore })
    await runOffer()
    expect(onBefore.mock.calls).toEqual([[true], [false]])
    expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).toEqual({ moveOffer: 'declined' })
  })

  it('tells the user how to move it by hand when the move fails, and logs why without their name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onBefore = vi.fn()
      const host = offeringHost({
        moveToApplicationsFolder: vi.fn(() => {
          throw new Error(`Failed to copy ${homedir()}/Downloads/Termpolis.app`)
        }),
      })
      const { fakeWindow } = await start(host, { onBeforeQuitAndInstall: onBefore })
      await runOffer()
      expect(onBefore.mock.calls).toEqual([[true], [false]])
      expect(host.showMessageBox).toHaveBeenLastCalledWith(fakeWindow, MOVE_FAILED_DIALOG)
      expect(warn).toHaveBeenCalledWith('[updater] Move to Applications failed: Failed to copy ~/Downloads/Termpolis.app')
      expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).toEqual({ moveOffer: 'failed' })
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['win32', 'C:\\Program Files\\Termpolis\\Termpolis.exe'],
    ['linux', '/opt/Termpolis/termpolis'],
    ['darwin', '/usr/local/bin/termpolis'],
  ] as const)('never offers on %s outside a macOS bundle (%s), and checks as usual', async (platform, exePath) => {
    const host = offeringHost({ platform, exePath })
    await start(host)
    await runOffer()
    expect(host.showMessageBox).not.toHaveBeenCalled()
    expect(host.isInApplicationsFolder).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("makes no offer where Electron can't say whether the app is in Applications", async () => {
    const host = offeringHost({ isInApplicationsFolder: undefined })
    await start(host)
    await runOffer()
    expect(host.showMessageBox).not.toHaveBeenCalled()
  })

  it('makes no offer to an app already in Applications', async () => {
    const host = offeringHost({ exePath: APPS_EXE, probe: writable, isInApplicationsFolder: vi.fn(() => true) })
    await start(host)
    await runOffer()
    expect(host.showMessageBox).not.toHaveBeenCalled()
    expect(existsSync(prefsFile)).toBe(false)
  })

  it('never lets the location check escape as an unhandled rejection', async () => {
    // The hint it stands down with can't reach a window that is being torn down mid-launch.
    const mod = await freshAutoUpdater({ platform: 'darwin', exePath: DMG_EXE, probe: readOnlyDisk })
    mod.__setUpdateConfigExistsForTests(() => true)
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })
    const rejections = await unhandledRejectionsDuring(async () => {
      mod.initAutoUpdater(() => ({ webContents: { send } }) as any)
      await settle()
    })
    expect(rejections).toEqual([])
    expect(send).toHaveBeenCalled()
  })

  it('never lets the offer escape as an unhandled rejection', async () => {
    const host = offeringHost({
      prefsPath: () => {
        throw new Error("userData isn't available yet")
      },
    })
    await start(host)
    expect(await unhandledRejectionsDuring(runOffer)).toEqual([])
    expect(host.showMessageBox).not.toHaveBeenCalled()
  })

  it('makes no offer when app-update.yml is absent: there is nothing to update', async () => {
    const host = offeringHost()
    const mod = await freshAutoUpdater({ platform: 'darwin', ...host })
    mod.__setUpdateConfigExistsForTests(() => false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    mod.initAutoUpdater(() => null)
    await runOffer()
    expect(host.showMessageBox).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  describe("by default, through Electron's own app and dialog", () => {
    afterEach(() => {
      for (const key of ['getPath', 'isInApplicationsFolder', 'moveToApplicationsFolder']) delete electron.app[key]
    })

    function giveAppMacMethods() {
      Object.assign(electron.app, {
        getPath: vi.fn(() => dir),
        isInApplicationsFolder: vi.fn(() => false),
        moveToApplicationsFolder: vi.fn(() => false),
      })
    }

    it('asks over the main window, and keeps the answer in userData', async () => {
      giveAppMacMethods()
      electron.showMessageBox.mockResolvedValue({ response: 0 })
      const { fakeWindow } = await start({ exePath: DMG_EXE, probe: readOnlyDisk })
      await runOffer()
      expect(electron.showMessageBox).toHaveBeenCalledWith(fakeWindow, MOVE_OFFER_DIALOG)
      expect(electron.app.getPath).toHaveBeenCalledWith('userData')
      expect(electron.app.moveToApplicationsFolder).toHaveBeenCalledTimes(1)
      expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).toEqual({ moveOffer: 'declined' })
    })

    it('asks without a parent when there is no window yet', async () => {
      giveAppMacMethods()
      electron.showMessageBox.mockResolvedValue({ response: 1 })
      await start({ exePath: DMG_EXE, probe: readOnlyDisk }, { noWindow: true })
      await runOffer()
      expect(electron.showMessageBox.mock.calls).toEqual([[MOVE_OFFER_DIALOG]])
      expect(electron.app.moveToApplicationsFolder).not.toHaveBeenCalled()
    })

    it("makes no offer where Electron's app has no isInApplicationsFolder (Windows, Linux)", async () => {
      await start({ exePath: DMG_EXE, probe: readOnlyDisk })
      await runOffer()
      expect(electron.showMessageBox).not.toHaveBeenCalled()
    })

    it('reads a saved answer from userData', async () => {
      giveAppMacMethods()
      writeFileSync(prefsFile, JSON.stringify({ moveOffer: 'declined' }))
      await start({ exePath: DMG_EXE, probe: readOnlyDisk })
      await runOffer()
      expect(electron.showMessageBox).not.toHaveBeenCalled()
    })
  })
})

describe('initAutoUpdater dev/test short-circuit', () => {
  it('does not register event listeners when NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test'
    vi.resetModules()
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
    ipcHandlers.clear()
    mockAutoUpdater.on.mockClear()
    const mod = await import('../../src/main/autoUpdater')
    mod.initAutoUpdater(() => null)
    expect(mockAutoUpdater.on).not.toHaveBeenCalled()
    // IPC surface should still be mounted so the renderer can render
    // the banner in dev fixtures.
    expect(ipcHandlers.has('updater:status')).toBe(true)
    expect(ipcHandlers.has('updater:check')).toBe(true)
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: false, error: 'auto-update disabled in dev/test' })
  })

  it('gives up quietly when electron-updater is unavailable', async () => {
    const mod = await freshAutoUpdater()
    mod.__setUpdaterProviderForTests(() => null)
    mod.initAutoUpdater(() => null)
    expect(mockAutoUpdater.on).not.toHaveBeenCalled()
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: false, error: 'electron-updater unavailable' })
  })

  it("loads electron-updater's own autoUpdater by default, and gives up quietly when it won't load", async () => {
    // Outside Electron, as here, building electron-updater's autoUpdater throws: it needs
    // Electron's app. The default loader turns that into "unavailable".
    vi.resetModules()
    ipcHandlers.clear()
    const mod = await import('../../src/main/autoUpdater')
    mod.__setUpdaterHostForTests(LINUX_HOST)
    expect(() => mod.initAutoUpdater(() => null)).not.toThrow()
    expect(mockAutoUpdater.on).not.toHaveBeenCalled()
    expect(await ipcHandlers.get('updater:check')!()).toEqual({ success: false, error: 'electron-updater unavailable' })
  })
})

describe('initAutoUpdater for a Linux .deb — Restart installs from outside Termpolis, and quitting never installs', () => {
  // electron-updater installs a .deb with spawnSync on the main thread, so the window froze behind
  // the administrator prompt and dpkg (debUpdate.ts has the whole chain). Restart now hands the
  // download to the install runner and quits at once; the runner starts Termpolis again.
  async function setup(host: Partial<UpdaterHost> = {}) {
    for (const key of ['autoInstallOnAppQuit', 'autoRunAppAfterInstall']) delete (mockAutoUpdater as Record<string, unknown>)[key]
    mockAutoUpdater.quitAndInstall.mockReset()
    const calls: string[] = []
    const installDeb = vi.fn((_deb: string | undefined, _version: string | undefined): DebInstallStart => {
      calls.push('install')
      return { started: true }
    })
    const quit = vi.fn(() => { calls.push('quit') })
    const onBefore = vi.fn((armed?: boolean) => { calls.push(`bypass ${armed}`) })
    const send = vi.fn()
    const mod = await freshAutoUpdater({ ...DEB_HOST, installDeb, quit, ...host })
    mod.initAutoUpdater(() => ({ webContents: { send } }) as any, { onBeforeQuitAndInstall: onBefore })
    return { installDeb, quit, onBefore, send, calls }
  }
  const restart = () => ipcHandlers.get('updater:quit-and-install')!()
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('never lets electron-updater install a .deb: not on quit, and not through app.relaunch()', async () => {
    await setup()
    // Its install on quit runs the same blocking install from Electron's quit event, the prompt
    // appearing after the window has gone, out of reach of the will-quit watchdog.
    expect((mockAutoUpdater as Record<string, unknown>).autoInstallOnAppQuit).toBe(false)
    expect((mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall).toBe(false)
  })

  it.each<[string, Partial<UpdaterHost>]>([
    ['an AppImage', { appImage: true }],
    ['macOS', { platform: 'darwin', exePath: '/usr/local/bin/termpolis' }],
    ['Windows', { platform: 'win32', exePath: 'C:\\Program Files\\Termpolis\\Termpolis.exe' }],
  ])('leaves %s to electron-updater, installing on quit as before', async (_name, host) => {
    const { installDeb } = await setup(host)
    expect((mockAutoUpdater as Record<string, unknown>).autoInstallOnAppQuit).toBe(true)
    expect((mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall).toBeUndefined()
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    expect(restart()).toEqual({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(installDeb).not.toHaveBeenCalled()
  })

  it('hands the downloaded .deb to the install runner, then quits at once with the close guard bypassed', async () => {
    const { installDeb, quit, calls } = await setup()
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    expect(restart()).toEqual({ success: true })
    // electron-updater has already checked the file against the sha512 in latest-linux.yml.
    expect(installDeb).toHaveBeenCalledWith(DEB, '9.9.9')
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    // A tick later, so the renderer has its answer first.
    expect(quit).not.toHaveBeenCalled()
    await tick()
    expect(calls).toEqual(['install', 'bypass true', 'quit'])
  })

  it('keeps the bypass armed through an updater error once the runner waits: the quit must still come', async () => {
    const { onBefore } = await setup()
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    restart()
    eventHandlers['error']?.(new Error('sha512 checksum mismatch'))
    expect(onBefore.mock.calls).toEqual([[true]])
  })

  it.each<[string, Extract<DebInstallStart, { started: false }>]>([
    ['there is no way to ask for administrator rights', { started: false, message: debManualInstallMessage(DEB) }],
    ['another Termpolis is already installing it', { started: false, message: DEB_BUSY_MESSAGE, busy: true }],
  ])('says why, stays open and changes nothing when %s', async (_why, start) => {
    const { send, quit, onBefore } = await setup({ installDeb: () => start })
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    send.mockClear()
    mockRecordUpdaterEvent.mockClear()
    expect(restart()).toEqual({ success: false, error: start.message })
    const hint = { status: 'error', error: start.message, reason: 'deb-install' }
    expect(send).toHaveBeenCalledWith('updater:state', hint)
    expect(ipcHandlers.get('updater:status')!()).toEqual(hint)
    // Something for the user to do, not a failure to report.
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
    await tick()
    expect(quit).not.toHaveBeenCalled()
    expect(onBefore).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("treats a runner that throws as one that couldn't start", async () => {
    const { quit } = await setup({ installDeb: () => { throw new Error('EMFILE') } })
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    const message = debManualInstallMessage(DEB, DEB_NOT_STARTED_LEAD)
    expect(restart()).toEqual({ success: false, error: message })
    expect(ipcHandlers.get('updater:status')!()).toEqual({ status: 'error', error: message, reason: 'deb-install' })
    await tick()
    expect(quit).not.toHaveBeenCalled()
  })

  it('passes on an update-downloaded that named no file, for the runner to refuse', async () => {
    const { installDeb } = await setup()
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    restart()
    expect(installDeb).toHaveBeenCalledWith(undefined, '9.9.9')
  })

  it('installs only an update that has finished downloading', async () => {
    const { installDeb } = await setup()
    expect(restart()).toEqual({ success: false, error: 'no update ready' })
    expect(installDeb).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdater for a Linux .deb — the launch after an install says what became of it', () => {
  const CANCELLED = DEB_CANCELLED_MESSAGE
  async function setup(host: Partial<UpdaterHost> = {}) {
    const send = vi.fn()
    const takeDebNotice = vi.fn((): string | null => CANCELLED)
    const mod = await freshAutoUpdater({ ...DEB_HOST, takeDebNotice, ...host })
    mod.initAutoUpdater(() => ({ webContents: { send } }) as any)
    return { send, takeDebNotice }
  }

  it('reads the result once, at launch, and tells it at once without reporting it', async () => {
    const { send, takeDebNotice } = await setup()
    expect(takeDebNotice).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('updater:state', { status: 'idle', notice: CANCELLED })
    // The banner asks for the state when it mounts, which can be after this was sent.
    expect(ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle', notice: CANCELLED })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
  })

  it('keeps telling it through the next check, beside the update that check finds ready again', async () => {
    const { send } = await setup()
    eventHandlers['checking-for-update']?.()
    expect(send).toHaveBeenLastCalledWith('updater:state', { status: 'checking', notice: CANCELLED })
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    expect(send).toHaveBeenLastCalledWith('updater:state', { status: 'downloaded', version: '9.9.9', notice: CANCELLED })
    // Telemetry hears of the update and never of the notice, which can name the user's home folder.
    expect(mockRecordUpdaterEvent).toHaveBeenLastCalledWith({ status: 'downloaded', version: '9.9.9' })
    // A check that gets no answer goes back to where it was, notice and all.
    eventHandlers['error']?.(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(send).toHaveBeenLastCalledWith('updater:state', { status: 'downloaded', version: '9.9.9', notice: CANCELLED })
  })

  it('stops telling it once Restart is tried again', async () => {
    const { send } = await setup({ installDeb: () => ({ started: false, message: DEB_BUSY_MESSAGE, busy: true }) })
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    ipcHandlers.get('updater:quit-and-install')!()
    expect(send).toHaveBeenLastCalledWith('updater:state', { status: 'error', error: DEB_BUSY_MESSAGE, reason: 'deb-install' })
    eventHandlers['checking-for-update']?.()
    expect(send).toHaveBeenLastCalledWith('updater:state', { status: 'checking' })
  })

  it('tells nothing when there is nothing to tell, or the result cannot be read', async () => {
    for (const takeDebNotice of [() => null, () => { throw new Error('EACCES') }]) {
      const { send } = await setup({ takeDebNotice })
      expect(send).not.toHaveBeenCalled()
      expect(ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle' })
    }
  })

  it.each<[string, Partial<UpdaterHost>]>([
    ['an AppImage', { appImage: true }],
    ['macOS', { platform: 'darwin', exePath: '/usr/local/bin/termpolis' }],
    ['Windows', { platform: 'win32', exePath: 'C:\\Program Files\\Termpolis\\Termpolis.exe' }],
  ])('reads no result for %s, which never writes one', async (_name, host) => {
    const { takeDebNotice } = await setup(host)
    expect(takeDebNotice).not.toHaveBeenCalled()
  })

  it('reads no result in a dev or test run, which never installs', async () => {
    process.env.NODE_ENV = 'test'
    const { takeDebNotice } = await setup()
    expect(takeDebNotice).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdater for a Linux .deb — a Termpolis opened while an update is being installed', () => {
  // Opened by hand while the runner of an earlier Restart waits at the password dialog, or while
  // dpkg runs: it starts from the version being replaced, and holds the single-instance lock that
  // the Termpolis the runner starts afterwards needs.
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  async function setup(host: Partial<UpdaterHost> = {}) {
    const showMessageBox = vi.fn((_parent: unknown, _options: unknown) => Promise.resolve({ response: 0 }))
    const quit = vi.fn()
    const takeDebNotice = vi.fn((): string | null => null)
    const onBefore = vi.fn()
    const win = { webContents: { send: vi.fn() } }
    const mod = await freshAutoUpdater({ ...DEB_HOST, debInstallerRunning: () => true, showMessageBox, quit, takeDebNotice, ...host })
    mod.__setUpdateConfigExistsForTests(() => true)
    mod.initAutoUpdater(() => win as any, { onBeforeQuitAndInstall: onBefore })
    return { mod, showMessageBox, quit, takeDebNotice, onBefore, win }
  }

  it('says an update is being installed, then quits, without reading a result or checking for updates', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    try {
      const { mod, showMessageBox, quit, takeDebNotice, onBefore, win } = await setup()
      expect(showMessageBox).toHaveBeenCalledWith(win, mod.DEB_INSTALLING_DIALOG)
      expect(quit).not.toHaveBeenCalled()
      await tick()
      // Past the close guard, as for any quit Termpolis chooses itself.
      expect(onBefore.mock.calls).toEqual([[true]])
      expect(quit).toHaveBeenCalledTimes(1)
      // The runner hasn't written its result yet, and this copy has nothing to check for.
      expect(takeDebNotice).not.toHaveBeenCalled()
      expect(setIntervalSpy).not.toHaveBeenCalled()
      // Quitting installs nothing, and a check asked for by hand still finds its error listener.
      expect((mockAutoUpdater as Record<string, unknown>).autoInstallOnAppQuit).toBe(false)
      expect(typeof eventHandlers['error']).toBe('function')
    } finally {
      setIntervalSpy.mockRestore()
    }
  })

  it('tells the user Termpolis will open again by itself, and what to do with the password dialog', async () => {
    const { mod } = await setup()
    expect(mod.DEB_INSTALLING_DIALOG).toEqual({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      message: 'Termpolis is being updated',
      detail:
        'Termpolis closes now and opens again by itself once the update is installed. If your desktop is asking for ' +
        'your administrator password, answer it, or cancel it to keep the version you have.',
    })
  })

  it('still quits when the dialog cannot be shown', async () => {
    const { quit } = await setup({ showMessageBox: () => Promise.reject(new Error('window gone')) })
    await tick()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('raises nothing when the quit itself throws', async () => {
    const quit = vi.fn(() => { throw new Error('quitting already') })
    expect(await unhandledRejectionsDuring(() => setup({ quit }))).toEqual([])
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('carries on as usual when it cannot tell whether an install is at work', async () => {
    const { showMessageBox, quit, takeDebNotice } = await setup({ debInstallerRunning: () => { throw new Error('EACCES') } })
    await tick()
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(takeDebNotice).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Partial<UpdaterHost>]>([
    ['an AppImage', { appImage: true }],
    ['macOS', { platform: 'darwin', exePath: '/usr/local/bin/termpolis' }],
    ['Windows', { platform: 'win32', exePath: 'C:\\Program Files\\Termpolis\\Termpolis.exe' }],
  ])('never looks for %s, which has no install runner', async (_name, host) => {
    const debInstallerRunning = vi.fn(() => true)
    const { showMessageBox, quit } = await setup({ ...host, debInstallerRunning })
    await tick()
    expect(debInstallerRunning).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('never looks in a dev or test run, which never installs', async () => {
    process.env.NODE_ENV = 'test'
    const debInstallerRunning = vi.fn(() => true)
    const { quit } = await setup({ debInstallerRunning })
    await tick()
    expect(debInstallerRunning).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })
})

describe("initAutoUpdater for a Linux .deb — by default, through debUpdate and Electron's own app", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'au-deb-'))
    Object.assign(electron.app, { getPath: vi.fn(() => dir), getVersion: vi.fn(() => '1.54.0'), quit: vi.fn() })
  })
  afterEach(() => {
    for (const key of ['getPath', 'getVersion', 'quit']) delete electron.app[key]
    rmSync(dir, { recursive: true, force: true })
  })

  it('tells nothing when no install left a result, and finds no install at work', async () => {
    const { takeDebNotice: _t, debInstallerRunning: _r, quit: _q, ...host } = DEB_HOST
    const mod = await freshAutoUpdater(host)
    const send = vi.fn()
    mod.initAutoUpdater(() => ({ webContents: { send } }) as any)
    expect(ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle' })
    expect(send).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it("takes the last install's result from userData, read for the version running now", async () => {
    writeFileSync(join(dir, DEB_RESULT_FILE), JSON.stringify({ info: { from: '1.54.0', target: '1.54.1' }, code: 126, tailHex: '' }))
    const { takeDebNotice: _t, ...host } = DEB_HOST
    const mod = await freshAutoUpdater(host)
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    expect(ipcHandlers.get('updater:status')!()).toEqual({ status: 'idle', notice: DEB_CANCELLED_MESSAGE })
    expect(existsSync(join(dir, DEB_RESULT_FILE))).toBe(false)
  })

  it('hands Restart to debUpdate, from userData', async () => {
    // The real installDeb, with the real spawn. userData is a regular file here, so the log the
    // runner's output goes to can't be created, and startDebInstall stops before it spawns,
    // whatever .deb it is handed. A real runner would wait for the test process to exit, ask for
    // the administrator password, then start the test process again.
    const notAFolder = join(dir, 'not-a-folder')
    writeFileSync(notAFolder, '')
    electron.app.getPath = vi.fn(() => notAFolder)
    const { installDeb: _i, ...host } = DEB_HOST
    const mod = await freshAutoUpdater(host)
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    const answer = ipcHandlers.get('updater:quit-and-install')!() as { success: boolean; error?: string }
    expect(answer.success).toBe(false)
    // With pkexec on this machine the log can't be created; without it there is no way to ask.
    expect([debManualInstallMessage(DEB, DEB_NOT_STARTED_LEAD), debManualInstallMessage(DEB)]).toContain(answer.error)
    expect(electron.app.getPath).toHaveBeenCalledWith('userData')
    expect(readFileSync(notAFolder, 'utf8')).toBe('')
  })

  describe('which kind of Linux package this is', () => {
    // electron-updater picks DebUpdater by <resources>/package-type alone (main.js). APPIMAGE is
    // inherited like any variable: a .deb started from the terminal of an editor shipped as an
    // AppImage has the editor's.
    let savedAppImage: string | undefined
    beforeEach(() => {
      savedAppImage = process.env.APPIMAGE
      Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true, writable: true })
      for (const key of ['autoInstallOnAppQuit', 'autoRunAppAfterInstall']) delete (mockAutoUpdater as Record<string, unknown>)[key]
      mockAutoUpdater.quitAndInstall.mockReset()
    })
    afterEach(() => {
      delete (process as { resourcesPath?: string }).resourcesPath
      if (savedAppImage === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = savedAppImage
    })

    /** Restart on the default host, with APPIMAGE and <resources>/package-type as given. */
    async function restartWith(appImage: string | undefined, packageType: string | null) {
      if (appImage === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = appImage
      if (packageType !== null) writeFileSync(join(dir, 'package-type'), packageType)
      const { appImage: _a, ...host } = DEB_HOST
      const installDeb = vi.fn((_deb: string | undefined, _version: string | undefined): DebInstallStart => ({ started: true }))
      const mod = await freshAutoUpdater({ ...host, installDeb })
      mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
      eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
      const answer = ipcHandlers.get('updater:quit-and-install')!()
      return { installDeb, answer, updater: mockAutoUpdater as Record<string, unknown> }
    }

    it('takes a .deb for a .deb by its package-type, whatever APPIMAGE it inherited', async () => {
      const { installDeb, answer, updater } = await restartWith('/home/u/Applications/Cursor-1.7.0-x86_64.AppImage', 'deb\n')
      expect(updater.autoInstallOnAppQuit).toBe(false)
      expect(updater.autoRunAppAfterInstall).toBe(false)
      expect(answer).toEqual({ success: true })
      expect(installDeb).toHaveBeenCalledWith(DEB, '9.9.9')
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    })

    it('leaves an AppImage, which has no package-type, to electron-updater', async () => {
      const { installDeb, updater } = await restartWith('/home/u/Applications/Termpolis-1.54.0.AppImage', null)
      expect(updater.autoInstallOnAppQuit).toBe(true)
      expect(updater.autoRunAppAfterInstall).toBeUndefined()
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
      expect(installDeb).not.toHaveBeenCalled()
    })

    it('takes a copy with neither for a system package, as before', async () => {
      const { installDeb, updater } = await restartWith(undefined, null)
      expect(updater.autoInstallOnAppQuit).toBe(false)
      expect(installDeb).toHaveBeenCalledWith(DEB, '9.9.9')
    })
  })

  it("quits through Electron's app once the runner has started", async () => {
    const { quit: _q, ...host } = DEB_HOST
    const mod = await freshAutoUpdater({ ...host, installDeb: () => ({ started: true }) })
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })
})

describe('updater:quit-and-install for a Linux .deb — a window with no_new_privs cannot install', () => {
  async function load(host: Partial<UpdaterHost>) {
    mockAutoUpdater.quitAndInstall.mockReset()
    const onBefore = vi.fn()
    const installDeb = vi.fn((_deb: string | undefined, _version: string | undefined): DebInstallStart => ({ started: true }))
    const mod = await freshAutoUpdater({ ...DEB_HOST, installDeb, ...host })
    const send = vi.fn()
    mod.initAutoUpdater(() => ({ webContents: { send } }) as any, { onBeforeQuitAndInstall: onBefore })
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    send.mockClear()
    mockRecordUpdaterEvent.mockClear()
    return { send, onBefore, installDeb }
  }

  it("says why instead of starting an install whose pkexec can't run", async () => {
    // The runner would inherit the flag, and pkexec or sudo then fail outright.
    const { send, onBefore, installDeb } = await load({ noNewPrivs: () => true })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: NO_NEW_PRIVS_UPDATE_MESSAGE })
    expect(installDeb).not.toHaveBeenCalled()
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(onBefore).not.toHaveBeenCalled()
    const hint = { status: 'error', error: NO_NEW_PRIVS_UPDATE_MESSAGE, reason: 'no-new-privs' }
    expect(send).toHaveBeenCalledWith('updater:state', hint)
    expect(ipcHandlers.get('updater:status')!()).toEqual(hint)
    // Something the user does, not a failure to report.
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalled()
  })

  it('installs as usual when the flag is clear or unknown', async () => {
    for (const noNewPrivs of [() => false, () => null]) {
      const { installDeb } = await load({ noNewPrivs })
      expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
      expect(installDeb).toHaveBeenCalledWith(DEB, '9.9.9')
    }
  })

  it('lets an AppImage install, since replacing its own file needs no root', async () => {
    const { installDeb } = await load({ noNewPrivs: () => true, appImage: true })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(installDeb).not.toHaveBeenCalled()
  })

  it('reads the real flag by default', async () => {
    const { noNewPrivs: _n, ...host } = DEB_HOST
    const installDeb = vi.fn((_deb: string | undefined, _version: string | undefined): DebInstallStart => ({ started: true }))
    const mod = await freshAutoUpdater({ ...host, installDeb })
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    eventHandlers['update-downloaded']?.({ version: '9.9.9', downloadedFile: DEB })
    // Whatever this machine's answer is (a CI container can have the flag set), Restart follows it.
    const flagged = hasNoNewPrivs() === true
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual(
      flagged ? { success: false, error: NO_NEW_PRIVS_UPDATE_MESSAGE } : { success: true },
    )
    expect(installDeb).toHaveBeenCalledTimes(flagged ? 0 : 1)
  })
})
