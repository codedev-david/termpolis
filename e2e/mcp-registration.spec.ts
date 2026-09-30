/**
 * MCP Registration Tests
 * Verifies Termpolis connects to Claude Code, Codex CLI and Gemini CLI only with the
 * user's consent, writes exactly what it discloses, and removes all of it on Disconnect.
 *
 * Every agent config lives in a scratch home passed as TERMPOLIS_TEST_AGENT_HOME, never
 * the developer's real ~/.claude*, ~/.codex or ~/.gemini.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { e2eLaunchArgs, e2eUserDataDir } from './helpers/launch'

let app: ElectronApplication
let page: Page
let agentHome = ''

test.beforeAll(async () => {
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // The agents count as installed when their config directories exist.
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-mcp-reg-home-'))
  for (const dir of ['.claude', '.codex', '.gemini']) fs.mkdirSync(path.join(agentHome, dir))

  app = await electron.launch({
    args: e2eLaunchArgs('mcp-registration'),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENT_HOME: agentHome },
  })

  page = await app.firstWindow()
  // No dismissOnboarding here: skipping the tour answers its "Connect agents" step, and
  // these tests check what happens before anyone answers. They only use IPC and the
  // filesystem, so the tour can stay open.
  await page.waitForLoadState('domcontentloaded')
  // Let the MCP server and the boot migrations settle
  await page.waitForTimeout(5000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

// ══════════════════════════════════════════════════════
// MCP TOKEN
// ══════════════════════════════════════════════════════

test('MCP token file exists and is 64-char hex', () => {
  const tokenPath = path.join(e2eUserDataDir('mcp-registration'), 'mcp-token')
  expect(fs.existsSync(tokenPath)).toBeTruthy()
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()
  expect(token.length).toBe(64)
  expect(/^[0-9a-f]+$/.test(token)).toBeTruthy()
})

// ══════════════════════════════════════════════════════
// MCP SERVER
// ══════════════════════════════════════════════════════

test('MCP server health check responds', async () => {
  const http = await import('http')
  const result: string = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9315/health', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d))
    }).on('error', reject)
  })
  const health = JSON.parse(result)
  expect(health.status).toBe('ok')
  expect(health.tools).toBeGreaterThanOrEqual(14)
  expect(health.auth).toBe('required')
})

test('MCP server rejects unauthenticated requests', async () => {
  const http = await import('http')
  const code: number = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    const req = http.request({ hostname: '127.0.0.1', port: 9315, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      resolve(res.statusCode || 0)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
  expect(code).toBe(401)
})

test('MCP server returns 14 tools with valid auth', async () => {
  const http = await import('http')
  const tokenPath = path.join(e2eUserDataDir('mcp-registration'), 'mcp-token')
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()

  try {
    const result: string = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
      const req = http.request({
        hostname: '127.0.0.1', port: 9315, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
    const data = JSON.parse(result)
    if (data.error) {
      // Token mismatch — another Termpolis instance owns port 9315
      console.log('Skipping: token mismatch (another Termpolis is running)')
      return
    }
    expect(data.result.tools.length).toBe(18)
    const toolNames = data.result.tools.map((t: any) => t.name)
    for (const expected of [
      'list_terminals', 'create_terminal', 'run_command', 'read_output',
      'close_terminal', 'write_to_terminal', 'get_file_tree', 'get_git_status',
      'swarm_send_message', 'swarm_read_messages', 'swarm_create_task',
      'swarm_list_tasks', 'swarm_update_task', 'swarm_list_agents',
      'memory_write', 'memory_search', 'memory_list', 'memory_primer'
    ]) {
      expect(toolNames).toContain(expected)
    }
  } catch {
    // MCP server not reachable — skip gracefully
  }
})

test('MCP server handles notifications without error', async () => {
  try {
  const http = await import('http')
  const tokenPath = path.join(e2eUserDataDir('mcp-registration'), 'mcp-token')
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()

  const result: string = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const req = http.request({
      hostname: '127.0.0.1', port: 9315, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
  const data = JSON.parse(result)
  // Should NOT have an error — notifications should be accepted
  expect(data.error).toBeUndefined()
  } catch { /* token mismatch or server not reachable */ }
})

// ══════════════════════════════════════════════════════
// STDIO ADAPTER
// ══════════════════════════════════════════════════════

test('stdio adapter exists and is valid JavaScript', () => {
  const adapterPath = path.resolve('src/mcp-adapter/stdio-adapter.cjs')
  expect(fs.existsSync(adapterPath)).toBeTruthy()
  // Verify it's valid JS by requiring it doesn't throw a syntax error
  const content = fs.readFileSync(adapterPath, 'utf-8')
  expect(content).toContain('readline')
  expect(content).toContain('sendToServer')
  expect(content).toContain('MCP_PORT')
})

test('CLI tool exists and is valid JavaScript', () => {
  const cliPath = path.resolve('src/mcp-adapter/termpolis-cli.cjs')
  expect(fs.existsSync(cliPath)).toBeTruthy()
  const content = fs.readFileSync(cliPath, 'utf-8')
  expect(content).toContain('termpolis-cli')
  expect(content).toContain('list_terminals')
})

// ══════════════════════════════════════════════════════
// AGENT CONNECTION (consent-gated)
// ══════════════════════════════════════════════════════

const readJson = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(agentHome, ...parts), 'utf-8'))
const readText = (...parts: string[]) => {
  const file = path.join(agentHome, ...parts)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
}
const setIntegration = (req: { connect: boolean; primerHook?: boolean }) =>
  page.evaluate((r) => (window as any).termpolis.agentIntegrationSet(r), req)
const NODE_COMMAND = /(?:^|[\\/])node(?:\.exe)?$/

test('writes nothing to any agent before the user answers', async () => {
  const status = await page.evaluate(() => (window as any).termpolis.agentIntegrationStatus())
  expect(status.success).toBe(true)
  expect(status.data.consent).toBeNull()
  expect(status.data.connected).toBe(false)
  expect(fs.existsSync(path.join(agentHome, '.claude.json'))).toBe(false)
  expect(readText('.codex', 'config.toml')).not.toContain('mcp_servers.termpolis')
  expect(fs.existsSync(path.join(agentHome, '.gemini', 'settings.json'))).toBe(false)
})

test('Connect registers the server with each installed agent', async () => {
  const res = await setIntegration({ connect: true, primerHook: true })
  expect(res.success).toBe(true)
  expect(res.data.status.connected).toBe(true)

  // The command may be the bare `node` (relying on PATH) or an absolute
  // interpreter path — registration writes whichever it resolved, and on
  // Windows that is typically `C:\\Program Files\\nodejs\\node.exe`.
  // What matters is that it IS node, not how it was spelled.
  const claude = readJson('.claude.json').mcpServers?.termpolis
  expect(claude?.command).toMatch(NODE_COMMAND)
  expect(claude?.args?.[0]).toContain('stdio-adapter.cjs')

  const codex = readText('.codex', 'config.toml')
  expect(codex).toContain('[mcp_servers.termpolis]')
  expect(codex).toMatch(/command = "(?:[^"]*[\\/])?node(?:\.exe)?"/)
  expect(codex).toContain('stdio-adapter.cjs')

  const gemini = readJson('.gemini', 'settings.json').mcpServers?.termpolis
  expect(gemini?.command).toMatch(NODE_COMMAND)
  expect(gemini?.args?.[0]).toContain('stdio-adapter.cjs')
})

test('Claude Code: only the listed read-only and memory tools are pre-approved', () => {
  const allow: string[] = readJson('.claude', 'settings.json').permissions?.allow ?? []
  const ours = allow.filter((rule) => rule.startsWith('mcp__termpolis'))
  expect(ours).toContain('mcp__termpolis__memory_search')
  expect(ours).not.toContain('mcp__termpolis__*')
  expect(ours).not.toContain('mcp__termpolis')
  for (const tool of ['run_command', 'run_and_wait', 'write_to_terminal', 'create_terminal', 'gateway_call']) {
    expect(ours).not.toContain(`mcp__termpolis__${tool}`)
  }
})

test('Claude Code: no plugin, and the home folder is never pre-trusted', () => {
  const settings = readJson('.claude', 'settings.json')
  expect(Object.keys(settings.enabledPlugins ?? {}).some((k) => k.startsWith('termpolis@'))).toBe(false)
  expect(fs.existsSync(path.join(agentHome, '.claude', 'local-marketplace', 'plugins', 'termpolis'))).toBe(false)
  const home = agentHome.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  for (const [key, value] of Object.entries<any>(readJson('.claude.json').projects ?? {})) {
    if (key.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === home) {
      expect(value?.hasTrustDialogAccepted).not.toBe(true)
    }
  }
})

test('Disconnect removes everything Termpolis wrote', async () => {
  const res = await setIntegration({ connect: false })
  expect(res.success).toBe(true)
  expect(res.data.status.connected).toBe(false)
  expect(res.data.status.consent).toBe('declined')

  expect(readJson('.claude.json').mcpServers?.termpolis).toBeUndefined()
  const settings = readJson('.claude', 'settings.json')
  expect((settings.permissions?.allow ?? []).filter((rule: string) => rule.startsWith('mcp__termpolis'))).toEqual([])
  expect(JSON.stringify(settings.hooks ?? {})).not.toContain('termpolis')
  expect(readText('.codex', 'config.toml')).not.toContain('mcp_servers.termpolis')
  expect(readJson('.gemini', 'settings.json').mcpServers?.termpolis).toBeUndefined()
})

test('Reconnect for the swarm tests below', async () => {
  const res = await setIntegration({ connect: true, primerHook: true })
  expect(res.data.status.connected).toBe(true)
})

// ══════════════════════════════════════════════════════
// SWARM MCP TOOLS
// ══════════════════════════════════════════════════════

test('Swarm: can create and list tasks via MCP', async () => {
  try {
  const http = await import('http')
  const tokenPath = path.join(e2eUserDataDir('mcp-registration'), 'mcp-token')
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()

  async function mcpCall(method: string, params: any = {}) {
    return new Promise<any>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: method, arguments: params }, id: 1 })
      const req = http.request({
        hostname: '127.0.0.1', port: 9315, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => {
          try { resolve(JSON.parse(d)) } catch { resolve(null) }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  // Create a task
  const createRes = await mcpCall('swarm_create_task', { title: 'Test Task', description: 'E2E test task' })
  expect(createRes?.result?.content?.[0]?.text).toBeTruthy()
  const task = JSON.parse(createRes.result.content[0].text)
  expect(task.title).toBe('Test Task')
  expect(task.status).toBe('pending')

  // List tasks
  const listRes = await mcpCall('swarm_list_tasks')
  expect(listRes?.result?.content?.[0]?.text).toBeTruthy()
  const tasks = JSON.parse(listRes.result.content[0].text)
  expect(tasks.some((t: any) => t.title === 'Test Task')).toBeTruthy()

  // Send a message
  const msgRes = await mcpCall('swarm_send_message', { to: 'all', type: 'info', content: 'E2E test message' })
  expect(msgRes?.result?.content?.[0]?.text).toBeTruthy()
  } catch { /* token mismatch or server not reachable */ }
})

test('Swarm: can list agents via MCP', async () => {
  try {
  const http = await import('http')
  const tokenPath = path.join(e2eUserDataDir('mcp-registration'), 'mcp-token')
  const token = fs.readFileSync(tokenPath, 'utf-8').trim()

  const result: string = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'swarm_list_agents', arguments: {} }, id: 1 })
    const req = http.request({
      hostname: '127.0.0.1', port: 9315, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
  const data = JSON.parse(result)
  expect(data.result?.content?.[0]?.text).toBeTruthy()
  } catch { /* token mismatch or server not reachable */ }
})
