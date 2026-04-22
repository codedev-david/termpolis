/**
 * Plugin .mcp.json Variant — Real Claude Discovery
 * -------------------------------------------------
 * Guarded by TERMPOLIS_TEST_REAL_CLAUDE=1 because:
 *   - Depends on a real `claude` binary being installed and authed
 *   - Plugin discovery depends on Claude Code's version-specific behavior
 *   - Network/install flakiness makes this unsuitable for hosted CI
 *
 * When enabled, this spec:
 *   1. Ensures no other Termpolis is on the MCP port (skips if one is)
 *   2. Launches Termpolis so it writes the plugin-variant .mcp.json into
 *      the user's real ~/.claude (same behavior as a normal launch)
 *   3. Runs `claude -p "..."` WITHOUT `--mcp-config`, forcing the claude
 *      binary to discover termpolis purely through the plugin path
 *   4. Asserts the tool call landed on the Termpolis swarm bus by sentinel
 *
 * We DELIBERATELY do not isolate HOME here: Claude Code's auth lives in
 * ~/.claude/{accounts,session-tokens,settings.json}, and cloning those
 * into a scratch dir would be fragile across Claude versions. The test
 * piggybacks on whatever account is currently logged in.
 *
 * Side effects on your real profile: Termpolis's plugin auto-register
 * writes ~/.claude/local-marketplace/plugins/termpolis/ and flips
 * enabledPlugins["termpolis@<marketplace>"]=true. Termpolis does this
 * on every launch anyway — not a new mutation.
 *
 * Run locally (Windows bash):
 *   TERMPOLIS_TEST_REAL_CLAUDE=1 npx playwright test e2e/plugin-mcp-real-claude.spec.ts
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { execSync, spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import http from 'http'
import net from 'net'

const REAL_CLAUDE_ENABLED = process.env.TERMPOLIS_TEST_REAL_CLAUDE === '1'

test.skip(!REAL_CLAUDE_ENABLED, 'Set TERMPOLIS_TEST_REAL_CLAUDE=1 to run against a real claude binary')

let app: ElectronApplication
let mcpPort: number
let mcpToken: string

const PROJECT_ROOT = path.resolve('.')

function claudeAvailable(): boolean {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
    })
    return res.status === 0 && !!res.stdout?.trim()
  } catch {
    return false
  }
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1')
  })
}

function termpolisUserData(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'termpolis')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  }
  return path.join(os.homedir(), '.config', 'termpolis')
}

async function postMcp<T = any>(port: number, token: string, body: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => (chunks += c))
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

test.beforeAll(async () => {
  if (!claudeAvailable()) {
    test.skip(true, 'claude binary not on PATH — skipping real-claude integration')
  }
  // If another Termpolis owns the MCP port, bail rather than racing it.
  if (await portInUse(9315)) {
    test.skip(true, 'MCP port 9315 already in use — stop the running Termpolis before running this spec')
  }

  execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // All four plugin writes + MCP server listen happen in app.whenReady.
  // Give them a comfortable buffer before we start probing.
  await page.waitForTimeout(4000)

  const userData = termpolisUserData()
  const tokenPath = path.join(userData, 'mcp-token')
  const portPath = path.join(userData, 'mcp-port')
  expect(fs.existsSync(tokenPath), `mcp-token must exist at ${tokenPath}`).toBe(true)
  expect(fs.existsSync(portPath), `mcp-port must exist at ${portPath}`).toBe(true)
  mcpToken = fs.readFileSync(tokenPath, 'utf-8').trim()
  mcpPort = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test('real claude -p discovers termpolis plugin and can call mcp__termpolis tools WITHOUT --mcp-config', async () => {
  expect(mcpToken?.length, 'mcp token must be readable').toBeGreaterThan(0)
  expect(mcpPort, 'mcp port must be a real port').toBeGreaterThan(0)

  const sentinel = `PLUGIN-DISCOVERY-${Date.now()}`

  // No --mcp-config, no --strict-mcp-config. This is the pure plugin
  // discovery path — the exact code path that v1.11.6's conductor
  // silently bypassed.
  const prompt =
    `Call the mcp__termpolis__swarm_send_message tool with ` +
    `from='plugin-discovery-test' to='all' type='info' content='${sentinel}'. ` +
    `After the tool call, reply ONLY with the single word DONE.`

  const res = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    encoding: 'utf-8',
    timeout: 120_000,
  })

  const output = (res.stdout || '') + (res.stderr || '')

  // If the plugin path didn't load MCP, claude will say so plainly.
  // Surface the real message so debugging is fast.
  const bypassSignals = [
    /tools?\s+(?:aren'?t|are not|isn'?t|is not)\s+(?:available|registered|loaded)/i,
    /no\s+mcp__\s+tools/i,
    /unable to use.*mcp/i,
    /Not logged in/i,
  ]
  const bypass = bypassSignals.find((p) => p.test(output))
  expect(
    bypass,
    `claude should NOT report MCP tools as unavailable. Matched: ${bypass}\nOutput:\n${output.slice(0, 2000)}`,
  ).toBeUndefined()

  // Verify the tool call actually landed on the bus.
  const readRes = await postMcp(mcpPort, mcpToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'swarm_read_messages', arguments: { limit: 20 } },
  })
  const text = JSON.stringify(readRes)
  expect(
    text.includes(sentinel),
    `swarm bus should contain sentinel "${sentinel}". ` +
    `Claude output:\n${output.slice(0, 2000)}\n` +
    `Swarm read response: ${text.slice(0, 500)}`,
  ).toBe(true)
})
