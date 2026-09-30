/**
 * Legacy Local Plugin — Removal Guard
 * ------------------------------------
 * Up to v1.48 Termpolis installed itself into Claude Code a second time, as a
 * local plugin that registered a duplicate MCP server:
 *
 *   ~/.claude/local-marketplace/plugins/termpolis/{.mcp.json, .claude-plugin/plugin.json}
 *   ~/.claude/plugins/cache/<marketplace>/termpolis/<version>/...   (Claude Code's copy)
 *   ~/.claude/settings.json → enabledPlugins["termpolis@<marketplace>"]
 *   ~/.claude/plugins/installed_plugins.json → plugins["termpolis@<marketplace>"]
 *   ~/.claude/local-marketplace/.claude-plugin/marketplace.json → plugins[{ name: "termpolis" }]
 *
 * v1.49 no longer writes any of it, and its one-time `remove-local-plugin-v1` boot
 * migration takes the old install out again — without touching anything the user
 * keeps next to it. This spec seeds that old layout, alongside a plugin of the
 * user's own in the same marketplace, then checks what one real startup leaves.
 *
 * Every path is under a scratch home passed as TERMPOLIS_TEST_AGENT_HOME, never
 * the developer's real ~/.claude.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { e2eLaunchArgs } from './helpers/launch'

let app: ElectronApplication
let page: Page
let scratchHome: string

const PROJECT_ROOT = path.resolve('.')

const claude = (...parts: string[]) => path.join(scratchHome, '.claude', ...parts)
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'))

const SERVER = { mcpServers: { termpolis: { command: 'node', args: ['/opt/termpolis/stdio-adapter.cjs'] } } }
const MANIFEST = { name: 'termpolis', version: '1.0.0', author: { name: 'Termpolis' } }

test.beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-pluginmcp-home-'))

  // The plugin as v1.48 left it: marketplace source, Claude Code's cached copy, and the
  // three registrations that point at it.
  writeJson(claude('local-marketplace', 'plugins', 'termpolis', '.mcp.json'), SERVER)
  writeJson(claude('local-marketplace', 'plugins', 'termpolis', '.claude-plugin', 'plugin.json'), MANIFEST)
  writeJson(claude('plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.mcp.json'), SERVER)
  writeJson(claude('plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.claude-plugin', 'plugin.json'), MANIFEST)
  writeJson(claude('settings.json'), {
    enabledPlugins: { 'termpolis@local-plugins': true, 'mine@local-plugins': true },
    theme: 'dark',
  })
  writeJson(claude('plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'termpolis@local-plugins': [{ scope: 'user' }], 'mine@local-plugins': [{ scope: 'user' }] },
  })
  writeJson(claude('local-marketplace', '.claude-plugin', 'marketplace.json'), {
    name: 'local-plugins',
    plugins: [{ name: 'termpolis', source: './plugins/termpolis' }, { name: 'mine', source: './plugins/mine' }],
  })
  // The user's own plugin in the same marketplace.
  writeJson(claude('local-marketplace', 'plugins', 'mine', '.claude-plugin', 'plugin.json'), { name: 'mine' })

  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })

  app = await electron.launch({
    args: e2eLaunchArgs('plugin-removal'),
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENT_HOME: scratchHome },
  })

  page = await app.firstWindow()
  // No dismissOnboarding here: skipping the tour answers its "Connect agents" step, and
  // these tests check what happens before anyone answers. They only use IPC and the
  // filesystem, so the tour can stay open.
  await page.waitForLoadState('domcontentloaded')
  // The boot migrations run synchronously in app.whenReady, after the window
  // loads. Give them a comfortable buffer.
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  if (app) await app.close()
  if (scratchHome) {
    try { fs.rmSync(scratchHome, { recursive: true, force: true }) } catch {}
  }
})

test('the plugin files are gone from the marketplace and the plugin cache', () => {
  expect(fs.existsSync(claude('local-marketplace', 'plugins', 'termpolis'))).toBe(false)
  expect(fs.existsSync(claude('plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.mcp.json'))).toBe(false)
  expect(fs.existsSync(claude('plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.claude-plugin', 'plugin.json'))).toBe(false)
})

test('the plugin is no longer enabled, installed or listed', () => {
  expect(readJson(claude('settings.json')).enabledPlugins).toEqual({ 'mine@local-plugins': true })
  expect(Object.keys(readJson(claude('plugins', 'installed_plugins.json')).plugins)).toEqual(['mine@local-plugins'])
  const listed = readJson(claude('local-marketplace', '.claude-plugin', 'marketplace.json')).plugins
  expect(listed.map((p: { name: string }) => p.name)).toEqual(['mine'])
})

test("the user's own plugin and settings stay", () => {
  expect(fs.existsSync(claude('local-marketplace', 'plugins', 'mine', '.claude-plugin', 'plugin.json'))).toBe(true)
  expect(readJson(claude('settings.json')).theme).toBe('dark')
})

// An install that already had the plugin is a legacy connection: it keeps working, through
// the one real registration, until the user answers the one-time review.
test('a legacy install keeps one MCP registration, with the explicit allow list', async () => {
  const status = await page.evaluate(() => (window as any).termpolis.agentIntegrationStatus())
  expect(status.data.legacyDetected).toBe(true)
  expect(status.data.consent).toBeNull()
  expect(status.data.connected).toBe(true)

  expect(readJson(path.join(scratchHome, '.claude.json')).mcpServers?.termpolis?.args?.[0]).toContain('stdio-adapter.cjs')
  const allow: string[] = readJson(claude('settings.json')).permissions?.allow ?? []
  expect(allow).toContain('mcp__termpolis__memory_search')
  expect(allow).not.toContain('mcp__termpolis__*')
  expect(allow).not.toContain('mcp__termpolis__run_command')
})
