import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as http from 'http'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { getMcpAuthToken, startMcpServer, stopMcpServer, awaitMcpPortBound, _resetPortStateForTest } =
  await import('../../src/main/mcpServer')
import { estimateTokens } from '../../src/main/memoryEconomy'
import { setSettings, resetSettings } from '../../src/main/headroom/config'
import { resetCcr } from '../../src/main/headroom/ccrStore'

const bigSearch = Array.from({ length: 100 }, (_, i) => ({ name: `symbol_${i}`, kind: 'function', file: `src/module_${i}.ts`, startLine: i * 10, endLine: i * 10 + 8, lang: 'ts' }))
const handlers = {
  codeSearch: () => bigSearch,
  memorySearch: async () => [{ id: 'm1', content: 'x'.repeat(6000) }],
}

function call(port: number, token: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: {} }, id: 1 })
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } },
      res => { let body = ''; res.on('data', d => (body += d)); res.on('end', () => resolve(JSON.parse(body).result.content[0].text)) },
    )
    req.on('error', reject); req.write(payload); req.end()
  })
}

let port: number, token: string, server: ReturnType<typeof startMcpServer>
beforeAll(async () => { _resetPortStateForTest(); server = startMcpServer(handlers as never); port = await awaitMcpPortBound(); token = getMcpAuthToken() })
afterAll(() => stopMcpServer(server))
beforeEach(() => { resetSettings(); resetCcr() })

describe('headroom token-spend proof (real dispatch)', () => {
  it('cuts a 100-hit code_search by ≥80% tokens', async () => {
    setSettings({ enabled: false })
    const raw = await call(port, token, 'code_search')
    setSettings({ enabled: true, mode: 'balanced' })
    const compressed = await call(port, token, 'code_search')
    const rawTok = estimateTokens(raw), compTok = estimateTokens(compressed)
    expect(compressed).toContain('retrieve_full')
    expect(1 - compTok / rawTok).toBeGreaterThanOrEqual(0.80)
  })

  it('leaves memory_search identical whether compression is on or off (brain non-interference)', async () => {
    setSettings({ enabled: false })
    const off = await call(port, token, 'memory_search')
    setSettings({ enabled: true, mode: 'aggressive' })
    const on = await call(port, token, 'memory_search')
    expect(on).toBe(off)
  })

  it('meets the perf budget: compressing a 100-hit search is fast', async () => {
    setSettings({ enabled: true, mode: 'balanced' })
    const start = performance.now()
    for (let i = 0; i < 20; i++) await call(port, token, 'code_search')
    expect((performance.now() - start) / 20).toBeLessThan(50)
  })
})
