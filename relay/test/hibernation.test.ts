import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { FRAME_BURST } from '../src/quota'
import type { PairingRoom } from '../src/pairingRoom'

function room(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

/** A fresh source address per upgrade, for the same reason quotaEnforcement.test.ts
 *  has one: the registration limiter is keyed by source and is not what this file
 *  is about, and a file that drifts up against it fails pointing at the wrong
 *  thing. */
let sources = 0
function source(): string {
  sources++
  return `10.9.${(sources >> 8) & 0xff}.${sources & 0xff}`
}

async function upgrade(id: string, role: string): Promise<Response> {
  return SELF.fetch(`https://relay.test/v1/pair/${id}?role=${role}`, {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': source() },
  })
}

async function connect(id: string, role: string): Promise<WebSocket> {
  const res = await upgrade(id, role)
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status}`)
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return ws
}

function stub(id: string) {
  return env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(id))
}

/** What one connection is allowed, as the room persists it. */
interface Conn {
  role: string
  tokens: number
  spent: number
  lastSeen: number
}

describe('hibernation', () => {
  it('hands every socket to the runtime, so an evicted isolate still has a room', async () => {
    const id = room('a')
    await connect(id, 'desktop')
    await connect(id, 'device')

    // The whole point of the Hibernation API: the RUNTIME holds the sockets, so
    // the isolate can be evicted while a pair sits idle and rebuilt on the next
    // frame. A socket taken with `server.accept()` lives in this isolate and
    // nowhere else, which pins a resident copy of every idle pairing in memory
    // -- and a terminal session is idle the overwhelming majority of the time.
    await runInDurableObject(stub(id), (_instance: PairingRoom, state) => {
      expect(state.getWebSockets()).toHaveLength(2)
      expect(state.getWebSockets('desktop')).toHaveLength(1)
      expect(state.getWebSockets('device')).toHaveLength(1)
    })
  })

  it('keeps each connection quota on its own socket, where hibernation cannot lose it', async () => {
    const id = room('b')
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')
    desktop.send(new Uint8Array(64))
    await new Promise((r) => setTimeout(r, 40))

    await runInDurableObject(stub(id), (_instance: PairingRoom, state) => {
      const ws = state.getWebSockets('desktop')[0]
      const conn = ws!.deserializeAttachment() as Conn
      // Held in an isolate field, every one of these silently resets to a full
      // allowance each time the room wakes: a frame rate an idle-then-flood
      // client never meets, and a 256 MiB budget that never runs out.
      expect(conn.role).toBe('desktop')
      expect(conn.spent).toBe(64)
      expect(conn.tokens).toBeLessThan(FRAME_BURST)
      expect(conn.lastSeen).toBeGreaterThan(0)
    })
  })

  it('answers the two-peer cap from the runtime registry rather than a field', async () => {
    const id = room('c')
    await connect(id, 'desktop')

    // A map of peers is empty after an eviction, so a rehydrated room would seat
    // a SECOND desktop into a pairing that already had one -- quietly handing a
    // stranger a copy of someone else's traffic. The registry is what survives,
    // so the registry is what the cap is read from.
    expect((await upgrade(id, 'desktop')).status).toBe(409)
    await runInDurableObject(stub(id), (_instance: PairingRoom, state) => {
      expect(state.getWebSockets('desktop')).toHaveLength(1)
    })
  })

  it('tells the partner when a socket fails instead of closing', async () => {
    const id = room('d')
    await connect(id, 'desktop')
    const device = await connect(id, 'device')
    await new Promise((r) => setTimeout(r, 20))

    const said: string[] = []
    device.addEventListener('message', (e) => {
      if (typeof e.data === 'string') said.push(e.data)
    })

    // `error` and `close` are separate events and a broken connection may raise
    // only the first. The classic path listened for both; a hibernation migration
    // that wired up `webSocketClose` alone would leave the phone waiting on a
    // desktop whose socket had already failed, with the role still held against
    // its reconnect. Invoked directly because a transport failure is not
    // something a test can ask workerd to stage.
    await runInDurableObject(stub(id), (instance: PairingRoom, state) => {
      instance.webSocketError(state.getWebSockets('desktop')[0]!)
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(said.map((s) => JSON.parse(s).kind)).toContain('peer-gone')
  })
})
