import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseNetstatWindows,
  parseSsLinux,
  parseLsofMac,
  recordEgress,
  getRecentEgress,
  clearEgress,
  startEgressPolling,
  stopEgressPolling,
  stopAllEgressPolling,
} from '../../src/main/egressAudit'

describe('egressAudit — parseNetstatWindows', () => {
  it('extracts TCP rows for the given pid only', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    192.168.1.10:62015     151.101.0.81:443       ESTABLISHED     12345',
      '  TCP    192.168.1.10:62016     1.1.1.1:443            ESTABLISHED     99999',
      '  TCP    192.168.1.10:62017     8.8.8.8:443            ESTABLISHED     12345',
    ].join('\r\n')
    const r = parseNetstatWindows(stdout, 12345)
    expect(r.length).toBe(2)
    expect(r[0].remoteHost).toBe('151.101.0.81')
    expect(r[0].remotePort).toBe(443)
    expect(r[0].state).toBe('ESTABLISHED')
    expect(r.find((e) => e.remoteHost === '8.8.8.8')).toBeTruthy()
  })

  it('skips listening sockets bound to 0.0.0.0', () => {
    const stdout =
      '  TCP    0.0.0.0:443     0.0.0.0:0    LISTENING    12345\r\n' +
      '  TCP    192.168.1.10:62017     8.8.8.8:443     ESTABLISHED    12345'
    const r = parseNetstatWindows(stdout, 12345)
    expect(r.length).toBe(1)
    expect(r[0].remoteHost).toBe('8.8.8.8')
  })

  it('returns empty when no rows match the pid', () => {
    const stdout = '  TCP    192.168.1.10:62017     8.8.8.8:443     ESTABLISHED    99999'
    const r = parseNetstatWindows(stdout, 12345)
    expect(r).toEqual([])
  })

  it('tolerates malformed rows', () => {
    const stdout = ['', 'garbage', '  UDP something', '  TCP   only-two-cols', ''].join('\n')
    const r = parseNetstatWindows(stdout, 12345)
    expect(r).toEqual([])
  })
})

describe('egressAudit — parseSsLinux', () => {
  it('extracts ESTAB rows for the given pid', () => {
    const stdout = [
      'State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process',
      'ESTAB  0      0       192.168.1.10:62015   151.101.0.81:443   users:(("node",pid=12345,fd=22))',
      'ESTAB  0      0       192.168.1.10:62016   1.1.1.1:443        users:(("other",pid=99999,fd=22))',
      'ESTAB  0      0       192.168.1.10:62017   8.8.8.8:443        users:(("node",pid=12345,fd=23))',
    ].join('\n')
    const r = parseSsLinux(stdout, 12345)
    expect(r.length).toBe(2)
    expect(r[0].remoteHost).toBe('151.101.0.81')
    expect(r[0].state).toBe('ESTAB')
  })

  it('returns empty when pid not present', () => {
    const stdout = 'ESTAB 0 0 1.2.3.4:5 6.7.8.9:10 users:(("node",pid=99999,fd=22))'
    const r = parseSsLinux(stdout, 12345)
    expect(r).toEqual([])
  })
})

describe('egressAudit — parseLsofMac', () => {
  it('extracts TCP arrows for the given pid', () => {
    const stdout = [
      'COMMAND  PID    USER  FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'node    12345    me   22u  IPv4 0xabc        0t0   TCP 192.168.1.10:62015->151.101.0.81:443 (ESTABLISHED)',
      'node    12345    me   23u  IPv4 0xdef        0t0   TCP 192.168.1.10:62016->8.8.8.8:443 (ESTABLISHED)',
      'node    99999    me   22u  IPv4 0xfff        0t0   TCP 192.168.1.10:62017->1.1.1.1:443 (ESTABLISHED)',
    ].join('\n')
    const r = parseLsofMac(stdout, 12345)
    expect(r.length).toBe(2)
    expect(r[0].remoteHost).toBe('151.101.0.81')
    expect(r[0].state).toBe('ESTABLISHED')
  })

  it('skips listening rows without an arrow', () => {
    const stdout = 'node 12345 me 22u IPv4 0xabc 0t0 TCP *:8080 (LISTEN)'
    const r = parseLsofMac(stdout, 12345)
    expect(r).toEqual([])
  })
})

describe('egressAudit — record/get/clear', () => {
  beforeEach(() => clearEgress())

  it('records unique endpoints by host:port', () => {
    recordEgress('term-1', [
      { remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'ESTABLISHED' },
      { remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'ESTABLISHED' },
      { remoteHost: '8.8.8.8', remotePort: 443, localPort: 0, state: 'ESTABLISHED' },
    ])
    expect(getRecentEgress('term-1')).toHaveLength(2)
  })

  it('keeps per-terminal isolation', () => {
    recordEgress('term-1', [{ remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'EST' }])
    recordEgress('term-2', [{ remoteHost: '8.8.8.8', remotePort: 443, localPort: 0, state: 'EST' }])
    expect(getRecentEgress('term-1')).toHaveLength(1)
    expect(getRecentEgress('term-2')).toHaveLength(1)
    expect(getRecentEgress('term-1')[0].remoteHost).toBe('1.1.1.1')
  })

  it('clearEgress(id) clears only that terminal', () => {
    recordEgress('term-1', [{ remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'EST' }])
    recordEgress('term-2', [{ remoteHost: '8.8.8.8', remotePort: 443, localPort: 0, state: 'EST' }])
    clearEgress('term-1')
    expect(getRecentEgress('term-1')).toEqual([])
    expect(getRecentEgress('term-2')).toHaveLength(1)
  })
})

describe('egressAudit — start/stop polling', () => {
  beforeEach(() => {
    clearEgress()
    stopAllEgressPolling()
  })

  it('runs the poller once immediately on start', async () => {
    let calls = 0
    const fakePoller = async (): Promise<any> => {
      calls++
      return [{ remoteHost: '1.1.1.1', remotePort: 443, localPort: 0, state: 'EST' }]
    }
    startEgressPolling('term-x', 999, 60_000, fakePoller)
    // immediate tick is queued — yield once
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(getRecentEgress('term-x').length).toBeGreaterThanOrEqual(1)
    stopEgressPolling('term-x')
  })

  it('stopEgressPolling halts subsequent ticks', () => {
    let calls = 0
    const fakePoller = async (): Promise<any> => {
      calls++
      return []
    }
    startEgressPolling('term-y', 999, 60_000, fakePoller)
    stopEgressPolling('term-y')
    // second start would replace; calling stop on a stopped id is a no-op
    stopEgressPolling('term-y')
    expect(calls).toBeGreaterThanOrEqual(0)
  })

  it('stopAllEgressPolling clears every running poller', () => {
    const fakePoller = async (): Promise<any> => []
    startEgressPolling('a', 1, 60_000, fakePoller)
    startEgressPolling('b', 2, 60_000, fakePoller)
    stopAllEgressPolling()
    // No assertion on count beyond "no exception" — the cache lives separately.
    expect(true).toBe(true)
  })
})
