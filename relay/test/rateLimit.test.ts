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

/** The most rooms `saturate` will open before it gives up on being refused.
 *
 *  `wrangler.toml` allows 30 per 60 seconds, so a refusal is due on the 31st
 *  request -- unless the window rolls first, which restarts the count and puts
 *  it off by up to 30 more. 61 covers that: 30 spent in a window that rolls
 *  away, then the 31 the next one needs. A second roll would need the loop to
 *  span 60 seconds, and these take under two. */
const MOST_ROOMS = 61

/** Open rooms from one source until the limiter refuses one, reporting every
 *  status seen on the way.
 *
 *  These tests used to open a fixed burst of 40 instead -- comfortably past an
 *  allowance of 30, and yet red about one run in three. The 60s window is
 *  wall-clock: it rolls wherever it likes, including halfway through a loop,
 *  and a burst of 40 split after its 15th request is 15 then 25. Neither half
 *  is over the allowance, so no 429 appears anywhere and the build reports a
 *  broken limiter that is working exactly as configured.
 *
 *  Asking until refused cannot be fooled that way: a roll costs this loop some
 *  extra requests, not its verdict.
 *
 *  `at` is where the room ids start, and every test owns a block of its own --
 *  a room id used once already is refused as a duplicate and would never reach
 *  the limiter at all. `addressFor` is given the id so a caller can vary the
 *  source address, which is the entire point of the /64 test. */
async function saturate(at: number, addressFor: (n: number) => string): Promise<number[]> {
  const codes: number[] = []
  for (let n = at; n < at + MOST_ROOMS && !codes.includes(429); n++) {
    codes.push(await open(n, addressFor(n)))
  }
  return codes
}

describe('registration rate limit', () => {
  it('refuses a source that opens rooms faster than the limit', async () => {
    const codes = await saturate(1000, () => '203.0.113.9')
    // A quota inside a room cannot stop someone creating a million rooms; that has
    // to be refused before the room exists, or the abuse is free.
    expect(codes).toContain(429)
    expect(codes[0]).toBe(101)
  })

  it('does not penalise a different source', async () => {
    await saturate(2000, () => '203.0.113.10')
    // Keying the limit globally would let one abuser lock out every other user of
    // a multi-tenant relay -- the limit would become the outage.
    expect(await open(2999, '198.51.100.4')).toBe(101)
  })

  it('does not consult the rate limiter for a request it would reject anyway', async () => {
    // A malformed pairing id is refused on shape alone. Spending limiter budget on
    // it would let unparseable junk exhaust an honest client's allowance -- so ask
    // more times than any allowance survives, then check the allowance survived.
    for (let i = 0; i < MOST_ROOMS; i++) {
      await SELF.fetch('https://relay.test/v1/pair/not-a-valid-id?role=desktop', {
        headers: { ...UPGRADE, 'CF-Connecting-IP': '198.51.100.7' },
      })
    }
    expect(await open(3999, '198.51.100.7')).toBe(101)
  })

  it('holds an IPv6 caller to one allowance per /64', async () => {
    // Keying on the address was no limit at all here. An ISP hands out a /64
    // without being asked, so a single ordinary home connection could open a room
    // per address -- eighteen quintillion of them -- while the IPv4 client next
    // door was cut off after a handful.
    const codes = await saturate(4000, (n) => `2001:db8:aaaa:bbbb::${n.toString(16)}`)
    expect(codes).toContain(429)
    expect(codes[0]).toBe(101)
  })

  it('does not penalise a neighbouring /64', async () => {
    // The other half of the trade. Aggregating wider than /64 would put unrelated
    // subscribers of one ISP on a shared counter, which is the outage the limit
    // exists to prevent rather than the abuse it exists to stop.
    await saturate(5000, (n) => `2001:db8:cccc:dddd::${n.toString(16)}`)
    expect(await open(5999, '2001:db8:cccc:dddf::1')).toBe(101)
  })

  it('counts a v4 address and its IPv4-mapped form together', async () => {
    // A dual-stack edge may report either form for one client. Two forms with two
    // counters is a free second allowance for anyone who can provoke the switch.
    //
    // The probe is what discriminates: on a counter of its own the mapped form is
    // this source's FIRST request and gets a room, so only a shared counter can
    // refuse it. But a probe is one instant, and a window that rolled between the
    // refusal `saturate` just watched happen and the probe itself would clear the
    // count and read exactly like the bug. So a 101 is not believed until a
    // second, freshly saturated attempt says the same -- two rolls would need this
    // to span 60 seconds, and it spends under two.
    let mapped = 0
    for (let attempt = 0; attempt < 2 && mapped !== 429; attempt++) {
      expect(await saturate(6000 + attempt * 100, () => '198.51.100.22')).toContain(429)
      mapped = await open(6900 + attempt, '::ffff:198.51.100.22')
    }
    expect(mapped).toBe(429)
  })
})
