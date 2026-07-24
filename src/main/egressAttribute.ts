// Egress attribution — the missing layer between the egress RECORD and the
// egress POLICY.
//
// egressAudit.ts asks the OS which remote endpoints an agent has open. netstat,
// ss and lsof do not reverse-DNS, so what comes back is a list of bare IP
// LITERALS: `160.79.104.10`, `2607:6bc0::10`. egressGuard.ts judges by HOSTNAME
// and — correctly, by its own fail-closed doctrine — calls an unattributable
// public IP a violation. Wire the poller straight into the guard and every
// ordinary conversation with Anthropic lights up as exfiltration. A security
// signal that fires on the product working is a signal that gets muted in a day,
// and a muted signal protects nobody. This module is the attribution step that
// makes the pipe honest: it decides which observed IPs belong to an allowlisted
// host, so the guard's verdict can be trusted.
//
// WHY FORWARD RESOLUTION (host -> IPs) AND NOT PTR (IP -> host):
//   - PTR records for CDN-fronted APIs almost never map back to the provider.
//     api.anthropic.com sits behind Cloudflare; the PTR for its address is a
//     Cloudflare edge name (or nothing at all). Judging by PTR would flag
//     ordinary provider traffic — the exact false-positive storm we exist to
//     prevent — while a lookup that returns NXDOMAIN teaches us nothing.
//   - PTR is attacker-controlled in the direction that matters. The operator of
//     an IP block writes its own reverse zone, so an exfil host can publish
//     `api.anthropic.com` as its PTR. Trusting that is trusting the suspect's
//     own testimony. Forward records live in the PROVIDER's zone: only Anthropic
//     can put an address into api.anthropic.com's A record.
//   - Forward resolution asks the question we actually mean. The agent resolved
//     the same hostname, from the same machine, through the same resolver, moments
//     ago — so the address it connected to is overwhelmingly likely to be in the
//     set that hostname resolves to for us right now. We reconstruct the agent's
//     own DNS answer instead of guessing at the IP's identity.
//   - It is one cheap batch of lookups, cached for 10 minutes, instead of a PTR
//     round-trip per observed connection on every poll.
//
// HONEST LIMITS (read before trusting a verdict):
//   - Shared resolver, shared fate. This layer trusts the same DNS the agent
//     trusts. A poisoned resolver fools both. This is an ATTRIBUTION control, not
//     a DNS-integrity control.
//   - Large anycast pools rotate. If the agent connected to a pool member that
//     our refresh did not see, we will call it a violation. That is why the
//     verdict is an audit entry for the human to review, never a block — and why
//     the TTL is short enough to track rotation but long enough not to be a DNS
//     storm.
//   - Several allowlist apexes (e.g. githubusercontent.com) have no A
//     record at all. NXDOMAIN on an individual host is the NORMAL case here, not
//     an error — which is precisely why one failing lookup must never abort the
//     refresh.
//   - An EMPTY allowed-IP map means DNS failed, NOT that everything is hostile.
//     `attributeEgress` will dutifully call every public IP a violation, because
//     a pure function must not silently invent a pass. The CALLER is responsible
//     for skipping judgement when `allowed.size === 0`. See the refresh below:
//     we never cache an empty result, and we keep serving the last-known-good set
//     rather than a blank one.
//
// No electron, no fs, no ambient clock: DNS and time are injected, so the whole
// module is deterministic under test and no unit test ever touches the network.

import { isLoopback, EGRESS_ALLOWLIST } from './egressGuard'

export interface DnsDeps {
  resolve4: (host: string) => Promise<string[]>
  resolve6: (host: string) => Promise<string[]>
  now: () => number
}

export type AttributionVerdict = 'allowed' | 'violation' | 'local'

export interface AttributedEgress {
  /** The observed literal, echoed exactly as the poller reported it. */
  ip: string
  verdict: AttributionVerdict
  /** Which allowlist rule owned this IP, e.g. 'anthropic'. Absent for local + violation. */
  matchedRule?: string
  /** One line, safe to render straight into the security panel. */
  reason: string
}

export interface AttributionReport {
  results: AttributedEgress[]
  violations: AttributedEgress[]
  clean: boolean
  summary: string
}

/** 10 minutes: long enough that a poll is not a DNS storm, short enough to track rotation. */
const DEFAULT_TTL_MS = 10 * 60 * 1000

/** How many distinct IPs the one-line summary names before it elides. */
const MAX_SUMMARY_IPS = 5

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

// ---------------------------------------------------------------------------
// Default DnsDeps. `node:dns/promises` is pulled at CALL time, never at module
// load: src/main is imported by test harnesses that stub node builtins, and a
// top-level import of a builtin has taken this process down before (see the same
// note in egressAudit.ts). Nothing here imports electron.
// ---------------------------------------------------------------------------
// Memoized so a refresh loads the module ONCE and then fans out, instead of
// firing one dynamic import per hostname per family (40 for the current
// allowlist) and racing the module loader with itself.
let dnsPromise: Promise<typeof import('node:dns/promises')> | null = null
function loadDns(): Promise<typeof import('node:dns/promises')> {
  if (!dnsPromise) dnsPromise = import('node:dns/promises')
  return dnsPromise
}

const defaultDeps: DnsDeps = {
  resolve4: async (host: string) => (await loadDns()).resolve4(host),
  resolve6: async (host: string) => (await loadDns()).resolve6(host),
  now: () => Date.now(),
}

// ip -> ruleName. Module-level because the whole point is to NOT re-resolve on
// every poll of every terminal.
let cachedMap: Map<string, string> | null = null
let cachedAt = 0
// One resolution in flight at a time. Four agents polling at once must produce
// one batch of lookups, not four.
let inflight: Promise<Map<string, string>> | null = null

/**
 * Canonical form of an address for exact-map comparison. netstat prints
 * `[2607:6bc0::10]`, lsof/ss print zone ids (`fe80::1%eth0`), and DNS may answer
 * with an expanded, upper-cased IPv6 spelling — all of which are the SAME address
 * and must key the same map entry.
 */
function normalizeIp(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let ip = raw.trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  const pct = ip.indexOf('%')
  if (pct !== -1) ip = ip.slice(0, pct)
  while (ip.endsWith('.')) ip = ip.slice(0, -1)
  // IPv4-mapped IPv6 (`::ffff:160.79.104.10`) carries a v4 address — key it as one,
  // BEFORE any v6 canonicalization (which would re-spell the tail as hex).
  if (ip.startsWith('::ffff:') && IPV4_RE.test(ip.slice(7))) ip = ip.slice(7)
  if (ip.includes(':')) ip = canonicalizeIpv6(ip)
  return ip
}

/**
 * Compress an IPv6 literal to its canonical text form via the WHATWG URL parser
 * (`2607:6bc0:0000:0000:0000:0000:0000:0010` -> `2607:6bc0::10`). Zero deps, and
 * it is the difference between an allowed AAAA matching and silently missing.
 * A string that is not a valid IPv6 literal is handed back untouched — it will
 * simply never match the allowed map, i.e. it fails closed.
 */
function canonicalizeIpv6(ip: string): string {
  try {
    const h = new URL('http://[' + ip + ']/').hostname
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  } catch {
    return ip
  }
}

/** Every allowlisted hostname, deduped, each owned by the FIRST rule that lists it. */
function allowlistJobs(): { rule: string; host: string }[] {
  const jobs: { rule: string; host: string }[] = []
  const seen = new Set<string>()
  for (const entry of EGRESS_ALLOWLIST) {
    for (const suffix of entry.suffixes) {
      const host = String(suffix ?? '').trim().toLowerCase()
      if (!host || seen.has(host)) continue
      seen.add(host)
      jobs.push({ rule: entry.rule, host })
    }
  }
  return jobs
}

/**
 * A + AAAA for one host. NEVER rejects: `allSettled` is the whole requirement —
 * githubusercontent.com has no A record, and a single
 * NXDOMAIN must not take the other hosts down with it.
 */
async function resolveHost(d: DnsDeps, host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.allSettled([d.resolve4(host), d.resolve6(host)])
  const out: string[] = []
  if (a.status === 'fulfilled' && Array.isArray(a.value)) out.push(...a.value)
  if (aaaa.status === 'fulfilled' && Array.isArray(aaaa.value)) out.push(...aaaa.value)
  return out
}

async function resolveAll(d: DnsDeps): Promise<Map<string, string>> {
  const jobs = allowlistJobs()
  // Resolve in parallel, but MERGE in allowlist order: two rules can legitimately
  // land on one shared CDN address, and which rule owns it must not depend on
  // which lookup happened to finish first.
  const answers = await Promise.all(jobs.map((j) => resolveHost(d, j.host)))

  const fresh = new Map<string, string>()
  jobs.forEach((job, i) => {
    for (const raw of answers[i]) {
      const ip = normalizeIp(raw)
      if (!ip) continue
      // A provider host that resolves to loopback/RFC-1918 is a DNS-rebinding
      // answer, not a provider address. Nothing is lost by dropping it — such an
      // address is judged 'local' anyway — and the allowed set stays a set of
      // addresses that can actually carry data off the machine.
      if (isLoopback(ip)) continue
      if (!fresh.has(ip)) fresh.set(ip, job.rule)
    }
  })

  if (fresh.size === 0) {
    // Total DNS failure (offline, resolver down, DNS blocked on the network).
    // Caching an empty allowed-set for ten minutes would turn every provider IP
    // into "possible exfiltration" — the storm this module exists to prevent.
    // Serve the last-known-good set (a provider address from ten minutes ago is
    // still a provider address) and, by leaving cachedAt untouched, retry on the
    // very next poll rather than sitting on the failure.
    if (cachedMap && cachedMap.size > 0) return cachedMap
    return fresh
  }

  cachedMap = fresh
  cachedAt = d.now()
  return fresh
}

/**
 * Resolve every allowlisted hostname to its current A/AAAA addresses and return
 * an `ip -> ruleName` map. Cached; re-resolved only once `ttlMs` has elapsed.
 * Never rejects, never throws: a security check that can crash the poll loop is
 * a security check that gets removed from the poll loop.
 */
export async function refreshAllowedIps(
  deps: Partial<DnsDeps> = {},
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Map<string, string>> {
  const d: DnsDeps = {
    resolve4: deps.resolve4 ?? defaultDeps.resolve4,
    resolve6: deps.resolve6 ?? defaultDeps.resolve6,
    now: deps.now ?? defaultDeps.now,
  }

  if (cachedMap && d.now() - cachedAt < ttlMs) return cachedMap
  if (inflight) return inflight

  inflight = resolveAll(d)
    .catch(() => cachedMap ?? new Map<string, string>())
    .finally(() => { inflight = null })
  return inflight
}

/**
 * Judge observed IP literals against the cached allowed-IP map.
 *
 * Pure. Loopback/private/link-local is 'local' (never egress at all), a member of
 * the allowed map is 'allowed' and carries its rule, and anything else public is
 * a 'violation'. An empty `allowed` map means DNS failed — see the header: the
 * caller must skip judgement in that case rather than cry wolf.
 */
export function attributeEgress(ips: string[], allowed: Map<string, string>): AttributionReport {
  const list = Array.isArray(ips) ? ips : []
  const map = allowed instanceof Map ? allowed : new Map<string, string>()
  const results = list.map((raw) => attributeOne(raw, map))
  const violations = results.filter((r) => r.verdict === 'violation')
  return {
    results,
    violations,
    clean: violations.length === 0,
    summary: summarize(results, violations),
  }
}

function attributeOne(raw: string, allowed: Map<string, string>): AttributedEgress {
  const ip = normalizeIp(raw)

  // Fail closed, exactly as egressGuard does: "I could not parse this" is not the
  // same as "this is fine".
  if (!ip) {
    return {
      ip: typeof raw === 'string' ? raw : '',
      verdict: 'violation',
      reason: 'Empty or unparseable address — cannot be attributed to any allowlisted host',
    }
  }

  // Checked BEFORE the map so a rebinding answer can never launder a private
  // address into "allowed by rule X".
  if (isLoopback(ip)) {
    return {
      ip: raw,
      verdict: 'local',
      reason: ip + ' is loopback/private/link-local — traffic never leaves the machine',
    }
  }

  const rule = allowed.get(ip)
  if (rule) {
    return {
      ip: raw,
      verdict: 'allowed',
      matchedRule: rule,
      reason: ip + ' is a current address of allowlist rule "' + rule + '" (forward-resolved from its hostnames)',
    }
  }

  return {
    ip: raw,
    verdict: 'violation',
    reason: ip + ' does not resolve from any host on the AI-provider allowlist — possible exfiltration',
  }
}

// One line, because this lands in a toast and in the audit log's `notes` field.
// Counts CONNECTIONS but names ADDRESSES: two sockets to the same collector is
// two violations and one name.
function summarize(results: AttributedEgress[], violations: AttributedEgress[]): string {
  if (results.length === 0) return 'No egress observed'

  if (violations.length === 0) {
    const allowed = results.filter((r) => r.verdict === 'allowed').length
    const local = results.filter((r) => r.verdict === 'local').length
    return 'No egress violations — ' + allowed + ' allowed, ' + local + ' local'
  }

  const ips: string[] = []
  for (const v of violations) {
    const ip = normalizeIp(v.ip) || '(empty)'
    if (!ips.includes(ip)) ips.push(ip)
  }
  const shown = ips.slice(0, MAX_SUMMARY_IPS)
  const more = ips.length - shown.length
  const named = shown.join(', ') + (more > 0 ? ', +' + more + ' more' : '')
  const n = violations.length
  return n + (n === 1 ? ' violation (' : ' violations (') + named + ')'
}

export function _resetEgressAttributionForTests(): void {
  cachedMap = null
  cachedAt = 0
  inflight = null
}
