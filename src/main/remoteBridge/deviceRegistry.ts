import { NO_CAPABILITIES, type Capabilities, type PairedDevice } from './protocol'

/** Paired devices, in memory. Main owns persistence; this owns the rules. */
export class DeviceRegistry {
  private readonly devices = new Map<string, PairedDevice>()

  constructor(devices: PairedDevice[] = []) {
    for (const d of devices) this.devices.set(d.id, { ...d })
  }

  add(device: PairedDevice): void {
    this.devices.set(device.id, { ...device, capabilities: { ...NO_CAPABILITIES, ...device.capabilities } })
  }

  get(id: string): PairedDevice | undefined {
    return this.devices.get(id)
  }

  list(): PairedDevice[] {
    return [...this.devices.values()]
  }

  revoke(id: string): boolean {
    return this.devices.delete(id)
  }

  setCapabilities(id: string, capabilities: Capabilities): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    d.capabilities = { ...capabilities }
    return true
  }

  touch(id: string, now: number = Date.now()): void {
    const d = this.devices.get(id)
    if (d) d.lastSeenAt = now
  }

  /** Drops devices unseen for longer than maxIdleMs. Returns the ids removed. */
  expireIdle(maxIdleMs: number, now: number = Date.now()): string[] {
    const expired: string[] = []
    for (const [id, d] of this.devices) {
      if (now - d.lastSeenAt > maxIdleMs) expired.push(id)
    }
    for (const id of expired) this.devices.delete(id)
    return expired
  }

  toJSON(): PairedDevice[] {
    return this.list()
  }
}
