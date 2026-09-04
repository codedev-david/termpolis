import { describe, it, expect } from 'vitest'
import { DeviceRegistry } from '../../src/main/remoteBridge/deviceRegistry'
import { NO_CAPABILITIES, type PairedDevice } from '../../src/main/remoteBridge/protocol'

function device(id: string, lastSeenAt = 1000): PairedDevice {
  return {
    id,
    label: `phone-${id}`,
    publicKey: `pk-${id}`,
    capabilities: { ...NO_CAPABILITIES },
    pairingId: 'f'.repeat(32),
    pairedAt: 500,
    lastSeenAt,
  }
}

describe('DeviceRegistry', () => {
  it('starts empty and grants nothing', () => {
    const r = new DeviceRegistry()
    expect(r.list()).toEqual([])
    expect(r.get('nope')).toBeUndefined()
  })

  it('adds and retrieves a device', () => {
    const r = new DeviceRegistry()
    r.add(device('a'))
    expect(r.get('a')?.label).toBe('phone-a')
    expect(r.list()).toHaveLength(1)
  })

  it('new devices hold no capabilities by default', () => {
    const r = new DeviceRegistry()
    r.add(device('a'))
    expect(r.get('a')?.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('revokes a device and reports whether it existed', () => {
    const r = new DeviceRegistry([device('a')])
    expect(r.revoke('a')).toBe(true)
    expect(r.get('a')).toBeUndefined()
    expect(r.revoke('a')).toBe(false)
  })

  it('updates capabilities and reports unknown ids', () => {
    const r = new DeviceRegistry([device('a')])
    expect(r.setCapabilities('a', { ...NO_CAPABILITIES, read: true })).toBe(true)
    expect(r.get('a')?.capabilities.read).toBe(true)
    expect(r.setCapabilities('ghost', NO_CAPABILITIES)).toBe(false)
  })

  it('touch advances lastSeenAt', () => {
    const r = new DeviceRegistry([device('a', 1000)])
    r.touch('a', 9999)
    expect(r.get('a')?.lastSeenAt).toBe(9999)
  })

  it('touch on an unknown id is a no-op, not a throw', () => {
    const r = new DeviceRegistry()
    expect(() => r.touch('ghost', 1)).not.toThrow()
  })

  it('expires only devices idle beyond the window, returning their ids', () => {
    const r = new DeviceRegistry([device('fresh', 9_000), device('stale', 1_000)])
    expect(r.expireIdle(5_000, 10_000)).toEqual(['stale'])
    expect(r.list().map((d) => d.id)).toEqual(['fresh'])
  })

  it('round-trips through toJSON so main can persist it', () => {
    const r = new DeviceRegistry([device('a')])
    expect(new DeviceRegistry(r.toJSON()).get('a')?.label).toBe('phone-a')
  })
})
