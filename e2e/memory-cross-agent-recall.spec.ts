/**
 * Cross-agent memory recall over the REAL MCP wire.
 *
 * Launches the real Electron app and talks to its live MCP HTTP server exactly
 * as a launched agent's stdio adapter does (POST /mcp, Bearer token, JSON-RPC
 * tools/call). One agent writes a fact; a DIFFERENT agent retrieves it — proving
 * the "shared brain across all agents" claim through the actual server + auth +
 * dispatch + store, not just an in-process unit call.
 *
 * Runs in the unpacked dev build (no bundled model) → memory falls back to
 * keyword search, which is enough to prove the wire + the shared store. The
 * REAL-embedding semantic proof lives in tests/electron/memorySemanticRecall
 * (run in CI's package-verify, where the model is present).
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import http from 'http'

let app: ElectronApplication
let token: string
let port: number

/**
 * Throwaway userData for this run. It has to be a real directory before launch
 * because we hand it to the app as --user-data-dir and then read the mcp-port /
 * mcp-token it writes there (src/main/index.ts:3157,3166 — both derive from
 * app.getPath('userData'), so the switch redirects them).
 *
 * This used to be hardcoded to the production %APPDATA%\termpolis, which meant
 * the spec was unrunnable on any machine with Termpolis open (the single-instance
 * lock is keyed on userData, so the launch took `!gotTheLock -> app.quit()`) and,
 * with Termpolis closed, wrote its test fact into the developer's real brain.
 */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-xagent-e2e-'))

function termpolisDataDir(): string {
  return userDataDir
}

function readPort(): number {
  const portFile = path.join(termpolisDataDir(), 'mcp-port')
  const p = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
  if (p > 0 && p < 65536) return p
  throw new Error(`unusable MCP port in ${portFile}: ${JSON.stringify(p)}`)
}

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: d }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function mcpCall(toolName: string, args: Record<string, unknown>, id = 1): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } })
  const res = await httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    },
    body,
  )
  return JSON.parse(res.body)
}

function parseToolResult(data: any): any {
  const text = data?.result?.content?.[0]?.text
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(5000) // let the MCP server bind + write token/port

  port = readPort()
  token = fs.readFileSync(path.join(termpolisDataDir(), 'mcp-token'), 'utf-8').trim()
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe.serial('shared brain over the real MCP wire', () => {
  // Unique marker so we assert on OUR write, not pre-ingested history.
  const marker = `xq${Date.now()}`
  const fact = `${marker}: the deploy pipeline uses blue-green releases with a manual approval gate`

  test('the wire is up: a valid token lists the memory tools', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const res = await httpRequest(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
      body,
    )
    expect(res.statusCode).toBe(200)
    const names = (JSON.parse(res.body)?.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_list')
  })

  test('agent A (claude) writes a fact via memory_write', async () => {
    const res = await mcpCall('memory_write', { agentId: 'claude', kind: 'decision', content: fact }, 2)
    expect(res.error).toBeFalsy()
    const written = parseToolResult(res)
    expect(written).toBeTruthy()
    expect(written.content).toContain(marker)
  })

  test('agent B (codex) retrieves agent A\'s fact via memory_search — shared store', async () => {
    const res = await mcpCall('memory_search', { query: 'blue-green deploy pipeline approval gate', limit: 5 }, 3)
    expect(res.error).toBeFalsy()
    const hits = parseToolResult(res)
    expect(Array.isArray(hits)).toBe(true)
    expect(hits.some((h: { content: string }) => h.content.includes(marker))).toBe(true)
  })

  test('memory_list surfaces the cross-agent write through the wire', async () => {
    const res = await mcpCall('memory_list', { limit: 50 }, 4)
    const list = parseToolResult(res)
    expect(Array.isArray(list)).toBe(true)
    expect(list.some((e: { content: string }) => e.content.includes(marker))).toBe(true)
  })
})
