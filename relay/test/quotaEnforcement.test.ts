import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { MAX_FRAME_BYTES, FRAME_BURST } from '../src/quota'

function room(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

async function connect(id: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${id}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
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

describe('a late close from a replaced connection', () => {
  it('does not evict the peer that took the role after it', async () => {
    const id = room('1')
    const stale = await connect(id, 'desktop')
    const device = await connect(id, 'device')
    const staleClosed = closeEvent(stale)
    stale.send(new Uint8Array(MAX_FRAME_BYTES + 1)) // cut for frame-size
    await staleClosed

    const fresh = await connect(id, 'desktop')
    const said = collect(device)
    // The old socket's own close now arrives, after the role has been re-taken.
    // Deleting by role alone would evict `fresh` and announce a `peer-gone` that
    // never happened -- a reconnect storm caused by the reconnect that fixed it.
    stale.close(1000, 'late')
    await new Promise((r) => setTimeout(r, 60))
    expect(said.text.map((s) => JSON.parse(s).kind)).not.toContain('peer-gone')

    const arrived = new Promise<number>((resolve) => {
      device.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') resolve((e.data as ArrayBuffer).byteLength)
      })
    })
    fresh.send(new Uint8Array(32))
    expect(await arrived).toBe(32)
  })
})
