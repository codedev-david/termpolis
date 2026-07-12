import { describe, it, expect } from 'vitest'
import {
  EGRESS_ALLOWLIST,
  isLoopback,
  judgeEndpoint,
  judgeEgress,
} from '../../src/main/egressGuard'
import type { Endpoint } from '../../src/main/egressGuard'

const ep = (host: string, port?: number, pid?: number): Endpoint => ({ host, port, pid })

describe('egressGuard — isLoopback (the "never a violation" set)', () => {
  it('treats IPv4 loopback 127.0.0.0/8 as local', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.1.2.3')).toBe(true)
    expect(isLoopback('127.255.255.255')).toBe(true)
  })

  it('treats IPv6 loopback and unspecified as local', () => {
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::')).toBe(true)
  })

  it('treats localhost (and RFC 6761 subdomains) as local, case-insensitively', () => {
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('LOCALHOST')).toBe(true)
    expect(isLoopback('app.localhost')).toBe(true)
  })

  it('treats 0.0.0.0 / 0.0.0.0/8 as local', () => {
    expect(isLoopback('0.0.0.0')).toBe(true)
  })

  it('treats RFC 1918 private ranges as local', () => {
    expect(isLoopback('10.0.0.5')).toBe(true)
    expect(isLoopback('10.255.255.254')).toBe(true)
    expect(isLoopback('192.168.1.10')).toBe(true)
    expect(isLoopback('192.168.255.1')).toBe(true)
    expect(isLoopback('172.16.0.1')).toBe(true)
    expect(isLoopback('172.20.30.40')).toBe(true)
    expect(isLoopback('172.31.255.254')).toBe(true)
  })

  it('does NOT over-claim the 172.16/12 boundary', () => {
    // 172.15.x and 172.32.x are PUBLIC — mislabelling them "local" would be a
    // silent hole in the guard.
    expect(isLoopback('172.15.0.1')).toBe(false)
    expect(isLoopback('172.32.0.1')).toBe(false)
    expect(isLoopback('172.100.1.1')).toBe(false)
  })

  it('treats 169.254.0.0/16 link-local as local', () => {
    expect(isLoopback('169.254.1.1')).toBe(true)
    expect(isLoopback('169.254.169.254')).toBe(true)
  })

  it('treats *.local (mDNS) as local', () => {
    expect(isLoopback('printer.local')).toBe(true)
    expect(isLoopback('my-mac.LOCAL')).toBe(true)
    expect(isLoopback('local')).toBe(true)
  })

  it('treats IPv6 link-local (fe80::/10) and unique-local (fc00::/7) as local', () => {
    expect(isLoopback('fe80::1')).toBe(true)
    expect(isLoopback('febf::abcd')).toBe(true)
    expect(isLoopback('fc00::1')).toBe(true)
    expect(isLoopback('fd12:3456::1')).toBe(true)
  })

  it('normalizes brackets, IPv6 zone ids and IPv4-mapped IPv6', () => {
    expect(isLoopback('[::1]')).toBe(true)
    expect(isLoopback('fe80::1%eth0')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:192.168.1.1')).toBe(true)
    expect(isLoopback('::ffff:8.8.8.8')).toBe(false)
  })

  it('is false for public addresses and real hostnames', () => {
    expect(isLoopback('8.8.8.8')).toBe(false)
    expect(isLoopback('1.2.3.4')).toBe(false)
    expect(isLoopback('151.101.0.81')).toBe(false)
    expect(isLoopback('2606:4700::1111')).toBe(false)
    expect(isLoopback('api.anthropic.com')).toBe(false)
    expect(isLoopback('evil.example.com')).toBe(false)
  })

  it('is false for empty / garbage / invalid-octet input', () => {
    expect(isLoopback('')).toBe(false)
    expect(isLoopback('   ')).toBe(false)
    expect(isLoopback('999.1.1.1')).toBe(false)
    expect(isLoopback(undefined as unknown as string)).toBe(false)
  })
})

describe('egressGuard — local endpoints are NEVER violations', () => {
  const locals = [
    '127.0.0.1',
    '::1',
    'localhost',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.0.42',
    '172.16.5.5',
    '169.254.169.254',
    'ollama.local',
    'fe80::1',
  ]

  it.each(locals)('%s → verdict "local"', (host) => {
    const j = judgeEndpoint(ep(host, 443))
    expect(j.verdict).toBe('local')
    expect(j.matchedRule).toBeUndefined()
    expect(j.reason).toBeTruthy()
  })

  it('a report of only-local endpoints is clean', () => {
    const r = judgeEgress(locals.map((h) => ep(h, 11434)))
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
    expect(r.judgements).toHaveLength(locals.length)
    expect(r.judgements.every((j) => j.verdict === 'local')).toBe(true)
  })
})

describe('egressGuard — EGRESS_ALLOWLIST shape', () => {
  it('covers the four supported agents plus package/infra', () => {
    const rules = EGRESS_ALLOWLIST.map((e) => e.rule)
    expect(rules).toContain('anthropic')
    expect(rules).toContain('openai')
    expect(rules).toContain('google')
    expect(rules).toContain('qwen')
    expect(rules).toContain('infra')
  })

  it('lists the specific provider hosts the agents need', () => {
    const all = EGRESS_ALLOWLIST.flatMap((e) => e.suffixes)
    for (const host of [
      'api.anthropic.com', 'anthropic.com', 'claude.ai', 'statsig.anthropic.com', 'sentry.io',
      'api.openai.com', 'openai.com', 'chatgpt.com',
      'generativelanguage.googleapis.com', 'googleapis.com', 'google.com', 'gstatic.com',
      'dashscope.aliyuncs.com', 'aliyuncs.com', 'modelscope.cn',
      'registry.npmjs.org', 'npmjs.org', 'github.com', 'githubusercontent.com', 'pypi.org',
    ]) {
      expect(all).toContain(host)
    }
  })

  it('every suffix is authored lowercase, bare, and dot-unanchored', () => {
    for (const entry of EGRESS_ALLOWLIST) {
      expect(entry.rule).toBe(entry.rule.toLowerCase())
      expect(entry.suffixes.length).toBeGreaterThan(0)
      for (const s of entry.suffixes) {
        expect(s).toBe(s.toLowerCase())
        expect(s.startsWith('.')).toBe(false)
        expect(s.endsWith('.')).toBe(false)
        expect(s).not.toContain('/')
        expect(s).not.toContain(':')
        expect(s).not.toContain('*')
      }
    }
  })
})

describe('egressGuard — allowlist families (exact host + subdomain)', () => {
  it('anthropic: Claude Code hosts', () => {
    for (const h of ['api.anthropic.com', 'anthropic.com', 'claude.ai', 'statsig.anthropic.com', 'sentry.io']) {
      const j = judgeEndpoint(ep(h, 443))
      expect(j.verdict).toBe('allowed')
      expect(j.matchedRule).toBe('anthropic')
    }
    // subdomains of the allowed apexes
    expect(judgeEndpoint(ep('console.anthropic.com')).matchedRule).toBe('anthropic')
    expect(judgeEndpoint(ep('www.claude.ai')).matchedRule).toBe('anthropic')
    expect(judgeEndpoint(ep('o1234567.ingest.sentry.io')).matchedRule).toBe('anthropic')
  })

  it('openai: Codex hosts', () => {
    for (const h of ['api.openai.com', 'openai.com', 'chatgpt.com']) {
      expect(judgeEndpoint(ep(h, 443)).matchedRule).toBe('openai')
    }
    expect(judgeEndpoint(ep('auth.openai.com')).verdict).toBe('allowed')
    expect(judgeEndpoint(ep('cdn.chatgpt.com')).matchedRule).toBe('openai')
  })

  it('google: Gemini CLI hosts', () => {
    for (const h of ['generativelanguage.googleapis.com', 'googleapis.com', 'google.com', 'gstatic.com']) {
      expect(judgeEndpoint(ep(h, 443)).matchedRule).toBe('google')
    }
    expect(judgeEndpoint(ep('oauth2.googleapis.com')).matchedRule).toBe('google')
    expect(judgeEndpoint(ep('www.google.com')).matchedRule).toBe('google')
    expect(judgeEndpoint(ep('fonts.gstatic.com')).matchedRule).toBe('google')
  })

  it('qwen: DashScope / Alibaba hosts', () => {
    for (const h of ['dashscope.aliyuncs.com', 'aliyuncs.com', 'modelscope.cn']) {
      expect(judgeEndpoint(ep(h, 443)).matchedRule).toBe('qwen')
    }
    expect(judgeEndpoint(ep('oss-cn-beijing.aliyuncs.com')).matchedRule).toBe('qwen')
    expect(judgeEndpoint(ep('www.modelscope.cn')).matchedRule).toBe('qwen')
  })

  it('infra: package registries + GitHub', () => {
    for (const h of ['registry.npmjs.org', 'npmjs.org', 'github.com', 'githubusercontent.com', 'pypi.org']) {
      expect(judgeEndpoint(ep(h, 443)).matchedRule).toBe('infra')
    }
    expect(judgeEndpoint(ep('raw.githubusercontent.com')).matchedRule).toBe('infra')
    expect(judgeEndpoint(ep('api.github.com')).matchedRule).toBe('infra')
    expect(judgeEndpoint(ep('files.pythonhosted.org')).verdict).toBe('violation') // NOT on the list
  })

  it('exhaustive: every allowlisted suffix, and a subdomain of it, maps to its own rule', () => {
    for (const entry of EGRESS_ALLOWLIST) {
      for (const s of entry.suffixes) {
        const exact = judgeEndpoint(ep(s))
        expect(exact.verdict).toBe('allowed')
        expect(exact.matchedRule).toBe(entry.rule)
        expect(exact.reason).toContain('allowlist')

        const sub = judgeEndpoint(ep('sub.' + s))
        expect(sub.verdict).toBe('allowed')
        expect(sub.matchedRule).toBe(entry.rule)
      }
    }
  })

  it('a report of only-allowed endpoints is clean', () => {
    const r = judgeEgress([ep('api.anthropic.com', 443), ep('registry.npmjs.org', 443)])
    expect(r.clean).toBe(true)
    expect(r.violations).toHaveLength(0)
    expect(r.summary).toContain('No egress violations')
  })
})

describe('egressGuard — SECURITY: dot-anchored suffix match (look-alike domains)', () => {
  it('evil-anthropic.com is a VIOLATION (prefix look-alike must not match anthropic.com)', () => {
    const j = judgeEndpoint(ep('evil-anthropic.com', 443))
    expect(j.verdict).toBe('violation')
    expect(j.matchedRule).toBeUndefined()
  })

  it('anthropic.com.evil.net is a VIOLATION (suffix-confusion must not match anthropic.com)', () => {
    const j = judgeEndpoint(ep('anthropic.com.evil.net', 443))
    expect(j.verdict).toBe('violation')
    expect(j.matchedRule).toBeUndefined()
  })

  const prefixLookalikes = [
    'evil-anthropic.com',
    'notanthropic.com',
    'xanthropic.com',
    'evil-claude.ai',
    'evil-sentry.io',
    'evil-openai.com',
    'notopenai.com',
    'evil-chatgpt.com',
    'evil-google.com',
    'evil-googleapis.com',
    'evil-gstatic.com',
    'evil-aliyuncs.com',
    'evil-modelscope.cn',
    'evil-github.com',
    'evil-githubusercontent.com',
    'evil-npmjs.org',
    'evil-pypi.org',
  ]
  it.each(prefixLookalikes)('prefix look-alike %s → violation', (host) => {
    expect(judgeEndpoint(ep(host)).verdict).toBe('violation')
  })

  it('exhaustive: <allowlisted-suffix>.evil.net is a violation for EVERY allowlist entry', () => {
    for (const entry of EGRESS_ALLOWLIST) {
      for (const s of entry.suffixes) {
        const j = judgeEndpoint(ep(s + '.evil.net'))
        expect(j.verdict).toBe('violation')
        expect(j.matchedRule).toBeUndefined()
      }
    }
  })

  it('INTENTIONAL: a real subdomain under an allowed apex stays allowed (DNS is provider-controlled)', () => {
    // `evil-api.anthropic.com` can only exist if Anthropic created it — the
    // registrable domain is the trust boundary, not the leftmost label.
    expect(judgeEndpoint(ep('evil-api.anthropic.com')).verdict).toBe('allowed')
  })
})

describe('egressGuard — unknown hosts and bare public IPs are violations', () => {
  const bad = [
    'evil.example.com',
    'pastebin.com',
    'exfil.attacker.io',
    'webhook.site',
    'requestbin.net',
    '8.8.8.8',
    '1.2.3.4',
    '151.101.0.81',
    '2606:4700::1111',
  ]
  it.each(bad)('%s → violation', (host) => {
    const j = judgeEndpoint(ep(host, 443))
    expect(j.verdict).toBe('violation')
    expect(j.matchedRule).toBeUndefined()
    expect(j.reason).toContain('allowlist')
  })
})

describe('egressGuard — fails closed on empty / malformed input', () => {
  it('an empty host is a violation, not a silent pass', () => {
    const j = judgeEndpoint(ep(''))
    expect(j.verdict).toBe('violation')
  })

  it('a whitespace-only host is a violation', () => {
    expect(judgeEndpoint(ep('   ')).verdict).toBe('violation')
  })

  it('a null/undefined endpoint does not throw and is a violation', () => {
    expect(judgeEndpoint(null as unknown as Endpoint).verdict).toBe('violation')
    expect(judgeEndpoint(undefined as unknown as Endpoint).verdict).toBe('violation')
    expect(judgeEndpoint({} as unknown as Endpoint).verdict).toBe('violation')
  })
})

describe('egressGuard — case-insensitivity and trailing dots', () => {
  it('uppercase provider hosts are allowed', () => {
    expect(judgeEndpoint(ep('API.ANTHROPIC.COM')).matchedRule).toBe('anthropic')
    expect(judgeEndpoint(ep('Api.OpenAI.Com')).matchedRule).toBe('openai')
  })

  it('trailing FQDN root dots are trimmed', () => {
    expect(judgeEndpoint(ep('api.anthropic.com.')).verdict).toBe('allowed')
    expect(judgeEndpoint(ep('registry.npmjs.org..')).verdict).toBe('allowed')
  })

  it('mixed case + trailing dot together', () => {
    const j = judgeEndpoint(ep('API.Anthropic.Com.'))
    expect(j.verdict).toBe('allowed')
    expect(j.matchedRule).toBe('anthropic')
  })

  it('surrounding whitespace is trimmed', () => {
    expect(judgeEndpoint(ep('  api.anthropic.com  ')).verdict).toBe('allowed')
  })

  it('LOCALHOST and 127.0.0.1 with trailing dot stay local', () => {
    expect(judgeEndpoint(ep('LocalHost')).verdict).toBe('local')
    expect(judgeEndpoint(ep('localhost.')).verdict).toBe('local')
  })

  it('case/dot normalization does NOT rescue a look-alike', () => {
    expect(judgeEndpoint(ep('EVIL-ANTHROPIC.COM')).verdict).toBe('violation')
    expect(judgeEndpoint(ep('Anthropic.Com.Evil.Net.')).verdict).toBe('violation')
  })
})

describe('egressGuard — ports and pids', () => {
  it('the verdict is host-only: a provider host on an odd port is still allowed', () => {
    expect(judgeEndpoint(ep('api.anthropic.com', 8080)).verdict).toBe('allowed')
  })

  it('echoes the caller endpoint (host as given, port, pid) back on the judgement', () => {
    const input = ep('EVIL.example.com', 4444, 12345)
    const j = judgeEndpoint(input)
    expect(j.endpoint).toBe(input)
    expect(j.endpoint.host).toBe('EVIL.example.com')
    expect(j.endpoint.port).toBe(4444)
    expect(j.endpoint.pid).toBe(12345)
  })

  it('tolerates an endpoint with no port/pid', () => {
    expect(judgeEndpoint({ host: 'api.anthropic.com' }).verdict).toBe('allowed')
  })
})

describe('egressGuard — judgeEgress report', () => {
  it('empty input is clean', () => {
    const r = judgeEgress([])
    expect(r.clean).toBe(true)
    expect(r.judgements).toEqual([])
    expect(r.violations).toEqual([])
    expect(r.summary).toBe('No egress observed')
  })

  it('non-array input does not throw and is clean', () => {
    const r = judgeEgress(null as unknown as Endpoint[])
    expect(r.clean).toBe(true)
    expect(r.judgements).toEqual([])
  })

  it('summary names the offending hosts (spec shape)', () => {
    const r = judgeEgress([
      ep('api.anthropic.com', 443),
      ep('evil.example.com', 443),
      ep('1.2.3.4', 8443),
      ep('127.0.0.1', 11434),
    ])
    expect(r.clean).toBe(false)
    expect(r.summary).toBe('2 violations (evil.example.com, 1.2.3.4)')
  })

  it('singular summary for one violation', () => {
    const r = judgeEgress([ep('api.anthropic.com'), ep('evil.example.com')])
    expect(r.summary).toBe('1 violation (evil.example.com)')
  })

  it('clean summary counts allowed vs local', () => {
    const r = judgeEgress([ep('api.anthropic.com'), ep('github.com'), ep('127.0.0.1')])
    expect(r.summary).toBe('No egress violations — 2 allowed, 1 local')
  })

  it('violations[] holds exactly the violation judgements, in input order', () => {
    const r = judgeEgress([
      ep('evil-anthropic.com'),
      ep('api.anthropic.com'),
      ep('exfil.attacker.io'),
      ep('10.0.0.1'),
    ])
    expect(r.judgements).toHaveLength(4)
    expect(r.judgements.map((j) => j.verdict)).toEqual(['violation', 'allowed', 'violation', 'local'])
    expect(r.violations).toHaveLength(2)
    expect(r.violations.map((v) => v.endpoint.host)).toEqual(['evil-anthropic.com', 'exfil.attacker.io'])
    expect(r.clean).toBe(false)
  })

  it('counts every violating connection but de-duplicates the hosts it names', () => {
    const r = judgeEgress([ep('evil.example.com', 443), ep('evil.example.com', 8443)])
    expect(r.violations).toHaveLength(2)
    expect(r.summary).toBe('2 violations (evil.example.com)')
  })

  it('normalizes the host it names in the summary', () => {
    const r = judgeEgress([ep('EVIL.Example.COM.')])
    expect(r.summary).toBe('1 violation (evil.example.com)')
  })

  it('caps the named-host list so the summary stays one line', () => {
    const r = judgeEgress([
      ep('a.evil.com'), ep('b.evil.com'), ep('c.evil.com'),
      ep('d.evil.com'), ep('e.evil.com'), ep('f.evil.com'), ep('g.evil.com'),
    ])
    expect(r.violations).toHaveLength(7)
    expect(r.summary).toBe('7 violations (a.evil.com, b.evil.com, c.evil.com, d.evil.com, e.evil.com, +2 more)')
    expect(r.summary.includes('\n')).toBe(false)
  })

  it('a lone empty-host endpoint is reported as a violation with a placeholder name', () => {
    const r = judgeEgress([ep('')])
    expect(r.clean).toBe(false)
    expect(r.summary).toBe('1 violation ((empty))')
  })

  it('the realistic swarm case: four agents, all provider traffic, is clean', () => {
    const r = judgeEgress([
      ep('api.anthropic.com', 443, 101),
      ep('statsig.anthropic.com', 443, 101),
      ep('api.openai.com', 443, 102),
      ep('generativelanguage.googleapis.com', 443, 103),
      ep('dashscope.aliyuncs.com', 443, 104),
      ep('registry.npmjs.org', 443, 105),
      ep('127.0.0.1', 3000, 101),
    ])
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('the realistic exfil case: one agent phoning home to an unexpected host', () => {
    const r = judgeEgress([
      ep('api.anthropic.com', 443, 101),
      ep('attacker-collect.xyz', 443, 101),
    ])
    expect(r.clean).toBe(false)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].endpoint.pid).toBe(101)
    expect(r.summary).toBe('1 violation (attacker-collect.xyz)')
  })
})
