import { SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('worker routing', () => {
  it('refuses a plain GET on the pairing path with 426', async () => {
    const res = await SELF.fetch('https://relay.test/v1/pair/' + 'a'.repeat(32))
    expect(res.status).toBe(426)
    expect(await res.text()).toMatch(/websocket/i)
  })

  it('404s an unknown path', async () => {
    const res = await SELF.fetch('https://relay.test/nope')
    expect(res.status).toBe(404)
  })

  // The pairing id is the ONLY routing key, and it comes from a stranger. A
  // permissive parse would let a caller address arbitrary Durable Object names.
  it('rejects a pairing id that is not 32 lowercase hex chars', async () => {
    const bad = ['', 'short', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33), 'a'.repeat(31)]
    for (const id of bad) {
      const res = await SELF.fetch(`https://relay.test/v1/pair/${id}`, {
        headers: { Upgrade: 'websocket' },
      })
      expect(res.status, `pairing id ${JSON.stringify(id)}`).toBe(400)
    }
  })

  it('does not treat a path-traversal id as a route', async () => {
    const res = await SELF.fetch('https://relay.test/v1/pair/../admin', {
      headers: { Upgrade: 'websocket' },
    })
    // Either the URL normalises the segment away (404: no such route) or it
    // arrives intact and fails the hex check (400). Both are refusals; what must
    // never happen is a 101 or a 5xx.
    expect([400, 404]).toContain(res.status)
  })

  it('exposes no build or platform detail in error bodies', async () => {
    const res = await SELF.fetch('https://relay.test/nope')
    expect(await res.text()).not.toMatch(/cloudflare|worker|durable|stack|at .*:\d+/i)
  })
})
