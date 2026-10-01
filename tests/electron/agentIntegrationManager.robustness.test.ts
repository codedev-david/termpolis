// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { delimiter, dirname, isAbsolute, join, parse, relative } from 'path'
import {
  bootAgentIntegration, claudeHookShell, disconnectAgentIntegration, getAgentIntegrationStatus, isFolderTrustAllowed,
  prepareCodexLaunch, removeCodexHomeTrust, resolveAgentIntegrationPaths, setAgentIntegration, trustFolderForAgents,
} from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths, AgentIntegrationRuntime, HookShell } from '../../src/main/agentIntegrationManager'
import { CLAUDE_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import type { NodeSpec } from '../../src/main/agentMcpRegistry'
import { claudeProjectKey } from '../../src/main/claudeTrust'
import { MCP_TOOLS_AUTO_ALLOWED } from '../../src/shared/agentIntegration'
import {
  blockWrites, codexServerToml, codexTrustToml, createSandbox, ourEntry, readJson, readText,
  throwingHomeIn, withPlatform, writeJson, writeLedger, writeText,
} from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

// Reverting folder trust never throws on its own; these tests make it, to prove a disconnect
// carries on past a step that does.
const fault = vi.hoisted(() => ({ revert: undefined as unknown }))

vi.mock('../../src/main/claudeTrust', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/claudeTrust')>()
  return {
    ...actual,
    revertClaudeTrust: (...args: Parameters<typeof actual.revertClaudeTrust>): ReturnType<typeof actual.revertClaudeTrust> => {
      if (fault.revert !== undefined) throw fault.revert
      return actual.revertClaudeTrust(...args)
    },
  }
})

const START_DIR = process.cwd()
let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  fault.revert = undefined
  vi.restoreAllMocks()
  // Back out of the sandbox before it goes: Windows can't remove the working directory.
  process.chdir(START_DIR)
  sb.dispose()
})

const WRITE_ERROR = /EISDIR|EPERM|EACCES/
const OUR_TRUST = 'Folder trust Termpolis added'
const NONE = { installed: false, configPath: '', registered: false }
const DISCONNECTED = {
  consent: null, legacyDetected: false, connected: false, primerHook: true,
  agents: { claude: NONE, codex: NONE, gemini: NONE },
  autoAllowedTools: [...MCP_TOOLS_AUTO_ALLOWED], trustedFolders: [], codexHomeTrusted: false,
}
/** What every entry point reports when there is no home folder to find agent configs in. */
const NO_HOME_ROW = {
  agent: 'claude', file: '~', action: 'skipped', what: 'Agent configs', error: expect.stringContaining('home folder is unknown'),
}

function installAll(): void {
  for (const dir of [sb.paths.claudeDir, sb.paths.codexHome, sb.paths.geminiDir]) mkdirSync(dir, { recursive: true })
}

/** Termpolis's entries in every agent config, as connecting leaves them (and folder trust for `trustKey`). */
function seedOurs(trustKey?: string): void {
  writeJson(sb.files.settings, { permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
  writeJson(sb.files.claudeJson, {
    mcpServers: { termpolis: { type: 'stdio', ...ourEntry(sb) } },
    ...(trustKey ? { projects: { [trustKey]: { hasTrustDialogAccepted: true } } } : {}),
  })
  writeText(sb.files.codex, codexServerToml('node', [sb.adapter]))
  writeJson(sb.files.gemini, { mcpServers: { termpolis: ourEntry(sb) } })
}

/** The rows a disconnect gives for seedOurs(), in order. */
function removalRows(): unknown[] {
  return [
    { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'Tool permissions' },
    { agent: 'claude', file: sb.files.claudeJson, action: 'remove', what: 'MCP server' },
    { agent: 'codex', file: sb.files.codex, action: 'remove', what: 'MCP server' },
    { agent: 'gemini', file: sb.files.gemini, action: 'remove', what: 'MCP server' },
  ]
}

/** Every config file's text (null when missing), to prove a call wrote nothing. */
function snapshot(): Record<string, string | null> {
  const files = [...Object.values(sb.files), sb.ledgerFile]
  return Object.fromEntries(files.map((f) => [f, existsSync(f) ? readText(f) : null]))
}

/** Every file (with its text) and folder (null) under `dir`. */
function tree(dir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      out[relative(dir, p)] = e.isDirectory() ? null : readText(p)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}

/** The SessionStart hook command connecting writes for a bare `node`, for sh. */
function guardedNodeHook(script: string): string {
  return `if [ -f "${script}" ] && command -v "node" >/dev/null 2>&1; then node "${script}"; fi`
}

/** The same, for PowerShell. */
function psNodeHook(script: string): string {
  return `if ((Test-Path -LiteralPath '${script}' -PathType Leaf) -and `
    + `(Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue)) `
    + `{ $p = Start-Process -FilePath 'node' -ArgumentList '"${script}"' -NoNewWindow -Wait -PassThru; exit $p.ExitCode }`
}

/** Connect with `node` as the runner and the hook written for `shell`, and return the hook. */
function hookEntryFor(node: NodeSpec, shell: HookShell, script = sb.hookScript): Record<string, unknown> {
  mkdirSync(sb.paths.claudeDir, { recursive: true })
  setAgentIntegration({ ...sb.rt, node, hookShell: shell, hookScriptPath: script }, { connect: true })
  return readJson(sb.files.settings).hooks.SessionStart[0].hooks[0]
}

/** Connect with `node` as the runner and the hook written for `shell`, and return its command. */
function hookFor(node: NodeSpec, shell: HookShell = 'sh', script?: string): string {
  return hookEntryFor(node, shell, script).command as string
}

describe('resolveAgentIntegrationPaths: never a relative agent path', () => {
  it.each<[string, string]>([
    ['blank', ''],
    ['whitespace', '  '],
    ['relative', 'someone'],
  ])('a %s OS home folder gives no home and no agent folder', (_label, osHome) => {
    expect(resolveAgentIntegrationPaths(osHome, sb.paths.userData, {})).toEqual({
      home: '', userData: sb.paths.userData, claudeDir: '', claudeJson: '', codexHome: '', geminiDir: '',
    })
  })

  it('ignores a CLAUDE_CONFIG_DIR or CODEX_HOME that is not a full path', () => {
    const home = join(sb.root, 'os-home')
    expect(resolveAgentIntegrationPaths(home, sb.paths.userData, { CLAUDE_CONFIG_DIR: 'claude-config', CODEX_HOME: ' codex ' })).toEqual({
      home,
      userData: sb.paths.userData,
      claudeDir: join(home, '.claude'),
      claudeJson: join(home, '.claude.json'),
      codexHome: join(home, '.codex'),
      geminiDir: join(home, '.gemini'),
    })
  })

  it('a test home that is not a full path gives no home, never the real one', () => {
    const paths = resolveAgentIntegrationPaths(join(sb.root, 'os-home'), sb.paths.userData, { TERMPOLIS_TEST_AGENT_HOME: 'scratch-home' })
    expect(paths).toEqual({ home: '', userData: sb.paths.userData, claudeDir: '', claudeJson: '', codexHome: '', geminiDir: '' })
  })

  it('keeps full-path overrides when the home folder is unknown', () => {
    const claude = join(sb.root, 'cfg-claude')
    const codex = join(sb.root, 'cfg-codex')
    expect(resolveAgentIntegrationPaths('', sb.paths.userData, { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex })).toEqual({
      home: '', userData: sb.paths.userData, claudeDir: claude, claudeJson: join(claude, '.claude.json'), codexHome: codex, geminiDir: '',
    })
  })
})

describe('no full home folder: nothing lands in the working directory', () => {
  let cwd: string
  let before: Record<string, string | null>
  let noHome: AgentIntegrationPaths
  let rt: AgentIntegrationRuntime

  beforeEach(() => {
    // What relative agent paths would reach from here: a connected install of every agent.
    cwd = join(sb.root, 'cwd')
    writeJson(join(cwd, '.claude', 'settings.json'), { permissions: { allow: ['mcp__termpolis__*'] } })
    writeJson(join(cwd, '.claude.json'), { mcpServers: { termpolis: { type: 'stdio', ...ourEntry(sb) } } })
    writeText(join(cwd, '.codex', 'config.toml'), `${codexServerToml('node', [sb.adapter])}\n${codexTrustToml(parse(cwd).root)}`)
    writeJson(join(cwd, '.gemini', 'settings.json'), { mcpServers: { termpolis: ourEntry(sb) } })
    writeJson(join(cwd, '.mcp.json'), { termpolis: ourEntry(sb) })
    mkdirSync(join(cwd, 'proj'))
    before = tree(cwd)
    process.chdir(cwd)
    noHome = resolveAgentIntegrationPaths('', sb.paths.userData, {})
    rt = { ...sb.rt, paths: noHome }
  })

  it('shows no agent, and saves no first ledger (it could not look for an older install)', () => {
    expect(getAgentIntegrationStatus(noHome)).toEqual(DISCONNECTED)
    expect(existsSync(sb.ledgerFile)).toBe(false)
    expect(tree(cwd)).toEqual(before)
  })

  it('start: runs no migration and applies nothing, and says why', () => {
    writeLedger(sb, { consent: 'granted', migrations: [] })
    expect(bootAgentIntegration(rt).changes).toEqual([NO_HOME_ROW])
    // Not done, so the first start that has a home folder runs them.
    expect(readJson(sb.ledgerFile).migrations).toEqual([])
    expect(tree(cwd)).toEqual(before)
  })

  it('connect: keeps the answer, and writes no agent config', () => {
    expect(setAgentIntegration(rt, { connect: true })).toEqual({
      status: { ...DISCONNECTED, consent: 'granted', connected: true },
      changes: [NO_HOME_ROW],
    })
    expect(readJson(sb.ledgerFile).consent).toBe('granted')
    expect(tree(cwd)).toEqual(before)
  })

  it('decline and disconnect: keep the answer and the trust keys, and touch no agent config', () => {
    writeLedger(sb, { consent: 'granted', trustedByTermpolis: ['kept'] })
    expect(setAgentIntegration(rt, { connect: false }).changes).toEqual([NO_HOME_ROW])
    expect(readJson(sb.ledgerFile)).toMatchObject({ consent: 'declined', trustedByTermpolis: ['kept'] })
    expect(disconnectAgentIntegration(noHome)).toEqual([NO_HOME_ROW])
    expect(readJson(sb.ledgerFile)).toMatchObject({ consent: null, trustedByTermpolis: ['kept'] })
    expect(tree(cwd)).toEqual(before)
  })

  it('folder trust, the Codex launch and Codex home trust change nothing', () => {
    writeLedger(sb, { consent: 'granted' })
    const proj = join(cwd, 'proj')
    expect(trustFolderForAgents(noHome, proj)).toEqual({ changed: false, keys: [], skipped: 'no-home' })
    expect(prepareCodexLaunch(noHome, proj)).toEqual({ developerInstructions: null, skipped: 'disabled', approvals: 0 })
    expect(removeCodexHomeTrust(noHome)).toEqual({ changed: false, error: expect.stringContaining('home folder is unknown') })
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([])
    expect(tree(cwd)).toEqual(before)
  })

  it('answers no folder-trust prompt: the home folder could not be told from any other', () => {
    writeLedger(sb, { consent: 'granted' })
    expect(isFolderTrustAllowed(sb.paths, join(sb.home, 'proj'))).toBe(true)
    expect(isFolderTrustAllowed(noHome, join(cwd, 'proj'))).toBe(false)
    expect(isFolderTrustAllowed(noHome, join(cwd, 'proj'), cwd)).toBe(false)
  })

  it('a userData that is not a full path: no ledger here, and a connect that says it was not saved', () => {
    installAll()
    const paths = resolveAgentIntegrationPaths(sb.home, 'userData', {})
    expect(getAgentIntegrationStatus(paths)).toMatchObject({ consent: null, connected: false })
    expect(setAgentIntegration({ ...sb.rt, paths }, { connect: true })).toEqual({
      status: expect.objectContaining({ consent: null, connected: false }),
      changes: [],
      saveError: expect.stringContaining('not a full path'),
    })
    expect(disconnectAgentIntegration(paths)).toEqual([
      { agent: 'claude', file: 'agent-integration.json', action: 'skipped', what: 'Record of the disconnect', error: expect.stringContaining('not a full path') },
    ])
    expect(existsSync(sb.files.claudeJson) || existsSync(sb.files.settings)).toBe(false)
    expect(tree(cwd)).toEqual(before)
  })
})

describe('boot and set: an error path that cannot throw in turn', () => {
  const stopped = (error: RegExp): unknown => ({
    status: DISCONNECTED,
    changes: [{ agent: 'claude', file: 'agent-integration.json', action: 'skipped', what: 'Agent integration', error: expect.stringMatching(error) }],
  })
  const unreadable = (): AgentIntegrationRuntime => ({ ...sb.rt, get paths(): AgentIntegrationPaths { throw new Error('boom: no paths') } })

  it.each<[string, () => AgentIntegrationRuntime, RegExp]>([
    ['a userData that is not a string', () => ({ ...sb.rt, paths: { ...sb.paths, userData: undefined as unknown as string } }), /string/],
    ['no runtime at all', () => null as unknown as AgentIntegrationRuntime, /null/],
    ['paths that throw when read', unreadable, /boom: no paths/],
  ])('report %s instead of throwing', (_label, make, error) => {
    const rt = make()
    expect(bootAgentIntegration(rt)).toEqual(stopped(error))
    expect(setAgentIntegration(rt, { connect: true })).toEqual(stopped(error))
  })

  it.each<[string, () => AgentIntegrationRuntime, RegExp]>([
    ['no runtime at all', () => null as unknown as AgentIntegrationRuntime, /null/],
    ['paths that throw when read', unreadable, /boom: no paths/],
  ])('a decline with %s is reported, not thrown', (_label, make, error) => {
    expect(setAgentIntegration(make(), { connect: false })).toEqual(stopped(error))
  })

  it('a decline with a userData that is not a string still disconnects, and says the answer was not kept', () => {
    seedOurs()
    const paths = { ...sb.paths, userData: undefined as unknown as string }
    expect(setAgentIntegration({ ...sb.rt, paths }, { connect: false })).toEqual({
      status: DISCONNECTED,
      changes: [
        { agent: 'claude', file: 'agent-integration.json', action: 'skipped', what: 'Disconnect', error: expect.stringMatching(/string/) },
        ...removalRows(),
      ],
      saveError: expect.stringMatching(/string/),
    })
  })
})

describe('disconnectAgentIntegration: one failure never stops the rest', () => {
  it('with no usable paths at all, reports each step it could not take', () => {
    expect(disconnectAgentIntegration(undefined as unknown as AgentIntegrationPaths)).toEqual([
      { agent: 'claude', file: 'agent-integration.json', action: 'skipped', what: 'Disconnect', error: expect.stringContaining('undefined') },
      NO_HOME_ROW,
      { agent: 'claude', file: 'agent-integration.json', action: 'skipped', what: 'Record of the disconnect', error: expect.stringContaining('undefined') },
    ])
  })

  it('takes null options as none', () => {
    writeLedger(sb, { consent: 'granted' })
    expect(disconnectAgentIntegration(sb.paths, null as unknown as { recordDecline?: boolean })).toEqual([])
    expect(readJson(sb.ledgerFile).consent).toBeNull()
  })

  it.each<[string, (s: Sandbox) => string, (s: Sandbox, key: string) => unknown[], boolean]>([
    ['claudeDirs', (s) => s.files.settings, (s) => [
      { agent: 'claude', file: s.paths.claudeDir, action: 'skipped', what: 'Disconnect', error: 'boom: home unavailable in claudeDirs' },
      { agent: 'claude', file: s.files.claudeJson, action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: s.files.codex, action: 'remove', what: 'MCP server' },
      { agent: 'gemini', file: s.files.gemini, action: 'remove', what: 'MCP server' },
      { agent: 'claude', file: s.files.claudeJson, action: 'remove', what: OUR_TRUST },
    ], false],
    ['claudeJsonFiles', (s) => s.files.claudeJson, (s) => [
      { agent: 'claude', file: s.files.settings, action: 'remove', what: 'Tool permissions' },
      { agent: 'claude', file: s.paths.claudeJson, action: 'skipped', what: 'Disconnect', error: 'boom: home unavailable in claudeJsonFiles' },
      { agent: 'codex', file: s.files.codex, action: 'remove', what: 'MCP server' },
      { agent: 'gemini', file: s.files.gemini, action: 'remove', what: 'MCP server' },
    ], true],
    ['codexHomes', (s) => s.files.codex, (s) => [
      { agent: 'claude', file: s.files.settings, action: 'remove', what: 'Tool permissions' },
      { agent: 'claude', file: s.files.claudeJson, action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: s.paths.codexHome, action: 'skipped', what: 'Disconnect', error: 'boom: home unavailable in codexHomes' },
      { agent: 'gemini', file: s.files.gemini, action: 'remove', what: 'MCP server' },
      { agent: 'claude', file: s.files.claudeJson, action: 'remove', what: OUR_TRUST },
    ], false],
  ])('a failure listing the files (%s) skips that agent only', (fnName, untouched, rows, keysKept) => {
    const key = claudeProjectKey(join(sb.home, 'mine'))
    writeLedger(sb, { consent: 'granted', trustedByTermpolis: [key] })
    seedOurs(key)
    const original = readText(untouched(sb))
    expect(disconnectAgentIntegration(throwingHomeIn(fnName, sb.paths))).toEqual(rows(sb, key))
    expect(readText(untouched(sb))).toBe(original)
    // Keys whose revert never ran stay, for the next disconnect.
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual(keysKept ? [key] : [])
  })

  it.each<[string, unknown, string]>([
    ['an error', new Error('boom: revert'), 'boom: revert'],
    ['a value with no message or string form', Object.create(null), 'unknown error'],
  ])('a trust revert that throws %s keeps the keys, after every agent is disconnected', (_label, thrown, error) => {
    const key = claudeProjectKey(join(sb.home, 'mine'))
    writeLedger(sb, { consent: 'granted', trustedByTermpolis: [key] })
    seedOurs(key)
    fault.revert = thrown
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      ...removalRows(),
      { agent: 'claude', file: sb.files.claudeJson, action: 'skipped', what: 'Disconnect', error },
    ])
    expect(readJson(sb.files.claudeJson).projects).toEqual({ [key]: { hasTrustDialogAccepted: true } })
    expect(readJson(sb.ledgerFile).trustedByTermpolis).toEqual([key])
  })
})

describe('an answer that cannot be saved', () => {
  it('connect: says so, and writes nothing into agent configs', () => {
    installAll()
    writeLedger(sb)
    const before = snapshot()
    blockWrites(sb.ledgerFile)
    expect(setAgentIntegration(sb.rt, { connect: true })).toEqual({
      status: expect.objectContaining({ consent: null, connected: false }),
      changes: [],
      saveError: expect.stringMatching(WRITE_ERROR),
    })
    expect(snapshot()).toEqual(before)
  })

  it('decline: disconnects all the same, and says the answer was not kept', () => {
    writeLedger(sb, { consent: 'granted' })
    seedOurs()
    blockWrites(sb.ledgerFile)
    const r = setAgentIntegration(sb.rt, { connect: false })
    expect(r.changes).toEqual(removalRows())
    expect(r.saveError).toMatch(WRITE_ERROR)
    // What is saved is still the old answer, and the status says so.
    expect(r.status).toMatchObject({ consent: 'granted', connected: true })
    expect(readJson(sb.ledgerFile).consent).toBe('granted')
  })

  it('disconnectAgentIntegration: a last row says the disconnect was not recorded', () => {
    writeLedger(sb, { consent: 'granted' })
    seedOurs()
    blockWrites(sb.ledgerFile)
    expect(disconnectAgentIntegration(sb.paths, { recordDecline: true })).toEqual([
      ...removalRows(),
      { agent: 'claude', file: sb.ledgerFile, action: 'skipped', what: 'Record of the disconnect', error: expect.stringMatching(WRITE_ERROR) },
    ])
  })
})

describe('the SessionStart hook once Termpolis is gone', () => {
  it('guards an absolute runner by its file, and keeps its environment', () => {
    const exe = join(sb.root, 'app', 'Termpolis.exe')
    const bin = exe.replace(/\\/g, '/')
    expect(hookFor({ command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } })).toBe(
      `if [ -f "${sb.hookScript}" ] && [ -f "${bin}" ]; then ELECTRON_RUN_AS_NODE=1 "${bin}" "${sb.hookScript}"; fi`,
    )
  })

  it.each<[string, (command: string) => Record<string, unknown>]>([
    ['in a group', (command) => ({ matcher: 'startup', hooks: [{ type: 'command', command, timeout: 10 }] })],
    ['as a flat entry', (command) => ({ type: 'command', command })],
  ])('rewrites an unguarded hook %s in place, once, and leaves the MCP server entry alone', (_label, entry) => {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb, { consent: 'granted' })
    writeJson(sb.files.claudeJson, { mcpServers: { termpolis: { type: 'stdio', ...ourEntry(sb) } } })
    const mine = { hooks: [{ type: 'command', command: 'echo mine' }] }
    writeJson(sb.files.settings, {
      permissions: { allow: [...CLAUDE_ALLOW_RULES] },
      hooks: { SessionStart: [mine, entry(`node "${sb.hookScript}"`)] },
    })
    const server = readText(sb.files.claudeJson)
    const rt = { ...sb.rt, hookShell: 'sh' as const }

    expect(bootAgentIntegration(rt).changes).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'update', what: 'SessionStart memory hook' },
    ])
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [mine, entry(guardedNodeHook(sb.hookScript))] })
    expect(readText(sb.files.claudeJson)).toBe(server)
    expect(bootAgentIntegration(rt).changes).toEqual([])
  })

  it('disconnect removes the hook in any form, and leaves the user\'s own', () => {
    const mine = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }
    writeJson(sb.files.settings, {
      hooks: {
        SessionStart: [
          mine,
          { hooks: [{ type: 'command', command: `node "${sb.hookScript}"` }] },
          { hooks: [{ type: 'command', command: guardedNodeHook(sb.hookScript) }] },
          { hooks: [{ type: 'command', command: psNodeHook(sb.hookScript), shell: 'powershell' }] },
          { type: 'command', command: 'node "C:/old/memory-primer-hook.cjs"' },
          { type: 'command', command: psNodeHook('C:/old/memory-primer-hook.cjs'), shell: 'powershell' },
        ],
      },
    })
    expect(disconnectAgentIntegration(sb.paths)).toEqual([
      { agent: 'claude', file: sb.files.settings, action: 'remove', what: 'SessionStart memory hook' },
    ])
    expect(readJson(sb.files.settings)).toEqual({ hooks: { SessionStart: [mine] } })
  })
})

describe('the SessionStart hook, in the shell Claude Code runs it in', () => {
  type Hook = (script: string) => Record<string, unknown>
  const unguarded: Hook = (s) => ({ type: 'command', command: `node "${s}"` })
  const shHook: Hook = (s) => ({ type: 'command', command: guardedNodeHook(s) })
  const psHook: Hook = (s) => ({ type: 'command', command: psNodeHook(s), shell: 'powershell' })
  const inGroup = (hook: Hook): Hook => (s) => ({ matcher: 'startup', hooks: [{ ...hook(s), timeout: 10 }] })
  const hookRow = (action: string): unknown => ({ agent: 'claude', file: sb.files.settings, action, what: 'SessionStart memory hook' })

  /** Connected, with `entries` as SessionStart, and the MCP server entry already in place. */
  function seedHooks(entries: unknown[]): void {
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeLedger(sb, { consent: 'granted' })
    writeJson(sb.files.claudeJson, { mcpServers: { termpolis: { type: 'stdio', ...ourEntry(sb) } } })
    writeJson(sb.files.settings, { permissions: { allow: [...CLAUDE_ALLOW_RULES] }, hooks: { SessionStart: entries } })
  }

  it('is the PowerShell form for PowerShell, and says so in `shell`', () => {
    expect(hookEntryFor('node', 'powershell')).toEqual(psHook(sb.hookScript))
    const exe = join(sb.root, 'app', 'Termpolis.exe')
    const bin = exe.replace(/\\/g, '/')
    expect(hookEntryFor({ command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } }, 'powershell')).toEqual({
      type: 'command',
      command: `if ((Test-Path -LiteralPath '${sb.hookScript}' -PathType Leaf) -and (Test-Path -LiteralPath '${bin}' -PathType Leaf)) `
        + `{ $env:ELECTRON_RUN_AS_NODE = '1'; $p = Start-Process -FilePath '${bin}' -ArgumentList '"${sb.hookScript}"' `
        + '-NoNewWindow -Wait -PassThru; exit $p.ExitCode }',
      shell: 'powershell',
    })
  })

  it('doubles every single quote PowerShell knows, curly ones too, and leaves $ and ` as they are', () => {
    const exe = "C:\\Users\\O'Brien\\Termpolis.exe"
    const script = 'C:/x/\u2018a\u2019 \u201Ab\u201B $x `b` [w] & (p); y/memory-primer-hook.cjs'
    const doubled = 'C:/x/\u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B $x `b` [w] & (p); y/memory-primer-hook.cjs'
    expect(hookFor({ command: exe }, 'powershell', script)).toBe(
      `if ((Test-Path -LiteralPath '${doubled}' -PathType Leaf) -and (Test-Path -LiteralPath 'C:/Users/O''Brien/Termpolis.exe' -PathType Leaf)) `
        + `{ $p = Start-Process -FilePath 'C:/Users/O''Brien/Termpolis.exe' -ArgumentList '"${doubled}"' -NoNewWindow -Wait -PassThru; `
        + 'exit $p.ExitCode }',
    )
  })

  it.each<[string, Hook, HookShell, Hook]>([
    ['an unguarded hook, for PowerShell', inGroup(unguarded), 'powershell', inGroup(psHook)],
    ['an unguarded flat entry, for PowerShell', unguarded, 'powershell', psHook],
    ['the sh form, for PowerShell', inGroup(shHook), 'powershell', inGroup(psHook)],
    ['the PowerShell form, for sh', inGroup(psHook), 'sh', inGroup(shHook)],
    ['the PowerShell command without its `shell`', inGroup((s) => ({ ...psHook(s), shell: undefined })), 'powershell', inGroup(psHook)],
    ['the sh form with a `shell` it does not need', inGroup((s) => ({ ...shHook(s), shell: 'bash' })), 'sh', inGroup(shHook)],
  ])('rewrites %s, in place and once, and keeps the rest', (_label, before, hookShell, after) => {
    const mine = { hooks: [{ type: 'command', command: 'echo mine' }] }
    seedHooks([mine, before(sb.hookScript)])
    const rt = { ...sb.rt, hookShell }

    expect(bootAgentIntegration(rt).changes).toEqual([hookRow('update')])
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [mine, after(sb.hookScript)] })
    expect(bootAgentIntegration(rt).changes).toEqual([])
  })

  it('steps over junk in SessionStart', () => {
    const junk = [null, 'junk', { hooks: [null, 7] }]
    seedHooks(junk)
    expect(bootAgentIntegration({ ...sb.rt, hookShell: 'powershell' }).changes).toEqual([hookRow('add')])
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [...junk, { hooks: [psHook(sb.hookScript)] }] })
  })

  it('a flat entry holding a copy of itself goes, and the next start adds the hook back', () => {
    // Keeping the flat entry and dropping its copy leaves an empty `hooks`, so the entry goes too.
    const old = unguarded(sb.hookScript)
    seedHooks([{ ...old, hooks: [old] }])
    const rt = { ...sb.rt, hookShell: 'powershell' as const }

    expect(bootAgentIntegration(rt).changes).toEqual([hookRow('update')])
    expect(readJson(sb.files.settings).hooks).toBeUndefined()
    expect(bootAgentIntegration(rt).changes).toEqual([hookRow('add')])
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [{ hooks: [psHook(sb.hookScript)] }] })
  })

  it('with none given, finds the shell as Claude Code does, from the env in settings.json too', () => {
    const bash = join(sb.root, 'tools', 'Git', 'bin', 'bash.exe')
    writeText(bash, '')
    mkdirSync(sb.paths.claudeDir, { recursive: true })
    writeJson(sb.files.settings, { env: { CLAUDE_CODE_GIT_BASH_PATH: bash } })

    withPlatform('win32', () => setAgentIntegration(sb.rt, { connect: true }))
    expect(readJson(sb.files.settings).hooks).toEqual({ SessionStart: [{ hooks: [shHook(sb.hookScript)] }] })
  })
})

describe('claudeHookShell', () => {
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const GIT_BASH_X86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  /** A file system holding `files` and nothing else, which, as Windows does, ignores case. */
  const only = (...files: string[]) => (p: string): boolean => files.some((f) => f.toLowerCase() === p.toLowerCase())
  const nothing = only()

  it.each(['darwin', 'linux'] as const)('is sh on %s', (platform) => {
    expect(claudeHookShell(platform, undefined, {}, nothing)).toBe('sh')
  })

  it('on Windows, is sh with Git Bash in either folder Git installs to, and PowerShell with none', () => {
    expect(claudeHookShell('win32', undefined, {}, only(GIT_BASH))).toBe('sh')
    expect(claudeHookShell('win32', undefined, {}, only(GIT_BASH_X86))).toBe('sh')
    expect(claudeHookShell('win32', undefined, {}, nothing)).toBe('powershell')
    expect(claudeHookShell('win32', undefined, { PATH: 'C:\\Windows\\System32;C:\\Windows' }, nothing)).toBe('powershell')
  })

  it('takes CLAUDE_CODE_GIT_BASH_PATH when it names a bash or sh that is there', () => {
    for (const bash of ['D:\\tools\\bash.exe', 'D:\\tools\\SH.EXE', 'D:\\tools\\bash', 'D:\\tools\\sh']) {
      expect(claudeHookShell('win32', undefined, { CLAUDE_CODE_GIT_BASH_PATH: bash }, only(bash))).toBe('sh')
    }
  })

  it('looks further when CLAUDE_CODE_GIT_BASH_PATH names some other file, or one that is not there', () => {
    const zsh = 'D:\\tools\\zsh.exe'
    expect(claudeHookShell('win32', undefined, { CLAUDE_CODE_GIT_BASH_PATH: zsh }, only(zsh))).toBe('powershell')
    expect(claudeHookShell('win32', undefined, { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe' }, nothing)).toBe('powershell')
    expect(claudeHookShell('win32', undefined, { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe' }, only(GIT_BASH))).toBe('sh')
  })

  it('reads the env in settings.json over its own, whatever the case of the names', () => {
    const bash = 'D:\\tools\\bash.exe'
    expect(claudeHookShell('win32', { CLAUDE_CODE_GIT_BASH_PATH: bash }, {}, only(bash))).toBe('sh')
    expect(claudeHookShell('win32', { claude_code_git_bash_path: 'D:\\gone\\bash.exe' }, { CLAUDE_CODE_GIT_BASH_PATH: bash }, only(bash)))
      .toBe('powershell')
    expect(claudeHookShell('win32', { Path: 'D:\\Git\\cmd' }, { PATH: 'C:\\Windows' }, only('D:\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\bash.exe')))
      .toBe('sh')
  })

  it.each<[string, unknown]>([
    ['missing', null],
    ['not an object', 'D:\\tools\\bash.exe'],
    ['not text', { CLAUDE_CODE_GIT_BASH_PATH: 1 }],
  ])('ignores a settings.json env that is %s', (_label, settingsEnv) => {
    const bash = 'D:\\tools\\bash.exe'
    expect(claudeHookShell('win32', settingsEnv, { CLAUDE_CODE_GIT_BASH_PATH: bash }, only(bash))).toBe('sh')
  })

  describe('git on PATH', () => {
    const GIT = 'D:\\Git\\cmd\\git.exe'
    const BASH = 'D:\\Git\\bin\\bash.exe'

    it('is sh when the first git on PATH has bin\\bash.exe two folders up, quoted or not', () => {
      expect(claudeHookShell('win32', undefined, { PATH: 'C:\\Windows;"D:\\Git\\cmd"' }, only(GIT, BASH))).toBe('sh')
      expect(claudeHookShell('win32', undefined, { PATH: 'D:\\Git\\cmd' }, only(GIT))).toBe('powershell')
    })

    it('looks no further than the first git', () => {
      expect(claudeHookShell('win32', undefined, { PATH: 'E:\\other;D:\\Git\\cmd' }, only('E:\\other\\git.exe', GIT, BASH)))
        .toBe('powershell')
    })

    it('skips folders on PATH that are not full paths', () => {
      expect(claudeHookShell('win32', undefined, { PATH: ';Git\\cmd;D:\\Git\\cmd' }, only('Git\\cmd\\git.exe', GIT, BASH))).toBe('sh')
    })

    it('goes by PATHEXT, and by the usual extensions without it', () => {
      expect(claudeHookShell('win32', undefined, { PATH: 'D:\\Git\\cmd', PATHEXT: '.BAT;;.EXE' }, only('D:\\Git\\cmd\\git.bat', BASH)))
        .toBe('sh')
      expect(claudeHookShell('win32', undefined, { PATH: 'D:\\Git\\cmd', PATHEXT: '.CMD' }, only(GIT, BASH))).toBe('powershell')
      expect(claudeHookShell('win32', undefined, { PATH: 'D:\\Git\\cmd', PATHEXT: '' }, only(GIT, BASH))).toBe('sh')
    })
  })
})

/** A shell Claude Code runs hook commands in, and what it passes before the command. */
interface HookRunner {
  name: string
  shell: HookShell
  /** Null when this machine has none. */
  exe: string | null
  args: string[]
}

const existing = (p: string): string | null => (existsSync(p) ? p : null)
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
// Electron, as Termpolis.exe is, is a Windows app, where node.exe is a console one. Only an
// install that ran Electron's own install script has it.
const ELECTRON = process.platform === 'win32'
  ? existing(join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'))
  : null

// Claude Code runs a hook's command with `sh -c`: Git Bash on Windows. On Windows, a hook whose
// `shell` is powershell, and every hook where there is no Git Bash, runs in PowerShell: pwsh
// when it is on PATH, else Windows PowerShell.
const HOOK_RUNNERS: HookRunner[] = process.platform === 'win32'
  ? [
    { name: 'Git Bash', shell: 'sh', exe: existing('C:/Program Files/Git/bin/bash.exe'), args: ['-c'] },
    {
      name: 'Windows PowerShell',
      shell: 'powershell',
      exe: existing(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
      args: POWERSHELL_ARGS,
    },
    {
      name: 'pwsh',
      shell: 'powershell',
      exe: (process.env.PATH ?? '').split(delimiter).filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, 'pwsh.exe')).find((p) => existsSync(p)) ?? null,
      args: POWERSHELL_ARGS,
    },
  ]
  : [{ name: 'sh', shell: 'sh', exe: existing('/bin/sh'), args: ['-c'] }]

for (const runner of HOOK_RUNNERS) {
  describe.skipIf(!runner.exe)(`the SessionStart hook, run by ${runner.name}`, { timeout: 60_000 }, () => {
    // Claude Code hands a hook its input as JSON, on stdin.
    const INPUT = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: 'C:/proj \u2014 \u00fc' })
    const PRIMER = 'let s = ""\nprocess.stdin.on("data", (c) => { s += c }).on("end", () => {\n'
      + '  console.log("primer ran " + (process.env.ELECTRON_RUN_AS_NODE || "-") + " " + s)\n})\n'
    /** What PRIMER prints, with `env` as its ELECTRON_RUN_AS_NODE. */
    const ran = (env = '-'): string => `primer ran ${env} ${INPUT}`

    /** This environment, with `path` as PATH and none of what changes how the shell or the runner starts. */
    function hookEnv(path: string): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {}
      for (const [k, v] of Object.entries(process.env)) {
        // A pwsh running these tests would hand Windows PowerShell its own module folders.
        if (!['PATH', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV', 'ENV', 'PSMODULEPATH'].includes(k.toUpperCase())) env[k] = v
      }
      env.PATH = path
      return env
    }

    function runHook(command: string, path = process.env.PATH ?? ''): { status: number | null; stdout: string; stderr: string } {
      const r = spawnSync(runner.exe as string, [...runner.args, command], { encoding: 'utf8', env: hookEnv(path), input: INPUT, timeout: 30_000 })
      return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
    }

    /**
     * Run `command` as Claude Code 2.1 runs a hook: the input and a newline on stdin, and once the
     * shell exits, read on only until its pipes close or 500 ms pass with nothing new, 10 s at
     * most. What a runner prints later than that, Claude Code never sees. runHook reads on until
     * the runner closes the pipes too, so a shell that does not wait for its runner passes there.
     */
    function runAsClaudeCode(command: string): Promise<{ status: number | null; stdout: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(runner.exe as string, [...runner.args, command], { env: hookEnv(process.env.PATH ?? ''), windowsHide: true })
        let stdout = ''
        let lastData = 0
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk
          lastData = Date.now()
        })
        child.stderr.resume()
        const closed = new Promise<boolean>((done) => child.once('close', () => done(true)))
        const readOn = async (): Promise<void> => {
          const exitedAt = Date.now()
          for (;;) {
            const before = lastData
            const quiet = new Promise<boolean>((done) => setTimeout(() => done(false), 500))
            if (await Promise.race([closed, quiet]) || Date.now() - exitedAt >= 10_000) return
            if (lastData !== before) continue
            await new Promise((done) => setImmediate(done))
            if (lastData === before) return
          }
        }
        child.once('error', reject)
        child.once('exit', (status) => {
          void readOn().then(() => resolve({ status, stdout: stdout.trim() }))
        })
        child.stdin.end(`${INPUT}\n`)
      })
    }

    /** Connect, and return the hook command, for this shell. */
    const hook = (node: NodeSpec, script?: string): string => hookFor(node, runner.shell, script)

    it('runs the primer, with the hook\'s input, while its runner and script are both there', () => {
      writeText(sb.hookScript, PRIMER)
      expect(runHook(hook({ command: process.execPath }))).toEqual({ status: 0, stdout: ran(), stderr: '' })
      expect(runHook(hook({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })))
        .toEqual({ status: 0, stdout: ran('1'), stderr: '' })
    })

    it('still reports a primer that fails while installed', () => {
      writeText(sb.hookScript, 'process.exit(3)\n')
      expect(runHook(hook({ command: process.execPath })).status).toBe(3)
    })

    it.skipIf(!ELECTRON)('waits for a runner that is a Windows app, as Termpolis.exe is, so Claude Code gets its output and exit code', async () => {
      const command = hook({ command: ELECTRON as string, env: { ELECTRON_RUN_AS_NODE: '1' } })
      // It prints a second after its input ends, as the primer prints once Termpolis answers.
      writeText(sb.hookScript, 'let s = ""\nprocess.stdin.on("data", (c) => { s += c }).on("end", () => setTimeout(() => {\n'
        + '  console.log("primer ran " + (process.env.ELECTRON_RUN_AS_NODE || "-") + " " + s.trim())\n}, 1000))\n')
      expect(await runAsClaudeCode(command)).toEqual({ status: 0, stdout: ran('1') })
      writeText(sb.hookScript, 'process.exit(3)\n')
      expect(await runAsClaudeCode(command)).toEqual({ status: 3, stdout: '' })
    })

    it('exits 0, silently, once the script is gone', () => {
      expect(runHook(hook({ command: process.execPath }))).toEqual({ status: 0, stdout: '', stderr: '' })
    })

    it('exits 0, silently, once the runner is gone', () => {
      writeText(sb.hookScript, PRIMER)
      const gone = join(sb.root, 'uninstalled', 'Termpolis.exe')
      expect(runHook(hook({ command: gone, env: { ELECTRON_RUN_AS_NODE: '1' } }))).toEqual({ status: 0, stdout: '', stderr: '' })
    })

    it('a bare node: runs from PATH, and exits 0 silently when PATH has none', () => {
      writeText(sb.hookScript, PRIMER)
      const command = hook('node')
      expect(runHook(command, `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`))
        .toEqual({ status: 0, stdout: ran(), stderr: '' })
      const empty = join(sb.root, 'empty-path')
      mkdirSync(empty)
      expect(runHook(command, empty)).toEqual({ status: 0, stdout: '', stderr: '' })
    })

    it('takes a runner and a script whose paths have quotes, brackets, & and ( ) in them as they are', () => {
      // sh reads $ and ` within double quotes, and the sh form has always quoted that way.
      const dir = join(sb.root, `it's \u2019q\u2019 ${runner.shell === 'powershell' ? '$x `b` ' : ''}[w] & (p); y`)
      const script = join(dir, 'memory-primer-hook.cjs')
      const node = join(dir, parse(process.execPath).base)
      writeText(script, PRIMER)
      try {
        linkSync(process.execPath, node)
      } catch {
        copyFileSync(process.execPath, node)
      }
      try {
        expect(runHook(hook({ command: node }, script))).toEqual({ status: 0, stdout: ran(), stderr: '' })
        expect(runHook(hook({ command: join(dir, 'gone', 'Termpolis.exe') }, script))).toEqual({ status: 0, stdout: '', stderr: '' })
      } finally {
        // Windows may still hold the runner a moment after it exits.
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
      }
    })
  })
}
