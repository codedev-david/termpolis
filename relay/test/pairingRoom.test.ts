import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

function room(seed: string): string {
  return seed.repeat(32).slice(0, 32)
}

async function upgrade(id: string, role: string): Promise<Response> {
  return SELF.fetch(`https://relay.test/v1/pair/${id}?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  })
}

async function connect(id: string, role: string): Promise<WebSocket> {
  const res = await upgrade(id, role)
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status} ${await res.text()}`)
  ws.accept()
  return ws
}

function nextText(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') resolve(e.data)
    })
  })
}

describe('pairing room', () => {
  it('greets a desktop and a device with their own role', async () => {
    const id = room('a')
    const desktop = await connect(id, 'desktop')
    expect(JSON.parse(await nextText(desktop))).toEqual({ kind: 'hello', role: 'desktop' })

    const device = await connect(id, 'device')
    expect(JSON.parse(await nextText(device))).toEqual({ kind: 'hello', role: 'device' })
  })

  it('tells a waiting desktop when its device arrives', async () => {
    const id = room('b')
    const desktop = await connect(id, 'desktop')
    await nextText(desktop) // hello

    const joined = nextText(desktop)
    await connect(id, 'device')
    expect(JSON.parse(await joined)).toEqual({ kind: 'peer-joined', role: 'device' })
  })

  it('does not announce a peer to itself', async () => {
    const id = room('c')
    const desktop = await connect(id, 'desktop')
    const seen: string[] = []
    desktop.addEventListener('message', (e) => {
      if (typeof e.data === 'string') seen.push(e.data)
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(seen.map((s) => JSON.parse(s).kind)).toEqual(['hello'])
  })

  it('refuses a role that is already connected', async () => {
    const id = room('d')
    await connect(id, 'desktop')
    expect((await upgrade(id, 'desktop')).status).toBe(409)
  })

  it('refuses an unknown role', async () => {
    for (const role of ['admin', '', 'DESKTOP', 'desktop2']) {
      expect((await upgrade(room('e'), role)).status, role).toBe(400)
    }
  })

  it('keeps rooms separate: a desktop in one room is not a peer in another', async () => {
    const a = await connect(room('1'), 'desktop')
    const seen: string[] = []
    a.addEventListener('message', (e) => {
      if (typeof e.data === 'string') seen.push(JSON.parse(e.data).kind)
    })
    await connect(room('2'), 'device')
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toEqual(['hello'])
  })
})
