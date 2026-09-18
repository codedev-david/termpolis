const mockStore = new Map<string, string>()
const mockOptions: Record<string, unknown>[] = []
const mockWrites: string[] = []
let mockReadThrows = false
let mockWriteThrows = false
let mockDeleteThrows = false

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockReadThrows) throw new Error('keychain is locked')
    return mockStore.get(key) ?? null
  }),
  setItemAsync: jest.fn(async (key: string, value: string, opts?: Record<string, unknown>) => {
    if (mockWriteThrows) throw new Error('keychain is locked')
    if (opts !== undefined) mockOptions.push(opts)
    mockWrites.push(`set ${key}`)
    mockStore.set(key, value)
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    if (mockDeleteThrows) throw new Error('keychain is locked')
    mockWrites.push(`delete ${key}`)
    mockStore.delete(key)
  }),
}))

import { forgetGrant, readGrant, writeGrant } from '../src/storage/grant'

const GRANT_KEY = 'termpolis.remote.relay-grant.v1'

beforeEach(() => {
  mockStore.clear()
  mockOptions.length = 0
  mockWrites.length = 0
  mockReadThrows = false
  mockWriteThrows = false
  mockDeleteThrows = false
})

describe('the cached grant -- writing it', () => {
  it('records the answer and the moment it was given', async () => {
    // Both halves matter. "Entitled" without a timestamp is a grant that never
    // expires, which is a subscription that cannot be cancelled by anything
    // short of reinstalling.
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    await writeGrant(true)
    expect(JSON.parse(mockStore.get(GRANT_KEY) ?? 'null')).toEqual({
      entitled: true,
      at: 1_700_000_000_000,
    })
    jest.restoreAllMocks()
  })

  it('records a refusal as firmly as a grant', async () => {
    // Not an absence. "The store said no" overwrites a stale yes, which is the
    // whole reason a cancellation takes effect at the next launch rather than
    // in three days' time.
    await writeGrant(true)
    await writeGrant(false)
    expect(JSON.parse(mockStore.get(GRANT_KEY) ?? 'null').entitled).toBe(false)
  })

  it('locks the value to this device, unlocked', async () => {
    // Same protection the pairing keys get. A grant that syncs to a backup and
    // restores onto another phone is access the App Store never sold.
    await writeGrant(true)
    expect(mockOptions).toContainEqual({ keychainAccessible: 'whenUnlockedThisDeviceOnly' })
  })

  it('does not take the boot down when the keychain refuses', async () => {
    // The cost of failing here is one extra App Store lookup next launch. The
    // cost of throwing is the app.
    mockWriteThrows = true
    await expect(writeGrant(true)).resolves.toBeUndefined()
  })
})

describe('the cached grant -- reading it back', () => {
  it('returns nothing when none was ever written', async () => {
    await expect(readGrant()).resolves.toBeNull()
  })

  it('returns what was written', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    await writeGrant(true)
    jest.restoreAllMocks()
    await expect(readGrant()).resolves.toEqual({ entitled: true, at: 1_700_000_000_000 })
  })

  it('treats a locked keychain as no grant rather than as a refusal', async () => {
    // Face ID not yet given. The App Store is about to be asked anyway, and
    // "we could not look" must not be recorded as "you have not paid".
    await writeGrant(true)
    mockReadThrows = true
    await expect(readGrant()).resolves.toBeNull()
  })

  it.each([
    ['not JSON at all', 'not json'],
    ['a bare string', '"yes"'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a grant with no verdict', '{"at":1700000000000}'],
    ['a verdict that is a string', '{"entitled":"true","at":1700000000000}'],
    ['a grant with no timestamp', '{"entitled":true}'],
    ['a timestamp that is a string', '{"entitled":true,"at":"1700000000000"}'],
  ])('refuses to understand %s', async (_name, raw) => {
    // A grant is a claim about money. Half-understood, it is re-asked rather
    // than repaired -- guessing wrong either gives the app away or bills
    // somebody who already paid.
    mockStore.set(GRANT_KEY, raw)
    await expect(readGrant()).resolves.toBeNull()
  })
})

describe('the cached grant -- destroying it', () => {
  it('leaves nothing behind for the next owner of the phone', async () => {
    await writeGrant(true)
    await forgetGrant()
    expect(mockStore.has(GRANT_KEY)).toBe(false)
    await expect(readGrant()).resolves.toBeNull()
  })

  it('does not take the erase down when the keychain refuses', async () => {
    // `forgetEverything` deletes key material first. A throw here would abort
    // an erase that has already done the part that matters.
    mockDeleteThrows = true
    await expect(forgetGrant()).resolves.toBeUndefined()
  })
})
