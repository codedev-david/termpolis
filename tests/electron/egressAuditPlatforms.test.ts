// Hits the win32 / darwin / linux branches of pollAgentEgress on every CI
// runner by injecting a fake executor so the OS-specific binary
// (netstat / lsof / ss) is not actually invoked.

import { describe, it, expect } from 'vitest'
import { pollAgentEgress, type EgressExecutor } from '../../src/main/egressAudit'

const fakeExec: EgressExecutor = async (bin) => {
  if (bin === 'netstat') {
    return '  TCP    192.168.1.10:62015     151.101.0.81:443       ESTABLISHED     12345\r\n'
  }
  if (bin === 'lsof') {
    return 'node    12345    me   22u  IPv4 0xabc        0t0   TCP 192.168.1.10:62015->151.101.0.81:443 (ESTABLISHED)\n'
  }
  if (bin === 'ss') {
    return 'ESTAB  0      0       192.168.1.10:62015   151.101.0.81:443   users:(("node",pid=12345,fd=22))\n'
  }
  throw new Error('unexpected bin: ' + bin)
}

describe('pollAgentEgress — platform branches with injected executor', () => {
  it('hits the win32 branch and returns parsed netstat output', async () => {
    const r = await pollAgentEgress(12345, 'win32', fakeExec)
    expect(r.length).toBe(1)
    expect(r[0].remoteHost).toBe('151.101.0.81')
  })

  it('hits the darwin branch and returns parsed lsof output', async () => {
    const r = await pollAgentEgress(12345, 'darwin', fakeExec)
    expect(r.length).toBe(1)
    expect(r[0].remoteHost).toBe('151.101.0.81')
  })

  it('hits the linux (default) branch and returns parsed ss output', async () => {
    const r = await pollAgentEgress(12345, 'linux', fakeExec)
    expect(r.length).toBe(1)
    expect(r[0].remoteHost).toBe('151.101.0.81')
  })

  it('catches executor errors and returns []', async () => {
    const failing: EgressExecutor = async () => {
      throw new Error('boom')
    }
    expect(await pollAgentEgress(12345, 'win32', failing)).toEqual([])
    expect(await pollAgentEgress(12345, 'darwin', failing)).toEqual([])
    expect(await pollAgentEgress(12345, 'linux', failing)).toEqual([])
  })
})
