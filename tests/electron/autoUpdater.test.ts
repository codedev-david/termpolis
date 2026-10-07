import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir, tmpdir } from 'os'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UpdaterHost } from '../../src/main/autoUpdater'
import { MOVE_FAILED_DIALOG, MOVE_OFFER_DIALOG, updateBlockerHint } from '../../src/main/updaterLocation'
import { DISK_FULL_MESSAGE, NO_UPDATE_FEED_MESSAGE, UPDATE_SERVER_UNREACHABLE_MESSAGE } from '../../src/main/updaterErrors'
import { NO_NEW_PRIVS_UPDATE_MESSAGE } from '../../src/main/autoUpdater'

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

// Deterministic whatever OS runs the suite: no macOS location check, no Move offer.
// The Linux-only pieces are pinned too: a CI container can run the suite with no_new_privs set, and
// nothing here may ever restart the test runner.
const LINUX_HOST: Partial<UpdaterHost> = {
  platform: 'linux',
  exePath: '/opt/Termpolis/termpolis',
  appImage: false,
  noNewPrivs: () => false,
  relaunch: () => true,
  onQuitForUpdate: () => {},
}

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
})

describe('initAutoUpdater on Linux — reopening after an update keeps sudo working (no_new_privs)', () => {
  // electron-updater's .deb/.rpm/pacman installers reopen the app with app.relaunch(), which on
  // Linux leaves the new copy with no_new_privs: sudo then fails in every terminal (noNewPrivs.ts).
  async function setup(host: Partial<UpdaterHost>) {
    delete (mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall
    mockAutoUpdater.quitAndInstall.mockReset()
    let listener: (() => void) | undefined
    const relaunch = vi.fn(() => true)
    const onQuitForUpdate = vi.fn((fn: () => void) => { listener = fn })
    const mod = await freshAutoUpdater({ ...LINUX_HOST, appImage: false, relaunch, onQuitForUpdate, ...host })
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    return { relaunch, onQuitForUpdate, quitForUpdate: () => listener?.() }
  }

  it("stops electron-updater's app.relaunch() and reopens Termpolis itself after Restart", async () => {
    const { relaunch, quitForUpdate } = await setup({})
    expect((mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall).toBe(false)
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    quitForUpdate()
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('does not reopen after an install on quit, which nobody asked to restart from', async () => {
    const { relaunch, quitForUpdate } = await setup({})
    quitForUpdate()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('does not reopen when the install failed', async () => {
    const { relaunch, quitForUpdate } = await setup({})
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    ipcHandlers.get('updater:quit-and-install')!()
    eventHandlers['error']?.(new Error('sha512 checksum mismatch'))
    quitForUpdate()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('leaves an AppImage to its own updater, which starts the new image without the flag', async () => {
    const { onQuitForUpdate } = await setup({ appImage: true })
    expect((mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall).toBeUndefined()
    expect(onQuitForUpdate).not.toHaveBeenCalled()
  })

  it('changes nothing on Windows', async () => {
    const { onQuitForUpdate } = await setup({ platform: 'win32', exePath: 'C:\Program Files\Termpolis\Termpolis.exe' })
    expect((mockAutoUpdater as Record<string, unknown>).autoRunAppAfterInstall).toBeUndefined()
    expect(onQuitForUpdate).not.toHaveBeenCalled()
  })
})

describe('updater:quit-and-install on Linux — a window with no_new_privs cannot install', () => {
  async function load(host: Partial<UpdaterHost>) {
    mockAutoUpdater.quitAndInstall.mockReset()
    const onBefore = vi.fn()
    const mod = await freshAutoUpdater({ ...LINUX_HOST, ...host })
    const send = vi.fn()
    mod.initAutoUpdater(() => ({ webContents: { send } }) as any, { onBeforeQuitAndInstall: onBefore })
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    send.mockClear()
    mockRecordUpdaterEvent.mockClear()
    return { send, onBefore }
  }

  it("says why instead of quitting into a pkexec that can't run", async () => {
    const { send, onBefore } = await load({ noNewPrivs: () => true })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: NO_NEW_PRIVS_UPDATE_MESSAGE })
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
      await load({ noNewPrivs })
      expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    }
  })

  it('lets an AppImage install, since replacing its own file needs no root', async () => {
    await load({ noNewPrivs: () => true, appImage: true })
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
  })

  it('reads the real flag by default', async () => {
    const { appImage: _a, noNewPrivs: _n, ...host } = LINUX_HOST
    mockAutoUpdater.quitAndInstall.mockReset()
    const mod = await freshAutoUpdater({ ...host, appImage: true })
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    // An AppImage never consults it, so this proves only that the default host wires up cleanly.
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: true })
  })
})
