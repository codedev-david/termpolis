/**
 * The updater's scheduled checks stand down while the event loop struggles (1.54.5 hotfix, lane G).
 *
 * An update check is a network request plus electron-updater's own file work on main; it is never urgent. While
 * shed the scheduled check (the 10 s first check and the 4 h interval) is skipped, and ONE check is made up
 * a minute after calm returns, so a busy machine still hears about updates and nothing bursts at the instant
 * SHED ends. A manual "Check for updates" (the updater:check IPC) is a user action and is never gated.
 *
 * Counters: checkForUpdates() calls, with fake timers; a control proves the unshed behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { UpdaterHost } from '../../src/main/autoUpdater'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

const mockAutoUpdater = {
  on: vi.fn(),
  checkForUpdates: vi.fn((): Promise<unknown> => Promise.resolve()),
  quitAndInstall: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  logger: null as unknown,
}

vi.mock('electron', () => ({
  app: { isPackaged: true },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler) }) },
}))
vi.mock('../../src/main/telemetry', () => ({ recordUpdaterEvent: vi.fn() }))

const HOST: Partial<UpdaterHost> = {
  platform: 'linux',
  exePath: '/opt/Termpolis/termpolis',
  appImage: true,
  noNewPrivs: () => false,
  installDeb: () => ({ started: false, message: 'test' }),
  takeDebNotice: () => null,
  debInstallerRunning: () => false,
  quit: () => {},
}

const FOUR_HOURS = 4 * 60 * 60 * 1000

async function boot(configExists = true) {
  vi.resetModules()
  ipcHandlers.clear()
  const updater = await import('../../src/main/autoUpdater')
  const governor = await import('../../src/main/loopGovernor') // same module graph as the updater just imported
  updater.__setUpdaterProviderForTests(() => mockAutoUpdater)
  updater.__setUpdaterHostForTests(HOST)
  updater.__setUpdateConfigExistsForTests(() => configExists)
  updater.initAutoUpdater(() => ({ webContents: { send: vi.fn() } }) as never)
  return { updater, shed: governor.shedRegistry }
}

beforeEach(() => {
  vi.useFakeTimers()
  process.env.NODE_ENV = 'production'
  delete process.env.TERMPOLIS_SKIP_UPDATER
  mockAutoUpdater.checkForUpdates.mockClear()
})
afterEach(() => { vi.useRealTimers(); process.env.NODE_ENV = 'test' })

describe('scheduled update checks and SHED', () => {
  it('control: calm, the first check runs at 10 s and the next one 4 h later', async () => {
    await boot()
    vi.advanceTimersByTime(9_999)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('shed: the 10 s check and every 4 h check are skipped (zero checkForUpdates calls)', async () => {
    const { shed } = await boot()
    shed.setShed(true)
    vi.advanceTimersByTime(10_000)
    vi.advanceTimersByTime(FOUR_HOURS * 3)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('shed that ends: exactly ONE check is made up, a minute later, not at the instant calm returns', async () => {
    const { shed } = await boot()
    shed.setShed(true)
    vi.advanceTimersByTime(FOUR_HOURS) // the 10 s check and the 4 h check were both skipped
    shed.setShed(false)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled() // not a burst on resume
    vi.advanceTimersByTime(59_999)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FOUR_HOURS - 60_000 - 1)
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1) // the made-up one replaced both skipped ones
  })

  it('a shed that skipped nothing makes nothing up (control: no check appears out of thin air)', async () => {
    const { shed } = await boot()
    vi.advanceTimersByTime(10_000) // the first check ran, calm
    mockAutoUpdater.checkForUpdates.mockClear()
    shed.setShed(true)
    shed.setShed(false)
    vi.advanceTimersByTime(10 * 60_000)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('a manual check (updater:check) is a user action and is never gated, even while shed', async () => {
    const { shed } = await boot()
    shed.setShed(true)
    mockAutoUpdater.checkForUpdates.mockClear()
    await ipcHandlers.get('updater:check')!()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('no update config (nothing is scheduled today): nothing is registered and no timer exists', async () => {
    const { shed } = await boot(false)
    expect(shed.names().filter((n) => n.startsWith('updater'))).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('registers one entry for the scheduled checks', async () => {
    const { shed } = await boot()
    expect(shed.names().filter((n) => n.startsWith('updater'))).toHaveLength(1)
  })
})
