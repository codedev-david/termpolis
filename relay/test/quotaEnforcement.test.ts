import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { MAX_FRAME_BYTES, FRAME_BURST } from '../src/quota'
import type { PairingRoom } from '../src/pairingRoom'

function room(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

/** A fresh source address per upgrade.
 *
 *  The registration rate limit is keyed by source and has its own file. Sharing
 *  one key across this one left the suite sitting a single upgrade below the
 *  limit: the next test anyone added would have been refused by a limiter that is
 *  not what this file is about, and the failure would have pointed at the frame
 *  quota instead. */
let sources = 0
function source(): string {
  sources++
  return `10.${(sources >> 16) & 0xff}.${(sources >> 8) & 0xff}.${sources & 0xff}`
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

function closeEvent(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code }))
  })
}

function collect(ws: WebSocket): { text: string[]; binary: unknown[] } {
  const out = { text: [] as string[], binary: [] as unknown[] }
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') out.text.push(e.data)
    else out.binary.push(e.data)
  })
  return out
}

describe('quota enforcement', () => {
  it('closes a peer that sends an oversized frame, and tells it which limit', async () => {
    const id = room('7')
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')

    const said = collect(desktop)
    const closed = closeEvent(desktop)
    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))

    expect((await closed).code).toBe(1009) // "message too big"
    expect(said.text.map((s) => JSON.parse(s))).toContainEqual({
      kind: 'quota-exceeded',
      limit: 'frame-size',
    })
  })

  it('does not forward the oversized frame before closing', async () => {
    const id = room('8')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    const seen = collect(device)
    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await new Promise((r) => setTimeout(r, 60))
    // Enforcing after the forward would make the limit a report, not a control.
    expect(seen.binary).toEqual([])
  })

  it('accepts a frame exactly at the cap', async () => {
    const id = room('9')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    desktop.send(new Uint8Array(MAX_FRAME_BYTES))
    expect(await arrived).toBe(MAX_FRAME_BYTES)
  })

  it('cuts a peer that floods past the burst allowance', async () => {
    const id = room('0')
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')

    const said = collect(desktop)
    const closed = closeEvent(desktop)
    for (let i = 0; i < FRAME_BURST * 5; i++) desktop.send(new Uint8Array([i & 0xff]))

    expect((await closed).code).toBe(1008) // "policy violation"
    expect(said.text.map((s) => JSON.parse(s).limit)).toContain('frame-rate')
  })

  it('frees the role when a peer is cut, so an honest client can reconnect', async () => {
    const id = room('a').slice(0, 31) + 'b'
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')
    const closed = closeEvent(desktop)
    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await closed

    const res = await SELF.fetch(`https://relay.test/v1/pair/${id}?role=desktop`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(101)
  })

  it('tells the surviving peer that its partner is gone when one is cut', async () => {
    const id = room('c')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    await new Promise((r) => setTimeout(r, 20))

    const said = collect(device)
    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await new Promise((r) => setTimeout(r, 60))
    // Without this the phone would sit waiting on a desktop the relay already cut.
    expect(said.text.map((s) => JSON.parse(s))).toContainEqual({
      kind: 'peer-gone',
      role: 'desktop',
    })
  })
})

describe('per-connection byte budget', () => {
  it('cuts a peer that forwards more bytes than its connection is allowed', async () => {
    const id = room('d')
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')

    const said = collect(desktop)
    const closed = closeEvent(desktop)
    // 4 MiB budget (vitest.config.ts) against 1 MiB frames: five frames overruns
    // it, and the burst allowance of 40 leaves the rate limit out of the way so
    // this test can only fail for the reason it is named after.
    for (let i = 0; i < 5; i++) desktop.send(new Uint8Array(MAX_FRAME_BYTES))

    expect((await closed).code).toBe(1008)
    expect(said.text.map((s) => JSON.parse(s).limit)).toContain('connection-bytes')
  })

  it('gives a reconnecting peer a fresh budget', async () => {
    const id = room('e')
    let desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    const closed = closeEvent(desktop)
    for (let i = 0; i < 5; i++) desktop.send(new Uint8Array(MAX_FRAME_BYTES))
    await closed

    // The budget bounds one socket's cost. Carrying it across a reconnect would
    // make it a permanent penalty on a pairing the relay cannot even identify.
    desktop = await connect(id, 'desktop')
    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    desktop.send(new Uint8Array(MAX_FRAME_BYTES))
    expect(await arrived).toBe(MAX_FRAME_BYTES)
  })
})

describe('a cut connection cannot spend its successor budget', () => {
  it('leaves a reconnecting peer unaffected by the frames its predecessor sent', async () => {
    const id = room('f')
    const stale = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    const closed = closeEvent(stale)
    for (let i = 0; i < FRAME_BURST * 5; i++) stale.send(new Uint8Array([1]))
    await closed

    const fresh = await connect(id, 'desktop')
    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    // Looking the allowances up by role instead of holding them per connection
    // would charge the newcomer for the flood that got its predecessor cut.
    fresh.send(new Uint8Array(64))
    expect(await arrived).toBe(64)
  })
})

describe('a role the relay freed', () => {
  it('stays occupied until the incumbent has actually been dropped', async () => {
    // Why `drop` may delete by ROLE without checking which socket is leaving: the
    // seat is held for the whole of the teardown, and `fetch` answers 409 across
    // that window. A close event therefore cannot arrive for a socket some other
    // connection has already replaced -- the case a guard there would defend
    // against is unreachable, and this is what makes it unreachable.
    const id = room('1')
    const stale = await connect(id, 'desktop')
    expect((await upgrade(id, 'desktop')).status).toBe(409)

    const staleClosed = closeEvent(stale)
    stale.send(new Uint8Array(MAX_FRAME_BYTES + 1)) // cut for frame-size
    await staleClosed

    expect((await upgrade(id, 'desktop')).status).toBe(101)
  })

  it('announces peer-gone once, not once per teardown event', async () => {
    // `close` and `error` are both wired to `drop`, and a socket that errors and
    // then closes calls it twice. A second announcement would tell the phone its
    // desktop had left again -- plausibly after the desktop had reconnected.
    const id = room('5')
    const stale = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    await new Promise((r) => setTimeout(r, 20))
    const said = collect(device)

    const staleClosed = closeEvent(stale)
    stale.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await staleClosed
    await new Promise((r) => setTimeout(r, 60))

    const gone = said.text.map((t) => JSON.parse(t)).filter((m) => m.kind === 'peer-gone')
    expect(gone).toEqual([{ kind: 'peer-gone', role: 'desktop' }])
  })
})

describe('a flood does not take the room down with it', () => {
  it('keeps serving the surviving peer after the offender is cut mid-burst', async () => {
    const id = room('2')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    await new Promise((r) => setTimeout(r, 20))

    const said = collect(device)
    const closed = closeEvent(desktop)
    // Every frame sent after the one that trips the limit is already queued, and
    // each arrives at a socket the relay has just closed. Announcing the quota on
    // a closed socket throws, and an uncaught throw inside a Durable Object's
    // message handler takes the whole room down -- evicting the peer that did
    // nothing wrong, which then reconnects, which is how one client's bug becomes
    // everyone's outage.
    for (let i = 0; i < FRAME_BURST * 5; i++) desktop.send(new Uint8Array([i & 0xff]))
    await closed
    await new Promise((r) => setTimeout(r, 60))

    expect(said.text.map((s) => JSON.parse(s).kind)).toContain('peer-gone')

    // The room is still there and still pairing: the surviving device receives
    // from a desktop that reconnects after the flood.
    const fresh = await connect(id, 'desktop')
    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    fresh.send(new Uint8Array(16))
    expect(await arrived).toBe(16)
  })
})

function stub(id: string) {
  return env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(id))
}

/** `cut` is private, and deliberately so -- nothing outside the room should be
 *  able to hang up on a peer. Reaching it directly is still the only way to ask
 *  the question below, because from outside the room a cut that throws and a cut
 *  that does not look exactly alike: the socket ends up closed either way. */
function cutOf(instance: PairingRoom) {
  const room = instance as unknown as {
    cut: (sock: WebSocket, code: number, limit: string) => void
  }
  return room.cut.bind(room)
}

describe('cutting a socket that has already closed', () => {
  it('is a no-op rather than an uncaught exception', async () => {
    const id = room('3')
    await connect(id, 'desktop')

    await runInDurableObject(stub(id), (instance: PairingRoom) => {
      const sock = new WebSocketPair()[1]
      sock.accept()
      sock.close(1000, 'gone')

      // workerd refuses BOTH halves of a cut after a close -- the quota notice
      // and the close itself -- and every call site is an event listener or the
      // alarm handler, where the throw is an uncaught exception inside the
      // Durable Object rather than an error anyone can catch. A client that
      // floods past the frame rate arrives here once per frame it had already
      // queued behind the one that tripped the limit.
      expect(() => cutOf(instance)(sock, 1008, 'frame-rate')).not.toThrow()
    })
  })

  it('still announces the limit and closes when the socket is open', async () => {
    const id = room('4')
    await connect(id, 'desktop')

    await runInDurableObject(stub(id), async (instance: PairingRoom) => {
      const pair = new WebSocketPair()
      const client = pair[0]
      const sock = pair[1]
      sock.accept()
      client.accept()

      const said: string[] = []
      client.addEventListener('message', (e) => {
        if (typeof e.data === 'string') said.push(e.data)
      })
      const closed = new Promise<number>((resolve) =>
        client.addEventListener('close', (e) => resolve(e.code)),
      )

      // The guard must not be the whole method: a check that never lets anything
      // through would pass the test above and silently stop telling clients why
      // they were disconnected, which is the reconnect loop `cut` exists to
      // prevent.
      cutOf(instance)(sock, 1008, 'frame-rate')

      expect(await closed).toBe(1008)
      expect(said.map((s) => JSON.parse(s))).toEqual([
        { kind: 'quota-exceeded', limit: 'frame-rate' },
      ])
    })
  })
})
