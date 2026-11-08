import { describe, it, expect, beforeEach } from 'vitest'
import type { ProxyResultMsg } from '../../src/main/headroomProxy/proxySupervisor'
const { setProxyFirstSight, getProxyFirstSight } = await import('../../src/main/headroomProxy/proxySupervisor')
const { summarizeElisionHealth } = await import('../../src/main/headroom/elisionHealth')
const { recordProxyResult, resetProxyLedger } = await import('../../src/main/headroomProxy/proxyLedger')
const { resetCcr } = await import('../../src/main/headroom/ccrStore')
const { resetDepthCurveAll } = await import('../../src/main/headroom/sessionDepth')

/**
 * The live view reads two things it is not handed: the policy the proxy really runs (which Settings may
 * have been changed away from since, and which the supervisor freezes at the first start of a run) and
 * the early aged-out counters of the proxy ledger. A fresh module graph per file, because the
 * supervisor takes its policy once and keeps it.
 */

beforeEach(() => { resetProxyLedger(); resetCcr(); resetDepthCurveAll() })

const result = (kinds: Record<string, number>): ProxyResultMsg => ({
  kind: 'result', changed: false, stashes: [], status: 200, turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
  usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 1 },
  stats: { kinds },
} as unknown as ProxyResultMsg)

describe('the live Elision health view', () => {
  it('speaks for Legacy until the supervisor has been told a policy, then for the one it was told', () => {
    expect(getProxyFirstSight()).toBe('legacy')
    let v = summarizeElisionHealth()
    expect(v.firstSight.policy).toBe('legacy')
    expect(v.oldBehaviour).toBeNull()
    setProxyFirstSight('late')
    expect(getProxyFirstSight()).toBe('late')
    v = summarizeElisionHealth()
    expect(v.firstSight.policy).toBe('late')
    expect(v.oldBehaviour).not.toBeNull()
    // Frozen for the run: a later value is ignored, so the view cannot disagree with the proxy.
    setProxyFirstSight('legacy')
    expect(summarizeElisionHealth().firstSight.policy).toBe('late')
  })

  it('carries the aged-out stubs found in conversations too short to have made them', () => {
    expect(summarizeElisionHealth().agedEarly).toEqual({ requests: 0, stubs: 0 })
    recordProxyResult(result({ plain: 3, aged: 2, agedEarly: 2 }))
    recordProxyResult(result({ plain: 5, agedEarly: 1 }))
    recordProxyResult(result({ plain: 5, aged: 4 })) // aged out in a long conversation: expected, not counted here
    expect(summarizeElisionHealth().agedEarly).toEqual({ requests: 2, stubs: 3 })
  })
})
