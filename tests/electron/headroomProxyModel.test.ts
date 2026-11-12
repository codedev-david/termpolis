// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { requestModelAndEffort } from '../../src/main/headroomProxy/usageParse'
import { modelFamily, modelUnits, MODEL_WEIGHTS, MODEL_WEIGHT_NOTE } from '../../src/main/headroom/effectiveUnits'
import { resultFrame, type ProxyResult } from '../../src/main/headroomProxy/proxyMain'
import type { WireStats } from '../../src/main/headroomProxy/wireCompress'
import {
  recordProxyResult, currentModelTotals, resetProxyLedger, resetProxyCounters, loadProxyBaseFromDisk, saveProxyTotalsToDisk,
} from '../../src/main/headroomProxy/proxyLedger'

// A partial tally, as a child older than the app sends: the ledger reads every absent counter as 0.
const stats = { trBlocks: 0, trOrigChars: 0, trCompChars: 0, images: 0, imgOrigBytes: 0, imgCompBytes: 0 } as unknown as WireStats
function result(model: string | undefined, usage: Record<string, number>) {
  return {
    kind: 'result' as const, changed: false, stats, stashes: [], status: 200,
    turn: { toolCalls: 0, retrieveCalls: 0, pure: false },
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, ...usage },
    ...(model ? { model } : {}),
  } as Parameters<typeof recordProxyResult>[0]
}

describe('the model of every request', () => {
  beforeEach(() => resetProxyLedger())

  it('usage result carries the request\'s model and effort', () => {
    const body = JSON.stringify({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'use "model": "claude-haiku-5-5" and {"effort":"low"} in text' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { model: 'haiku' } }] }],
      max_tokens: 32000,
      output_config: { effort: 'xhigh' },
    })
    expect(requestModelAndEffort(body)).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(requestModelAndEffort('{"model":"claude-sonnet-5-5","output_config":{"effort":"turbo"}}')).toEqual({ model: 'sonnet' })
    expect(requestModelAndEffort('{"model":"gpt-x"}')).toEqual({ model: 'other' })
    expect(requestModelAndEffort('{"messages":[]}')).toEqual({})
    expect(requestModelAndEffort('')).toEqual({})
    expect(requestModelAndEffort(undefined as unknown as string)).toEqual({})

    const r: ProxyResult = { changed: false, stats, usage: result(undefined, {}).usage, turn: { toolCalls: 0, retrieveCalls: 0, pure: false }, stashes: [], status: 200, model: 'haiku', effort: 'low' }
    expect(resultFrame(r)).toMatchObject({ kind: 'result', model: 'haiku', effort: 'low' })
    const bare = resultFrame({ ...r, model: undefined, effort: undefined })
    expect('model' in bare || 'effort' in bare).toBe(false)
  })

  it('byModel totals split opus vs haiku', () => {
    recordProxyResult(result('opus', { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }))
    recordProxyResult(result('opus', { input_tokens: 5, cache_creation_input_tokens: 200, output_tokens: 20 }))
    recordProxyResult(result('haiku', { input_tokens: 7, output_tokens: 3 }))
    recordProxyResult(result(undefined, { output_tokens: 999 })) // an older child: counted in the totals, not by model
    recordProxyResult(result('claude-opus-5-5', { output_tokens: 999 })) // never a build id
    const t = currentModelTotals()
    expect(Object.keys(t).sort()).toEqual(['haiku', 'opus'])
    expect(t.opus).toEqual({ requests: 2, inputTokens: 15, cacheReadTokens: 1000, cacheCreationTokens: 200, outputTokens: 70 })
    expect(t.haiku).toEqual({ requests: 1, inputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 3 })
    resetProxyCounters()
    expect(currentModelTotals()).toEqual({})
  })

  it('by-model totals survive a restart, and a damaged file reads as known families only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-bymodel-'))
    recordProxyResult(result('sonnet', { input_tokens: 4, output_tokens: 6 }))
    saveProxyTotalsToDisk(dir)
    for (let i = 0; i < 50 && !readFileSafe(join(dir, 'proxy-totals.json')).includes('byModel'); i++) await new Promise((r) => setTimeout(r, 20))
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    recordProxyResult(result('sonnet', { output_tokens: 1 }))
    expect(currentModelTotals().sonnet).toEqual({ requests: 2, inputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 7 })

    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ byModel: { opus: { requests: -3, outputTokens: 'x', inputTokens: 2 }, gpt: { requests: 9 }, haiku: null } }))
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    expect(currentModelTotals()).toEqual({ opus: { requests: 0, inputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 } })
    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ byModel: [1, 2] }))
    resetProxyLedger()
    loadProxyBaseFromDisk(dir)
    expect(currentModelTotals()).toEqual({})
  })

  it('weighs units by family, at API list-price ratios, and says so', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('opus')
    expect(modelFamily('opusplan')).toBe('opus')
    expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet')
    expect(modelFamily('HAIKU')).toBe('haiku')
    expect(modelFamily('claude-fable-5-1')).toBe('fable')
    expect(modelFamily('mystery')).toBe('other')
    expect(modelFamily(42)).toBe('other')
    expect(MODEL_WEIGHTS).toEqual({ opus: 1, sonnet: 0.5, haiku: 0.1, fable: 1, other: 1 })
    expect(MODEL_WEIGHT_NOTE).toBe('API-price weighting; subscription weights unpublished')
    const t = { cacheReadTokens: 1000, cacheCreationTokens: 100, inputTokens: 10, outputTokens: 20 } // 100 + 125 + 10 + 100 = 335
    expect(modelUnits(t, 'opus')).toBe(335)
    expect(modelUnits(t, 'sonnet')).toBe(167.5)
    expect(modelUnits(t, 'haiku')).toBeCloseTo(33.5)
    expect(modelUnits(t, 'claude-haiku-5-5')).toBeCloseTo(33.5)
    expect(modelUnits(t, 'unknown')).toBe(335)
  })
})

function readFileSafe(p: string): string { try { return readFileSync(p, 'utf8') } catch { return '' } }
