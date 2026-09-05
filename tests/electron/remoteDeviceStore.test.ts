import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PairedDevice } from '../../src/main/remoteBridge/protocol'
import {
  loadRemoteDevices,
  remoteDevicesPath,
  saveRemoteDevices,
} from '../../src/main/remoteDeviceStore'

const device = (over: Partial<PairedDevice> = {}): PairedDevice => ({
  id: 'a1b2c3d4e5f60718',
  label: 'Pixel 9 Pro',
  publicKey: '0f'.repeat(32),
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  capabilities: { read: true, createTerminal: false, writeToTerminal: false, closeTerminal: true },
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_090_000,
  ...over,
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-devices-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** What a file on disk actually holds, so a test can write malformed entries. */
function writeRaw(value: unknown): void {
  fs.writeFileSync(remoteDevicesPath(dir), JSON.stringify(value), 'utf8')
}

describe('remoteDeviceStore', () => {
  it('round-trips a device list', () => {
    const devices = [device(), device({ id: 'ffffffffffffffff', label: 'iPhone 17' })]
    saveRemoteDevices(dir, devices)
    expect(loadRemoteDevices(dir)).toEqual(devices)
  })

  it('returns an empty list when the file is missing or unreadable', () => {
    expect(loadRemoteDevices(dir)).toEqual([])
    fs.writeFileSync(remoteDevicesPath(dir), '{ not json')
    expect(loadRemoteDevices(dir)).toEqual([])
    // A JSON document that parses but is not a list of devices is no better.
    writeRaw({ devices: [device()] })
    expect(loadRemoteDevices(dir)).toEqual([])
  })

  it('drops entries missing an id, publicKey or sessionRoomId', () => {
    // Every one of these is load-bearing: the id addresses the device, the public
    // key is what it authenticates with, and the room id is where the desktop
    // dials. A half-written entry is not a device with gaps -- it is not a device.
    writeRaw([
      { ...device(), id: '' },
      { ...device(), publicKey: undefined },
      { ...device(), sessionRoomId: 42 },
      'not an object',
      null,
      device({ id: 'keepme0000000000' }),
    ])
    expect(loadRemoteDevices(dir).map((d) => d.id)).toEqual(['keepme0000000000'])
  })

  it('reads an absent capability flag as false rather than trusting the file', () => {
    // This file decides what a phone may do. A capability that is missing --
    // hand-edited out, written by an older build, truncated mid-write -- must
    // deny. Anything else grants permission by omission.
    writeRaw([{ ...device(), capabilities: { read: true } }])
    expect(loadRemoteDevices(dir)[0].capabilities).toEqual({
      read: true,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    })
  })

  it('coerces a non-boolean capability to false instead of letting it be truthy', () => {
    // `'false'`, `1` and `{}` are all truthy in JS. A capability check written as
    // `if (caps.writeToTerminal)` would grant every one of them.
    writeRaw([
      {
        ...device(),
        capabilities: {
          read: 'false',
          createTerminal: 1,
          writeToTerminal: {},
          closeTerminal: true,
        },
      },
    ])
    expect(loadRemoteDevices(dir)[0].capabilities).toEqual({
      read: false,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: true,
    })
  })

  it('drops unknown keys and repairs missing scalars', () => {
    writeRaw([{ ...device(), evil: 'payload', label: undefined, pairedAt: 'soon' }])
    const [loaded] = loadRemoteDevices(dir)
    expect(loaded).not.toHaveProperty('evil')
    expect(loaded.label).toBe('')
    expect(loaded.pairedAt).toBe(0)
  })

  it('swallows a write error rather than taking the app down', () => {
    // Persistence failing is bad; an unhandled throw out of a pairing handler is
    // worse -- the device is already paired in memory by the time we save.
    expect(() => saveRemoteDevices(path.join(dir, 'no', 'such'), [device()])).not.toThrow()
  })
})
