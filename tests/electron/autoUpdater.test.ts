import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture event handlers + IPC handlers registered by initAutoUpdater
const eventHandlers: Record<string, Function> = {}
const ipcHandlers = new Map<string, Function>()

const mockAutoUpdater = {
  on: vi.fn((event: string, handler: Function) => {
    eventHandlers[event] = handler
  }),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
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
  return { fakeWindow }
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
