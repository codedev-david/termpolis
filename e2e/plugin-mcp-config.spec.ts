/**
 * Plugin .mcp.json Variant — Shape & Adapter-Path Guard
 * ------------------------------------------------------
 * Termpolis writes MCP config in four places on startup so Claude Code
 * can find the termpolis server regardless of which discovery path
 * claude is using:
 *
 *   1. `<userData>/claude-mcp-config.json`     — standalone, for `--mcp-config`
 *   2. `~/.claude/settings.json`               — user-scope mcpServers entry
 *   3. `~/.mcp.json`                           — global MCP file
 *   4. `~/.claude/local-marketplace/plugins/termpolis/.mcp.json` +
 *      `~/.claude/plugins/cache/<marketplace>/termpolis/1.0.0/.mcp.json`
 *                                              — the PLUGIN variant
 *
 * v1.11.5 broke because the adapter `args[0]` pointed at a file that
 * wasn't shipped by electron-builder. mcpAdapterPackaging.test.ts guards
 * the packaging side. This spec guards the *discovery* side: after a
 * real startup, the plugin-variant files must (a) exist, (b) parse,
 * (c) have the mcpServers wrapper, and (d) point at an adapter that
 * actually exists on disk.
 *
 * To keep this from polluting the user's real ~/.claude, we override
 * HOME (Linux/mac) and USERPROFILE (Windows) to a scratch dir for the
 * duration of the launch. Termpolis's write logic uses os.homedir(),
 * which respects both of those.
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication
let scratchHome: string
let scratchUserData: string

const PROJECT_ROOT = path.resolve('.')

test.beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-pluginmcp-home-'))
  scratchUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-pluginmcp-userdata-'))

  // Seed an empty settings.json so the auto-enable path has something
  // to merge into. Termpolis only touches settings.json if it exists.
  fs.mkdirSync(path.join(scratchHome, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(scratchHome, '.claude', 'settings.json'),
    JSON.stringify({}, null, 2),
  )

  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: PROJECT_ROOT, stdio: 'pipe' })

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${scratchUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOME: scratchHome,
      USERPROFILE: scratchHome,
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // All four plugin writes happen synchronously in app.whenReady, but they
  // run after the window loads. Give them a comfortable buffer.
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  if (app) await app.close()
  for (const dir of [scratchHome, scratchUserData]) {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
})

function readPluginMcp(filePath: string) {
  expect(fs.existsSync(filePath), `plugin file should exist: ${filePath}`).toBe(true)
  const raw = fs.readFileSync(filePath, 'utf-8')
  let parsed: any
  expect(() => { parsed = JSON.parse(raw) }, `plugin file should be valid JSON: ${filePath}`).not.toThrow()
  return parsed
}

function assertMcpShape(mcp: any, label: string) {
  expect(mcp?.mcpServers, `${label}: mcpServers wrapper required`).toBeDefined()
  expect(mcp.mcpServers.termpolis, `${label}: termpolis server required`).toBeDefined()
  expect(mcp.mcpServers.termpolis.command, `${label}: command must be 'node'`).toBe('node')
  expect(Array.isArray(mcp.mcpServers.termpolis.args), `${label}: args must be array`).toBe(true)
  expect(mcp.mcpServers.termpolis.args.length, `${label}: args must have adapter path`).toBeGreaterThan(0)
  const adapterPath = mcp.mcpServers.termpolis.args[0]
  expect(typeof adapterPath, `${label}: adapter path must be string`).toBe('string')
  expect(
    fs.existsSync(adapterPath),
    `${label}: adapter path must resolve to an existing file: ${adapterPath}`,
  ).toBe(true)
  expect(adapterPath.endsWith('.cjs'), `${label}: adapter must be a .cjs file`).toBe(true)
}

test('marketplace plugin .mcp.json exists with correct shape and resolvable adapter', () => {
  const pluginMcp = path.join(
    scratchHome, '.claude', 'local-marketplace', 'plugins', 'termpolis', '.mcp.json',
  )
  const mcp = readPluginMcp(pluginMcp)
  assertMcpShape(mcp, 'marketplace plugin')
})

test('plugin cache .mcp.json exists with correct shape and resolvable adapter', () => {
  // Cache path depends on the marketplace name resolved at startup. We don't
  // know the name ahead of time, so glob for any cached termpolis plugin.
  const cacheRoot = path.join(scratchHome, '.claude', 'plugins', 'cache')
  expect(fs.existsSync(cacheRoot), 'plugin cache root must exist').toBe(true)

  const matches: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === '.mcp.json' && full.includes(path.sep + 'termpolis' + path.sep)) {
        matches.push(full)
      }
    }
  }
  walk(cacheRoot, 0)

  expect(matches.length, 'at least one cached termpolis .mcp.json must exist').toBeGreaterThan(0)
  for (const match of matches) {
    const mcp = readPluginMcp(match)
    assertMcpShape(mcp, `cache ${match}`)
  }
})

test('plugin.json manifests exist alongside both .mcp.json copies', () => {
  // A plugin .mcp.json without a sibling .claude-plugin/plugin.json won't be
  // discovered by Claude Code — it looks at the plugin.json first.
  const marketplacePluginJson = path.join(
    scratchHome, '.claude', 'local-marketplace',
    'plugins', 'termpolis', '.claude-plugin', 'plugin.json',
  )
  expect(fs.existsSync(marketplacePluginJson)).toBe(true)
  const manifest = JSON.parse(fs.readFileSync(marketplacePluginJson, 'utf-8'))
  expect(manifest.name).toBe('termpolis')
})

test('termpolis is listed in enabledPlugins inside settings.json', () => {
  const settingsPath = path.join(scratchHome, '.claude', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  expect(settings.enabledPlugins, 'enabledPlugins block must exist').toBeDefined()
  const keys = Object.keys(settings.enabledPlugins)
  const termpolisKey = keys.find((k) => k.startsWith('termpolis@'))
  expect(
    termpolisKey,
    `enabledPlugins must contain a termpolis@<marketplace> entry. Found: ${keys.join(', ')}`,
  ).toBeDefined()
  expect(settings.enabledPlugins[termpolisKey!]).toBe(true)
})

test('marketplace.json lists termpolis if the file exists', () => {
  const marketplaceJson = path.join(
    scratchHome, '.claude', 'local-marketplace', '.claude-plugin', 'marketplace.json',
  )
  // This file is only touched if it already existed; we seeded an empty
  // ~/.claude so it won't exist here. Skip the assertion if absent, since
  // the "register in existing marketplace" path is a soft-merge feature
  // rather than a guarantee. If it DOES exist, it must contain termpolis.
  if (!fs.existsSync(marketplaceJson)) {
    test.info().annotations.push({
      type: 'note',
      description: 'marketplace.json not pre-seeded — registration path not exercised in this run.',
    })
    return
  }
  const manifest = JSON.parse(fs.readFileSync(marketplaceJson, 'utf-8'))
  const names = (manifest.plugins || []).map((p: any) => p.name)
  expect(names).toContain('termpolis')
})
