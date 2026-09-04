import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { IDLE_TIMEOUT_MS } from '../src/quota'
import type { PairingRoom } from '../src/pairingRoom'

const UPGRADE = { Upgrade: 'websocket' }

function room(tag: string): string {
  return tag.repeat(32).slice(0, 32)
}

async function connect(id: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${id}?role=${role}`, { headers: UPGRADE })
  const ws = res.webSocket!
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return ws
}

function closeEvent(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  )
}

function stub(id: string) {
  return env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(id))
}

function peersOf(instance: PairingRoom): Map<string, { lastSeen: number }> {
  return (instance as unknown as { peers: Map<string, { lastSeen: number }> }).peers
}

describe('idle eviction', () => {
  it('closes a peer that has sent nothing for the whole idle window', async () => {
    const id = room('a')
    const desktop = await connect(id, 'desktop')
    const closed = closeEvent(desktop)

    // A socket that never speaks still costs a slot, and holds the room's only
    // desktop role against the real desktop's reconnect. Time is pushed back rather
    // than waited out: Date.now() is frozen inside a Workers invocation, so a test
    // that slept would measure nothing.
    await runInDurableObject(stub(id), (instance: PairingRoom) => {
      for (const p of peersOf(instance).values()) p.lastSeen -= IDLE_TIMEOUT_MS + 1
    })
    await runInDurableObject(stub(id), (instance: PairingRoom) => instance.alarm())

    expect((await closed).reason).toBe('idle')
  })

  it('refreshes the deadline when a peer sends, so an active session is never cut', async () => {
    const id = room('b')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    // Push BOTH peers past the deadline, then have the desktop send. If activity
    // did not refresh `lastSeen`, a session six minutes old would be evicted while
    // someone was typing into it -- and a test that only sent a frame without
    // ageing the clock first could not tell the difference, because Date.now() does
    // not advance inside a Workers invocation.
    await runInDurableObject(stub(id), (instance: PairingRoom) => {
      peersOf(instance).get('desktop')!.lastSeen -= IDLE_TIMEOUT_MS + 1
    })
    desktop.send(new Uint8Array([7]))
    await new Promise((r) => setTimeout(r, 30))
    await runInDurableObject(stub(id), (instance: PairingRoom) => instance.alarm())

    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    desktop.send(new Uint8Array(9))
    expect(await arrived).toBe(9)
  })

  it('still evicts the silent partner of an active peer', async () => {
    const id = room('e')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    const deviceClosed = closeEvent(device)

    await runInDurableObject(stub(id), (instance: PairingRoom) => {
      for (const p of peersOf(instance).values()) p.lastSeen -= IDLE_TIMEOUT_MS + 1
    })
    // Only the desktop speaks. Refreshing a shared deadline instead of a per-peer
    // one would keep a dead phone's socket alive for as long as the desktop worked.
    desktop.send(new Uint8Array([7]))
    await new Promise((r) => setTimeout(r, 30))
    await runInDurableObject(stub(id), (instance: PairingRoom) => instance.alarm())

    expect((await deviceClosed).reason).toBe('idle')
  })

  it('tells the surviving peer that an evicted partner is gone', async () => {
    const id = room('c')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    device.send(new Uint8Array([1]))

    const said: string[] = []
    device.addEventListener('message', (e) => {
      if (typeof e.data === 'string') said.push(e.data)
    })
    await runInDurableObject(stub(id), (instance: PairingRoom) => {
      peersOf(instance).get('desktop')!.lastSeen -= IDLE_TIMEOUT_MS + 1
    })
    await runInDurableObject(stub(id), (instance: PairingRoom) => instance.alarm())
    await new Promise((r) => setTimeout(r, 50))

    // The phone must learn the desktop is gone, or it will sit waiting on a
    // conversation that ended -- the same signal a deliberate disconnect gives.
    expect(said.map((s) => JSON.parse(s).kind)).toContain('peer-gone')
  })

  it('arms the alarm when a peer connects', async () => {
    const id = room('f')
    await connect(id, 'desktop')

    // Every other test in this file drives eviction by calling `alarm()` itself,
    // which proves what the handler does and nothing about whether it is ever
    // scheduled. Delete the setAlarm at connect and those tests all still pass
    // while idle eviction is, in production, entirely dead code. This is the only
    // test that reads the arming.
    const [pending, insideNow] = await runInDurableObject(stub(id), async (_i, state) => [
      await state.storage.getAlarm(),
      Date.now(),
    ])

    expect(pending).not.toBeNull()
    expect(pending! - insideNow).toBeGreaterThan(IDLE_TIMEOUT_MS - 60_000)
    expect(pending! - insideNow).toBeLessThanOrEqual(IDLE_TIMEOUT_MS)
  })

  it('stops re-arming the alarm once the room is empty', async () => {
    const id = room('d')
    const desktop = await connect(id, 'desktop')
    const closed = closeEvent(desktop)
    desktop.close(1000, 'bye')
    await closed
    await new Promise((r) => setTimeout(r, 50))

    // An empty room that keeps scheduling alarms is a Durable Object that never
    // goes away, billed forever for a pairing nobody is using.
    await runInDurableObject(stub(id), (instance: PairingRoom) => instance.alarm())
    const pending = await runInDurableObject(stub(id), (_i, state) => state.storage.getAlarm())
    expect(pending).toBeNull()
  })
})
