// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { join, parse } from 'path'
import {
  bootAgentIntegration, disconnectAgentIntegration, getAgentIntegrationStatus, setAgentIntegration,
  trustFolderForAgents,
} from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths } from '../../src/main/agentIntegrationManager'
import { CLAUDE_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import { claudeProjectKey } from '../../src/main/claudeTrust'
import { codexServerState } from '../../src/main/codexConfigEdit'
import {
  ALL_MIGRATIONS, PLUGIN_MANIFEST, allMigrationsBut, blockWrites, codexServerToml, createSandbox, ourEntry,
  readJson, readText, throwingHomeIn, unblockWrites, withPlatform, writeJson, writeLedger, writeText,
} from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
})

afterEach(() => {
  vi.restoreAllMocks()
  sb.dispose()
})

const WRITE_ERROR = /EISDIR|EPERM|EACCES/
const ALLOW_MIGRATION = 'Permission for every Termpolis tool to run without asking'
const MCP_JSON = 'MCP server in ~/.mcp.json'
const UNSAFE_TRUST = 'Folder trust for your home folder or a drive root'
const OUR_TRUST = 'Folder trust Termpolis added'
const PLUGIN = {
  enabled: 'Local Termpolis plugin, enabled',
  record: 'Local Termpolis plugin, install record',
  market: 'Local Termpolis plugin, marketplace entry',
  files: 'Local Termpolis plugin, files',
}

const approval = (tool: string): string => `[mcp_servers.termpolis.tools.${tool}]\napproval_mode = "auto"`

/** A ledger where the user said no and only migration `id` has still to run. */
function onlyPending(id: string): void {
  writeLedger(sb, { consent: 'declined', migrations: allMigrationsBut(id) })
}

function ledgerMigrations(): string[] {
  return readJson(sb.ledgerFile).migrations
}

/** The Claude config dir (CLAUDE_CONFIG_DIR style) and the Codex home moved out of the home folder. */
function splitPaths(): AgentIntegrationPaths {
  const ccd = join(sb.root, 'ccd')
  return { ...sb.paths, claudeDir: ccd, claudeJson: join(ccd, '.claude.json'), codexHome: join(sb.root, 'cx') }
}

describe('legacy detection (no ledger yet)', () => {
  it.each<[string, (s: Sandbox) => void, boolean]>([
    ['an MCP server in Claude settings.json', (s) => writeJson(s.files.settings, { mcpServers: { termpolis: ourEntry(s) } }), false],
    ['a Termpolis allow rule', (s) => writeJson(s.files.settings, { permissions: { allow: ['mcp__termpolis__memory_search'] } }), false],
    ['the local plugin enabled', (s) => writeJson(s.files.settings, { enabledPlugins: { 'termpolis@local-plugins': true } }), false],
    ['the local plugin enabled under a marketplace it registered', (s) => {
      writeJson(s.files.settings, { enabledPlugins: { 'termpolis@mine': true } })
      writeJson(join(s.paths.claudeDir, 'plugins', 'known_marketplaces.json'), {
        mine: { source: { source: 'directory', path: join(s.paths.claudeDir, 'local-marketplace') } },
      })
    }, false],
    ['the memory primer hook', (s) => writeJson(s.files.settings, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "C:/old/memory-primer-hook.cjs"' }] }] },
    }), true],
    ['the local plugin folder', (s) => writeJson(
      join(s.paths.claudeDir, 'local-marketplace', 'plugins', 'termpolis', '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST,
    ), false],
    ['an MCP server in .claude.json', (s) => writeJson(s.files.claudeJson, { mcpServers: { termpolis: { type: 'stdio', ...ourEntry(s) } } }), false],
    ['an MCP server in ~/.mcp.json', (s) => writeJson(s.files.mcpJson, { mcpServers: { termpolis: ourEntry(s) } }), false],
    ['a top-level server in ~/.mcp.json', (s) => writeJson(s.files.mcpJson, { termpolis: ourEntry(s) }), false],
    ['an MCP server in Codex', (s) => writeText(s.files.codex, codexServerToml('node', [s.adapter])), false],
    ['an MCP server in Gemini', (s) => writeJson(s.files.gemini, { mcpServers: { termpolis: ourEntry(s) } }), false],
  ])('finds %s', (_label, setup, hook) => {
    setup(sb)
    expect(getAgentIntegrationStatus(sb.paths)).toMatchObject({ consent: null, legacyDetected: true, connected: true, primerHook: hook })
    expect(readJson(sb.ledgerFile)).toEqual({
      version: 1, consent: null, primerHook: hook, legacy: true, migrations: [], trustedByTermpolis: [],
    })
  })

  it('ignores what Termpolis did not write, and files it cannot read', () => {
    const foreign = { command: 'npx', args: ['termpolis-mcp'] }
    writeJson(sb.files.settings, {
      mcpServers: { termpolis: foreign },
      permissions: { allow: ['Bash(ls)', 'mcp__github__search'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      enabledPlugins: { 'other@local-plugins': true, 'termpolis@official': true },
    })
    writeJson(join(sb.paths.claudeDir, 'local-marketplace', 'plugins', 'termpolis', '.claude-plugin', 'plugin.json'), {
      name: 'termpolis', author: { name: 'Someone else' },
    })
    writeJson(join(sb.paths.claudeDir, 'local-marketplace', 'termpolis', '.mcp.json'), { mcpServers: { termpolis: foreign } })
    writeText(sb.files.claudeJson, '{"mcpServers": {"termpolis": ')
    writeJson(sb.files.mcpJson, { termpolis: foreign })
    mkdirSync(sb.files.codex, { recursive: true })
    writeJson(sb.files.gemini, { mcpServers: { termpolis: foreign } })
    expect(getAgentIntegrationStatus(sb.paths)).toMatchObject({ legacyDetected: false, connected: false, primerHook: true })
  })

  it.each([
    ['not valid TOML', '[mcp_servers.termpolis\ncommand = "node"\n'],
    ["someone else's server", codexServerToml('npx', ['termpolis-mcp'])],
  ])('a Codex config that is %s is not a legacy install', (_label, text) => {
    writeText(sb.files.codex, text)
    expect(getAgentIntegrationStatus(sb.paths).legacyDetected).toBe(false)
  })

  it.each<[string, (s: Sandbox, p: AgentIntegrationPaths) => void]>([
    ['Claude settings in the configured folder', (_s, p) => writeJson(join(p.claudeDir, 'settings.json'), { permissions: { allow: ['mcp__termpolis__*'] } })],
    ['Claude settings in the default folder', (s) => writeJson(join(s.home, '.claude', 'settings.json'), { permissions: { allow: ['mcp__termpolis__*'] } })],
    ['.claude.json in the configured folder', (s, p) => writeJson(p.claudeJson, { mcpServers: { termpolis: ourEntry(s) } })],
    ['.claude.json in the home folder', (s) => writeJson(join(s.home, '.claude.json'), { mcpServers: { termpolis: ourEntry(s) } })],
    ['Codex in the configured home', (s, p) => writeText(join(p.codexHome, 'config.toml'), codexServerToml('node', [s.adapter]))],
    ['Codex in the default home', (s) => writeText(join(s.home, '.codex', 'config.toml'), codexServerToml('node', [s.adapter]))],
  ])('with the configs moved, still finds %s', (_label, setup) => {
    const split = splitPaths()
    setup(sb, split)
    expect(getAgentIntegrationStatus(split).legacyDetected).toBe(true)
  })
})

describe('migration: claude-allow-safe-list-v1', () => {
  const ID = 'claude-allow-safe-list-v1'
  const rule = (tool: string): string => `mcp__termpolis__${tool}`
  // The explicit list the first Termpolis wrote, and the part of it the safe list keeps.
  const FIRST_VERSION = [
    'list_terminals', 'create_terminal', 'run_command', 'read_output', 'close_terminal',
    'write_to_terminal', 'get_file_tree', 'get_git_status', 'swarm_send_message',
    'swarm_read_messages', 'swarm_create_task', 'swarm_list_tasks', 'swarm_update_task',
    'swarm_list_agents',
  ].map(rule)
  const FIRST_VERSION_SAFE = ['list_terminals', 'get_git_status', 'swarm_read_messages', 'swarm_list_tasks', 'swarm_list_agents'].map(rule)

  beforeEach(() => {
    onlyPending(ID)
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['the wildcard', { model: 'opus', permissions: { allow: [rule('*'), 'Bash(ls)'] } }, { model: 'opus', permissions: { allow: ['Bash(ls)'] } }],
    [
      'the (*) forms',
      { permissions: { allow: [rule('run_command(*)'), rule('memory_search'), 'Read(*)'] } },
      { permissions: { allow: [rule('memory_search'), 'Read(*)'] } },
    ],
    [
      "the first version's whole list, keeping its safe tools",
      { permissions: { allow: ['Bash(ls)', ...FIRST_VERSION] } },
      { permissions: { allow: ['Bash(ls)', ...FIRST_VERSION_SAFE] } },
    ],
    ['an allow list it empties, keeping deny', { permissions: { allow: [rule('*')], deny: ['Bash(rm:*)'] } }, { permissions: { deny: ['Bash(rm:*)'] } }],
    ['permissions it empties', { permissions: { allow: [rule('*')] }, model: 'opus' }, { model: 'opus' }],
  ])('removes %s', (_label, before, after) => {
    writeJson(sb.files.settings, before)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: ALLOW_MIGRATION },
    ])
    expect(readJson(sb.files.settings)).toEqual(after)
    expect(ledgerMigrations()).toEqual([...allMigrationsBut(ID), ID])
  })

  it('leaves the first version\'s rules when only some are there: those could be the user\'s', () => {
    const partial = { permissions: { allow: FIRST_VERSION.slice(0, -1) } }
    writeJson(sb.files.settings, partial)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    expect(readJson(sb.files.settings)).toEqual(partial)
    expect(ledgerMigrations()).toContain(ID)
  })

  it('runs again at the next start when settings.json has an unexpected shape', () => {
    writeJson(sb.files.settings, { permissions: 'all' })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: ALLOW_MIGRATION, error: '`permissions` is not an object' },
    ])
    expect(readJson(sb.files.settings)).toEqual({ permissions: 'all' })
    expect(ledgerMigrations()).not.toContain(ID)

    writeJson(sb.files.settings, { permissions: { allow: [rule('*')] } })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: ALLOW_MIGRATION },
    ])
    expect(ledgerMigrations()).toContain(ID)
  })

  it('cleans both the configured Claude folder and the default one', () => {
    const split = splitPaths()
    const files = [join(split.claudeDir, 'settings.json'), join(sb.home, '.claude', 'settings.json')]
    for (const f of files) writeJson(f, { permissions: { allow: [rule('*')] } })
    expect(bootAgentIntegration({ ...sb.rt, paths: split }).changes).toEqual(
      files.map((file) => ({ agent: 'claude', file, action: 'remove', what: ALLOW_MIGRATION })),
    )
    for (const f of files) expect(readJson(f)).toEqual({})
  })
})

describe('migration: drop-global-mcp-json-v1', () => {
  const ID = 'drop-global-mcp-json-v1'

  beforeEach(() => {
    onlyPending(ID)
  })

  it.each<[string, (s: Sandbox) => Record<string, unknown>]>([
    ['under mcpServers', (s) => ({ mcpServers: { termpolis: ourEntry(s) } })],
    ['at the top level', (s) => ({ termpolis: ourEntry(s) })],
    ['in both places', (s) => ({ mcpServers: { termpolis: ourEntry(s) }, termpolis: ourEntry(s) })],
  ])('deletes a ~/.mcp.json that held only the Termpolis server %s', (_label, make) => {
    writeJson(sb.files.mcpJson, make(sb))
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'remove', what: MCP_JSON },
    ])
    expect(existsSync(sb.files.mcpJson)).toBe(false)
    expect(ledgerMigrations()).toContain(ID)
  })

  it("keeps the file, and the user's own servers in it", () => {
    writeJson(sb.files.mcpJson, { mcpServers: { termpolis: ourEntry(sb), github: { command: 'gh' } } })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'remove', what: MCP_JSON },
    ])
    expect(readJson(sb.files.mcpJson)).toEqual({ mcpServers: { github: { command: 'gh' } } })
  })

  it("leaves someone else's termpolis server alone", () => {
    writeJson(sb.files.mcpJson, { mcpServers: { termpolis: { command: 'npx', args: ['termpolis-mcp'] } } })
    const text = readText(sb.files.mcpJson)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    expect(readText(sb.files.mcpJson)).toBe(text)
    expect(ledgerMigrations()).toContain(ID)
  })

  it('runs again at the next start when the file cannot be written', () => {
    writeJson(sb.files.mcpJson, { mcpServers: { termpolis: ourEntry(sb) } })
    const text = readText(sb.files.mcpJson)
    blockWrites(sb.files.mcpJson)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'skipped', what: MCP_JSON, error: expect.stringMatching(WRITE_ERROR) },
    ])
    expect(readText(sb.files.mcpJson)).toBe(text)
    expect(ledgerMigrations()).not.toContain(ID)

    unblockWrites(sb.files.mcpJson)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'remove', what: MCP_JSON },
    ])
    expect(existsSync(sb.files.mcpJson)).toBe(false)
    expect(ledgerMigrations()).toContain(ID)
  })
})

describe('migration: remove-local-plugin-v1', () => {
  const ID = 'remove-local-plugin-v1'

  beforeEach(() => {
    onlyPending(ID)
  })

  function layout() {
    const dir = sb.paths.claudeDir
    const market = join(dir, 'local-marketplace')
    const cache = join(dir, 'plugins', 'cache')
    return {
      dir,
      market,
      cache,
      settings: join(dir, 'settings.json'),
      installed: join(dir, 'plugins', 'installed_plugins.json'),
      known: join(dir, 'plugins', 'known_marketplaces.json'),
      marketplace: join(market, '.claude-plugin', 'marketplace.json'),
      src: join(market, 'plugins', 'termpolis'),
      src2: join(market, 'termpolis'),
      v1: join(cache, 'local-plugins', 'termpolis', '1.0.0'),
      v2: join(cache, 'my-market', 'termpolis', '0.9.0'),
    }
  }

  /** The two files the old installer wrote into a plugin folder. */
  function pluginFiles(folder: string, which: { manifest?: boolean; servers?: boolean } = { manifest: true, servers: true }): void {
    if (which.manifest) writeJson(join(folder, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST)
    if (which.servers) writeJson(join(folder, '.mcp.json'), { mcpServers: { termpolis: ourEntry(sb) } })
  }

  it('takes out the enablement, the install record, the marketplace entry and every copy of its files', () => {
    const L = layout()
    const source = { source: 'directory', path: L.market }
    writeJson(L.settings, {
      enabledPlugins: { 'termpolis@local-plugins': true, 'termpolis@my-market': true, 'other@local-plugins': true },
      extraKnownMarketplaces: { 'my-market': { source } },
    })
    writeJson(L.known, {
      'local-plugins': { source },
      official: { source: { source: 'github', repo: 'example/plugins' } },
    })
    const record = [{ scope: 'user', version: '1.0.0' }]
    writeJson(L.installed, {
      version: 2,
      plugins: { 'termpolis@local-plugins': record, 'termpolis@my-market': record, 'other@local-plugins': record },
    })
    writeJson(L.marketplace, {
      name: 'local-plugins',
      owner: { name: 'me' },
      plugins: [{ name: 'termpolis', source: './plugins/termpolis/' }, { name: 'other', source: './plugins/other' }],
    })
    pluginFiles(L.src)
    pluginFiles(L.src2, { servers: true })
    writeText(join(L.src2, 'README.md'), '# my notes\n')
    pluginFiles(L.v1)
    pluginFiles(L.v2, { manifest: true })
    const known = readText(L.known)

    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: L.settings, action: 'remove', what: PLUGIN.enabled },
      { agent: 'claude', file: L.installed, action: 'remove', what: PLUGIN.record },
      { agent: 'claude', file: L.marketplace, action: 'remove', what: PLUGIN.market },
      { agent: 'claude', file: L.src, action: 'remove', what: PLUGIN.files },
      { agent: 'claude', file: L.src2, action: 'remove', what: PLUGIN.files },
      { agent: 'claude', file: L.v1, action: 'remove', what: PLUGIN.files },
      { agent: 'claude', file: L.v2, action: 'remove', what: PLUGIN.files },
    ])
    // Other plugins and every marketplace registration stay.
    expect(readJson(L.settings)).toEqual({
      enabledPlugins: { 'other@local-plugins': true },
      extraKnownMarketplaces: { 'my-market': { source } },
    })
    expect(readJson(L.installed)).toEqual({ version: 2, plugins: { 'other@local-plugins': record } })
    expect(readJson(L.marketplace)).toEqual({
      name: 'local-plugins', owner: { name: 'me' }, plugins: [{ name: 'other', source: './plugins/other' }],
    })
    expect(readText(L.known)).toBe(known)
    // Folders left empty go, up to the Claude folder or the plugin cache; a user's file keeps its folder.
    expect(existsSync(join(L.market, 'plugins'))).toBe(false)
    expect(readdirSync(L.market).sort()).toEqual(['.claude-plugin', 'termpolis'])
    expect(readdirSync(L.src2)).toEqual(['README.md'])
    expect(readdirSync(L.cache)).toEqual([])
    expect(ledgerMigrations()).toContain(ID)
  })

  it("leaves plugin folders that are not Termpolis's, or that link out of the Claude folder", () => {
    const L = layout()
    const foreign = { mcpServers: { termpolis: { command: 'npx', args: ['termpolis-mcp'] } } }
    writeJson(join(L.src, '.claude-plugin', 'plugin.json'), { name: 'termpolis', author: { name: 'Someone else' } })
    writeJson(join(L.src, '.mcp.json'), foreign)
    // A link to a checkout of the plugin's source.
    const checkout = join(sb.root, 'checkout')
    pluginFiles(checkout)
    sb.link(checkout, L.src2)
    // A cached version that is a link, and a cached marketplace that links out of the cache.
    const version = join(sb.root, 'linked-version')
    pluginFiles(version)
    sb.link(version, L.v1)
    const outside = join(sb.root, 'outside-market')
    pluginFiles(join(outside, 'termpolis', '2.0.0'))
    sb.link(outside, join(L.cache, 'linked-market'))
    writeJson(L.settings, { extraKnownMarketplaces: { 'linked-market': { source: { source: 'directory', path: L.market } } } })

    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    for (const folder of [checkout, version, join(outside, 'termpolis', '2.0.0')]) {
      expect(readJson(join(folder, '.claude-plugin', 'plugin.json'))).toEqual(PLUGIN_MANIFEST)
      expect(existsSync(join(folder, '.mcp.json'))).toBe(true)
    }
    expect(readJson(join(L.src, '.mcp.json'))).toEqual(foreign)
    expect(ledgerMigrations()).toContain(ID)
  })

  it('does not follow a marketplace name out of the plugin cache', () => {
    const L = layout()
    writeJson(L.settings, { extraKnownMarketplaces: { '../../evil': { source: { source: 'directory', path: L.market } } } })
    const evil = join(L.dir, 'evil', 'termpolis', '1.0.0')
    pluginFiles(evil)
    // No plugin cache at all: the folder cannot be shown to be inside it.
    expect(existsSync(L.cache)).toBe(false)
    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    expect(existsSync(join(evil, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(evil, '.mcp.json'))).toBe(true)
  })

  it('never prunes folders outside the cache path, even when a link leads back into the cache', () => {
    const L = layout()
    writeJson(L.settings, { extraKnownMarketplaces: { '../../back': { source: { source: 'directory', path: L.market } } } })
    const inCache = join(L.cache, 'real-market')
    pluginFiles(join(inCache, 'termpolis', '1.0.0'), { manifest: true })
    sb.link(inCache, join(L.dir, 'back'))
    const viaLink = join(L.dir, 'back', 'termpolis', '1.0.0')
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: viaLink, action: 'remove', what: PLUGIN.files },
    ])
    // The file went; the emptied folders stay, as they are only reachable by a path outside the cache.
    expect(readdirSync(join(inCache, 'termpolis', '1.0.0'))).toEqual(['.claude-plugin'])
    expect(readdirSync(join(inCache, 'termpolis', '1.0.0', '.claude-plugin'))).toEqual([])
  })

  it('removes only the files it can prove are its own', () => {
    const L = layout()
    writeText(join(L.src, '.claude-plugin'), 'not a folder\n')
    pluginFiles(L.src, { servers: true })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: L.src, action: 'remove', what: PLUGIN.files },
    ])
    expect(readdirSync(L.src)).toEqual(['.claude-plugin'])
    expect(readText(join(L.src, '.claude-plugin'))).toBe('not a folder\n')
  })

  it('reports a copy it could not remove, and runs again at the next start', () => {
    const L = layout()
    writeJson(L.settings, { extraKnownMarketplaces: { 'other-market': { source: { source: 'directory', path: L.market } } } })
    const v = join(L.cache, 'local-plugins', 'termpolis', '1.0.0')
    pluginFiles(v, { manifest: true })
    // A second marketplace name for the same cached copy: by the time it comes up, pruning the
    // first has taken the copy away.
    sb.link(join(L.cache, 'local-plugins'), join(L.cache, 'other-market'))
    const alias = join(L.cache, 'other-market', 'termpolis', '1.0.0')
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: v, action: 'remove', what: PLUGIN.files },
      { agent: 'claude', file: alias, action: 'skipped', what: PLUGIN.files, error: expect.stringContaining('ENOENT') },
    ])
    expect(existsSync(join(L.cache, 'local-plugins'))).toBe(false)
    expect(ledgerMigrations()).not.toContain(ID)

    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    expect(ledgerMigrations()).toContain(ID)
  })

  it.each(['win32', 'linux'] as const)('finds its folders with %s path rules', (platform) => {
    const L = layout()
    pluginFiles(L.v1)
    const r = withPlatform(platform, () => bootAgentIntegration(sb.rt))
    expect(r.changes).toEqual([{ agent: 'claude', file: L.v1, action: 'remove', what: PLUGIN.files }])
    expect(existsSync(join(L.cache, 'local-plugins'))).toBe(false)
  })
})

describe('migration: untrust-home-v1', () => {
  const ID = 'untrust-home-v1'

  beforeEach(() => {
    onlyPending(ID)
  })

  it('withdraws trust in the home folder, the folders above it and the drive root, and keeps the rest', () => {
    const keys = {
      home: claudeProjectKey(sb.home),
      above: claudeProjectKey(sb.root),
      root: claudeProjectKey(parse(sb.root).root),
      project: claudeProjectKey(join(sb.home, 'proj')),
    }
    writeJson(sb.files.claudeJson, {
      numStartups: 2,
      projects: {
        [keys.home]: { hasTrustDialogAccepted: true },
        [keys.above]: { hasTrustDialogAccepted: true },
        [keys.root]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'] },
        [keys.project]: { hasTrustDialogAccepted: true },
      },
    })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: UNSAFE_TRUST },
    ])
    // An entry holding only the flag goes; one with more in it keeps that, with the flag off.
    expect(readJson(sb.files.claudeJson)).toEqual({
      numStartups: 2,
      projects: {
        [keys.root]: { hasTrustDialogAccepted: false, allowedTools: ['Bash(ls)'] },
        [keys.project]: { hasTrustDialogAccepted: true },
      },
    })
    expect(ledgerMigrations()).toContain(ID)
  })

  it('runs again at the next start when .claude.json cannot be read', () => {
    writeText(sb.files.claudeJson, '{broken')
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: UNSAFE_TRUST, error: expect.any(String) },
    ])
    expect(readText(sb.files.claudeJson)).toBe('{broken')
    expect(ledgerMigrations()).not.toContain(ID)
  })

  it.each<[NodeJS.Platform, number]>([['win32', 1], ['linux', 2]])(
    'with %s path rules, two spellings of .claude.json that differ only in case are %i file(s)',
    (platform, count) => {
      const upper: AgentIntegrationPaths = { ...sb.paths, claudeJson: join(sb.home, '.CLAUDE.json') }
      const lower = join(sb.home, '.claude.json')
      writeText(lower, '{broken')
      writeText(upper.claudeJson, '{broken')
      const r = withPlatform(platform, () => bootAgentIntegration({ ...sb.rt, paths: upper }))
      expect(r.changes).toEqual([upper.claudeJson, lower].slice(0, count).map((file) => (
        { agent: 'claude', file, action: 'skipped', what: UNSAFE_TRUST, error: expect.any(String) }
      )))
    },
  )
})

describe('one-time migrations', () => {
  it('run once each: a rule the user adds back afterwards stays', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb, { consent: 'declined', migrations: [] })
    writeJson(sb.files.settings, { permissions: { allow: ['mcp__termpolis__*'] } })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: ALLOW_MIGRATION },
    ])
    expect(ledgerMigrations()).toEqual([...ALL_MIGRATIONS])

    writeJson(sb.files.settings, { permissions: { allow: ['mcp__termpolis__*'] } })
    expect(bootAgentIntegration(sb.rt).changes).toEqual([])
    expect(readJson(sb.files.settings)).toEqual({ permissions: { allow: ['mcp__termpolis__*'] } })
  })

  it('a migration that throws is reported, and runs again at the next start', () => {
    onlyPending('drop-global-mcp-json-v1')
    writeJson(sb.files.mcpJson, { termpolis: ourEntry(sb) })
    const r = bootAgentIntegration({ ...sb.rt, paths: throwingHomeIn('removeGlobalMcpJson', sb.paths) })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.home, action: 'skipped', what: 'drop-global-mcp-json-v1', error: expect.stringContaining('boom') },
    ])
    expect(readJson(sb.files.mcpJson)).toEqual({ termpolis: ourEntry(sb) })
    expect(ledgerMigrations()).not.toContain('drop-global-mcp-json-v1')

    expect(bootAgentIntegration(sb.rt).changes).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'remove', what: MCP_JSON },
    ])
    expect(ledgerMigrations()).toContain('drop-global-mcp-json-v1')
  })
})

describe('disconnectAgentIntegration', () => {
  it("removes exactly what Termpolis wrote, giving the user's files back byte for byte", () => {
    for (const d of [sb.paths.claudeDir, sb.paths.codexHome, sb.paths.geminiDir]) mkdirSync(d, { recursive: true })
    writeLedger(sb)
    const userKey = claudeProjectKey(join(sb.root, 'user-project'))
    writeJson(sb.files.claudeJson, {
      numStartups: 5,
      mcpServers: { github: { command: 'gh' } },
      projects: { [userKey]: { hasTrustDialogAccepted: true } },
    })
    writeJson(sb.files.settings, {
      model: 'opus',
      // A user may allow one of Termpolis's command tools on their own: that rule is theirs.
      permissions: { allow: ['Bash(ls)', 'mcp__termpolis__run_command'], deny: ['Bash(rm:*)'] },
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    })
    writeText(sb.files.codex, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n')
    writeJson(sb.files.gemini, { theme: 'dark', mcpServers: { other: { command: 'y' } } })
    const files = [sb.files.claudeJson, sb.files.settings, sb.files.codex, sb.files.gemini]
    const original = files.map(readText)

    setAgentIntegration(sb.rt, { connect: true })
    const proj = join(sb.home, 'proj')
    mkdirSync(proj)
    expect(trustFolderForAgents(sb.paths, proj).changed).toBe(true)
    files.forEach((f, i) => expect(readText(f)).not.toBe(original[i]))

    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'SessionStart memory hook' },
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: sb.files.codex, action: 'remove', what: 'MCP server' },
      { agent: 'gemini', file: sb.files.gemini, action: 'remove', what: 'MCP server' },
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: OUR_TRUST },
    ])
    files.forEach((f, i) => expect(readText(f)).toBe(original[i]))
    expect(readJson(sb.ledgerFile)).toEqual({
      version: 1, consent: null, primerHook: true, legacy: false, migrations: [...ALL_MIGRATIONS], trustedByTermpolis: [],
    })
  })

  it('records a decline, keeping the hook choice and the migrations already done', () => {
    writeLedger(sb, { consent: 'granted', primerHook: false, legacy: true, migrations: ['claude-allow-safe-list-v1'] })
    expect(disconnectAgentIntegration(sb.paths, { recordDecline: true })).toEqual([])
    expect(readJson(sb.ledgerFile)).toEqual({
      version: 1, consent: 'declined', primerHook: false, legacy: false, migrations: ['claude-allow-safe-list-v1'], trustedByTermpolis: [],
    })
    disconnectAgentIntegration(sb.paths)
    expect(readJson(sb.ledgerFile).consent).toBeNull()
  })

  it('with no ledger saved, leaves a fresh one', () => {
    expect(disconnectAgentIntegration(sb.paths)).toEqual([])
    expect(readJson(sb.ledgerFile)).toEqual({
      version: 1, consent: null, primerHook: true, legacy: false, migrations: [], trustedByTermpolis: [],
    })
    expect(readdirSync(sb.home)).toEqual([])
  })

  it('withdraws only the folder trust it recorded, plus any on the home folder', () => {
    const keys = {
      mine: claudeProjectKey(join(sb.home, 'mine')),
      theirs: claudeProjectKey(join(sb.home, 'theirs')),
      home: claudeProjectKey(sb.home),
    }
    writeLedger(sb, { consent: 'granted', trustedByTermpolis: [keys.mine] })
    writeJson(sb.files.claudeJson, {
      projects: {
        [keys.mine]: { hasTrustDialogAccepted: true },
        [keys.theirs]: { hasTrustDialogAccepted: true },
        [keys.home]: { hasTrustDialogAccepted: true },
      },
    })
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: OUR_TRUST },
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: UNSAFE_TRUST },
    ])
    expect(readJson(sb.files.claudeJson)).toEqual({ projects: { [keys.theirs]: { hasTrustDialogAccepted: true } } })
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([])
  })

  it('keeps the trust keys it could not withdraw, so the next disconnect can try again', () => {
    const key = claudeProjectKey(join(sb.home, 'mine'))
    writeLedger(sb, { consent: 'granted', trustedByTermpolis: [key] })
    writeText(sb.files.claudeJson, '{broken')
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: 'MCP server', error: expect.any(String) },
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: OUR_TRUST, error: expect.any(String) },
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: UNSAFE_TRUST, error: expect.any(String) },
    ])
    expect(readText(sb.files.claudeJson)).toBe('{broken')
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([key])
  })

  it.each<[string, (s: Sandbox) => string]>([
    ['its server and tool approvals', (s) => `model = "o3"\n\n${codexServerToml('node', [s.adapter])}\n${approval('memory_search')}\n`],
    ['tool approvals left without their server', () => `model = "o3"\n\n${approval('memory_search')}\n`],
    ['a server table that names no command', () => 'model = "o3"\n\n[mcp_servers.termpolis]\n'],
  ])('Codex: removes %s', (_label, make) => {
    writeText(sb.files.codex, make(sb))
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'remove', what: 'MCP server' },
    ])
    expect(readText(sb.files.codex)).toBe('model = "o3"\n')
    expect(codexServerState(readText(sb.files.codex))).toEqual({ state: 'absent' })
  })

  it.each<[string, string | null]>([
    ['missing', null],
    ['without Termpolis', 'model = "o3"\n'],
    ["holding someone else's termpolis server", codexServerToml('npx', ['termpolis-mcp'])],
  ])('Codex: leaves a config.toml %s as it is', (_label, text) => {
    if (text !== null) writeText(sb.files.codex, text)
    expect(disconnectAgentIntegration(sb.paths)).toEqual([])
    expect(existsSync(sb.files.codex) ? readText(sb.files.codex) : null).toBe(text)
  })

  it.each<[string, (s: Sandbox) => void, RegExp]>([
    ['not valid TOML', (s) => writeText(s.files.codex, '[mcp_servers.termpolis\n'), /./],
    ['a folder', (s) => mkdirSync(s.files.codex, { recursive: true }), /EISDIR|EPERM|EACCES|illegal operation/],
    ['not writable', (s) => {
      writeText(s.files.codex, codexServerToml('node', [s.adapter]))
      blockWrites(s.files.codex)
    }, WRITE_ERROR],
  ])('Codex: reports a config.toml that is %s', (_label, make, error) => {
    make(sb)
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error: expect.stringMatching(error) },
    ])
  })

  it('a config.toml it cannot write is left as it was', () => {
    const text = codexServerToml('node', [sb.adapter])
    writeText(sb.files.codex, text)
    blockWrites(sb.files.codex)
    disconnectAgentIntegration(sb.paths)
    expect(readText(sb.files.codex)).toBe(text)
  })

  it('cleans both the configured locations and the default ones', () => {
    const split = splitPaths()
    const settings = [join(split.claudeDir, 'settings.json'), join(sb.home, '.claude', 'settings.json')]
    const claudeJsons = [split.claudeJson, join(sb.home, '.claude.json')]
    const codex = [join(split.codexHome, 'config.toml'), join(sb.home, '.codex', 'config.toml')]
    for (const f of settings) writeJson(f, { permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
    for (const f of claudeJsons) writeJson(f, { mcpServers: { termpolis: { type: 'stdio', ...ourEntry(sb) } } })
    for (const f of codex) writeText(f, codexServerToml('node', [sb.adapter]))

    expect(disconnectAgentIntegration(split)).toEqual([
      ...settings.map((file) => ({ agent: 'claude', file, action: 'remove', what: 'Tool permissions' })),
      ...claudeJsons.map((file) => ({ agent: 'claude', file, action: 'remove', what: 'MCP server' })),
      ...codex.map((file) => ({ agent: 'codex', file, action: 'remove', what: 'MCP server' })),
    ])
    for (const f of [...settings, ...claudeJsons]) expect(readJson(f)).toEqual({})
    for (const f of codex) expect(readText(f)).toBe('')
  })

  it('reports a step that throws and carries on with the rest', () => {
    writeLedger(sb, { consent: 'granted' })
    writeJson(sb.files.mcpJson, { termpolis: ourEntry(sb) })
    writeJson(sb.files.gemini, { mcpServers: { termpolis: ourEntry(sb) } })
    expect(disconnectAgentIntegration(throwingHomeIn('removeGlobalMcpJson', sb.paths))).toEqual([
      { agent: 'claude', file: sb.files.mcpJson, action: 'skipped', what: 'Disconnect', error: expect.stringContaining('boom') },
      { agent: 'gemini', file: sb.files.gemini, action: 'remove', what: 'MCP server' },
    ])
    expect(readJson(sb.files.mcpJson)).toEqual({ termpolis: ourEntry(sb) })
    expect(readJson(sb.files.gemini)).toEqual({})
  })
})

describe('a config write that fails part-way', () => {
  it('reports the steps it could not save, not the ones already in place', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb)
    writeJson(sb.files.settings, { permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
    blockWrites(sb.files.settings)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes.filter((c) => c.file === sb.files.settings)).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'SessionStart memory hook', error: expect.stringMatching(WRITE_ERROR) },
    ])
    expect(readJson(sb.files.settings)).toEqual({ permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
  })
})
