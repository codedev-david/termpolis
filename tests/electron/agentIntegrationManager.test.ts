// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join, parse } from 'path'
import {
  bootAgentIntegration, conductorMcpConfig, getAgentIntegrationStatus, isFolderTrustAllowed,
  prepareCodexLaunch, removeCodexHomeTrust, resolveAgentIntegrationPaths, setAgentIntegration,
  trustFolderForAgents,
} from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths } from '../../src/main/agentIntegrationManager'
import { CLAUDE_ALLOW_RULES, FOREIGN_SERVER } from '../../src/main/agentMcpRegistry'
import { __resetTrustCache, claudeProjectKey } from '../../src/main/claudeTrust'
import { codexServerState, codexTrustedProjects, tomlString } from '../../src/main/codexConfigEdit'
import {
  AGENTS_BEGIN, AGENTS_END, CODEX_BASE_INSTRUCTION, buildCodexInstruction, cleanAgentsMd,
} from '../../src/main/codexParity'
import { CODEX_AUTO_APPROVED_TOOLS, MCP_TOOLS_AUTO_ALLOWED } from '../../src/shared/agentIntegration'
import type { AgentIntegrationStatus } from '../../src/shared/agentIntegration'
import {
  ALL_MIGRATIONS, blockWrites, codexServerToml, codexTrustToml, createSandbox, isUnder, ourEntry,
  readJson, readText, samePath, writeJson, writeLedger, writeText,
} from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
  // The hook as sh runs it, on any machine; the robustness tests cover each shell.
  sb.rt.hookShell = 'sh'
})

afterEach(() => {
  vi.restoreAllMocks()
  sb.dispose()
})

const WRITE_ERROR = /EISDIR|EPERM|EACCES/

/** The Codex table that pre-approves one Termpolis tool. */
const approval = (tool: string): string => `[mcp_servers.termpolis.tools.${tool}]\napproval_mode = "auto"`

function installAll(): void {
  for (const dir of [sb.paths.claudeDir, sb.paths.codexHome, sb.paths.geminiDir]) mkdirSync(dir, { recursive: true })
}

function ourClaudeServer(): Record<string, unknown> {
  return { type: 'stdio', ...ourEntry(sb) }
}

/** The hook as connecting writes it: runs only while its script and runner are still there. */
function ourHookGroup(): Record<string, unknown> {
  const command = `if [ -f "${sb.hookScript}" ] && command -v "node" >/dev/null 2>&1; then node "${sb.hookScript}"; fi`
  return { hooks: [{ type: 'command', command }] }
}

/** Every config file's text (null when missing), to prove a call wrote nothing. */
function snapshot(): Record<string, string | null> {
  const files = [...Object.values(sb.files), sb.ledgerFile]
  return Object.fromEntries(files.map((f) => [f, existsSync(f) ? readText(f) : null]))
}

const freshLedger = { version: 1, consent: null, primerHook: true, legacy: false, migrations: [], trustedByTermpolis: [] }

describe('test sandbox', () => {
  it('resolves every agent path inside the per-test temp home, never a real agent config', () => {
    const realHome = homedir()
    const appData = process.env.APPDATA || join(realHome, 'AppData', 'Roaming')
    const forbidden = [
      join(realHome, '.claude'), join(realHome, '.claude.json'), join(realHome, '.codex'),
      join(realHome, '.gemini'), join(realHome, '.mcp.json'), join(appData, 'termpolis'),
    ]
    const { home, userData, ...agentPaths } = sb.paths
    expect(samePath(home, sb.home)).toBe(true)
    expect(isUnder(sb.root, userData)).toBe(true)
    for (const p of Object.values(agentPaths)) expect(isUnder(sb.home, p)).toBe(true)

    const everyPath = [
      ...Object.values(sb.paths), ...Object.values(sb.files), sb.ledgerFile, sb.adapter, sb.hookScript,
      String(process.env.TERMPOLIS_TEST_AGENT_HOME), String(process.env.CLAUDE_CONFIG_DIR), String(process.env.CODEX_HOME),
    ]
    for (const p of everyPath) {
      expect(isUnder(sb.root, p)).toBe(true)
      for (const f of forbidden) expect(samePath(f, p) || isUnder(f, p)).toBe(false)
    }
    // The decoy OS home handed to the resolver lost to the test home.
    expect(resolveAgentIntegrationPaths(join(sb.root, 'decoy-os-home'), sb.paths.userData, process.env)).toEqual(sb.paths)
  })
})

describe('resolveAgentIntegrationPaths', () => {
  it('a test home wins over the OS home, CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const ud = join(sb.root, 'ud')
    const p = resolveAgentIntegrationPaths(join(sb.root, 'os-home'), ud, {
      TERMPOLIS_TEST_AGENT_HOME: `  ${sb.home}  `,
      CLAUDE_CONFIG_DIR: join(sb.root, 'ccd'),
      CODEX_HOME: join(sb.root, 'cx'),
    })
    expect(p).toEqual({
      home: sb.home,
      userData: ud,
      claudeDir: join(sb.home, '.claude'),
      claudeJson: join(sb.home, '.claude.json'),
      codexHome: join(sb.home, '.codex'),
      geminiDir: join(sb.home, '.gemini'),
    })
  })

  it('without a test home, honours CLAUDE_CONFIG_DIR and CODEX_HOME, trimmed', () => {
    const osHome = join(sb.root, 'os-home')
    const ccd = join(sb.root, 'ccd')
    const cx = join(sb.root, 'cx')
    const p = resolveAgentIntegrationPaths(osHome, 'ud', {
      TERMPOLIS_TEST_AGENT_HOME: '   ',
      CLAUDE_CONFIG_DIR: ` ${ccd} `,
      CODEX_HOME: `\t${cx}\n`,
    })
    expect(p).toEqual({
      home: osHome,
      userData: 'ud',
      claudeDir: ccd,
      claudeJson: join(ccd, '.claude.json'),
      codexHome: cx,
      geminiDir: join(osHome, '.gemini'),
    })
  })

  it.each([
    ['nothing set', {}],
    ['blank overrides', { CLAUDE_CONFIG_DIR: '  ', CODEX_HOME: '' }],
  ])('falls back to the OS home with %s', (_label, env) => {
    const osHome = join(sb.root, 'os-home')
    expect(resolveAgentIntegrationPaths(osHome, 'ud', env)).toEqual({
      home: osHome,
      userData: 'ud',
      claudeDir: join(osHome, '.claude'),
      claudeJson: join(osHome, '.claude.json'),
      codexHome: join(osHome, '.codex'),
      geminiDir: join(osHome, '.gemini'),
    })
  })
})

describe('getAgentIntegrationStatus', () => {
  it('first call: creates the ledger and reports nothing installed', () => {
    const s = getAgentIntegrationStatus(sb.paths)
    expect(s).toEqual({
      consent: null,
      legacyDetected: false,
      connected: false,
      primerHook: true,
      agents: {
        claude: { installed: false, configPath: sb.paths.claudeJson, registered: false },
        codex: { installed: false, configPath: sb.files.codex, registered: false },
        gemini: { installed: false, configPath: sb.files.gemini, registered: false },
      },
      autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED],
      trustedFolders: [],
      codexHomeTrusted: false,
    })
    expect(s.autoAllowedTools).not.toBe(MCP_TOOLS_AUTO_ALLOWED)
    expect(readText(sb.ledgerFile)).toBe(JSON.stringify(freshLedger, null, 2) + '\n')
    // A status read writes nothing into the agents' configs.
    expect(readdirSync(sb.home)).toEqual([])
  })

  it.each<[string, Record<string, unknown>, Partial<AgentIntegrationStatus>]>([
    ['granted', { consent: 'granted' }, { consent: 'granted', connected: true, legacyDetected: false }],
    ['declined on a legacy install', { consent: 'declined', legacy: true }, { consent: 'declined', connected: false, legacyDetected: true }],
    ['legacy, not asked yet', { consent: null, legacy: true }, { consent: null, connected: true, legacyDetected: true }],
    ['not asked, not legacy', { consent: null }, { consent: null, connected: false, legacyDetected: false }],
    [
      'hand-edited values',
      { consent: 'maybe', primerHook: 0, legacy: 'yes', trustedByTermpolis: ['C:/a', 5, null] },
      { consent: null, connected: false, legacyDetected: false, primerHook: true, trustedFolders: ['C:/a'] },
    ],
    ['primer hook off', { consent: 'granted', primerHook: false, trustedByTermpolis: 'C:/a' }, { primerHook: false, trustedFolders: [] }],
  ])('reads a saved ledger: %s', (_label, fields, expected) => {
    writeLedger(sb, fields)
    const before = readText(sb.ledgerFile)
    expect(getAgentIntegrationStatus(sb.paths)).toMatchObject(expected)
    expect(readText(sb.ledgerFile)).toBe(before)
  })

  it.each([
    ['a JSON array', '[]'],
    ['not valid JSON', '{"version": 1,'],
    ['from a newer version', JSON.stringify({ version: 2, consent: 'granted' })],
  ])('starts over from a ledger that is %s', (_label, text) => {
    writeText(sb.ledgerFile, text)
    expect(getAgentIntegrationStatus(sb.paths)).toMatchObject({ consent: null, connected: false })
    expect(readJson(sb.ledgerFile)).toEqual(freshLedger)
  })

  it('reports each agent as registered from its own config', () => {
    writeLedger(sb, { consent: 'granted' })
    writeJson(sb.files.claudeJson, { mcpServers: { termpolis: ourClaudeServer() } })
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    writeJson(sb.files.gemini, { mcpServers: { termpolis: ourEntry(sb) } })
    expect(getAgentIntegrationStatus(sb.paths).agents).toEqual({
      // Claude counts as installed by its config folder, which this home does not have.
      claude: { installed: false, configPath: sb.files.claudeJson, registered: true },
      codex: { installed: true, configPath: sb.files.codex, registered: true },
      gemini: { installed: true, configPath: sb.files.gemini, registered: true },
    })
  })

  it('does not count a termpolis server that Termpolis did not write', () => {
    writeLedger(sb)
    const foreign = { mcpServers: { termpolis: { command: 'npx', args: ['termpolis-mcp'] } } }
    writeJson(sb.files.claudeJson, foreign)
    writeJson(sb.files.gemini, foreign)
    writeText(sb.files.codex, codexServerToml('npx', ['termpolis-mcp']))
    const { agents } = getAgentIntegrationStatus(sb.paths)
    expect([agents.claude.registered, agents.codex.registered, agents.gemini.registered]).toEqual([false, false, false])
  })

  it.each<[string, (file: string) => void]>([
    ['a folder', (f) => mkdirSync(f, { recursive: true })],
    ['not valid TOML', (f) => writeText(f, '[mcp_servers.termpolis\ncommand = "node"\n')],
  ])('a config.toml that is %s is neither registered nor trusted', (_label, make) => {
    writeLedger(sb)
    make(sb.files.codex)
    const s = getAgentIntegrationStatus(sb.paths)
    expect(s.agents.codex).toEqual({ installed: true, configPath: sb.files.codex, registered: false })
    expect(s.codexHomeTrusted).toBe(false)
  })

  it('flags Codex trust in the home folder, a folder above it or a filesystem root', () => {
    writeLedger(sb)
    const safe = codexTrustToml(join(sb.home, 'proj'))
    writeText(sb.files.codex, safe)
    expect(getAgentIntegrationStatus(sb.paths).codexHomeTrusted).toBe(false)
    for (const folder of [sb.home, sb.root, parse(sb.root).root]) {
      writeText(sb.files.codex, `${safe}\n${codexTrustToml(folder)}`)
      expect(getAgentIntegrationStatus(sb.paths).codexHomeTrusted).toBe(true)
    }
  })

  it('falls back to a disconnected status when the paths are unusable', () => {
    const none = { installed: false, configPath: '', registered: false }
    expect(getAgentIntegrationStatus({ ...sb.paths, userData: undefined as unknown as string })).toEqual({
      consent: null,
      legacyDetected: false,
      connected: false,
      primerHook: true,
      agents: { claude: none, codex: none, gemini: none },
      autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED],
      trustedFolders: [],
      codexHomeTrusted: false,
    })
  })

  it('warns, and still answers, when the ledger cannot be saved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    blockWrites(sb.ledgerFile)
    expect(getAgentIntegrationStatus(sb.paths)).toMatchObject({ consent: null, connected: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not save agent-integration.json'))
    expect(existsSync(sb.ledgerFile)).toBe(false)
  })
})

describe('setAgentIntegration: connect', () => {
  it('writes Termpolis into every installed agent and records the answer', () => {
    installAll()
    writeLedger(sb)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'add', what: 'MCP server' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' },
      { agent: 'codex', file: sb.files.codex, action: 'add', what: 'MCP server' },
      { agent: 'codex', file: sb.files.codex, action: 'add', what: 'Pre-approval for the memory tools' },
      { agent: 'gemini', file: sb.files.gemini, action: 'add', what: 'MCP server' },
    ])
    expect(readText(sb.files.claudeJson)).toBe(
      JSON.stringify({ mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter] } } }, null, 2) + '\n',
    )
    expect(readJson(sb.files.settings)).toEqual({
      permissions: { allow: [...CLAUDE_ALLOW_RULES] },
      hooks: { SessionStart: [ourHookGroup()] },
    })
    const toml = readText(sb.files.codex)
    expect(codexServerState(toml)).toEqual({ state: 'present', command: 'node', args: [sb.adapter] })
    for (const tool of CODEX_AUTO_APPROVED_TOOLS) expect(toml).toContain(approval(tool))
    expect(toml.match(/approval_mode = "auto"/g)).toHaveLength(CODEX_AUTO_APPROVED_TOOLS.length)
    expect(readJson(sb.files.gemini)).toEqual({ mcpServers: { termpolis: { command: 'node', args: [sb.adapter] } } })
    expect(readJson(sb.ledgerFile)).toEqual({ ...freshLedger, consent: 'granted', migrations: [...ALL_MIGRATIONS] })
    expect(r.status).toMatchObject({
      consent: 'granted',
      connected: true,
      agents: {
        claude: { installed: true, registered: true },
        codex: { installed: true, registered: true },
        gemini: { installed: true, registered: true },
      },
    })
  })

  it('is idempotent: connecting again changes nothing on disk', () => {
    installAll()
    writeLedger(sb)
    setAgentIntegration(sb.rt, { connect: true })
    const before = snapshot()
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it('touches only the agents that are installed', () => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    writeLedger(sb)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes.map((c) => c.agent)).toEqual(['codex', 'codex'])
    expect(existsSync(sb.paths.claudeDir)).toBe(false)
    expect(existsSync(sb.files.claudeJson)).toBe(false)
    expect(existsSync(sb.paths.geminiDir)).toBe(false)
    expect(r.status.agents.claude).toEqual({ installed: false, configPath: sb.files.claudeJson, registered: false })
    expect(r.status.agents.codex).toEqual({ installed: true, configPath: sb.files.codex, registered: true })
  })

  it("keeps the user's own entries, BOM, line endings and indentation", () => {
    installAll()
    writeLedger(sb)
    writeText(
      sb.files.claudeJson,
      '\uFEFF{\r\n    "numStartups": 7,\r\n    "mcpServers": {\r\n        "github": {\r\n            "command": "gh"\r\n        }\r\n    }\r\n}\r\n',
    )
    const userGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }
    writeJson(sb.files.settings, { model: 'opus', permissions: { allow: ['Bash(git status)'] }, hooks: { SessionStart: [userGroup] } })
    const userToml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n'
    writeText(sb.files.codex, userToml)
    writeJson(sb.files.gemini, { theme: 'dark', mcpServers: { other: { command: 'y' } } })

    setAgentIntegration(sb.rt, { connect: true })

    const claude = { numStartups: 7, mcpServers: { github: { command: 'gh' }, termpolis: ourClaudeServer() } }
    expect(readText(sb.files.claudeJson)).toBe('\uFEFF' + JSON.stringify(claude, null, 4).replace(/\n/g, '\r\n') + '\r\n')
    expect(readJson(sb.files.settings)).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(git status)', ...CLAUDE_ALLOW_RULES] },
      hooks: { SessionStart: [userGroup, ourHookGroup()] },
    })
    const toml = readText(sb.files.codex)
    expect(toml.startsWith(userToml)).toBe(true)
    expect(codexServerState(toml)).toEqual({ state: 'present', command: 'node', args: [sb.adapter] })
    expect(readJson(sb.files.gemini)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'y' }, termpolis: ourEntry(sb) } })
  })

  it('primerHook: false takes the hook out, and the choice sticks until it is changed', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb)
    setAgentIntegration(sb.rt, { connect: true })

    let r = setAgentIntegration(sb.rt, { connect: true, primerHook: false })
    expect(r.changes).toEqual([{ agent: 'claude', file: sb.files.settings, action: 'remove', what: 'SessionStart memory hook' }])
    expect(readJson(sb.files.settings)).toEqual({ permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
    expect(readJson(sb.ledgerFile).primerHook).toBe(false)
    expect(r.status.primerHook).toBe(false)

    r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([])
    expect(r.status.primerHook).toBe(false)

    r = setAgentIntegration(sb.rt, { connect: true, primerHook: true })
    expect(r.changes).toEqual([{ agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' }])
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [ourHookGroup()] })
  })

  it('without a hook script, adds no hook', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb)
    const r = setAgentIntegration({ ...sb.rt, hookScriptPath: null }, { connect: true })
    expect(r.changes.map((c) => c.what)).toEqual(['MCP server', 'Tool permissions'])
    expect(readJson(sb.files.settings)).toEqual({ permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
  })

  it('brings a stale Termpolis entry up to date and refuses a foreign one', () => {
    installAll()
    writeLedger(sb)
    writeJson(sb.files.claudeJson, {
      mcpServers: {
        termpolis: {
          type: 'stdio',
          command: 'C:/old/node.exe',
          args: ['C:/Old/App/MCP-Adapter/stdio-adapter.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          timeout: 5000,
        },
      },
    })
    writeJson(sb.files.gemini, { mcpServers: { termpolis: { command: 'npx', args: ['termpolis-mcp'] } } })
    writeText(sb.files.codex, codexServerToml('uvx', ['termpolis-server']))
    const gemini = readText(sb.files.gemini)
    const codex = readText(sb.files.codex)

    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'update', what: 'MCP server' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' },
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error: FOREIGN_SERVER },
      { agent: 'gemini', file: sb.files.gemini, action: 'skipped', what: 'MCP server', error: FOREIGN_SERVER },
    ])
    // The user's timeout survives; the Electron fallback env goes now that a real node is used.
    expect(readJson(sb.files.claudeJson)).toEqual({
      mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter], timeout: 5000 } },
    })
    expect(readText(sb.files.gemini)).toBe(gemini)
    expect(readText(sb.files.codex)).toBe(codex)
    expect(r.status.agents.codex.registered).toBe(false)
    expect(r.status.agents.gemini.registered).toBe(false)
  })

  it.each([
    ['not valid JSON', '{"mcpServers": ', /not valid JSON/],
    ['a JSON array', '[1, 2]', /not a JSON object/],
  ])('reports a .claude.json that is %s and leaves it untouched', (_label, text, error) => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb)
    writeText(sb.files.claudeJson, text)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: 'MCP server', error: expect.stringMatching(error) },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' },
    ])
    expect(readText(sb.files.claudeJson)).toBe(text)
  })

  it('reports config files that are folders, and carries on with the rest', () => {
    installAll()
    writeLedger(sb)
    for (const f of [sb.files.claudeJson, sb.files.codex, sb.files.gemini]) mkdirSync(f)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: 'MCP server', error: expect.any(String) },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' },
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error: expect.any(String) },
      { agent: 'gemini', file: sb.files.gemini, action: 'skipped', what: 'MCP server', error: expect.any(String) },
    ])
    expect(r.status.agents.claude.registered).toBe(false)
    expect(r.status.agents.codex.registered).toBe(false)
  })

  it('skips only the steps whose part of settings.json has an unexpected shape', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb)
    const settingsRows = (): unknown[] =>
      setAgentIntegration(sb.rt, { connect: true }).changes.filter((c) => c.file === sb.files.settings)

    writeJson(sb.files.settings, { permissions: 'all' })
    expect(settingsRows()).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'Tool permissions', error: '`permissions` is not an object' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'SessionStart memory hook' },
    ])
    expect(readJson(sb.files.settings)).toEqual({ permissions: 'all', hooks: { SessionStart: [ourHookGroup()] } })

    const odd = { permissions: { allow: 'everything' }, hooks: { SessionStart: {} } }
    writeJson(sb.files.settings, odd)
    expect(settingsRows()).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'Tool permissions', error: '`permissions.allow` is not an array' },
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'SessionStart memory hook', error: '`hooks.SessionStart` is not an array' },
    ])
    expect(readJson(sb.files.settings)).toEqual(odd)

    writeJson(sb.files.settings, { hooks: 'none', mcpServers: [] })
    expect(settingsRows()).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'SessionStart memory hook', error: '`hooks` is not an object' },
    ])
  })

  it('reports the writes that fail and leaves those files as they were', () => {
    installAll()
    writeLedger(sb)
    writeJson(sb.files.claudeJson, { numStartups: 1 })
    for (const f of [sb.files.claudeJson, sb.files.settings, sb.files.gemini]) blockWrites(f)
    const r = setAgentIntegration(sb.rt, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: 'MCP server', error: expect.stringMatching(WRITE_ERROR) },
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'Tool permissions', error: expect.stringMatching(WRITE_ERROR) },
      { agent: 'claude', file: sb.files.settings, action: 'skipped', what: 'SessionStart memory hook', error: expect.stringMatching(WRITE_ERROR) },
      { agent: 'codex', file: sb.files.codex, action: 'add', what: 'MCP server' },
      { agent: 'codex', file: sb.files.codex, action: 'add', what: 'Pre-approval for the memory tools' },
      { agent: 'gemini', file: sb.files.gemini, action: 'skipped', what: 'MCP server', error: expect.stringMatching(WRITE_ERROR) },
    ])
    expect(readJson(sb.files.claudeJson)).toEqual({ numStartups: 1 })
    expect(existsSync(sb.files.settings)).toBe(false)
    expect(existsSync(sb.files.gemini)).toBe(false)
  })

  it.each<[string, (s: Sandbox) => string, 'update' | 'unchanged']>([
    ['an empty [mcp_servers.termpolis] table', () => '[mcp_servers.termpolis]\n', 'update'],
    ['a table holding only our args', (s) => `[mcp_servers.termpolis]\nargs = [${tomlString(s.adapter)}]\n`, 'update'],
    ['a table that is already current', (s) => codexServerToml('node', [s.adapter]), 'unchanged'],
  ])('Codex: completes %s', (_label, make, action) => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    writeLedger(sb)
    writeText(sb.files.codex, make(sb))
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([
      ...(action === 'update' ? [{ agent: 'codex', file: sb.files.codex, action, what: 'MCP server' }] : []),
      { agent: 'codex', file: sb.files.codex, action: 'add', what: 'Pre-approval for the memory tools' },
    ])
    expect(codexServerState(readText(sb.files.codex))).toEqual({ state: 'present', command: 'node', args: [sb.adapter] })
  })

  it('Codex: a server table that sets only a command is not ours', () => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    writeLedger(sb)
    const text = '[mcp_servers.termpolis]\ncommand = "node"\n'
    writeText(sb.files.codex, text)
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error: FOREIGN_SERVER },
    ])
    expect(readText(sb.files.codex)).toBe(text)
  })

  it.each([
    ['a table that does not parse', '[mcp_servers.termpolis\ncommand = "node"\n', expect.any(String)],
    ['two [mcp_servers.termpolis] tables', '[mcp_servers.termpolis]\ncommand = "a"\n\n[mcp_servers.termpolis]\ncommand = "b"\n', 'config.toml has two [mcp_servers.termpolis] tables'],
    ['servers written as an inline table', 'mcp_servers = { other = { command = "x" } }\n', 'mcp_servers is set as an inline table'],
  ])('Codex: leaves %s alone', (_label, text, error) => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    writeLedger(sb)
    writeText(sb.files.codex, text)
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error },
    ])
    expect(readText(sb.files.codex)).toBe(text)
  })

  it('Codex: a failed write reports the rows it would have changed, not the ones already current', () => {
    mkdirSync(sb.paths.codexHome, { recursive: true })
    writeLedger(sb)
    blockWrites(sb.files.codex)

    const current = codexServerToml('node', [sb.adapter])
    writeText(sb.files.codex, current)
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'Pre-approval for the memory tools', error: expect.stringMatching(WRITE_ERROR) },
    ])
    expect(readText(sb.files.codex)).toBe(current)

    // A stale command, with approvals written as a `tools` key it will not edit.
    const stale = `${codexServerToml('C:/old/node.exe', [sb.adapter])}tools = { memory_primer = { approval_mode = "approve" } }\n`
    writeText(sb.files.codex, stale)
    expect(setAgentIntegration(sb.rt, { connect: true }).changes).toEqual([
      { agent: 'codex', file: sb.files.codex, action: 'skipped', what: 'MCP server', error: expect.stringMatching(WRITE_ERROR) },
      {
        agent: 'codex',
        file: sb.files.codex,
        action: 'skipped',
        what: 'Pre-approval for the memory tools',
        error: 'tool approvals are set with a tools key inside [mcp_servers.termpolis]',
      },
    ])
    expect(readText(sb.files.codex)).toBe(stale)
  })

  it('reports a failure instead of throwing, keeping the recorded answer', () => {
    writeLedger(sb)
    const r = setAgentIntegration({ ...sb.rt, node: null as unknown as string }, { connect: true })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.ledgerFile, action: 'skipped', what: 'Agent integration', error: expect.any(String) },
    ])
    expect(r.status.consent).toBe('granted')
    expect(readJson(sb.ledgerFile).consent).toBe('granted')
  })
})

describe('setAgentIntegration: decline', () => {
  it('takes everything back out and records the answer', () => {
    installAll()
    writeLedger(sb)
    setAgentIntegration(sb.rt, { connect: true })
    const r = setAgentIntegration(sb.rt, { connect: false })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'SessionStart memory hook' },
      { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: sb.files.codex, action: 'remove', what: 'MCP server' },
      { agent: 'gemini', file: sb.files.gemini, action: 'remove', what: 'MCP server' },
    ])
    expect(readJson(sb.files.claudeJson)).toEqual({})
    expect(readJson(sb.files.settings)).toEqual({})
    expect(readJson(sb.files.gemini)).toEqual({})
    expect(readText(sb.files.codex)).not.toContain('termpolis')
    expect(readJson(sb.ledgerFile)).toEqual({ ...freshLedger, consent: 'declined', migrations: [...ALL_MIGRATIONS] })
    expect(r.status).toMatchObject({
      consent: 'declined',
      connected: false,
      agents: { claude: { registered: false }, codex: { registered: false }, gemini: { registered: false } },
    })
  })
})

describe('bootAgentIntegration', () => {
  it('first start: runs and records every migration, and connects nothing', () => {
    const r = bootAgentIntegration(sb.rt)
    expect(r.changes).toEqual([])
    expect(r.status).toMatchObject({ consent: null, legacyDetected: false, connected: false })
    expect(readJson(sb.ledgerFile)).toEqual({ ...freshLedger, migrations: [...ALL_MIGRATIONS] })
    expect(readdirSync(sb.home)).toEqual([])
  })

  it('granted: re-applies at every start, and rewrites nothing once current', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    // Compact on purpose: a rewrite would pretty-print it.
    writeText(sb.ledgerFile, JSON.stringify({ ...freshLedger, consent: 'granted', migrations: ALL_MIGRATIONS }))
    const ledger = readText(sb.ledgerFile)

    const first = bootAgentIntegration(sb.rt)
    expect(first.changes.map((c) => `${c.what}: ${c.action}`)).toEqual([
      'MCP server: add', 'Tool permissions: add', 'SessionStart memory hook: add',
    ])
    const configs = snapshot()
    const second = bootAgentIntegration(sb.rt)
    expect(second.changes).toEqual([])
    expect(second.status).toMatchObject({ consent: 'granted', connected: true, agents: { claude: { registered: true } } })
    expect(snapshot()).toEqual(configs)
    expect(readText(sb.ledgerFile)).toBe(ledger)
  })

  it('declined: runs the pending migrations but connects nothing', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb, { consent: 'declined', migrations: [] })
    writeJson(sb.files.settings, { permissions: { allow: ['mcp__termpolis__*', 'Bash(ls)'] } })
    const r = bootAgentIntegration(sb.rt)
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'Permission for every Termpolis tool to run without asking' },
    ])
    expect(readJson(sb.files.settings)).toEqual({ permissions: { allow: ['Bash(ls)'] } })
    expect(existsSync(sb.files.claudeJson)).toBe(false)
    expect(readJson(sb.ledgerFile)).toEqual({ ...freshLedger, consent: 'declined', migrations: [...ALL_MIGRATIONS] })
  })

  it('an older install not asked yet stays connected, in the narrower form', () => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeJson(sb.files.settings, {
      permissions: { allow: ['mcp__termpolis__*'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "C:/old/memory-primer-hook.cjs"' }] }] },
    })
    writeJson(sb.files.claudeJson, {
      mcpServers: { termpolis: { type: 'stdio', command: 'node', args: ['C:/old/mcp-adapter/stdio-adapter.cjs'] } },
    })
    const r = bootAgentIntegration(sb.rt)
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'Permission for every Termpolis tool to run without asking' },
      { agent: 'claude', file: sb.files.claudeJson, action: 'update', what: 'MCP server' },
      { agent: 'claude', file: sb.files.settings, action: 'add', what: 'Tool permissions' },
      { agent: 'claude', file: sb.files.settings, action: 'update', what: 'SessionStart memory hook' },
    ])
    expect(readJson(sb.files.settings)).toEqual({
      permissions: { allow: [...CLAUDE_ALLOW_RULES] },
      hooks: { SessionStart: [ourHookGroup()] },
    })
    expect(readJson(sb.files.claudeJson)).toEqual({ mcpServers: { termpolis: ourClaudeServer() } })
    expect(readJson(sb.ledgerFile)).toEqual({ ...freshLedger, legacy: true, migrations: [...ALL_MIGRATIONS] })
    expect(r.status).toMatchObject({ consent: null, legacyDetected: true, connected: true, primerHook: true })
  })

  it('reports a failure instead of throwing', () => {
    writeLedger(sb, { consent: 'granted' })
    const r = bootAgentIntegration({ ...sb.rt, node: null as unknown as string })
    expect(r.changes).toEqual([
      { agent: 'claude', file: sb.ledgerFile, action: 'skipped', what: 'Agent integration', error: expect.any(String) },
    ])
    expect(r.status).toMatchObject({ consent: 'granted', connected: true })
  })
})

describe('isFolderTrustAllowed', () => {
  let proj: string
  beforeEach(() => {
    proj = join(sb.home, 'proj')
    mkdirSync(proj)
  })

  it('needs a folder and a connected integration', () => {
    writeLedger(sb, { consent: 'granted' })
    expect(isFolderTrustAllowed(sb.paths, '')).toBe(false)
    expect(isFolderTrustAllowed(sb.paths, '   ')).toBe(false)
    expect(isFolderTrustAllowed(sb.paths, proj)).toBe(true)
    writeLedger(sb, { consent: 'declined' })
    expect(isFolderTrustAllowed(sb.paths, proj)).toBe(false)
    writeLedger(sb, { consent: null, legacy: true })
    expect(isFolderTrustAllowed(sb.paths, proj)).toBe(true)
    writeLedger(sb, { consent: null, legacy: false })
    expect(isFolderTrustAllowed(sb.paths, proj)).toBe(false)
  })

  it('refuses the home folder, anything above it, filesystem roots and relative paths', () => {
    writeLedger(sb, { consent: 'granted' })
    for (const folder of [sb.home, `${sb.home}/`, sb.root, parse(sb.root).root, 'relative/dir']) {
      expect(isFolderTrustAllowed(sb.paths, folder)).toBe(false)
    }
  })

  it('sees through a link to the home folder, and through a home given as a link', () => {
    writeLedger(sb, { consent: 'granted' })
    const link = join(sb.root, 'home-link')
    sb.link(sb.home, link)
    expect(isFolderTrustAllowed(sb.paths, link)).toBe(false)
    const linkedHome: AgentIntegrationPaths = { ...sb.paths, home: link }
    expect(isFolderTrustAllowed(linkedHome, sb.home)).toBe(false)
    expect(isFolderTrustAllowed(linkedHome, proj)).toBe(true)
  })

  it('checks the git root as well as the folder', () => {
    writeLedger(sb, { consent: 'granted' })
    const repo = join(sb.home, 'repo')
    const src = join(repo, 'src')
    mkdirSync(src, { recursive: true })
    expect(isFolderTrustAllowed(sb.paths, src, repo)).toBe(true)
    // A dotfiles repo rooted at home: Codex would apply trust to the whole home folder.
    expect(isFolderTrustAllowed(sb.paths, src, sb.home)).toBe(false)
    expect(isFolderTrustAllowed(sb.paths, src, '  ')).toBe(true)
    expect(isFolderTrustAllowed(sb.paths, src, null)).toBe(true)
    expect(isFolderTrustAllowed(sb.paths, sb.home, repo)).toBe(false)
  })

  it('with no home folder known, refuses every folder: the home folder could not be told from any other', () => {
    writeLedger(sb, { consent: 'granted' })
    const noHome: AgentIntegrationPaths = { ...sb.paths, home: '' }
    expect(isFolderTrustAllowed(sb.paths, proj)).toBe(true)
    expect(isFolderTrustAllowed(noHome, proj)).toBe(false)
    expect(isFolderTrustAllowed(noHome, parse(sb.root).root)).toBe(false)
  })

  it('answers false instead of throwing on unusable paths', () => {
    expect(isFolderTrustAllowed({ ...sb.paths, userData: undefined as unknown as string }, proj)).toBe(false)
  })
})

describe('trustFolderForAgents', () => {
  let repo: string
  let src: string
  beforeEach(() => {
    repo = join(sb.home, 'repo')
    src = join(repo, 'src')
    mkdirSync(src, { recursive: true })
  })

  it('does nothing without consent', () => {
    writeLedger(sb)
    expect(trustFolderForAgents(sb.paths, src, repo)).toEqual({ changed: false, keys: [], skipped: 'no-consent' })
    expect(existsSync(sb.files.claudeJson)).toBe(false)
  })

  it('pre-accepts the folder and its git root, and records what it set', () => {
    writeLedger(sb, { consent: 'granted' })
    writeJson(sb.files.claudeJson, { numStartups: 3, projects: { 'C:/elsewhere': { allowedTools: [] } } })
    const keys = [claudeProjectKey(src), claudeProjectKey(repo)]

    expect(trustFolderForAgents(sb.paths, src, repo)).toEqual({ changed: true, keys })
    expect(readJson(sb.files.claudeJson)).toEqual({
      numStartups: 3,
      projects: {
        'C:/elsewhere': { allowedTools: [] },
        [keys[0]]: { hasTrustDialogAccepted: true },
        [keys[1]]: { hasTrustDialogAccepted: true },
      },
    })
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual(keys)
    expect(getAgentIntegrationStatus(sb.paths).trustedFolders).toEqual(keys)

    const config = readText(sb.files.claudeJson)
    expect(trustFolderForAgents(sb.paths, src, repo)).toEqual({ changed: false, keys, skipped: 'already-trusted' })
    __resetTrustCache()
    expect(trustFolderForAgents(sb.paths, src, repo)).toEqual({ changed: false, keys, skipped: 'already-trusted' })
    expect(readText(sb.files.claudeJson)).toBe(config)

    // A second folder in the same repo adds only itself to the ledger.
    const docs = join(repo, 'docs')
    mkdirSync(docs)
    expect(trustFolderForAgents(sb.paths, docs, repo)).toEqual({ changed: true, keys: [claudeProjectKey(docs), keys[1]] })
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([...keys, claudeProjectKey(docs)])
  })

  it('refuses unsafe folders, and drops an unsafe git root', () => {
    writeLedger(sb, { consent: 'granted' })
    expect(trustFolderForAgents(sb.paths, sb.home)).toEqual({ changed: false, keys: [], skipped: 'unsafe-root' })
    expect(trustFolderForAgents(sb.paths, parse(sb.root).root)).toEqual({ changed: false, keys: [], skipped: 'unsafe-root' })
    expect(trustFolderForAgents(sb.paths, '')).toEqual({ changed: false, keys: [], skipped: 'no-cwd' })
    expect(existsSync(sb.files.claudeJson)).toBe(false)

    const key = claudeProjectKey(src)
    expect(trustFolderForAgents(sb.paths, src, sb.home)).toEqual({ changed: true, keys: [key] })
    expect(Object.keys(readJson(sb.files.claudeJson).projects)).toEqual([key])
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([key])
  })

  it('leaves a config it cannot read, and records nothing when the write fails', () => {
    writeLedger(sb, { consent: 'granted' })
    const key = claudeProjectKey(src)
    writeText(sb.files.claudeJson, '{broken')
    expect(trustFolderForAgents(sb.paths, src)).toEqual({ changed: false, keys: [key], skipped: 'corrupt' })
    expect(readText(sb.files.claudeJson)).toBe('{broken')

    const other = join(sb.root, 'other-config.json')
    blockWrites(other)
    expect(trustFolderForAgents({ ...sb.paths, claudeJson: other }, src)).toEqual({ changed: false, keys: [key], skipped: 'write-failed' })
    expect(existsSync(other)).toBe(false)
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([])
  })

  it('reports a failure instead of throwing', () => {
    const r = trustFolderForAgents({ ...sb.paths, userData: undefined as unknown as string }, src)
    expect(r).toEqual({ changed: false, keys: [], skipped: expect.any(String) })
    expect(r.skipped).not.toBe('no-consent')
  })
})

describe('prepareCodexLaunch', () => {
  const block = `${AGENTS_BEGIN}\nold managed memory\n${AGENTS_END}\n`
  let proj: string
  beforeEach(() => {
    proj = join(sb.home, 'proj')
    mkdirSync(proj)
  })

  it('without consent: removes a legacy AGENTS.md block but adds nothing', () => {
    writeLedger(sb)
    writeText(join(proj, 'AGENTS.md'), block)
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    const toml = readText(sb.files.codex)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({
      developerInstructions: null, skipped: 'no-consent', approvals: 0, agentsMdCleaned: 'file-deleted',
    })
    expect(existsSync(join(proj, 'AGENTS.md'))).toBe(false)
    expect(readText(sb.files.codex)).toBe(toml)
  })

  it("keeps the user's own AGENTS.md text around the block", () => {
    writeLedger(sb)
    writeText(join(proj, 'AGENTS.md'), `# House rules\n\nUse tabs.\n\n${block}`)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({
      developerInstructions: null, skipped: 'no-consent', approvals: 0, agentsMdCleaned: 'block-removed',
    })
    expect(readText(join(proj, 'AGENTS.md'))).toBe('# House rules\n\nUse tabs.\n')
  })

  it('with no folder, or an AGENTS.md it cannot read, launches without the cleanup', () => {
    writeLedger(sb)
    expect(prepareCodexLaunch(sb.paths, '')).toEqual({ developerInstructions: null, skipped: 'no-consent', approvals: 0 })
    mkdirSync(join(proj, 'AGENTS.md'))
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({ developerInstructions: null, skipped: 'no-consent', approvals: 0 })
    expect(existsSync(join(proj, 'AGENTS.md'))).toBe(true)
  })

  it('never throws when the AGENTS.md cleanup throws; the launch carries on without it', () => {
    // IPC hands in whatever the renderer sent; the cleanup cannot even build a path from this.
    const cwd = 42 as unknown as string
    expect(() => cleanAgentsMd(cwd)).toThrow(TypeError)
    expect(prepareCodexLaunch(sb.paths, cwd)).toEqual({ developerInstructions: null, skipped: 'no-consent', approvals: 0 })

    writeLedger(sb, { consent: 'granted' })
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    expect(prepareCodexLaunch(sb.paths, cwd, { steering: 'Keep it short.' })).toEqual({
      developerInstructions: `${CODEX_BASE_INSTRUCTION} Keep it short.`,
      approvals: CODEX_AUTO_APPROVED_TOOLS.length,
    })
  })

  it.each<[string, string | null]>([
    ['no config.toml', null],
    ['no Termpolis server', 'model = "o3"\n'],
    ["someone else's termpolis server", '[mcp_servers.termpolis]\ncommand = "npx"\nargs = ["termpolis-mcp"]\n'],
  ])('connected, but Codex has %s: no override and nothing written', (_label, text) => {
    writeLedger(sb, { consent: 'granted' })
    if (text !== null) writeText(sb.files.codex, text)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({ developerInstructions: null, skipped: 'disabled', approvals: 0 })
    expect(existsSync(sb.files.codex) ? readText(sb.files.codex) : null).toBe(text)
  })

  it('connected: pre-approves the missing memory tools once and returns the instruction', () => {
    writeLedger(sb, { consent: 'granted' })
    const server = codexServerToml('node', [sb.adapter])
    // The user set one tool to ask every time; that choice stays.
    writeText(sb.files.codex, `${server}\n[mcp_servers.termpolis.tools.memory_write]\napproval_mode = "approve"\n`)

    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({
      developerInstructions: CODEX_BASE_INSTRUCTION,
      approvals: CODEX_AUTO_APPROVED_TOOLS.length - 1,
    })
    const toml = readText(sb.files.codex)
    expect(toml.startsWith(server)).toBe(true)
    for (const tool of CODEX_AUTO_APPROVED_TOOLS.filter((t) => t !== 'memory_write')) expect(toml).toContain(approval(tool))
    expect(toml).toContain('[mcp_servers.termpolis.tools.memory_write]\napproval_mode = "approve"')
    expect(toml).not.toContain(approval('memory_write'))

    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({ developerInstructions: CODEX_BASE_INSTRUCTION, approvals: 0 })
    expect(readText(sb.files.codex)).toBe(toml)
  })

  it('adds the steering line when it is shell-safe, and drops it when it is not', () => {
    writeLedger(sb, { consent: 'granted' })
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    const steering = 'Prefer small commits — keep tests green…'
    const r = prepareCodexLaunch(sb.paths, proj, { steering })
    expect(r.developerInstructions).toBe(`${CODEX_BASE_INSTRUCTION} Prefer small commits - keep tests green...`)
    expect(r.developerInstructions).toBe(buildCodexInstruction(steering))
    expect(prepareCodexLaunch(sb.paths, proj, { steering: 'rm -rf $HOME' }).developerInstructions).toBe(CODEX_BASE_INSTRUCTION)
    expect(prepareCodexLaunch(sb.paths, proj, { steering: null }).developerInstructions).toBe(CODEX_BASE_INSTRUCTION)
  })

  it('launches without the approvals it cannot add', () => {
    writeLedger(sb, { consent: 'granted' })
    const withToolsKey = `${codexServerToml('node', [sb.adapter])}tools = { memory_primer = { approval_mode = "approve" } }\n`
    writeText(sb.files.codex, withToolsKey)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({ developerInstructions: CODEX_BASE_INSTRUCTION, approvals: 0 })
    expect(readText(sb.files.codex)).toBe(withToolsKey)

    const plain = codexServerToml('node', [sb.adapter])
    writeText(sb.files.codex, plain)
    blockWrites(sb.files.codex)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({ developerInstructions: CODEX_BASE_INSTRUCTION, approvals: 0 })
    expect(readText(sb.files.codex)).toBe(plain)
  })

  it.each<[string, (s: Sandbox) => string]>([
    ['at the top level', (s) => `developer_instructions = "Be terse."\n\n${codexServerToml('node', [s.adapter])}`],
    ['in a profile', (s) => `${codexServerToml('node', [s.adapter])}\n[profiles.work]\ndeveloper_instructions = "Be terse."\n`],
  ])('leaves developer_instructions the user set %s', (_label, make) => {
    writeLedger(sb, { consent: 'granted' })
    writeText(sb.files.codex, make(sb))
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({
      developerInstructions: null, skipped: 'user-set', approvals: CODEX_AUTO_APPROVED_TOOLS.length,
    })
  })

  it('a config.toml it cannot read disables the override', () => {
    writeLedger(sb, { consent: 'granted' })
    mkdirSync(sb.files.codex, { recursive: true })
    writeText(join(proj, 'AGENTS.md'), block)
    expect(prepareCodexLaunch(sb.paths, proj)).toEqual({
      developerInstructions: null, skipped: 'disabled', approvals: 0, agentsMdCleaned: 'file-deleted',
    })
  })

  it('an older install not asked yet counts as connected', () => {
    writeLedger(sb, { consent: null, legacy: true })
    writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
    expect(prepareCodexLaunch(sb.paths, proj).developerInstructions).toBe(CODEX_BASE_INSTRUCTION)
  })
})

describe('removeCodexHomeTrust', () => {
  it('does nothing without a config', () => {
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: false })
    expect(existsSync(sb.files.codex)).toBe(false)
  })

  it('withdraws trust in the home folder, the folders above it and roots, and keeps the rest', () => {
    const safe = join(sb.home, 'proj')
    writeText(sb.files.codex, [
      'model = "o3"\n',
      codexTrustToml(sb.home),
      codexTrustToml(sb.root),
      codexTrustToml(parse(sb.root).root),
      codexTrustToml(safe),
    ].join('\n'))
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: true })
    const toml = readText(sb.files.codex)
    expect(codexTrustedProjects(toml)).toEqual([safe])
    expect(toml).toContain('model = "o3"')
    expect(getAgentIntegrationStatus(sb.paths).codexHomeTrusted).toBe(false)
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: false })
    expect(readText(sb.files.codex)).toBe(toml)
  })

  it('keeps the rest of a project table that holds more than the trust line', () => {
    writeText(sb.files.codex, `[projects.${tomlString(sb.home)}]\ntrust_level = "trusted"\nsandbox_mode = "workspace-write"\n`)
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: true })
    expect(readText(sb.files.codex)).toBe(`[projects.${tomlString(sb.home)}]\nsandbox_mode = "workspace-write"\n`)
  })

  it('reports a config it cannot parse, read or write, and leaves it as it was', () => {
    writeText(sb.files.codex, '[projects\n')
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: false, error: expect.any(String) })
    expect(readText(sb.files.codex)).toBe('[projects\n')

    const home = codexTrustToml(sb.home)
    writeText(sb.files.codex, home)
    blockWrites(sb.files.codex)
    expect(removeCodexHomeTrust(sb.paths)).toEqual({ changed: false, error: expect.stringMatching(WRITE_ERROR) })
    expect(readText(sb.files.codex)).toBe(home)

    const dirHome = { ...sb.paths, codexHome: join(sb.root, 'dir-codex') }
    mkdirSync(join(dirHome.codexHome, 'config.toml'), { recursive: true })
    expect(removeCodexHomeTrust(dirHome)).toEqual({ changed: false, error: expect.any(String) })
  })
})

describe('conductorMcpConfig', () => {
  it('always returns the Termpolis server, consent or not, and writes nothing', () => {
    expect(conductorMcpConfig(sb.rt)).toEqual({
      mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [sb.adapter] } },
    })
    const runner = { command: join(sb.root, 'app', 'Termpolis.exe'), env: { ELECTRON_RUN_AS_NODE: '1' } }
    expect(conductorMcpConfig({ ...sb.rt, node: runner })).toEqual({
      mcpServers: { termpolis: { type: 'stdio', command: runner.command, args: [sb.adapter], env: { ELECTRON_RUN_AS_NODE: '1' } } },
    })
    expect(existsSync(sb.ledgerFile)).toBe(false)
    expect(readdirSync(sb.home)).toEqual([])
  })
})
