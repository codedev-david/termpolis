import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'os'

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

vi.mock('electron', () => ({
  app: {
    isPackaged: true, // skip the dev-mode short-circuit
  },
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

// vi.mock can't intercept lazy require() inside the SUT, so we inject the
// fake autoUpdater via __setUpdaterProviderForTests instead.
async function loadAutoUpdater(opts?: { onBeforeQuitAndInstall?: () => void }) {
  vi.resetModules()
  for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
  ipcHandlers.clear()
  const mod = await import('../../src/main/autoUpdater')
  mod.__setUpdaterProviderForTests(() => mockAutoUpdater)
  const fakeWindow = { webContents: { send: vi.fn() } } as any
  mod.initAutoUpdater(() => fakeWindow, opts)
  return { fakeWindow, mod }
}

beforeEach(() => {
  // Vitest defaults NODE_ENV to 'test', which the updater treats as a
  // skip signal. Force a non-test value so event listeners get registered.
  process.env.NODE_ENV = 'production'
  delete process.env.TERMPOLIS_SKIP_UPDATER
  mockRecordUpdaterEvent.mockReset()
  mockAutoUpdater.on.mockClear()
  mockAutoUpdater.checkForUpdates.mockClear()
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
  const missingConfigErr = () =>
    new Error(
      "ENOENT: no such file or directory, open " +
        "'C:\\Users\\x\\AppData\\Local\\Programs\\termpolis\\resources\\app-update.yml'",
    )

  it('does NOT report a missing-config ENOENT as a production error', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(missingConfigErr())
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    )
  })

  it('surfaces a missing-config ENOENT as a benign not-available state', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(missingConfigErr())
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not-available' }),
    )
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith(
      'updater:state',
      expect.objectContaining({ status: 'not-available' }),
    )
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

  it('surfaces a transient network error (offline) as a benign not-available state', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not-available' }),
    )
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith(
      'updater:state',
      expect.objectContaining({ status: 'not-available' }),
    )
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

  it('surfaces a read-only volume refusal (macOS .dmg) as a benign not-available state', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(
      new Error(
        'Cannot update while running on a read-only volume. The application is on a ' +
          'read-only volume. Please move the application and try again. If you’re on ' +
          'macOS Sierra or later, you’ll need to move the application out of the ' +
          'Downloads directory.',
      ),
    )
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not-available' }),
    )
    // Never as an error: an 'error' state is what telemetry.ts turns into a
    // Sentry captureMessage, which is how one launch filed BOTH #21 and #22.
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    )
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith(
      'updater:state',
      expect.objectContaining({ status: 'not-available' }),
    )
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
    vi.resetModules()
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
    ipcHandlers.clear()
    mockAutoUpdater.on.mockClear()
    const mod = await import('../../src/main/autoUpdater')
    mod.__setUpdaterProviderForTests(() => mockAutoUpdater)
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
    vi.resetModules()
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
    ipcHandlers.clear()
    const mod = await import('../../src/main/autoUpdater')
    mod.__setUpdaterProviderForTests(() => mockAutoUpdater)
    mod.__setUpdateConfigExistsForTests(() => true)
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    mod.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as any)
    expect(setIntervalSpy).toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})

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

describe('initAutoUpdater — a GitHub 5xx and a full disk (Sentry ELECTRON-Y, ELECTRON-Z/10/11)', () => {
  it('surfaces a 504 from GitHub as a benign not-available state, never an error', async () => {
    const { fakeWindow } = await loadAutoUpdater()
    eventHandlers['error']?.(gatewayTimeout())
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({ status: 'not-available' })
    expect(mockRecordUpdaterEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('updater:state', { status: 'not-available' })
  })

  it('tells the user their disk is full, without filing it as a crash', async () => {
    const { fakeWindow, mod } = await loadAutoUpdater()
    // On macOS Squirrel fails right AFTER electron-updater announced the download.
    eventHandlers['update-downloaded']?.({ version: '9.9.9' })
    eventHandlers['error']?.(diskFull())
    expect(fakeWindow.webContents.send).toHaveBeenLastCalledWith('updater:state', {
      status: 'error',
      error: mod.DISK_FULL_MESSAGE,
    })
    // report:false = a breadcrumb only; telemetry skips the captureMessage that filed #29/#30/#31.
    expect(mockRecordUpdaterEvent).toHaveBeenLastCalledWith({
      status: 'error',
      error: mod.DISK_FULL_MESSAGE,
      report: false,
    })
    // Squirrel never staged it, so there is nothing to restart into.
    expect(ipcHandlers.get('updater:quit-and-install')!()).toEqual({ success: false, error: 'no update ready' })
  })

  it("treats Node's ENOSPC (Windows / Linux download) the same way", async () => {
    const { mod } = await loadAutoUpdater()
    eventHandlers['error']?.(new Error('ENOSPC: no space left on device, write'))
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'error',
      error: mod.DISK_FULL_MESSAGE,
      report: false,
    })
  })

  it('still reports a genuine HTTP failure (a 404), minus the response-header dump', async () => {
    await loadAutoUpdater()
    eventHandlers['error']?.(
      new Error(
        '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest-mac.yml"\n' +
          'Headers: {\n  "set-cookie": [\n    "_gh_sess=<elided>; path=/"\n  ]\n}',
      ),
    )
    expect(mockRecordUpdaterEvent).toHaveBeenCalledWith({
      status: 'error',
      error: '404 \n"method: GET url: https://github.com/o/r/releases/download/v1/latest-mac.yml"',
    })
  })

  it('a failed manual check reports its reason minus the header dump', async () => {
    await loadAutoUpdater()
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(() => Promise.reject(gatewayTimeout()))
    const res = await ipcHandlers.get('updater:check')!()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/^504 \n"method: GET url: https:\/\/github\.com\/codedev-david\/termpolis\/releases\.atom/)
    expect(res.error).not.toMatch(/Headers:|set-cookie|_gh_sess/)
  })

  it('re-exports the new predicates alongside the old ones', async () => {
    vi.resetModules()
    const mod = await import('../../src/main/autoUpdater')
    expect(mod.isTransientHttpServerError(gatewayTimeout())).toBe(true)
    expect(mod.isBenignUpdaterError(gatewayTimeout())).toBe(true)
    expect(mod.isDiskFullError(diskFull())).toBe(true)
    expect(mod.isBenignUpdaterError(diskFull())).toBe(false)
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

describe('initAutoUpdater — nothing leaks: download rejections, cookies and home paths in the log', () => {
  // A download that dies on a full disk: electron-updater emits 'error' AND rejects the
  // downloadPromise that checkForUpdates() resolved with.
  const checkThatStartsAFailingDownload = () =>
    Promise.resolve({ downloadPromise: Promise.reject(new Error('ENOSPC: no space left on device, write')) })

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
    vi.resetModules()
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k]
    ipcHandlers.clear()
    const mod = await import('../../src/main/autoUpdater')
    mod.__setUpdaterProviderForTests(() => mockAutoUpdater)
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
  })
})
