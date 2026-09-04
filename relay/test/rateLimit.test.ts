import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

const UPGRADE = { Upgrade: 'websocket' }

function roomId(n: number): string {
  return n.toString(16).padStart(32, '0')
}

async function open(n: number, ip: string): Promise<number> {
  const res = await SELF.fetch(`https://relay.test/v1/pair/${roomId(n)}?role=desktop`, {
    headers: { ...UPGRADE, 'CF-Connecting-IP': ip },
  })
  res.webSocket?.accept()
  res.webSocket?.close()
  return res.status
}

describe('registration rate limit', () => {
  it('refuses a source that opens rooms faster than the limit', async () => {
    const codes: number[] = []
    for (let i = 0; i < 40; i++) codes.push(await open(i, '203.0.113.9'))
    // A quota inside a room cannot stop someone creating a million rooms; that has
    // to be refused before the room exists, or the abuse is free.
    expect(codes).toContain(429)
    expect(codes[0]).toBe(101)
  })

  it('does not penalise a different source', async () => {
    for (let i = 100; i < 140; i++) await open(i, '203.0.113.10')
    // Keying the limit globally would let one abuser lock out every other user of
    // a multi-tenant relay -- the limit would become the outage.
    expect(await open(500, '198.51.100.4')).toBe(101)
  })

  it('does not consult the rate limiter for a request it would reject anyway', async () => {
    // A malformed pairing id is refused on shape alone. Spending limiter budget on
    // it would let unparseable junk exhaust an honest client's allowance.
    for (let i = 0; i < 40; i++) {
      await SELF.fetch('https://relay.test/v1/pair/not-a-valid-id?role=desktop', {
        headers: { ...UPGRADE, 'CF-Connecting-IP': '198.51.100.7' },
      })
    }
    expect(await open(600, '198.51.100.7')).toBe(101)
  })
})
