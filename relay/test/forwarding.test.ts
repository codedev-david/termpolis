import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

function room(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

async function connect(id: string, role: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${id}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status}`)
  // Every peer must ask for ArrayBuffers. The default is "blob", and send() coerces
  // a Blob to a string -- so a client left on the default both misreads what it
  // receives and destroys what it sends. The relay sets this on its own half; it
  // cannot set it on yours.
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return ws
}

function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') resolve(new Uint8Array(e.data as ArrayBuffer))
    })
  })
}

function collectBinary(ws: WebSocket): unknown[] {
  const seen: unknown[] = []
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') seen.push(e.data)
  })
  return seen
}

describe('frame forwarding', () => {
  it('delivers a sealed frame byte-for-byte in both directions', async () => {
    const id = room('1')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    // Every byte value, so a charset-mangling round trip cannot pass.
    const payload = new Uint8Array(256).map((_, i) => i)
    const arriving = nextBinary(device)
    desktop.send(payload)
    expect(Array.from(await arriving)).toEqual(Array.from(payload))

    const back = new Uint8Array([0, 255, 0, 255, 0])
    const arrivingBack = nextBinary(desktop)
    device.send(back)
    expect(Array.from(await arrivingBack)).toEqual(Array.from(back))
  })

  it('does not echo a frame back to its sender', async () => {
    const id = room('2')
    const desktop = await connect(id, 'desktop')
    await connect(id, 'device')

    const echoed = collectBinary(desktop)
    desktop.send(new Uint8Array([7, 7, 7]))
    await new Promise((r) => setTimeout(r, 40))
    expect(echoed).toEqual([])
  })

  it('drops a frame addressed at nobody rather than buffering it', async () => {
    const id = room('3')
    const desktop = await connect(id, 'desktop')
    desktop.send(new Uint8Array([1, 2, 3])) // no device connected yet
    await new Promise((r) => setTimeout(r, 20))

    const device = await connect(id, 'device')
    // The device must NOT receive the frame sent before it existed. Buffering it
    // would mean the relay holds payload between connections -- exactly the
    // property the design promises it does not have.
    const seen = collectBinary(device)
    await new Promise((r) => setTimeout(r, 40))
    expect(seen).toEqual([])
  })

  it('ignores a text frame from a peer instead of acting on it', async () => {
    const id = room('4')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    // Attach AFTER the relay-authored greeting, so what is collected is only what
    // the desktop's text frames caused.
    await new Promise((r) => setTimeout(r, 20))
    const said: string[] = []
    device.addEventListener('message', (e) => {
      if (typeof e.data === 'string') said.push(e.data)
    })
    // A peer must not be able to forge the relay's own control vocabulary at its
    // partner, nor address the relay itself.
    desktop.send(JSON.stringify({ kind: 'peer-gone', role: 'device' }))
    desktop.send('{"kind":"quota-exceeded","limit":"bytes"}')
    await new Promise((r) => setTimeout(r, 40))
    expect(said).toEqual([])
  })

  it('forwards a frame that is byte-identical to a control frame, because it is binary', async () => {
    const id = room('5')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    // The relay must not sniff CONTENT to decide what is payload. A sealed frame
    // is indistinguishable from random bytes, so any content-based rule would
    // eventually swallow real traffic. Frame TYPE is the only discriminator.
    const lookalike = new TextEncoder().encode('{"kind":"hello","role":"device"}')
    const arriving = nextBinary(device)
    desktop.send(lookalike)
    expect(new TextDecoder().decode(await arriving)).toBe('{"kind":"hello","role":"device"}')
  })

  it('carries an empty frame rather than silently swallowing it', async () => {
    const id = room('6')
    const desktop = await connect(id, 'desktop')
    const device = await connect(id, 'device')

    const arriving = nextBinary(device)
    desktop.send(new Uint8Array(0))
    expect((await arriving).length).toBe(0)
  })
})
