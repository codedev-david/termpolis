// Egress audit — periodically asks the OS what remote endpoints each AI agent
// has open TCP connections to, and records the unique hosts to the AI Security
// audit log so a security-conscious user can see "Claude talked to api.anthropic.com
// and console.anthropic.com today, nothing else".
//
// Why this layer exists despite agents already shipping their own logs:
//   - Provider SDKs can change endpoints silently (e.g., a new region, a new
//     telemetry beacon, a third-party proxy). The OS-level view is ground truth
//     regardless of what the agent says it does.
//   - In a swarm config, multiple agents run concurrently; correlating
//     "which PID talked to which host" is much easier from netstat than from
//     parsing each agent's transcript.
//
// Design choices:
//   - Polling, not packet capture. Cheap (one shell-out every minute), no
//     elevated privileges required, no driver to install. Misses sub-minute
//     bursts; for our threat model that's fine.
//   - Pure parser exports (`parseNetstatWindows`, `parseSsLinux`,
//     `parseLsofMac`) so unit tests can run without any OS dependency. Only
//     `pollAgentEgress` actually shells out.
//   - Endpoint = `host:port`. We don't reverse-DNS — keeps the audit
//     signal stable when DNS is flaky and avoids extra network calls.
//   - Bounded in-memory cache per terminal (256 endpoints) so the renderer
//     can show "talked to N hosts in this session" without re-shelling.

// We deliberately defer the child_process / util imports to call time.
// Several test harnesses mock `child_process` to a partial stub, and a
// top-level `promisify(execFile)` would throw at module load — taking down
// every test that transitively imports src/main/index.ts. Pulling them in
// inside `pollAgentEgress` keeps the cold-start bullet-proof.

export interface EgressEndpoint {
  remoteHost: string
  remotePort: number
  localPort: number
  state: string
}

const MAX_ENDPOINTS_PER_TERMINAL = 256

// terminalId -> Set<host:port>
const recentEgress = new Map<string, Map<string, EgressEndpoint>>()

// Windows `netstat -ano` lines look like:
//   "  TCP    192.168.1.10:62015    151.101.0.81:443    ESTABLISHED   12345"
// We pull only TCP rows whose final column matches our PID.
export function parseNetstatWindows(stdout: string, pid: number): EgressEndpoint[] {
  const out: EgressEndpoint[] = []
  const lines = stdout.split(/\r?\n/)
  for (const ln of lines) {
    const t = ln.trim()
    if (!t.startsWith('TCP')) continue
    const cols = t.split(/\s+/)
    if (cols.length < 5) continue
    const lpStr = cols[1]
    const rpStr = cols[2]
    const state = cols[3]
    const linePid = Number.parseInt(cols[4], 10)
    if (linePid !== pid) continue
    const lp = splitHostPort(lpStr)
    const rp = splitHostPort(rpStr)
    if (!rp || rp.host === '0.0.0.0' || rp.host === '::' || rp.port === 0) continue
    out.push({ remoteHost: rp.host, remotePort: rp.port, localPort: lp?.port ?? 0, state })
  }
  return out
}

// Linux `ss -tnp` lines look like:
//   "ESTAB  0  0  192.168.1.10:62015  151.101.0.81:443  users:((\"node\",pid=12345,fd=22))"
export function parseSsLinux(stdout: string, pid: number): EgressEndpoint[] {
  const out: EgressEndpoint[] = []
  const lines = stdout.split(/\r?\n/)
  for (const ln of lines) {
    if (!ln.includes('pid=' + pid)) continue
    const cols = ln.trim().split(/\s+/)
    if (cols.length < 5) continue
    const state = cols[0]
    const lp = splitHostPort(cols[3])
    const rp = splitHostPort(cols[4])
    if (!rp || rp.host === '0.0.0.0' || rp.host === '::' || rp.port === 0) continue
    out.push({ remoteHost: rp.host, remotePort: rp.port, localPort: lp?.port ?? 0, state })
  }
  return out
}

// macOS `lsof -nP -iTCP -p <pid>` lines look like:
//   "node  12345 user 22u IPv4 0x... 0t0 TCP 192.168.1.10:62015->151.101.0.81:443 (ESTABLISHED)"
export function parseLsofMac(stdout: string, pid: number): EgressEndpoint[] {
  const out: EgressEndpoint[] = []
  const lines = stdout.split(/\r?\n/)
  for (const ln of lines) {
    if (!ln.includes(' ' + pid + ' ')) continue
    const arrow = ln.indexOf('->')
    if (arrow === -1) continue
    const tcpIdx = ln.indexOf('TCP ')
    if (tcpIdx === -1 || tcpIdx > arrow) continue
    const localStr = ln.slice(tcpIdx + 4, arrow).trim()
    const tail = ln.slice(arrow + 2)
    const stateMatch = /\(([A-Z_]+)\)/.exec(tail)
    const state = stateMatch ? stateMatch[1] : 'UNKNOWN'
    const remoteEnd = tail.indexOf(' ')
    const remoteStr = (remoteEnd === -1 ? tail : tail.slice(0, remoteEnd)).trim()
    const lp = splitHostPort(localStr)
    const rp = splitHostPort(remoteStr)
    if (!rp || rp.host === '0.0.0.0' || rp.host === '::' || rp.port === 0) continue
    out.push({ remoteHost: rp.host, remotePort: rp.port, localPort: lp?.port ?? 0, state })
  }
  return out
}

function splitHostPort(s: string): { host: string; port: number } | null {
  if (!s) return null
  // Strip surrounding brackets for IPv6.
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(s)
  if (!m) return null
  return { host: m[1], port: Number.parseInt(m[2], 10) }
}

// Public for testing — lets a test inject a fake exec.
export type EgressExecutor = (bin: string, args: string[]) => Promise<string>

const defaultExecutor: EgressExecutor = async (bin, args) => {
  // Lazy require — see top-of-file note. If the host has stubbed out
  // child_process, this throws and the caller's catch returns [] gracefully.
  const cp: typeof import('child_process') = require('child_process')
  const { promisify } = require('util') as typeof import('util')
  if (typeof cp.execFile !== 'function') throw new Error('execFile unavailable')
  const pExecFile = promisify(cp.execFile)
  const { stdout } = (await pExecFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })) as { stdout: string }
  return stdout
}

export async function pollAgentEgress(
  pid: number,
  platform = process.platform,
  executor: EgressExecutor = defaultExecutor,
): Promise<EgressEndpoint[]> {
  if (!pid || pid <= 0) return []
  try {
    if (platform === 'win32') {
      const stdout = await executor('netstat', ['-ano', '-p', 'TCP'])
      return parseNetstatWindows(stdout, pid)
    }
    if (platform === 'darwin') {
      const stdout = await executor('lsof', ['-nP', '-iTCP', '-p', String(pid)])
      return parseLsofMac(stdout, pid)
    }
    // linux + others
    const stdout = await executor('ss', ['-tnp'])
    return parseSsLinux(stdout, pid)
  } catch {
    // Any failure (tool missing, permission denied, exec timeout) → empty list.
    // We never want a missing netstat to crash the main process.
    return []
  }
}

export function recordEgress(terminalId: string, endpoints: EgressEndpoint[]): void {
  let m = recentEgress.get(terminalId)
  if (!m) {
    m = new Map()
    recentEgress.set(terminalId, m)
  }
  for (const e of endpoints) {
    const key = e.remoteHost + ':' + e.remotePort
    if (!m.has(key) && m.size < MAX_ENDPOINTS_PER_TERMINAL) {
      m.set(key, e)
    }
  }
}

export function getRecentEgress(terminalId: string): EgressEndpoint[] {
  const m = recentEgress.get(terminalId)
  if (!m) return []
  return Array.from(m.values())
}

export function clearEgress(terminalId?: string): void {
  if (terminalId) {
    recentEgress.delete(terminalId)
  } else {
    recentEgress.clear()
  }
}

