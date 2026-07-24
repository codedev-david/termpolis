import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EGRESS_ALLOWLIST } from '../../src/main/egressGuard'

// The DEFAULT DnsDeps lazily pull `node:dns/promises`. We mock the builtin so
// that even the no-injection path in this suite never touches a real resolver:
// a security test that silently depends on the network is a test that lies the
// first time CI runs in a sandbox.
const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn(async (_host: string): Promise<string[]> => []),
  resolve6: vi.fn(async (_host: string): Promise<string[]> => []),
}))
vi.mock('node:dns/promises', () => ({
  default: { resolve4: dnsMock.resolve4, resolve6: dnsMock.resolve6 },
  resolve4: dnsMock.resolve4,
  resolve6: dnsMock.resolve6,
}))

import {
  refreshAllowedIps,
  attributeEgress,
  _resetEgressAttributionForTests,
} from '../../src/main/egressAttribute'
import type { DnsDeps } from '../../src/main/egressAttribute'

// ---------------------------------------------------------------------------
// Fixtures: a fake DNS zone for the allowlisted hosts. Values are shaped like
// the real answers (Cloudflare/Anthropic-ish) but are fixtures — nothing here
// is looked up for real.
// ---------------------------------------------------------------------------

const ALL_HOSTS = Array.from(new Set(EGRESS_ALLOWLIST.flatMap((e) => e.suffixes)))
const RULE_OF: Record<string, string> = {}
for (const e of EGRESS_ALLOWLIST) for (const s of e.suffixes) if (!(s in RULE_OF)) RULE_OF[s] = e.rule

interface ZoneEntry { v4?: string[]; v6?: string[] }

const ZONE: Record<string, ZoneEntry> = {
  // anthropic
  'api.anthropic.com': { v4: ['160.79.104.10'], v6: ['2607:6bc0::10'] },
  'anthropic.com': { v4: ['160.79.104.11'] },
  'claude.ai': { v4: ['160.79.104.12'] },
  'statsig.anthropic.com': { v4: ['160.79.104.13'] },
  'sentry.io': { v4: ['34.120.195.249'] },
  // openai
  'api.openai.com': { v4: ['162.159.140.245'] },
  'openai.com': { v4: ['162.159.140.246'] },
  'chatgpt.com': { v4: ['104.18.32.47'] },
  // google
  'generativelanguage.googleapis.com': { v4: ['142.250.72.234'], v6: ['2607:f8b0:4005:80f::200a'] },
  'googleapis.com': { v4: ['142.250.72.235'] },
  'google.com': { v4: ['142.250.72.236'] },
  'gstatic.com': { v4: ['142.250.72.237'] },
  // infra
  'registry.npmjs.org': { v4: ['104.16.0.35'] },
  'npmjs.org': { v4: ['104.16.0.36'] },
  'github.com': { v4: ['140.82.121.4'] },
  'githubusercontent.com': { v4: ['185.199.108.133'] },
  'pypi.org': { v4: ['151.101.0.223'] },
}

const NXDOMAIN = (host: string) => Object.assign(new Error('queryA ENOTFOUND ' + host), { code: 'ENOTFOUND' })

/** A resolver over the fixture zone. Unknown host / missing family => rejects, like real DNS. */
function makeDeps(overrides: Partial<DnsDeps> = {}, clock = { t: 1_000_000 }): DnsDeps & { clock: { t: number } } {
  const deps = {
    resolve4: vi.fn(async (host: string) => {
      const z = ZONE[host]
      if (!z?.v4) throw NXDOMAIN(host)
      return z.v4
    }),
    resolve6: vi.fn(async (host: string) => {
      const z = ZONE[host]
      if (!z?.v6) throw NXDOMAIN(host)
      return z.v6
    }),
    now: vi.fn(() => clock.t),
    ...overrides,
  }
  return Object.assign(deps, { clock })
}

const TEN_MIN = 10 * 60 * 1000

beforeEach(() => {
  _resetEgressAttributionForTests()
  dnsMock.resolve4.mockReset().mockResolvedValue([])
  dnsMock.resolve6.mockReset().mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// refreshAllowedIps — forward resolution of the allowlist
// ---------------------------------------------------------------------------

describe('egressAttribute — refreshAllowedIps resolves the whole allowlist', () => {
  it('asks the resolver for EVERY suffix of EVERY rule, exactly once per family', async () => {
    const d = makeDeps()
    await refreshAllowedIps(d)

    const asked4 = (d.resolve4 as any).mock.calls.map((c: string[]) => c[0]).sort()
    const asked6 = (d.resolve6 as any).mock.calls.map((c: string[]) => c[0]).sort()
    expect(asked4).toEqual([...ALL_HOSTS].sort())
    expect(asked6).toEqual([...ALL_HOSTS].sort())
  })

  it('returns an ip -> ruleName map', async () => {
    const map = await refreshAllowedIps(makeDeps())
    expect(map).toBeInstanceOf(Map)
    expect(map.get('160.79.104.10')).toBe('anthropic') // api.anthropic.com A
    expect(map.get('2607:6bc0::10')).toBe('anthropic') // api.anthropic.com AAAA
    expect(map.get('162.159.140.245')).toBe('openai')
    expect(map.get('142.250.72.234')).toBe('google')
    expect(map.get('140.82.121.4')).toBe('infra')
  })

  it('covers every rule in the allowlist (no rule silently unresolved)', async () => {
    const map = await refreshAllowedIps(makeDeps())
    const rules = new Set(map.values())
    for (const e of EGRESS_ALLOWLIST) expect(rules.has(e.rule)).toBe(true)
  })

  it('exhaustive: every fixture IP maps back to the rule that owns its hostname', async () => {
    const map = await refreshAllowedIps(makeDeps())
    for (const host of Object.keys(ZONE)) {
      for (const ip of [...(ZONE[host].v4 ?? []), ...(ZONE[host].v6 ?? [])]) {
        expect(map.get(ip)).toBe(RULE_OF[host])
      }
    }
  })

  it('dedupes: one IP shared by several hosts of the same rule appears once', async () => {
    const shared = '104.18.32.99'
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'api.openai.com' || host === 'openai.com' || host === 'chatgpt.com') return [shared]
        throw NXDOMAIN(host)
      }),
      resolve6: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.get(shared)).toBe('openai')
    expect([...map.keys()].filter((k) => k === shared)).toHaveLength(1)
    expect(map.size).toBe(1)
  })

  it('is deterministic when two RULES share an IP: the first rule in the allowlist owns it', async () => {
    // A shared CDN front-end is a real case (google + infra can land on the same
    // anycast address). Parallel resolution must not make ownership a race.
    const shared = '203.0.113.7'
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'google.com') return [shared]        // rule "google"  (3rd)
        if (host === 'github.com') return [shared]        // rule "infra"   (5th)
        if (host === 'claude.ai') return [shared]         // rule "anthropic" (1st) — wins
        throw NXDOMAIN(host)
      }),
      resolve6: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.get(shared)).toBe('anthropic')
    expect(map.size).toBe(1)
  })

  it('never stores a loopback/private answer (DNS-rebinding hardening)', async () => {
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'api.anthropic.com') return ['127.0.0.1', '10.0.0.5', '160.79.104.10']
        throw NXDOMAIN(host)
      }),
      resolve6: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.has('127.0.0.1')).toBe(false)
    expect(map.has('10.0.0.5')).toBe(false)
    expect(map.get('160.79.104.10')).toBe('anthropic')
  })

  it('ignores garbage answers (empty strings / non-strings) without throwing', async () => {
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'github.com') return ['', '   ', null as any, 42 as any, '140.82.121.4']
        throw NXDOMAIN(host)
      }),
      resolve6: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.size).toBe(1)
    expect(map.get('140.82.121.4')).toBe('infra')
  })

  it('canonicalizes IPv6 answers so textual variants still key the map', async () => {
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
      resolve6: vi.fn(async (host: string) => {
        // Expanded + uppercase — a legal spelling of 2607:6bc0::10.
        if (host === 'api.anthropic.com') return ['2607:6BC0:0000:0000:0000:0000:0000:0010']
        throw NXDOMAIN(host)
      }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.get('2607:6bc0::10')).toBe('anthropic')
  })
})

// ---------------------------------------------------------------------------
// refreshAllowedIps — resilience. Several allowlist apexes legitimately have no
// A record; NXDOMAIN is the NORMAL case, not an error.
// ---------------------------------------------------------------------------

describe('egressAttribute — a DNS failure on one host never aborts the refresh', () => {
  it('one hostname failing A leaves every other host populated', async () => {
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'api.anthropic.com') throw new Error('EAI_AGAIN')
        const z = ZONE[host]
        if (!z?.v4) throw NXDOMAIN(host)
        return z.v4
      }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.has('160.79.104.10')).toBe(false)         // the failing host's A
    expect(map.get('2607:6bc0::10')).toBe('anthropic')   // its AAAA still resolved
    expect(map.get('160.79.104.11')).toBe('anthropic')   // sibling host in the same rule
    expect(map.get('140.82.121.4')).toBe('infra')        // an unrelated rule
  })

  it('every AAAA lookup failing (v4-only network) still yields a full v4 map', async () => {
    const d = makeDeps({
      resolve6: vi.fn(async (_host: string) => { throw new Error('ENODATA') }),
    })
    const map = await refreshAllowedIps(d)
    expect(map.get('160.79.104.10')).toBe('anthropic')
    expect(map.get('104.16.0.35')).toBe('infra')
    expect([...map.values()]).not.toContain(undefined)
    expect(map.has('2607:6bc0::10')).toBe(false)
  })

  it('a rejected lookup for a host with no records at all is a non-event', async () => {
    const d = makeDeps()
    const map = await refreshAllowedIps(d)
    // Every host in the allowlist has a fixture, so a full map came back despite
    // most hosts having NO AAAA record (rejections).
    expect(map.size).toBeGreaterThanOrEqual(ALL_HOSTS.length)
  })

  it('total DNS failure with no prior cache => empty map, and the failure is NOT cached', async () => {
    const boom = { resolve4: vi.fn(async () => { throw new Error('offline') }), resolve6: vi.fn(async () => { throw new Error('offline') }) }
    const clock = { t: 5_000 }
    const map = await refreshAllowedIps({ ...boom, now: () => clock.t })
    expect(map.size).toBe(0)

    // An empty allowed-set cached for 10 minutes would flag every provider IP as
    // exfiltration. The next poll must RETRY, not serve the failure.
    const good = makeDeps({}, clock)
    const map2 = await refreshAllowedIps(good)
    expect(good.resolve4).toHaveBeenCalled()
    expect(map2.get('160.79.104.10')).toBe('anthropic')
  })

  it('total DNS failure WITH a good cache keeps serving the last-known-good set', async () => {
    const clock = { t: 1_000 }
    const good = makeDeps({}, clock)
    const first = await refreshAllowedIps(good)
    expect(first.get('160.79.104.10')).toBe('anthropic')

    clock.t += TEN_MIN + 1 // expire the TTL so a real refresh is attempted
    const boom = {
      resolve4: vi.fn(async () => { throw new Error('offline') }),
      resolve6: vi.fn(async () => { throw new Error('offline') }),
      now: () => clock.t,
    }
    const second = await refreshAllowedIps(boom)
    expect(boom.resolve4).toHaveBeenCalled()             // it really did try
    expect(second.get('160.79.104.10')).toBe('anthropic') // stale beats blind
    expect(second.size).toBe(first.size)
  })
})

// ---------------------------------------------------------------------------
// refreshAllowedIps — caching. A poll must not become a DNS storm.
// ---------------------------------------------------------------------------

describe('egressAttribute — the allowed-IP set is cached with a TTL', () => {
  it('does NOT re-resolve inside the TTL window', async () => {
    const clock = { t: 0 }
    const d = makeDeps({}, clock)
    const first = await refreshAllowedIps(d)
    const calls = (d.resolve4 as any).mock.calls.length
    expect(calls).toBe(ALL_HOSTS.length)

    clock.t += TEN_MIN - 1
    const second = await refreshAllowedIps(d)
    expect((d.resolve4 as any).mock.calls.length).toBe(calls) // not re-resolved
    expect(second).toBe(first)                                 // same cached map
  })

  it('re-resolves once the TTL has expired, and picks up rotated IPs', async () => {
    const clock = { t: 0 }
    let a = '160.79.104.10'
    const d = makeDeps({
      resolve4: vi.fn(async (host: string) => {
        if (host === 'api.anthropic.com') return [a]
        throw NXDOMAIN(host)
      }),
      resolve6: vi.fn(async (host: string) => { throw NXDOMAIN(host) }),
    }, clock)

    const first = await refreshAllowedIps(d)
    expect(first.get('160.79.104.10')).toBe('anthropic')
    expect((d.resolve4 as any).mock.calls.length).toBe(ALL_HOSTS.length)

    a = '160.79.104.99' // provider rotated its A record
    clock.t += TEN_MIN + 1
    const second = await refreshAllowedIps(d)
    expect((d.resolve4 as any).mock.calls.length).toBe(ALL_HOSTS.length * 2)
    expect(second.get('160.79.104.99')).toBe('anthropic')
    expect(second.has('160.79.104.10')).toBe(false) // the stale IP is dropped
  })

  it('honours a custom ttlMs', async () => {
    const clock = { t: 0 }
    const d = makeDeps({}, clock)
    await refreshAllowedIps(d, 1000)
    const calls = (d.resolve4 as any).mock.calls.length

    clock.t = 999
    await refreshAllowedIps(d, 1000)
    expect((d.resolve4 as any).mock.calls.length).toBe(calls) // still fresh

    clock.t = 1001
    await refreshAllowedIps(d, 1000)
    expect((d.resolve4 as any).mock.calls.length).toBe(calls * 2) // expired
  })

  it('the default TTL is 10 minutes', async () => {
    const clock = { t: 0 }
    const d = makeDeps({}, clock)
    await refreshAllowedIps(d)
    const calls = (d.resolve4 as any).mock.calls.length

    clock.t = TEN_MIN - 1
    await refreshAllowedIps(d)
    expect((d.resolve4 as any).mock.calls.length).toBe(calls)

    clock.t = TEN_MIN + 1
    await refreshAllowedIps(d)
    expect((d.resolve4 as any).mock.calls.length).toBe(calls * 2)
  })

  it('concurrent callers share ONE in-flight resolution (four agents polling at once)', async () => {
    const d = makeDeps()
    const [m1, m2, m3, m4] = await Promise.all([
      refreshAllowedIps(d),
      refreshAllowedIps(d),
      refreshAllowedIps(d),
      refreshAllowedIps(d),
    ])
    expect((d.resolve4 as any).mock.calls.length).toBe(ALL_HOSTS.length) // once, not 4x
    expect(m2).toBe(m1)
    expect(m3).toBe(m1)
    expect(m4).toBe(m1)
  })

  it('_resetEgressAttributionForTests clears the cache', async () => {
    const clock = { t: 0 }
    const d = makeDeps({}, clock)
    await refreshAllowedIps(d)
    const calls = (d.resolve4 as any).mock.calls.length

    _resetEgressAttributionForTests()
    await refreshAllowedIps(d) // same clock — would have been a cache hit
    expect((d.resolve4 as any).mock.calls.length).toBe(calls * 2)
  })
})

// ---------------------------------------------------------------------------
// refreshAllowedIps — default deps (no injection) use node:dns/promises.
// ---------------------------------------------------------------------------

describe('egressAttribute — default DnsDeps', () => {
  it('falls back to node:dns/promises when no resolver is injected', async () => {
    dnsMock.resolve4.mockImplementation(async (host: string) =>
      host === 'api.anthropic.com' ? ['160.79.104.10'] : [])
    dnsMock.resolve6.mockRejectedValue(new Error('ENODATA'))

    const map = await refreshAllowedIps()

    expect(dnsMock.resolve4).toHaveBeenCalledWith('api.anthropic.com')
    expect(dnsMock.resolve4.mock.calls.length).toBe(ALL_HOSTS.length)
    expect(dnsMock.resolve6.mock.calls.length).toBe(ALL_HOSTS.length)
    expect(map.get('160.79.104.10')).toBe('anthropic')
  })

  it('a partial deps object keeps the real (mocked-builtin) resolver for the missing half', async () => {
    dnsMock.resolve4.mockImplementation(async (host: string) =>
      host === 'github.com' ? ['140.82.121.4'] : [])
    const resolve6 = vi.fn(async (_host: string) => [] as string[])

    const map = await refreshAllowedIps({ resolve6, now: () => 0 })

    expect(dnsMock.resolve4).toHaveBeenCalled() // default half
    expect(resolve6).toHaveBeenCalled()         // injected half
    expect(map.get('140.82.121.4')).toBe('infra')
  })

  it('uses a real clock by default (TTL still holds across calls)', async () => {
    dnsMock.resolve4.mockResolvedValue(['203.0.113.9'])
    await refreshAllowedIps()
    const calls = dnsMock.resolve4.mock.calls.length
    await refreshAllowedIps() // immediately after → inside the 10-min TTL
    expect(dnsMock.resolve4.mock.calls.length).toBe(calls)
  })
})

// ---------------------------------------------------------------------------
// attributeEgress — judging observed IP literals
// ---------------------------------------------------------------------------

const allowedMap = () => new Map<string, string>([
  ['160.79.104.10', 'anthropic'],
  ['2607:6bc0::10', 'anthropic'],
  ['162.159.140.245', 'openai'],
  ['142.250.72.234', 'google'],
  ['140.82.121.4', 'infra'],
])

describe('egressAttribute — an IP resolved from an allowlisted host is ALLOWED', () => {
  it('names the rule that owns the IP', async () => {
    const allowed = await refreshAllowedIps(makeDeps())
    const r = attributeEgress(['160.79.104.10'], allowed)
    expect(r.results).toHaveLength(1)
    expect(r.results[0].verdict).toBe('allowed')
    expect(r.results[0].matchedRule).toBe('anthropic')
    expect(r.results[0].ip).toBe('160.79.104.10')
    expect(r.results[0].reason).toContain('anthropic')
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('attributes each provider IP to its own rule', () => {
    const r = attributeEgress(
      ['160.79.104.10', '162.159.140.245', '142.250.72.234', '140.82.121.4'],
      allowedMap(),
    )
    expect(r.results.map((x) => x.matchedRule)).toEqual(['anthropic', 'openai', 'google', 'infra'])
    expect(r.results.every((x) => x.verdict === 'allowed')).toBe(true)
    expect(r.clean).toBe(true)
  })

  it('IPv6: an allowlisted AAAA is allowed and names its rule', () => {
    const r = attributeEgress(['2607:6bc0::10'], allowedMap())
    expect(r.results[0].verdict).toBe('allowed')
    expect(r.results[0].matchedRule).toBe('anthropic')
  })

  it('IPv6 textual variants (expanded / uppercase / bracketed / zone-id) still match', () => {
    const forms = [
      '2607:6BC0::10',
      '2607:6bc0:0000:0000:0000:0000:0000:0010',
      '[2607:6bc0::10]',
      '2607:6bc0::10%eth0',
    ]
    for (const f of forms) {
      const r = attributeEgress([f], allowedMap())
      expect(r.results[0].verdict, f).toBe('allowed')
      expect(r.results[0].matchedRule, f).toBe('anthropic')
    }
  })

  it('an IPv4-mapped IPv6 form of an allowed v4 is allowed', () => {
    const r = attributeEgress(['::ffff:160.79.104.10'], allowedMap())
    expect(r.results[0].verdict).toBe('allowed')
    expect(r.results[0].matchedRule).toBe('anthropic')
  })

  it('echoes the observed IP literal exactly as the poller reported it', () => {
    const r = attributeEgress(['  160.79.104.10  '], allowedMap())
    expect(r.results[0].ip).toBe('  160.79.104.10  ')
    expect(r.results[0].verdict).toBe('allowed')
  })
})

describe('egressAttribute — an unknown public IP is a VIOLATION', () => {
  const unknown = ['203.0.113.66', '8.8.8.8', '1.2.3.4', '151.101.0.81', '2606:4700::1111']

  it.each(unknown)('%s → violation', (ip) => {
    const r = attributeEgress([ip], allowedMap())
    expect(r.results[0].verdict).toBe('violation')
    expect(r.results[0].matchedRule).toBeUndefined()
    expect(r.results[0].reason).toContain('allowlist')
    expect(r.clean).toBe(false)
    expect(r.violations).toHaveLength(1)
  })

  it('a look-alike neighbouring IP of an allowed host is still a violation', () => {
    // Off-by-one in the last octet — the attacker sitting next door in the same
    // /24 as a provider must not inherit the provider's verdict.
    const r = attributeEgress(['160.79.104.11'], allowedMap())
    expect(r.results[0].verdict).toBe('violation')
  })

  it('a malformed / unparseable address fails CLOSED (violation, never a silent pass)', () => {
    for (const bad of ['', '   ', 'not:an:ip::zz', '999.1.1.1']) {
      const r = attributeEgress([bad], allowedMap())
      expect(r.results[0].verdict, bad).toBe('violation')
      expect(r.clean, bad).toBe(false)
    }
  })

  it('an EMPTY allowed map makes every public IP a violation (callers MUST skip when DNS is down)', () => {
    const r = attributeEgress(['160.79.104.10', '8.8.8.8'], new Map())
    expect(r.violations).toHaveLength(2)
    expect(r.clean).toBe(false)
  })

  it('violations[] holds exactly the violations, in input order', () => {
    const r = attributeEgress(
      ['203.0.113.66', '160.79.104.10', '198.51.100.7', '127.0.0.1'],
      allowedMap(),
    )
    expect(r.results.map((x) => x.verdict)).toEqual(['violation', 'allowed', 'violation', 'local'])
    expect(r.violations.map((v) => v.ip)).toEqual(['203.0.113.66', '198.51.100.7'])
    expect(r.clean).toBe(false)
  })
})

describe('egressAttribute — loopback / private / link-local are LOCAL, never violations', () => {
  const locals = [
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.0.42',
    '172.16.5.5',
    '172.31.255.254',
    '169.254.169.254',
    'fe80::1',
    'fe80::1%eth0',
    'fd12:3456::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ]

  it.each(locals)('%s → local', (ip) => {
    const r = attributeEgress([ip], allowedMap())
    expect(r.results[0].verdict).toBe('local')
    expect(r.results[0].matchedRule).toBeUndefined()
    expect(r.results[0].reason).toBeTruthy()
  })

  it('a poll of only-local endpoints is clean (Ollama on 127.0.0.1 must never alarm)', () => {
    const r = attributeEgress(locals, allowedMap())
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
    expect(r.results).toHaveLength(locals.length)
    expect(r.results.every((x) => x.verdict === 'local')).toBe(true)
  })

  it('does NOT over-claim the 172.16/12 boundary (172.15/172.32 are public → violations)', () => {
    const r = attributeEgress(['172.15.0.1', '172.32.0.1'], allowedMap())
    expect(r.results.map((x) => x.verdict)).toEqual(['violation', 'violation'])
  })

  it('a private IP that somehow got into the allowed map is STILL reported local', () => {
    const poisoned = new Map<string, string>([['127.0.0.1', 'anthropic']])
    const r = attributeEgress(['127.0.0.1'], poisoned)
    expect(r.results[0].verdict).toBe('local')
    expect(r.results[0].matchedRule).toBeUndefined()
  })
})

describe('egressAttribute — report shape and one-line summary', () => {
  it('an empty observed list is clean', () => {
    const r = attributeEgress([], allowedMap())
    expect(r.clean).toBe(true)
    expect(r.results).toEqual([])
    expect(r.violations).toEqual([])
    expect(r.summary).toBe('No egress observed')
  })

  it('non-array input does not throw and is clean', () => {
    const r = attributeEgress(null as unknown as string[], allowedMap())
    expect(r.clean).toBe(true)
    expect(r.results).toEqual([])
    expect(r.summary).toBe('No egress observed')
  })

  it('a clean summary counts allowed vs local', () => {
    const r = attributeEgress(['160.79.104.10', '140.82.121.4', '127.0.0.1'], allowedMap())
    expect(r.summary).toBe('No egress violations — 2 allowed, 1 local')
    expect(r.summary.includes('\n')).toBe(false)
  })

  it('a singular violation summary names the IP', () => {
    const r = attributeEgress(['160.79.104.10', '203.0.113.66'], allowedMap())
    expect(r.summary).toBe('1 violation (203.0.113.66)')
  })

  it('a plural violation summary names each offending IP once', () => {
    const r = attributeEgress(['203.0.113.66', '198.51.100.7', '203.0.113.66'], allowedMap())
    expect(r.violations).toHaveLength(3)          // three connections
    expect(r.summary).toBe('3 violations (203.0.113.66, 198.51.100.7)') // two IPs
  })

  it('caps the named IPs so the summary stays one line', () => {
    const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5', '203.0.113.6', '203.0.113.7']
    const r = attributeEgress(ips, allowedMap())
    expect(r.summary).toBe('7 violations (203.0.113.1, 203.0.113.2, 203.0.113.3, 203.0.113.4, 203.0.113.5, +2 more)')
    expect(r.summary.includes('\n')).toBe(false)
  })

  it('names an empty observation with a placeholder rather than an empty ()', () => {
    const r = attributeEgress([''], allowedMap())
    expect(r.summary).toBe('1 violation ((empty))')
  })

  it('normalizes the IP it names in the summary', () => {
    const r = attributeEgress(['[2606:4700::1111]'], allowedMap())
    expect(r.summary).toBe('1 violation (2606:4700::1111)')
  })
})

// ---------------------------------------------------------------------------
// A security check that can crash the poll loop is a security check that gets
// removed from the poll loop.
// ---------------------------------------------------------------------------

describe('egressAttribute — never throws at the caller', () => {
  it('a resolver that throws SYNCHRONOUSLY degrades to "cannot attribute", not a crash', async () => {
    const broken = {
      resolve4: (() => { throw new Error('dns module is broken') }) as unknown as DnsDeps['resolve4'],
      resolve6: (() => { throw new Error('dns module is broken') }) as unknown as DnsDeps['resolve6'],
      now: () => 0,
    }
    const map = await refreshAllowedIps(broken) // must resolve, never reject
    expect(map.size).toBe(0)
  })

  it('a synchronous resolver failure still serves the last-known-good set', async () => {
    const clock = { t: 0 }
    const first = await refreshAllowedIps(makeDeps({}, clock))
    clock.t += TEN_MIN + 1

    const broken = {
      resolve4: (() => { throw new Error('broken') }) as unknown as DnsDeps['resolve4'],
      resolve6: (() => { throw new Error('broken') }) as unknown as DnsDeps['resolve6'],
      now: () => clock.t,
    }
    const map = await refreshAllowedIps(broken)
    expect(map.get('160.79.104.10')).toBe('anthropic')
    expect(map.size).toBe(first.size)
  })

  it('a non-Map allowed argument does not throw', () => {
    const r = attributeEgress(['8.8.8.8'], null as unknown as Map<string, string>)
    expect(r.violations).toHaveLength(1)
    expect(r.clean).toBe(false)
  })

  it('non-string observations (poller garbage) fail closed', () => {
    const r = attributeEgress([null as unknown as string, undefined as unknown as string], allowedMap())
    expect(r.results.map((x) => x.verdict)).toEqual(['violation', 'violation'])
    expect(r.results[0].ip).toBe('')
    expect(r.summary).toBe('2 violations ((empty))')
  })
})

// ---------------------------------------------------------------------------
// The whole point: the poller's IP literals, judged without a false-positive storm.
// ---------------------------------------------------------------------------

describe('egressAttribute — end-to-end against a realistic poll', () => {
  it('an ordinary three-agent swarm poll (provider IPs + loopback) is CLEAN', async () => {
    const allowed = await refreshAllowedIps(makeDeps())
    const observed = [
      '160.79.104.10',      // claude → api.anthropic.com
      '2607:6bc0::10',      // claude over IPv6
      '34.120.195.249',     // claude → sentry.io
      '162.159.140.245',    // codex → api.openai.com
      '142.250.72.234',     // gemini → generativelanguage.googleapis.com
      '104.16.0.35',        // npm install
      '140.82.121.4',       // git push
      '127.0.0.1',          // local dev server
      '192.168.1.20',       // LAN
    ]
    const r = attributeEgress(observed, allowed)
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
    expect(r.summary).toBe('No egress violations — 7 allowed, 2 local')
  })

  it('the exfil case: one unexplained IP among ordinary provider traffic', async () => {
    const allowed = await refreshAllowedIps(makeDeps())
    const r = attributeEgress(['160.79.104.10', '203.0.113.66'], allowed)
    expect(r.clean).toBe(false)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].ip).toBe('203.0.113.66')
    expect(r.violations[0].matchedRule).toBeUndefined()
    expect(r.summary).toBe('1 violation (203.0.113.66)')
  })

  it('the regression this module exists to prevent: raw provider IPs are NOT violations', async () => {
    // Piping pollAgentEgress() straight into egressGuard.judgeEgress() would call
    // every one of these a violation, because they are bare public IPs.
    const allowed = await refreshAllowedIps(makeDeps())
    const providerIps = Object.values(ZONE).flatMap((z) => [...(z.v4 ?? []), ...(z.v6 ?? [])])
    const r = attributeEgress(providerIps, allowed)
    expect(r.violations).toEqual([])
    expect(r.clean).toBe(true)
  })
})
