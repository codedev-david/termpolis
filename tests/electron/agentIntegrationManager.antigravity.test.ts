// @vitest-environment node
// The Antigravity CLI (`agy`, what the Gemini profile runs) reads its MCP servers from
// ~/.gemini/config/mcp_config.json and its permissions from ~/.gemini/antigravity-cli/settings.json,
// never from Gemini CLI's settings.json. Connecting must reach both; disconnecting must take back
// exactly what it added.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import {
  bootAgentIntegration, codexHasTermpolisServer, disconnectAgentIntegration, getAgentIntegrationStatus,
  setAgentIntegration,
} from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths } from '../../src/main/agentIntegrationManager'
import { AGY_ALLOW_RULES, FOREIGN_SERVER } from '../../src/main/agentMcpRegistry'
import { MCP_TOOLS_AUTO_ALLOWED } from '../../src/shared/agentIntegration'
import { codexServerToml, createSandbox, ourEntry, readJson, writeJson, writeLedger, writeText } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
  sb.rt.hookShell = 'sh'
})

afterEach(() => {
  vi.restoreAllMocks()
  sb.dispose()
})

/** agy has run on this machine: both of its folders exist, as agy creates them. */
function installAgy(parts: { config?: boolean; cli?: boolean } = { config: true, cli: true }): void {
  mkdirSync(sb.paths.geminiDir, { recursive: true })
  if (parts.config) mkdirSync(dirname(sb.files.agyMcp), { recursive: true })
  if (parts.cli) mkdirSync(dirname(sb.files.agySettings), { recursive: true })
}

const connect = () => setAgentIntegration(sb.rt, { connect: true, primerHook: false })

describe('connecting reaches the Antigravity CLI', () => {
  it('adds the server to mcp_config.json and the safe list to its settings, keeping what agy wrote', () => {
    installAgy()
    writeJson(sb.files.agySettings, { trustedWorkspaces: ['C:\\work'] })
    writeJson(sb.files.agyMcp, { mcpServers: { fs: { command: 'npx', args: ['fs-server'] } } })

    const { changes } = connect()

    expect(readJson(sb.files.agyMcp)).toEqual({
      mcpServers: { fs: { command: 'npx', args: ['fs-server'] }, termpolis: ourEntry(sb) },
    })
    expect(readJson(sb.files.agySettings)).toEqual({
      trustedWorkspaces: ['C:\\work'],
      permissions: { allow: [...AGY_ALLOW_RULES] },
    })
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'gemini', file: sb.files.agyMcp, action: 'add', what: 'MCP server (Antigravity CLI)' }),
      expect.objectContaining({ agent: 'gemini', file: sb.files.agySettings, action: 'add', what: 'Tool permissions (Antigravity CLI)' }),
    ]))
  })

  it('creates both files when agy has made only its folders', () => {
    installAgy()
    connect()
    expect(readJson(sb.files.agyMcp)).toEqual({ mcpServers: { termpolis: ourEntry(sb) } })
    expect(readJson(sb.files.agySettings).permissions.allow).toEqual([...AGY_ALLOW_RULES])
  })

  it('never writes a `disabled` key, and keeps a user\'s own `disabled: true`', () => {
    installAgy()
    writeJson(sb.files.agyMcp, { mcpServers: { termpolis: { ...ourEntry(sb), disabled: true } } })
    connect()
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual({ ...ourEntry(sb), disabled: true })
  })

  it('is idempotent: a second connect changes nothing', () => {
    installAgy()
    connect()
    const before = [readJson(sb.files.agyMcp), readJson(sb.files.agySettings)]
    const { changes } = connect()
    expect(changes.filter((c) => c.file === sb.files.agyMcp || c.file === sb.files.agySettings)).toEqual([])
    expect([readJson(sb.files.agyMcp), readJson(sb.files.agySettings)]).toEqual(before)
  })

  it('appends only the missing rules and reports an update', () => {
    installAgy()
    const own = ['mcp(other/tool)', AGY_ALLOW_RULES[0]]
    writeJson(sb.files.agySettings, { permissions: { allow: own } })
    const { changes } = connect()
    expect(readJson(sb.files.agySettings).permissions.allow).toEqual([...own, ...AGY_ALLOW_RULES.slice(1)])
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: sb.files.agySettings, action: 'update' }),
    ]))
  })

  it('writes the server but no rules when only agy\'s config folder exists', () => {
    installAgy({ config: true, cli: false })
    connect()
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual(ourEntry(sb))
    expect(existsSync(sb.files.agySettings)).toBe(false)
  })

  it('writes nothing for agy when its config folder does not exist', () => {
    installAgy({ config: false, cli: true })
    connect()
    expect(existsSync(sb.files.agyMcp)).toBe(false)
    expect(existsSync(sb.files.agySettings)).toBe(false)
  })

  it('leaves someone else\'s `termpolis` server alone and allows nothing next to it', () => {
    installAgy()
    const foreign = { command: 'uvx', args: ['some-other-termpolis'] }
    writeJson(sb.files.agyMcp, { mcpServers: { termpolis: foreign } })
    const { changes } = connect()
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual(foreign)
    expect(existsSync(sb.files.agySettings)).toBe(false)
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: sb.files.agyMcp, action: 'skipped', what: 'MCP server (Antigravity CLI)', error: FOREIGN_SERVER }),
    ]))
  })

  it('skips a settings file whose permissions are the wrong shape, and says why', () => {
    installAgy()
    writeJson(sb.files.agySettings, { permissions: 'all' })
    const { changes } = connect()
    expect(readJson(sb.files.agySettings)).toEqual({ permissions: 'all' })
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: sb.files.agySettings, action: 'skipped', error: '`permissions` is not an object' }),
    ]))
  })

  it('boot re-applies for a connected user', () => {
    installAgy()
    writeLedger(sb, { consent: 'granted' })
    bootAgentIntegration(sb.rt)
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual(ourEntry(sb))
    expect(readJson(sb.files.agySettings).permissions.allow).toEqual([...AGY_ALLOW_RULES])
  })

  it('the rules are the same safe list as Claude Code\'s, in agy\'s form, with no wildcard', () => {
    expect(AGY_ALLOW_RULES).toEqual(MCP_TOOLS_AUTO_ALLOWED.map((t) => `mcp(termpolis/${t})`))
    expect(AGY_ALLOW_RULES.some((r) => r.includes('*'))).toBe(false)
  })
})

describe('disconnecting takes back exactly what was added', () => {
  it('removes the server and the rules, leaving agy\'s own keys and the user\'s rules', () => {
    installAgy()
    writeJson(sb.files.agySettings, { trustedWorkspaces: ['C:\\work'], permissions: { allow: ['mcp(other/tool)', 'mcp(termpolis/*)'] } })
    writeJson(sb.files.agyMcp, { mcpServers: { fs: { command: 'npx', args: ['fs-server'] } } })
    connect()

    const rows = disconnectAgentIntegration(sb.paths, { recordDecline: true })

    expect(readJson(sb.files.agyMcp)).toEqual({ mcpServers: { fs: { command: 'npx', args: ['fs-server'] } } })
    expect(readJson(sb.files.agySettings)).toEqual({
      trustedWorkspaces: ['C:\\work'],
      permissions: { allow: ['mcp(other/tool)', 'mcp(termpolis/*)'] },
    })
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: sb.files.agyMcp, action: 'remove', what: 'MCP server (Antigravity CLI)' }),
      expect.objectContaining({ file: sb.files.agySettings, action: 'remove', what: 'Tool permissions (Antigravity CLI)' }),
    ]))
  })

  it('leaves `{}` and drops an emptied permissions block when nothing else was there', () => {
    installAgy()
    connect()
    disconnectAgentIntegration(sb.paths)
    expect(readJson(sb.files.agyMcp)).toEqual({})
    expect(readJson(sb.files.agySettings)).toEqual({})
  })

  it('removes an entry agy imported from Gemini CLI, which carries the same signature', () => {
    installAgy()
    writeJson(sb.files.agyMcp, { mcpServers: { termpolis: ourEntry(sb) } })
    disconnectAgentIntegration(sb.paths)
    expect(readJson(sb.files.agyMcp)).toEqual({})
  })

  it('touches nothing when agy was never set up', () => {
    const rows = disconnectAgentIntegration(sb.paths)
    expect(existsSync(sb.files.agyMcp)).toBe(false)
    expect(existsSync(sb.files.agySettings)).toBe(false)
    expect(rows.filter((r) => r.file === sb.files.agyMcp || r.file === sb.files.agySettings)).toEqual([])
  })
})

describe('status', () => {
  it('counts Gemini as connected when only the Antigravity CLI has the server', () => {
    installAgy()
    writeJson(sb.files.agyMcp, { mcpServers: { termpolis: ourEntry(sb) } })
    expect(getAgentIntegrationStatus(sb.paths).agents.gemini).toEqual({
      installed: true, configPath: sb.files.gemini, registered: true,
    })
  })

  it('does not count a foreign `termpolis` server', () => {
    installAgy()
    writeJson(sb.files.agyMcp, { mcpServers: { termpolis: { command: 'uvx', args: ['other'] } } })
    expect(getAgentIntegrationStatus(sb.paths).agents.gemini.registered).toBe(false)
  })
})

describe('codexHasTermpolisServer: may a Linked machines job keep codex\'s Termpolis server', () => {
  it('says yes only for Termpolis\'s own server in config.toml', () => {
    expect(codexHasTermpolisServer(sb.paths)).toBe(false)
    writeText(sb.files.codex, codexServerToml('uvx', ['someone-else']))
    expect(codexHasTermpolisServer(sb.paths)).toBe(false)
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    expect(codexHasTermpolisServer(sb.paths)).toBe(true)
  })

  it('says no with no home folder to look in', () => {
    const noHome = { ...sb.paths, home: '' } as AgentIntegrationPaths
    expect(codexHasTermpolisServer(noHome)).toBe(false)
  })
})

describe('consent: nothing is written for agy without an answer on record', () => {
  const agyFiles = () => [existsSync(sb.files.agyMcp), existsSync(sb.files.agySettings)]

  it('leaves agy alone at startup for an older install whose owner hasn\'t answered yet', () => {
    installAgy()
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb, { consent: null, legacy: true })
    bootAgentIntegration(sb.rt)
    expect(agyFiles()).toEqual([false, false])
  })

  it('writes nothing for agy on a fresh install, or after a decline', () => {
    installAgy()
    writeLedger(sb, { consent: null, legacy: false })
    bootAgentIntegration(sb.rt)
    expect(agyFiles()).toEqual([false, false])
    writeLedger(sb, { consent: 'declined' })
    bootAgentIntegration(sb.rt)
    expect(agyFiles()).toEqual([false, false])
  })

  it('writes agy\'s entries once the owner says yes', () => {
    installAgy()
    writeLedger(sb, { consent: null, legacy: true })
    connect()
    expect(agyFiles()).toEqual([true, true])
  })
})
