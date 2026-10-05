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

  /** The caller sanitises; this only stores. */
  setLabel(id: string, label: string): boolean {
    const d = this.devices.get(id)
    if (!d) return false
    d.label = label
    return true
  }

  touch(id: string, now: number = Date.now()): void {
    const d = this.devices.get(id)
    if (d) d.lastSeenAt = now
  }

  /** Drops devices unseen for longer than maxIdleMs. Returns the ids removed.
   *
   *  Linked computers are exempt. `lastSeenAt` counts only requests that come
   *  IN, so a link this machine mostly asks rather than answers would read as
   *  idle while in daily use -- and a link is a relationship the user ends by
   *  unlinking, not a lost handset whose key should lapse on its own. */
  expireIdle(maxIdleMs: number, now: number = Date.now()): string[] {
    const expired: string[] = []
    for (const [id, d] of this.devices) {
      if (d.kind === 'desktop') continue
      if (now - d.lastSeenAt > maxIdleMs) expired.push(id)
    }
    for (const id of expired) this.devices.delete(id)
    return expired
  }

  toJSON(): PairedDevice[] {
    return this.list()
  }
}
