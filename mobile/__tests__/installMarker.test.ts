const mockKeychain = new Map<string, string>()
let mockDefaults: Record<string, unknown> = {}
let mockReadThrows = false
let mockWriteThrows = false

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockReadThrows) throw new Error('keychain is locked')
    return mockKeychain.get(key) ?? null
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    if (mockWriteThrows) throw new Error('keychain is locked')
    mockKeychain.set(key, value)
  }),
}))

const mockWipe = jest.fn(async () => undefined)
const mockForgetGrant = jest.fn(async () => undefined)
jest.mock('../src/storage/identity', () => ({ wipeEverything: () => mockWipe() }))
jest.mock('../src/storage/grant', () => ({ forgetGrant: () => mockForgetGrant() }))

// The real module asks for a native SettingsManager the test runtime lacks.
jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn() },
}))

import { Platform, Settings } from 'react-native'

import { settleInstall } from '../src/storage/installMarker'

const STAMP = 'termpolis.remote.install.v1'

beforeEach(() => {
  mockKeychain.clear()
  mockDefaults = {}
  mockReadThrows = false
  mockWriteThrows = false
  mockWipe.mockReset()
  mockWipe.mockResolvedValue(undefined)
  mockForgetGrant.mockReset()
  mockForgetGrant.mockResolvedValue(undefined)
  ;(Settings.get as jest.Mock).mockReset().mockImplementation((key: string) => mockDefaults[key])
  ;(Settings.set as jest.Mock).mockReset().mockImplementation((values: Record<string, unknown>) => {
    mockDefaults = { ...mockDefaults, ...values }
  })
})

describe('settleInstall -- telling a reinstall from an update', () => {
  it('stamps a phone updating from 1.2 and keeps its pairings', async () => {
    // No stamp anywhere: those builds never wrote one.
    expect(await settleInstall()).toBe('fresh')
    expect(mockWipe).not.toHaveBeenCalled()
    expect(mockForgetGrant).not.toHaveBeenCalled()
    expect(mockDefaults[STAMP]).toBe(1)
    // Not yet: iOS may not have saved the defaults stamp to disk.
    expect(mockKeychain.has(STAMP)).toBe(false)
  })

  it('adds the Keychain stamp on the next launch, and does nothing more after', async () => {
    await settleInstall()
    expect(await settleInstall()).toBe('kept')
    expect(mockKeychain.get(STAMP)).toBe('1')
    expect(await settleInstall()).toBe('kept')
    expect(mockWipe).not.toHaveBeenCalled()
  })

  it('keeps the pairings of an update whose defaults stamp was lost before iOS saved it', async () => {
    await settleInstall()
    // Killed before NSUserDefaults reached the disk.
    mockDefaults = {}
    expect(await settleInstall()).toBe('fresh')
    expect(mockWipe).not.toHaveBeenCalled()
  })

  it('wipes pairings and the cached grant after a reinstall', async () => {
    // The Keychain outlived the app; its defaults did not.
    mockKeychain.set(STAMP, '1')
    expect(await settleInstall()).toBe('wiped')
    expect(mockWipe).toHaveBeenCalledTimes(1)
    expect(mockForgetGrant).toHaveBeenCalledTimes(1)
    expect(mockDefaults[STAMP]).toBe(1)
    // And only once.
    expect(await settleInstall()).toBe('kept')
    expect(mockWipe).toHaveBeenCalledTimes(1)
  })

  it('writes a missing Keychain stamp on a stamped phone', async () => {
    mockDefaults[STAMP] = 1
    expect(await settleInstall()).toBe('kept')
    expect(mockKeychain.get(STAMP)).toBe('1')
  })
})

describe('settleInstall -- failures leave the next launch to try again', () => {
  it('treats a locked Keychain as unknown, not as a reinstall', async () => {
    mockReadThrows = true
    expect(await settleInstall()).toBe('skipped')
    expect(mockWipe).not.toHaveBeenCalled()
    expect(mockDefaults[STAMP]).toBeUndefined()
  })

  it('does not record a wipe that failed', async () => {
    mockKeychain.set(STAMP, '1')
    mockWipe.mockRejectedValue(new Error('keychain is locked'))
    expect(await settleInstall()).toBe('skipped')
    expect(mockDefaults[STAMP]).toBeUndefined()
  })

  it('repairs a Keychain stamp that failed to write, on the next launch', async () => {
    expect(await settleInstall()).toBe('fresh')
    mockWriteThrows = true
    expect(await settleInstall()).toBe('skipped')
    // The defaults stamp stays, so the next launch is not read as a reinstall.
    expect(mockDefaults[STAMP]).toBe(1)
    mockWriteThrows = false
    expect(await settleInstall()).toBe('kept')
    expect(mockWipe).not.toHaveBeenCalled()
    expect(mockKeychain.get(STAMP)).toBe('1')
  })
})

describe('settleInstall -- Android', () => {
  const os = Platform.OS
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  })

  it('does nothing, since Android removes keystore entries with the app', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
    mockKeychain.set(STAMP, '1')
    expect(await settleInstall()).toBe('skipped')
    expect(mockWipe).not.toHaveBeenCalled()
    expect(Settings.get).not.toHaveBeenCalled()
  })
})
