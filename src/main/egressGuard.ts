// Egress guard — turns the egress *record* into an egress *policy*.
//
// egressAudit.ts already asks the OS which remote endpoints each agent has open
// (`pollAgentEgress`) and writes them to the audit log. That only ever
// OBSERVED: a user who never opens the log learns nothing, and "Claude talked
// to 41 hosts today" is not a signal — it's homework. This module supplies the
// missing half: a judgement. We hold every observed endpoint against the set of
// hosts the four supported agents legitimately need, and anything outside that
// set is a violation.
//
// That one bit is the whole point. An agent talking to api.anthropic.com is the
// product working. An agent talking to a host nobody put on the list is the
// exfiltration signal we actually care about — a prompt-injected agent POSTing
// your repo to a collector, a compromised npm postinstall, a rogue MCP server
// phoning home. The allowlist is small precisely so that "not on it" stays loud.
//
// Design choices:
//   - Pure. No fs, no network, no electron, no clock. The caller passes the
//     endpoints in and gets a report back. Everything here is deterministic and
//     unit-testable, which is the only way a security check earns trust.
//   - Suffix matching is DOT-ANCHORED (host === suffix || host.endsWith('.' + suffix)).
//     A naive `includes`/`endsWith` lets `evil-anthropic.com` and
//     `anthropic.com.evil.net` walk straight through the guard — those are the
//     two shapes an attacker actually registers, and they are the tests that
//     matter most in the suite. The registrable domain is the trust boundary:
//     a subdomain UNDER an allowed apex stays allowed, because only the provider
//     controls that DNS zone.
//   - Loopback / RFC-1918 / link-local / mDNS are their own verdict ('local'),
//     never a violation. Local model servers (Ollama on 127.0.0.1:11434), the
//     dev server, and LAN peers are not egress at all, and a guard that cries
//     wolf about them gets muted within a day.
//   - Fail closed. An empty or unparseable host is a violation, not a pass:
//     "I could not attribute this" is not the same as "this is fine", and silence
//     is the one outcome a security check must never produce by accident.
//
// INTEGRATION NOTE (deliberate, read before wiring this to egressAudit):
// `pollAgentEgress` returns IP literals — netstat/ss/lsof do not reverse-DNS and
// egressAudit explicitly refuses to. A bare public IP is judged a violation here
// because an unattributable address is not proof of a known provider. So feeding
// raw poll output straight into judgeEgress() will flag ordinary traffic. The
// caller is expected to hand us HOSTNAMES (from a DNS/SNI map, or a resolver
// layer). Keeping that resolution outside this module is what keeps the module
// pure — and keeps the policy honest about what it can and cannot prove.

export interface Endpoint {
  host: string
  port?: number
  pid?: number
}

export type EgressVerdict = 'allowed' | 'violation' | 'local'

export interface EgressJudgement {
  endpoint: Endpoint
  /** 'allowed' = known provider, 'local' = never leaves the box, 'violation' = unexplained. */
  verdict: EgressVerdict
  /** Which allowlist entry allowed it, e.g. 'anthropic'. Absent for local + violation. */
  matchedRule?: string
  /** One line, safe to render straight into the security panel. */
  reason: string
}

export interface EgressReport {
  judgements: EgressJudgement[]
  violations: EgressJudgement[]
  clean: boolean
  summary: string
}

// The known-good AI provider + infra hosts. Exported so the UI can show the user
// exactly what policy is being applied — an allowlist the user cannot read is an
// allowlist the user cannot trust.
//
// Entries are bare, lowercase, dot-unanchored registrable domains (or the exact
// endpoints we want documented). Matching is suffix-based, so listing both
// `anthropic.com` and `api.anthropic.com` is redundant by design: the apex does
// the work, the specific host records intent for whoever reads this next.
export const EGRESS_ALLOWLIST: { rule: string; suffixes: string[] }[] = [
  // Claude Code. sentry.io is Claude Code's own crash/telemetry sink — it is
  // first-party traffic from our point of view, and omitting it would make the
  // guard scream on every clean install.
  { rule: 'anthropic', suffixes: ['api.anthropic.com', 'anthropic.com', 'claude.ai', 'statsig.anthropic.com', 'sentry.io'] },
  // Codex.
  { rule: 'openai', suffixes: ['api.openai.com', 'openai.com', 'chatgpt.com'] },
  // Gemini CLI (googleapis.com covers oauth2/cloudcode/generativelanguage).
  { rule: 'google', suffixes: ['generativelanguage.googleapis.com', 'googleapis.com', 'google.com', 'gstatic.com'] },
  // Qwen Code → DashScope / Model Studio / ModelScope.
  { rule: 'qwen', suffixes: ['dashscope.aliyuncs.com', 'aliyuncs.com', 'modelscope.cn'] },
  // Package + source infra every agent reaches for while it works. Not AI
  // providers, but blocking-by-alarm on `npm install` would be pure noise.
  { rule: 'infra', suffixes: ['registry.npmjs.org', 'npmjs.org', 'github.com', 'githubusercontent.com', 'pypi.org'] },
]

// How many distinct hosts the one-line summary names before it elides.
const MAX_SUMMARY_HOSTS = 5

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

// Canonical form of a host for comparison: lowercase, no surrounding whitespace,
// no brackets, no IPv6 zone id, no trailing FQDN root dot. `API.Anthropic.Com.`
// and `api.anthropic.com` are the same host and must judge the same.
function normalizeHost(host: unknown): string {
  if (typeof host !== 'string') return ''
  let h = host.trim().toLowerCase()
  // `[::1]` — the bracketed form netstat/lsof print for IPv6.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  // `fe80::1%eth0` — the scope/zone id is not part of the address.
  const pct = h.indexOf('%')
  if (pct !== -1) h = h.slice(0, pct)
  // The root label. `anthropic.com.` is a legal FQDN spelling of anthropic.com;
  // a guard that treats them differently is a guard with a bypass.
  while (h.endsWith('.')) h = h.slice(0, -1)
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — judge the address it actually carries.
  if (h.startsWith('::ffff:') && IPV4_RE.test(h.slice(7))) h = h.slice(7)
  return h
}

// Dot-anchored suffix match. THE security-critical primitive in this file:
//   'api.anthropic.com'  vs 'anthropic.com' → true   (subdomain)
//   'anthropic.com'      vs 'anthropic.com' → true   (exact)
//   'evil-anthropic.com' vs 'anthropic.com' → false  (prefix look-alike)
//   'anthropic.com.evil.net' vs 'anthropic.com' → false (suffix confusion)
// `host` must already be normalized; `suffix` is lowercased defensively so a
// future mis-cased allowlist entry fails loud in tests rather than silently
// never matching in production.
function matchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase()
  return host === s || host.endsWith('.' + s)
}

/**
 * True for any address whose traffic cannot reach the internet: loopback,
 * RFC-1918 private, link-local, and mDNS `.local`. Named `isLoopback` for the
 * caller's convenience — it is the "this is not egress at all" predicate, and
 * everything it covers is exempt from the allowlist by construction.
 */
export function isLoopback(host: string): boolean {
  const h = normalizeHost(host)
  // Empty is NOT local — see the fail-closed note in judgeEndpoint.
  if (!h) return false

  // localhost, app.localhost (RFC 6761), printer.local, my-mac.local (mDNS).
  if (matchesSuffix(h, 'localhost')) return true
  if (matchesSuffix(h, 'local')) return true

  const v4 = IPV4_RE.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    // Reject bogus octets outright rather than guessing — 999.1.1.1 is not an
    // address, and calling it "local" would be the wrong way to be wrong.
    if (a > 255 || b > 255 || Number(v4[3]) > 255 || Number(v4[4]) > 255) return false
    if (a === 0) return true                            // 0.0.0.0/8 "this network"
    if (a === 10) return true                           // 10.0.0.0/8
    if (a === 127) return true                          // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true             // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true    // 172.16.0.0/12
    if (a === 192 && b === 168) return true             // 192.168.0.0/16
    return false
  }

  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true          // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return true                // fe80::/10 link-local
    if (/^f[cd]/.test(h)) return true                   // fc00::/7 unique-local
    return false
  }

  return false
}

export function judgeEndpoint(ep: Endpoint): EgressJudgement {
  const endpoint: Endpoint = ep && typeof ep === 'object' ? ep : { host: '' }
  const host = normalizeHost(endpoint.host)

  // Fail closed. We were handed something we cannot attribute to anyone; the
  // safe answer is "flag it", not "wave it through".
  if (!host) {
    return {
      endpoint,
      verdict: 'violation',
      reason: 'Empty or unparseable host — cannot be matched against the AI-provider allowlist',
    }
  }

  if (isLoopback(host)) {
    return {
      endpoint,
      verdict: 'local',
      reason: host + ' is loopback/private/link-local — traffic never leaves the machine',
    }
  }

  for (const entry of EGRESS_ALLOWLIST) {
    for (const suffix of entry.suffixes) {
      if (matchesSuffix(host, suffix)) {
        return {
          endpoint,
          verdict: 'allowed',
          matchedRule: entry.rule,
          reason: host + ' matches allowlist rule "' + entry.rule + '" (' + suffix + ')',
        }
      }
    }
  }

  return {
    endpoint,
    verdict: 'violation',
    reason: host + ' is not on the AI-provider allowlist — possible exfiltration',
  }
}

export function judgeEgress(endpoints: Endpoint[]): EgressReport {
  const list = Array.isArray(endpoints) ? endpoints : []
  const judgements = list.map(judgeEndpoint)
  const violations = judgements.filter((j) => j.verdict === 'violation')
  return {
    judgements,
    violations,
    clean: violations.length === 0,
    summary: summarize(judgements, violations),
  }
}

// One line, because this lands in a toast and an audit-log `notes` field.
// Counts CONNECTIONS but names HOSTS: two sockets to the same collector is two
// violations and one name.
function summarize(judgements: EgressJudgement[], violations: EgressJudgement[]): string {
  if (judgements.length === 0) return 'No egress observed'

  if (violations.length === 0) {
    const allowed = judgements.filter((j) => j.verdict === 'allowed').length
    const local = judgements.filter((j) => j.verdict === 'local').length
    return 'No egress violations — ' + allowed + ' allowed, ' + local + ' local'
  }

  const hosts: string[] = []
  for (const v of violations) {
    const h = normalizeHost(v.endpoint.host) || '(empty)'
    if (!hosts.includes(h)) hosts.push(h)
  }
  const shown = hosts.slice(0, MAX_SUMMARY_HOSTS)
  const more = hosts.length - shown.length
  const named = shown.join(', ') + (more > 0 ? ', +' + more + ' more' : '')
  const n = violations.length
  return n + (n === 1 ? ' violation (' : ' violations (') + named + ')'
}
