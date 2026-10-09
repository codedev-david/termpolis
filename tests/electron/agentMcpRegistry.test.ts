// Unit tests for agentMcpRegistry: the pure transforms agentIntegrationManager applies to the
// agent CLIs' parsed configs (it does the file IO and asks for consent first), plus the node
// runner those entries spawn the stdio adapter with.
//
// The regression guards that matter most:
//   - Claude is given an explicit allow list of memory/read-only tools. The old blanket
//     `mcp__termpolis__*` rule (which covered run_command) is migrated away, never written.
//   - Every removal finds Termpolis's entries by signature, so a `termpolis` server, hook or
//     rule the user wrote themselves is left alone.
//   - A config with an unexpected shape is reported as skipped and left exactly as it was.
//     Earlier versions "recovered" by overwriting the odd value, and v1.11.5 shipped a
//     corrupt-config death path; neither may come back.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AGY_ALLOW_RULES, applyAgyAllowRules, removeAgyAllowRules,
  CLAUDE_ALLOW_RULES,
  FOREIGN_SERVER,
  applyAllowRules,
  applyPrimerHook,
  hasPluginEnablement,
  hasPrimerHook,
  hasServerEntry,
  hasTermpolisAllowRule,
  hookCommand,
  isAdapterPath,
  isPrimerHookCommand,
  isTermpolisPluginManifest,
  isTermpolisServerEntry,
  localMarketplaceNames,
  primerHookCommand,
  removeAllowRules,
  removeInstalledPlugin,
  removeLegacyAllowRules,
  removeMarketplaceEntry,
  removePluginEnablement,
  removePrimerHooks,
  removeRootServerEntry,
  removeServerEntry,
  resolveNodeCommand,
  resolveNodeRunner,
  runnerMatches,
  termpolisServerEntry,
  toRunner,
  upsertClaudeUserServer,
  upsertServerEntry,
} from '../../src/main/agentMcpRegistry'
import { MCP_TOOLS_ASK, MCP_TOOLS_AUTO_ALLOWED } from '../../src/shared/agentIntegration'

// Nothing below touches the disk: file-existence probes are injected, and these directories
// are only ever used to build candidate paths.
const FAKE = join(tmpdir(), 'termpolis-registry-test-never-created')

const ADAPTER = '/opt/Termpolis/resources/mcp-adapter/stdio-adapter.cjs'
const WIN_ADAPTER = 'C:\\Program Files\\Termpolis\\resources\\mcp-adapter\\stdio-adapter.cjs'
const HOOK = '/opt/Termpolis/resources/mcp-adapter/memory-primer-hook.cjs'
// Windows-style absolute path (backslashes), used to prove the hook command is normalized to a
// cross-platform forward-slash form.
const WIN_HOOK = 'C:\\Users\\me\\AppData\\Roaming\\termpolis\\resources\\mcp-adapter\\memory-primer-hook.cjs'
const NODE = '/usr/local/bin/node'
const ELECTRON_RUNNER = { command: '/opt/Termpolis/termpolis', env: { ELECTRON_RUN_AS_NODE: '1' } }
const RULE = (tool: string): string => `mcp__termpolis__${tool}`

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function onPlatform(platform: NodeJS.Platform, fn: () => void): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { fn() } finally { Object.defineProperty(process, 'platform', realPlatform) }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

describe('agentMcpRegistry', () => {
  describe('interpreter rendering', () => {
    it('accepts a bare command string or a runner as it is', () => {
      expect(toRunner('node')).toEqual({ command: 'node' })
      expect(toRunner(ELECTRON_RUNNER)).toBe(ELECTRON_RUNNER)
    })

    it('leaves a bare node unquoted so the hook shell resolves it on PATH', () => {
      expect(hookCommand({ command: 'node' })).toBe('node')
    })

    it('quotes an absolute interpreter and normalizes its backslashes', () => {
      expect(hookCommand({ command: 'C:\\Program Files\\nodejs\\node.exe' })).toBe('"C:/Program Files/nodejs/node.exe"')
    })

    it('hands the interpreter its environment as K=V prefixes, in order', () => {
      expect(hookCommand({ command: '/opt/Termpolis/termpolis', env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings' } }))
        .toBe('ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--no-warnings "/opt/Termpolis/termpolis"')
    })
  })

  describe('runnerMatches', () => {
    it('rejects a missing entry or a different command', () => {
      expect(runnerMatches(undefined, { command: NODE })).toBe(false)
      expect(runnerMatches({ command: 'node' }, { command: NODE })).toBe(false)
    })

    it('matches a runner that needs no env when the entry has none, an empty one, or a non-table', () => {
      expect(runnerMatches({ command: NODE }, { command: NODE })).toBe(true)
      expect(runnerMatches({ command: NODE, env: {} }, { command: NODE })).toBe(true)
      expect(runnerMatches({ command: NODE, env: 'junk' }, { command: NODE })).toBe(true)
    })

    it('does not match a runner that needs no env when the entry still sets one', () => {
      expect(runnerMatches({ command: NODE, env: { ELECTRON_RUN_AS_NODE: '1' } }, { command: NODE })).toBe(false)
    })

    it('requires every variable the runner needs, and tolerates extra ones the user added', () => {
      const cmd = ELECTRON_RUNNER.command
      expect(runnerMatches({ command: cmd }, ELECTRON_RUNNER)).toBe(false)
      expect(runnerMatches({ command: cmd, env: { ELECTRON_RUN_AS_NODE: '0' } }, ELECTRON_RUNNER)).toBe(false)
      expect(runnerMatches({ command: cmd, env: { ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'http://proxy:8080' } }, ELECTRON_RUNNER)).toBe(true)
    })
  })

  describe('resolveNodeCommand (#4 node-PATH robustness)', () => {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const sep = process.platform === 'win32' ? ';' : ':'
    const backstop = process.platform === 'win32' ? 'C:\\Program Files\\nodejs' : '/usr/local/bin'
    const noExtraDirs = (): string[] => []

    it('returns the first node that actually exists on PATH', () => {
      const yesDir = join(FAKE, 'yes')
      const target = join(yesDir, exe)
      const env = { PATH: [join(FAKE, 'no'), yesDir].join(sep) } as NodeJS.ProcessEnv
      expect(resolveNodeCommand(env, (p) => p === target)).toBe(target)
    })

    it('checks well-known install dirs when PATH has nothing', () => {
      const target = join(backstop, exe)
      expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === target)).toBe(target)
    })

    it('falls back to bare "node" when nothing exists — never bakes a bad path', () => {
      expect(resolveNodeCommand({ PATH: join(FAKE, 'x') } as NodeJS.ProcessEnv, () => false)).toBe('node')
    })

    it('with no arguments, probes this process\u2019s PATH on the real disk and still never returns a missing file', () => {
      const found = resolveNodeCommand()
      expect(found === 'node' || existsSync(found)).toBe(true)
    })

    it('trims PATH entries and never probes an empty one', () => {
      const nodeDir = join(FAKE, 'trimmed')
      const target = join(nodeDir, exe)
      const probes: string[] = []
      const env = { PATH: `${sep}  ${nodeDir}  ${sep}${sep}` } as NodeJS.ProcessEnv
      expect(resolveNodeCommand(env, (p) => { probes.push(p); return p === target }, noExtraDirs)).toBe(target)
      expect(probes).toEqual([target])
    })

    it('reads the Windows-cased Path variable when PATH is absent', () => {
      const target = join(FAKE, 'path-cased', exe)
      expect(resolveNodeCommand({ Path: join(FAKE, 'path-cased') } as NodeJS.ProcessEnv, (p) => p === target, noExtraDirs)).toBe(target)
    })

    it('searches the version-manager dirs, after PATH', () => {
      const pathDir = join(FAKE, 'on-path')
      const nvmDir = join(FAKE, 'nvm', 'v22', 'bin')
      const both = new Set([join(pathDir, exe), join(nvmDir, exe)])
      expect(resolveNodeCommand({ PATH: pathDir } as NodeJS.ProcessEnv, (p) => both.has(p), () => [nvmDir])).toBe(join(pathDir, exe))
      expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === join(nvmDir, exe), () => [nvmDir])).toBe(join(nvmDir, exe))
    })

    it('keeps PATH and the well-known dirs when probing version managers throws', () => {
      const boom = (): string[] => { throw new Error('EACCES: version manager dir') }
      const onPath = join(FAKE, 'kept', exe)
      expect(resolveNodeCommand({ PATH: join(FAKE, 'kept') } as NodeJS.ProcessEnv, (p) => p === onPath, boom)).toBe(onPath)
      const wellKnown = join(backstop, exe)
      expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === wellKnown, boom)).toBe(wellKnown)
    })

    it('on Windows, splits PATH on ";", looks for node.exe, and tries %ProgramFiles% before the C: default', () => {
      onPlatform('win32', () => {
        const probes: string[] = []
        const env = { PATH: 'C:\\a;C:\\b', ProgramFiles: 'D:\\Apps' } as NodeJS.ProcessEnv
        expect(resolveNodeCommand(env, (p) => { probes.push(p); return false }, noExtraDirs)).toBe('node')
        expect(probes).toEqual([
          join('C:\\a', 'node.exe'),
          join('C:\\b', 'node.exe'),
          join('D:\\Apps', 'nodejs', 'node.exe'),
          join('C:\\Program Files\\nodejs', 'node.exe'),
        ])
        const custom = join('D:\\Apps', 'nodejs', 'node.exe')
        const standard = join('C:\\Program Files\\nodejs', 'node.exe')
        const both = (p: string): boolean => p === custom || p === standard
        expect(resolveNodeCommand({ PATH: '', ProgramFiles: 'D:\\Apps' } as NodeJS.ProcessEnv, both, noExtraDirs)).toBe(custom)
        expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, both, noExtraDirs)).toBe(standard)
      })
    })

    it('on Linux, splits PATH on ":", looks for node, backs up with the usual bin dirs, and ignores ProgramFiles', () => {
      onPlatform('linux', () => {
        const probes: string[] = []
        const env = { PATH: '/a:/b', ProgramFiles: 'C:\\Program Files' } as NodeJS.ProcessEnv
        expect(resolveNodeCommand(env, (p) => { probes.push(p); return false }, noExtraDirs)).toBe('node')
        expect(probes).toEqual(['/a', '/b', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin'].map((d) => join(d, 'node')))
      })
    })

    it('on macOS, finds a Homebrew node when PATH is stripped', () => {
      onPlatform('darwin', () => {
        const brew = join('/opt/homebrew/bin', 'node')
        expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === brew, noExtraDirs)).toBe(brew)
      })
    })
  })

  // The Linux bug report behind all of this: Codex on a .deb install showed
  //   MCP client for `termpolis` failed to start: No such file or directory
  // because the config said `command = "node"` and the app — launched from a
  // desktop file, and shipping Electron rather than Node — had no such binary
  // on its PATH to hand the agent.
  describe('resolveNodeRunner', () => {
    const ELECTRON = process.platform === 'win32' ? 'C:/apps/Termpolis/Termpolis.exe' : '/opt/Termpolis/termpolis'

    it('uses a real node when one exists, with no environment of its own', () => {
      const bin = process.platform === 'win32' ? 'node.exe' : 'node'
      const nodeDir = join(FAKE, 'nodedir')
      const runner = resolveNodeRunner({ PATH: nodeDir } as NodeJS.ProcessEnv, (p) => p === join(nodeDir, bin), ELECTRON)
      expect(runner).toEqual({ command: join(nodeDir, bin) })
    })

    it('falls back to Termpolis\u2019s own Electron in node mode when no node exists', () => {
      // Not a nicety: the .deb depends on GTK, not on nodejs, so "there is no
      // node anywhere" is the DEFAULT state of a fresh Linux install. The one
      // interpreter we can prove exists is the binary currently running.
      const runner = resolveNodeRunner({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === ELECTRON, ELECTRON)
      expect(runner).toEqual({ command: ELECTRON, env: { ELECTRON_RUN_AS_NODE: '1' } })
    })

    it('never writes a path that does not exist \u2014 bare node is the last resort', () => {
      // A non-existent absolute path fails exactly as loudly as bare `node`,
      // but is far harder for a user to diagnose. If we cannot prove a file is
      // there, we say `node` and let PATH have the last word.
      expect(resolveNodeRunner({ PATH: '' } as NodeJS.ProcessEnv, () => false, ELECTRON)).toEqual({ command: 'node' })
    })

    it('never probes or writes an empty Electron path', () => {
      const probes: string[] = []
      expect(resolveNodeRunner({ PATH: '' } as NodeJS.ProcessEnv, (p) => { probes.push(p); return p === '' }, '')).toEqual({ command: 'node' })
      expect(probes).not.toContain('')
    })

    it('with no arguments, resolves against the real disk and never returns a missing interpreter', () => {
      const runner = resolveNodeRunner()
      expect(runner.command === 'node' || existsSync(runner.command)).toBe(true)
    })
  })

  describe('recognising Termpolis entries by signature', () => {
    it('knows the stdio adapter on any platform, whatever the install folder or letter case', () => {
      expect(isAdapterPath(ADAPTER)).toBe(true)
      expect(isAdapterPath(WIN_ADAPTER)).toBe(true)
      expect(isAdapterPath('D:\\TERMPOLIS\\RESOURCES\\MCP-ADAPTER\\STDIO-ADAPTER.CJS')).toBe(true)
    })

    it('does not mistake another adapter, a backup copy, or a non-string for Termpolis\u2019s', () => {
      expect(isAdapterPath('/opt/other/stdio-adapter.cjs')).toBe(false)
      expect(isAdapterPath(`${ADAPTER}.bak`)).toBe(false)
      expect(isAdapterPath(undefined)).toBe(false)
      expect(isAdapterPath(42)).toBe(false)
    })

    it('identifies a server entry by its first argument', () => {
      expect(isTermpolisServerEntry({ command: 'node', args: [ADAPTER] })).toBe(true)
      expect(isTermpolisServerEntry({ command: 'node', args: ['--inspect', ADAPTER] })).toBe(false)
      expect(isTermpolisServerEntry({ command: 'npx', args: ['-y', 'termpolis-mcp'] })).toBe(false)
      expect(isTermpolisServerEntry({ command: 'node', args: ADAPTER })).toBe(false)
      expect(isTermpolisServerEntry([ADAPTER])).toBe(false)
      expect(isTermpolisServerEntry(null)).toBe(false)
    })

    it('identifies the memory primer hook by its script name', () => {
      expect(isPrimerHookCommand(`node "${HOOK}"`)).toBe(true)
      expect(isPrimerHookCommand('node ./my-own-session-hook.cjs')).toBe(false)
      expect(isPrimerHookCommand(undefined)).toBe(false)
    })
  })

  describe('MCP server entries', () => {
    const ENTRY = termpolisServerEntry(NODE, ADAPTER)

    it('builds an entry that runs the adapter with the resolved interpreter and no env', () => {
      expect(ENTRY).toEqual({ command: NODE, args: [ADAPTER] })
      expect('env' in ENTRY).toBe(false)
    })

    it('carries the Electron fallback environment as its own copy', () => {
      const entry = termpolisServerEntry(ELECTRON_RUNNER, ADAPTER)
      expect(entry).toEqual({ command: ELECTRON_RUNNER.command, args: [ADAPTER], env: { ELECTRON_RUN_AS_NODE: '1' } })
      expect(entry.env).not.toBe(ELECTRON_RUNNER.env)
    })

    it('adds the server to a config with none, keeping the servers and settings already there', () => {
      const root: any = { mcpServers: { github: { command: 'gh-mcp' } }, theme: 'dark' }
      expect(upsertServerEntry(root, ENTRY)).toBe('add')
      expect(root).toEqual({ mcpServers: { github: { command: 'gh-mcp' }, termpolis: { command: NODE, args: [ADAPTER] } }, theme: 'dark' })
    })

    it('creates mcpServers when the config has no such table', () => {
      const root: any = {}
      expect(upsertServerEntry(root, ENTRY)).toBe('add')
      expect(root).toEqual({ mcpServers: { termpolis: { command: NODE, args: [ADAPTER] } } })
    })

    it('is unchanged when the entry already says exactly what it would write', () => {
      const root: any = { mcpServers: { termpolis: { command: NODE, args: [ADAPTER], timeout: 30000 } } }
      const before = JSON.stringify(root)
      expect(upsertServerEntry(root, ENTRY)).toBe('unchanged')
      expect(JSON.stringify(root)).toBe(before)
    })

    it('updates a stale interpreter and adapter path, keeping keys the user added', () => {
      const root: any = { mcpServers: { termpolis: {
        command: 'node', args: ['C:/old/mcp-adapter/stdio-adapter.cjs', '--stale'], timeout: 30000, disabled: false, env: { HTTPS_PROXY: 'http://proxy' },
      } } }
      expect(upsertServerEntry(root, ENTRY)).toBe('update')
      expect(root.mcpServers.termpolis).toEqual({ command: NODE, args: [ADAPTER], timeout: 30000, disabled: false, env: { HTTPS_PROXY: 'http://proxy' } })
    })

    it('merges the fallback environment into the user\u2019s own variables', () => {
      const root: any = { mcpServers: { termpolis: { command: 'node', args: [ADAPTER], env: { HTTPS_PROXY: 'http://proxy' } } } }
      expect(upsertServerEntry(root, termpolisServerEntry(ELECTRON_RUNNER, ADAPTER))).toBe('update')
      expect(root.mcpServers.termpolis.env).toEqual({ HTTPS_PROXY: 'http://proxy', ELECTRON_RUN_AS_NODE: '1' })
    })

    it('repairs an entry that has the right command but lost its env, or holds a non-table env', () => {
      const lost: any = { mcpServers: { termpolis: { command: ELECTRON_RUNNER.command, args: [ADAPTER] } } }
      expect(upsertServerEntry(lost, termpolisServerEntry(ELECTRON_RUNNER, ADAPTER))).toBe('update')
      expect(lost.mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
      const junk: any = { mcpServers: { termpolis: { command: ELECTRON_RUNNER.command, args: [ADAPTER], env: 'garbage' } } }
      expect(upsertServerEntry(junk, termpolisServerEntry(ELECTRON_RUNNER, ADAPTER))).toBe('update')
      expect(junk.mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    })

    it('drops the stale Electron env once a real node is found, but never the user\u2019s own env', () => {
      const stale: any = { mcpServers: { termpolis: { command: ELECTRON_RUNNER.command, args: [ADAPTER], env: { ELECTRON_RUN_AS_NODE: '1' } } } }
      expect(upsertServerEntry(stale, ENTRY)).toBe('update')
      expect(stale.mcpServers.termpolis).toEqual({ command: NODE, args: [ADAPTER] })

      const mixed: any = { mcpServers: { termpolis: { command: ELECTRON_RUNNER.command, args: [ADAPTER], env: { ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'x' } } } }
      expect(upsertServerEntry(mixed, ENTRY)).toBe('update')
      expect(mixed.mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'x' })

      const own: any = { mcpServers: { termpolis: { command: 'node', args: [ADAPTER], env: { NODE_ENV: 'production' } } } }
      expect(upsertServerEntry(own, ENTRY)).toBe('update')
      expect(own.mcpServers.termpolis.env).toEqual({ NODE_ENV: 'production' })
    })

    it('leaves a `termpolis` server the user configured themselves exactly as it is', () => {
      const root: any = { mcpServers: { termpolis: { command: 'npx', args: ['-y', 'my-termpolis-fork'] } } }
      const before = clone(root)
      expect(upsertServerEntry(root, ENTRY)).toEqual({ skipped: FOREIGN_SERVER })
      expect(root).toEqual(before)
      expect(upsertServerEntry({ mcpServers: { termpolis: 'x' } }, ENTRY)).toEqual({ skipped: FOREIGN_SERVER })
    })

    it('skips, rather than overwrites, an mcpServers that is not an object', () => {
      for (const odd of ['oops', [], null]) {
        const root: any = { mcpServers: odd }
        expect(upsertServerEntry(root, ENTRY)).toEqual({ skipped: '`mcpServers` is not an object' })
        expect(root).toEqual({ mcpServers: odd })
      }
    })

    it('writes Claude Code\u2019s user-scope server with type stdio, as `claude mcp add -s user` does', () => {
      const root: any = {}
      expect(upsertClaudeUserServer(root, ENTRY)).toBe('add')
      expect(root.mcpServers.termpolis).toEqual({ type: 'stdio', command: NODE, args: [ADAPTER] })
      expect(upsertClaudeUserServer(root, ENTRY)).toBe('unchanged')
      const untyped: any = { mcpServers: { termpolis: { command: NODE, args: [ADAPTER] } } }
      expect(upsertClaudeUserServer(untyped, ENTRY)).toBe('update')
      expect(untyped.mcpServers.termpolis.type).toBe('stdio')
    })

    it('removes only Termpolis\u2019s server, and mcpServers once it is empty', () => {
      const shared: any = { mcpServers: { termpolis: { command: 'node', args: [WIN_ADAPTER] }, github: { command: 'gh-mcp' } } }
      expect(removeServerEntry(shared)).toBe('remove')
      expect(shared).toEqual({ mcpServers: { github: { command: 'gh-mcp' } } })
      const alone: any = { mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } }, theme: 'dark' }
      expect(removeServerEntry(alone)).toBe('remove')
      expect(alone).toEqual({ theme: 'dark' })
    })

    it('does not remove a foreign `termpolis` server, or anything from an odd shape', () => {
      const foreign: any = { mcpServers: { termpolis: { command: 'npx', args: ['termpolis'] } } }
      expect(removeServerEntry(foreign)).toBe('unchanged')
      expect(foreign.mcpServers.termpolis).toEqual({ command: 'npx', args: ['termpolis'] })
      expect(removeServerEntry({})).toBe('unchanged')
      expect(removeServerEntry({ mcpServers: 'x' })).toBe('unchanged')
    })

    it('removes the top-level entry the first ~/.mcp.json writer left, and only that', () => {
      const root: any = { termpolis: { command: 'node', args: [ADAPTER] }, mcpServers: { github: { command: 'gh-mcp' } } }
      expect(removeRootServerEntry(root)).toBe('remove')
      expect(root).toEqual({ mcpServers: { github: { command: 'gh-mcp' } } })
      const foreign: any = { termpolis: { command: 'my-tool' } }
      expect(removeRootServerEntry(foreign)).toBe('unchanged')
      expect(foreign).toEqual({ termpolis: { command: 'my-tool' } })
    })

    it('reports whether Termpolis\u2019s server is configured', () => {
      expect(hasServerEntry({ mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } } })).toBe(true)
      expect(hasServerEntry({ mcpServers: { termpolis: { command: 'npx', args: ['termpolis'] } } })).toBe(false)
      expect(hasServerEntry({ mcpServers: [] })).toBe(false)
      expect(hasServerEntry({})).toBe(false)
    })
  })

  describe('Claude tool permissions', () => {
    const FIRST_VERSION = [
      'list_terminals', 'create_terminal', 'run_command', 'read_output', 'close_terminal',
      'write_to_terminal', 'get_file_tree', 'get_git_status', 'swarm_send_message',
      'swarm_read_messages', 'swarm_create_task', 'swarm_list_tasks', 'swarm_update_task',
      'swarm_list_agents',
    ].map(RULE)

    it('pre-approves exactly the safe tool list: never the wildcard, never a tool that can run commands', () => {
      expect(CLAUDE_ALLOW_RULES).toEqual(MCP_TOOLS_AUTO_ALLOWED.map(RULE))
      expect(CLAUDE_ALLOW_RULES).not.toContain('mcp__termpolis__*')
      for (const tool of [...MCP_TOOLS_ASK, 'run_command', 'run_and_wait', 'write_to_terminal', 'create_terminal', 'close_terminal', 'gateway_call']) {
        expect(CLAUDE_ALLOW_RULES).not.toContain(RULE(tool))
      }
    })

    it('adds the explicit list to a settings file with no permissions', () => {
      const root: any = { model: 'opus' }
      expect(applyAllowRules(root)).toBe('add')
      expect(root).toEqual({ model: 'opus', permissions: { allow: [...CLAUDE_ALLOW_RULES] } })
    })

    it('adds the list beside deny rules when there is no allow list yet', () => {
      const root: any = { permissions: { deny: ['Read(./.env)'] } }
      expect(applyAllowRules(root)).toBe('add')
      expect(root.permissions).toEqual({ deny: ['Read(./.env)'], allow: [...CLAUDE_ALLOW_RULES] })
    })

    it('appends only the missing rules, after the user\u2019s own', () => {
      const root: any = { permissions: { allow: ['Bash(git status)', RULE('memory_search')], deny: ['Read(./.env)'] } }
      expect(applyAllowRules(root)).toBe('update')
      expect(root.permissions.deny).toEqual(['Read(./.env)'])
      expect(root.permissions.allow).toEqual(['Bash(git status)', RULE('memory_search'), ...CLAUDE_ALLOW_RULES.filter((r) => r !== RULE('memory_search'))])
    })

    it('is unchanged once every rule is present', () => {
      const root: any = { permissions: { allow: ['Bash(ls)', ...CLAUDE_ALLOW_RULES] } }
      const before = JSON.stringify(root)
      expect(applyAllowRules(root)).toBe('unchanged')
      expect(JSON.stringify(root)).toBe(before)
    })

    it('skips, rather than replaces, permissions or an allow list of the wrong type', () => {
      const cases: Array<[any, string]> = [
        [{ permissions: 'all' }, '`permissions` is not an object'],
        [{ permissions: ['x'] }, '`permissions` is not an object'],
        [{ permissions: { allow: { x: 1 } } }, '`permissions.allow` is not an array'],
        [{ permissions: { allow: 'mcp__termpolis__*' } }, '`permissions.allow` is not an array'],
      ]
      for (const [root, message] of cases) {
        const before = JSON.stringify(root)
        expect(applyAllowRules(root)).toEqual({ skipped: message })
        expect(JSON.stringify(root)).toBe(before)
      }
    })

    it('upgrades a settings file from the old wildcard to the explicit list', () => {
      // Replaces the v1.48 expectation that the wildcard was ADDED: it covered run_command.
      const root: any = { permissions: { allow: ['Bash(git diff:*)', 'mcp__termpolis__*'] } }
      expect(removeLegacyAllowRules(root)).toBe('remove')
      expect(applyAllowRules(root)).toBe('add')
      expect(root.permissions.allow).toEqual(['Bash(git diff:*)', ...CLAUDE_ALLOW_RULES])
      expect(root.permissions.allow).not.toContain('mcp__termpolis__*')
    })

    it('migrates the wildcard and the old (*) matchers, and nothing the user wrote', () => {
      const root: any = { permissions: { allow: [
        'Bash(npm test)', 'mcp__termpolis__*', 'mcp__termpolis__run_command(*)', RULE('memory_search'),
        'mcp__github__*', 'mcp__other__tool(*)', 42,
      ] } }
      expect(removeLegacyAllowRules(root)).toBe('remove')
      expect(root.permissions.allow).toEqual(['Bash(npm test)', RULE('memory_search'), 'mcp__github__*', 'mcp__other__tool(*)', 42])
    })

    it('migrates the first version\u2019s complete 14-rule list, keeping the rules still on the safe list', () => {
      const root: any = { permissions: { allow: ['Bash(ls)', ...FIRST_VERSION] } }
      expect(removeLegacyAllowRules(root)).toBe('remove')
      expect(root.permissions.allow).toEqual(['Bash(ls)', ...['list_terminals', 'get_git_status', 'swarm_read_messages', 'swarm_list_tasks', 'swarm_list_agents'].map(RULE)])
    })

    it('leaves a partial copy of that list alone: a rule or two may be the user\u2019s own choice', () => {
      const root: any = { permissions: { allow: FIRST_VERSION.slice(1) } }
      expect(removeLegacyAllowRules(root)).toBe('unchanged')
      expect(root.permissions.allow).toEqual(FIRST_VERSION.slice(1))
    })

    it('deletes an allow list, and a permissions object, that the migration leaves empty', () => {
      const bare: any = { permissions: { allow: ['mcp__termpolis__*'] }, model: 'x' }
      expect(removeLegacyAllowRules(bare)).toBe('remove')
      expect(bare).toEqual({ model: 'x' })
      const withDeny: any = { permissions: { allow: ['mcp__termpolis__*'], deny: ['Bash(rm:*)'] } }
      expect(removeLegacyAllowRules(withDeny)).toBe('remove')
      expect(withDeny).toEqual({ permissions: { deny: ['Bash(rm:*)'] } })
    })

    it('has nothing to migrate without permissions, and skips odd shapes', () => {
      expect(removeLegacyAllowRules({})).toBe('unchanged')
      expect(removeLegacyAllowRules({ permissions: {} })).toBe('unchanged')
      expect(removeLegacyAllowRules({ permissions: 'x' })).toEqual({ skipped: '`permissions` is not an object' })
    })

    it('on disconnect removes the safe list and every legacy rule, and keeps the user\u2019s', () => {
      const root: any = { permissions: { allow: ['Bash(ls)', ...CLAUDE_ALLOW_RULES, 'mcp__termpolis__*', RULE('run_command')] } }
      expect(removeAllowRules(root)).toBe('remove')
      // A lone run_command rule is not recognisably Termpolis's, so it stays.
      expect(root.permissions.allow).toEqual(['Bash(ls)', RULE('run_command')])
    })

    it('removal is unchanged when none of its rules are present, and skips odd shapes', () => {
      expect(removeAllowRules({ permissions: { allow: ['Bash(ls)'] } })).toBe('unchanged')
      expect(removeAllowRules({})).toBe('unchanged')
      expect(removeAllowRules({ permissions: { allow: 7 } })).toEqual({ skipped: '`permissions.allow` is not an array' })
    })

    it('reports any Termpolis rule, legacy or current', () => {
      expect(hasTermpolisAllowRule({ permissions: { allow: ['mcp__termpolis__*'] } })).toBe(true)
      expect(hasTermpolisAllowRule({ permissions: { allow: [RULE('memory_search')] } })).toBe(true)
      expect(hasTermpolisAllowRule({ permissions: { allow: ['mcp__github__*', 3] } })).toBe(false)
      expect(hasTermpolisAllowRule({})).toBe(false)
      expect(hasTermpolisAllowRule({ permissions: 'x' })).toBe(false)
    })
  })

  describe('SessionStart memory primer hook', () => {
    const CMD = primerHookCommand(NODE, HOOK)
    const group = (command: string, extra: Record<string, unknown> = {}): any => ({ hooks: [{ type: 'command', command, ...extra }] })

    it('renders the hook with its interpreter and a quoted, forward-slash script path', () => {
      expect(CMD).toBe(`"${NODE}" "${HOOK}"`)
      expect(primerHookCommand('node', WIN_HOOK)).toBe('node "C:/Users/me/AppData/Roaming/termpolis/resources/mcp-adapter/memory-primer-hook.cjs"')
      expect(primerHookCommand({ command: 'C:\\Users\\me\\AppData\\Local\\Programs\\termpolis\\Termpolis.exe', env: { ELECTRON_RUN_AS_NODE: '1' } }, WIN_HOOK))
        .toBe('ELECTRON_RUN_AS_NODE=1 "C:/Users/me/AppData/Local/Programs/termpolis/Termpolis.exe" "C:/Users/me/AppData/Roaming/termpolis/resources/mcp-adapter/memory-primer-hook.cjs"')
    })

    it('adds the hook to a settings file with no hooks', () => {
      const root: any = { model: 'x' }
      expect(applyPrimerHook(root, CMD)).toBe('add')
      expect(root).toEqual({ model: 'x', hooks: { SessionStart: [group(CMD)] } })
    })

    it('adds SessionStart beside the other events already there', () => {
      const stop = [group('notify-send done')]
      const root: any = { hooks: { Stop: stop } }
      expect(applyPrimerHook(root, CMD)).toBe('add')
      expect(root.hooks).toEqual({ Stop: stop, SessionStart: [group(CMD)] })
    })

    it('adds its own group after the user\u2019s SessionStart hooks, including groups it cannot read', () => {
      const user = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }
      const odd = [null, 'echo', { hooks: 'x' }, { hooks: [null, 'str', { command: 'echo' }] }]
      const root: any = { hooks: { SessionStart: [user, ...odd] } }
      expect(applyPrimerHook(root, CMD)).toBe('add')
      expect(root.hooks.SessionStart).toEqual([user, ...odd, group(CMD)])
    })

    it('is idempotent: a second call finds its hook and changes nothing', () => {
      const root: any = {}
      applyPrimerHook(root, CMD)
      const once = JSON.stringify(root)
      expect(applyPrimerHook(root, CMD)).toBe('unchanged')
      expect(JSON.stringify(root)).toBe(once)
    })

    it('points an existing hook at the new interpreter or script in place, keeping its other keys', () => {
      const root: any = { hooks: { SessionStart: [{ matcher: '*', hooks: [
        { type: 'command', command: 'echo hi' },
        { type: 'command', command: 'node "/old/memory-primer-hook.cjs"', timeout: 10 },
      ] }] } }
      expect(applyPrimerHook(root, CMD)).toBe('update')
      expect(root.hooks.SessionStart).toEqual([{ matcher: '*', hooks: [
        { type: 'command', command: 'echo hi' },
        { type: 'command', command: CMD, timeout: 10 },
      ] }])
    })

    it('updates a flat group whose command is the hook itself', () => {
      const root: any = { hooks: { SessionStart: [{ type: 'command', command: 'node "/old/memory-primer-hook.cjs"' }] } }
      expect(applyPrimerHook(root, CMD)).toBe('update')
      expect(root.hooks.SessionStart).toEqual([{ type: 'command', command: CMD }])
    })

    it('collapses duplicates to exactly one hook, pruning groups that empty', () => {
      const root: any = { hooks: { SessionStart: [
        group(CMD),
        { hooks: [{ type: 'command', command: 'echo keep' }, { type: 'command', command: 'node "/older/memory-primer-hook.cjs"' }] },
        { type: 'command', command: 'node "/oldest/memory-primer-hook.cjs"' },
        group('node "/x/memory-primer-hook.cjs"'),
      ] } }
      expect(applyPrimerHook(root, CMD)).toBe('update')
      expect(root.hooks.SessionStart).toEqual([group(CMD), group('echo keep')])
    })

    it('skips, rather than repairs, a hooks value of the wrong type', () => {
      // Earlier versions replaced a wrong-typed `hooks` or `SessionStart` with their own.
      // Now the user's file is left exactly as it is and the edit is reported as skipped.
      const cases: Array<[any, string]> = [
        [{ hooks: 'garbage' }, '`hooks` is not an object'],
        [{ hooks: ['x'] }, '`hooks` is not an object'],
        [{ hooks: { SessionStart: 'oops', PreToolUse: [group('keep-me')] } }, '`hooks.SessionStart` is not an array'],
      ]
      for (const [root, message] of cases) {
        const before = JSON.stringify(root)
        expect(applyPrimerHook(root, CMD)).toEqual({ skipped: message })
        expect(removePrimerHooks(root)).toEqual({ skipped: message })
        expect(JSON.stringify(root)).toBe(before)
      }
    })

    it('removes every primer hook on disconnect and prunes what that leaves empty', () => {
      const root: any = { hooks: { SessionStart: [group(CMD)] }, model: 'x' }
      expect(removePrimerHooks(root)).toBe('remove')
      expect(root).toEqual({ model: 'x' })
    })

    it('keeps the user\u2019s hooks and other events when removing', () => {
      const stop = [group('notify-send done')]
      const root: any = { hooks: { SessionStart: [
        { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: CMD }] },
        { type: 'command', command: CMD },
      ], Stop: stop } }
      expect(removePrimerHooks(root)).toBe('remove')
      expect(root.hooks).toEqual({ SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: stop })
    })

    it('drops an emptied SessionStart but keeps the hooks object for other events', () => {
      const stop = [group('notify-send done')]
      const root: any = { hooks: { SessionStart: [group(CMD)], Stop: stop } }
      expect(removePrimerHooks(root)).toBe('remove')
      expect(root.hooks).toEqual({ Stop: stop })
    })

    it('removal is unchanged when there is no primer hook', () => {
      expect(removePrimerHooks({})).toBe('unchanged')
      expect(removePrimerHooks({ hooks: { Stop: [] } })).toBe('unchanged')
      const mine: any = { hooks: { SessionStart: [group('echo hi')] } }
      expect(removePrimerHooks(mine)).toBe('unchanged')
      expect(mine).toEqual({ hooks: { SessionStart: [group('echo hi')] } })
    })

    it('reports whether a primer hook is installed, in either shape', () => {
      expect(hasPrimerHook({ hooks: { SessionStart: [group(CMD)] } })).toBe(true)
      expect(hasPrimerHook({ hooks: { SessionStart: [{ type: 'command', command: CMD }] } })).toBe(true)
      expect(hasPrimerHook({ hooks: { SessionStart: [group('echo hi')] } })).toBe(false)
      expect(hasPrimerHook({})).toBe(false)
      expect(hasPrimerHook({ hooks: 5 })).toBe(false)
    })
  })

  // Earlier versions installed a local Claude Code plugin. Nothing installs it now; these
  // helpers only find and remove what those versions left, by Termpolis's own signatures.
  describe('the local plugin earlier versions installed', () => {
    it('always checks local-plugins, plus any marketplace sourced from the local-marketplace folder', () => {
      const settings = { extraKnownMarketplaces: {
        mine: { source: { source: 'directory', path: 'C:\\Users\\me\\AppData\\Roaming\\termpolis\\local-marketplace' } },
        github: { source: { source: 'github', repo: 'org/plugins' } },
        broken: 'x',
        stringSource: { source: 'local-marketplace' },
      } }
      const known = {
        'tp-local': { source: { source: 'directory', path: '/home/me/.config/termpolis/local-marketplace/' } },
        elsewhere: { source: { source: 'directory', path: '/srv/marketplace' } },
      }
      expect(localMarketplaceNames(settings, known).sort()).toEqual(['local-plugins', 'mine', 'tp-local'])
    })

    it('falls back to local-plugins alone when neither table is usable', () => {
      expect(localMarketplaceNames(null, null)).toEqual(['local-plugins'])
      expect(localMarketplaceNames({ extraKnownMarketplaces: ['x'] }, 'nope' as any)).toEqual(['local-plugins'])
    })

    it('removes only termpolis@<those marketplaces> enablement, and enabledPlugins once empty', () => {
      const root: any = { enabledPlugins: { 'termpolis@local-plugins': true, 'termpolis@mine': false, 'superpowers@claude-plugins': true } }
      expect(removePluginEnablement(root, ['local-plugins', 'mine'])).toBe('remove')
      expect(root.enabledPlugins).toEqual({ 'superpowers@claude-plugins': true })
      const only: any = { enabledPlugins: { 'termpolis@local-plugins': true }, model: 'x' }
      expect(removePluginEnablement(only, ['local-plugins'])).toBe('remove')
      expect(only).toEqual({ model: 'x' })
    })

    it('leaves a termpolis plugin from any other marketplace alone', () => {
      const root: any = { enabledPlugins: { 'termpolis@community': true } }
      expect(removePluginEnablement(root, ['local-plugins'])).toBe('unchanged')
      expect(root.enabledPlugins).toEqual({ 'termpolis@community': true })
      expect(removePluginEnablement({}, ['local-plugins'])).toBe('unchanged')
      expect(removePluginEnablement({ enabledPlugins: ['termpolis@local-plugins'] }, ['local-plugins'])).toBe('unchanged')
    })

    it('reports an enablement entry under any of the given marketplaces', () => {
      expect(hasPluginEnablement({ enabledPlugins: { 'termpolis@mine': false } }, ['local-plugins', 'mine'])).toBe(true)
      expect(hasPluginEnablement({ enabledPlugins: { 'termpolis@community': true } }, ['local-plugins'])).toBe(false)
      expect(hasPluginEnablement({}, ['local-plugins'])).toBe(false)
    })

    it('drops the installed_plugins record for those marketplaces only', () => {
      const root: any = { version: 2, plugins: { 'termpolis@local-plugins': [{ scope: 'user' }], 'other@x': [] } }
      expect(removeInstalledPlugin(root, ['local-plugins'])).toBe('remove')
      expect(root).toEqual({ version: 2, plugins: { 'other@x': [] } })
      expect(removeInstalledPlugin(root, ['local-plugins'])).toBe('unchanged')
      expect(removeInstalledPlugin({ plugins: [] }, ['local-plugins'])).toBe('unchanged')
    })

    it('removes the marketplace entry that points at the plugin folder, in either slash style', () => {
      const root: any = { name: 'local-plugins', plugins: [
        { name: 'termpolis', source: './plugins/termpolis' },
        { name: 'termpolis', source: '.\\plugins\\termpolis\\' },
        { name: 'termpolis', source: 'https://github.com/someone/termpolis' },
        { name: 'other', source: './plugins/other' },
        { name: 'termpolis', source: { source: 'github', repo: 'x/termpolis' } },
        'junk',
      ] }
      expect(removeMarketplaceEntry(root)).toBe('remove')
      expect(root.plugins).toEqual([
        { name: 'termpolis', source: 'https://github.com/someone/termpolis' },
        { name: 'other', source: './plugins/other' },
        { name: 'termpolis', source: { source: 'github', repo: 'x/termpolis' } },
        'junk',
      ])
      expect(removeMarketplaceEntry(root)).toBe('unchanged')
      expect(removeMarketplaceEntry({ plugins: {} })).toBe('unchanged')
    })

    it('recognises the plugin folder by its Termpolis manifest or its adapter server, not by name alone', () => {
      expect(isTermpolisPluginManifest({ name: 'termpolis', author: { name: 'Termpolis' } }, null)).toBe(true)
      expect(isTermpolisPluginManifest(null, { mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } } })).toBe(true)
      expect(isTermpolisPluginManifest({ name: 'termpolis', author: 'Termpolis' }, null)).toBe(false)
      expect(isTermpolisPluginManifest({ name: 'termpolis', author: { name: 'Someone Else' } }, { mcpServers: {} })).toBe(false)
      expect(isTermpolisPluginManifest({ name: 'other', author: { name: 'Termpolis' } }, null)).toBe(false)
      expect(isTermpolisPluginManifest(null, null)).toBe(false)
    })
  })

  describe('malformed configs', () => {
    const ENTRY = termpolisServerEntry(NODE, ADAPTER)
    const CMD = primerHookCommand(NODE, HOOK)
    const transforms: Array<[string, (root: any) => unknown]> = [
      ['upsertServerEntry', (r) => upsertServerEntry(r, ENTRY)],
      ['upsertClaudeUserServer', (r) => upsertClaudeUserServer(r, ENTRY)],
      ['removeServerEntry', removeServerEntry],
      ['removeRootServerEntry', removeRootServerEntry],
      ['removeLegacyAllowRules', removeLegacyAllowRules],
      ['applyAllowRules', applyAllowRules],
      ['removeAllowRules', removeAllowRules],
      ['applyPrimerHook', (r) => applyPrimerHook(r, CMD)],
      ['removePrimerHooks', removePrimerHooks],
      ['removePluginEnablement', (r) => removePluginEnablement(r, ['local-plugins'])],
      ['removeInstalledPlugin', (r) => removeInstalledPlugin(r, ['local-plugins'])],
      ['removeMarketplaceEntry', removeMarketplaceEntry],
    ]
    const junk: unknown[] = [null, 0, 'garbage', true, ['x'], { termpolis: 'x' }]
    const roots = (): any[] => junk.flatMap((v) => [
      { mcpServers: v }, { termpolis: v }, { permissions: v }, { permissions: { allow: v } },
      { hooks: v }, { hooks: { SessionStart: v } }, { hooks: { SessionStart: [v] } },
      { enabledPlugins: v }, { plugins: v },
    ])

    it('never throws, and never changes a config it reports as skipped or unchanged', () => {
      // The manager writes a file only when an edit says it changed something, so a
      // "skipped" or "unchanged" that still mutated the object would be silently lost or,
      // worse, written by the next edit that did change something.
      for (const [name, fn] of transforms) {
        for (const root of roots()) {
          const before = JSON.stringify(root)
          let result: unknown
          expect(() => { result = fn(root) }, `${name} on ${before}`).not.toThrow()
          if (result === 'unchanged' || (typeof result === 'object' && result !== null && 'skipped' in result)) {
            expect(JSON.stringify(root), `${name} on ${before}`).toBe(before)
          } else {
            expect(['add', 'update', 'remove'], `${name} on ${before}`).toContain(result)
          }
        }
      }
    })
  })
})

describe('Antigravity CLI tool permissions', () => {
  it('appends the safe list to a missing permissions block', () => {
    const root: Record<string, any> = {}
    expect(applyAgyAllowRules(root)).toBe('add')
    expect(root.permissions.allow).toEqual([...AGY_ALLOW_RULES])
  })

  it('refuses a permissions block or allow list of the wrong shape, on apply and on remove', () => {
    expect(applyAgyAllowRules({ permissions: [] })).toEqual({ skipped: '`permissions` is not an object' })
    expect(applyAgyAllowRules({ permissions: { allow: 'x' } })).toEqual({ skipped: '`permissions.allow` is not an array' })
    expect(removeAgyAllowRules({ permissions: [] })).toEqual({ skipped: '`permissions` is not an object' })
    expect(removeAgyAllowRules({ permissions: { allow: 'x' } })).toEqual({ skipped: '`permissions.allow` is not an array' })
  })

  it('has nothing to remove when no permissions block exists or none of its rules are ours', () => {
    expect(removeAgyAllowRules({})).toBe('unchanged')
    expect(removeAgyAllowRules({ permissions: {} })).toBe('unchanged')
    const root = { permissions: { allow: ['mcp(termpolis/*)', 'command(git status)'] } }
    expect(removeAgyAllowRules(root)).toBe('unchanged')
    expect(root.permissions.allow).toEqual(['mcp(termpolis/*)', 'command(git status)'])
  })

  it('removes exactly the safe list and keeps the rest of the block', () => {
    const root: Record<string, any> = { permissions: { allow: [AGY_ALLOW_RULES[1], 'mcp(fs/read)'], deny: ['command(rm)'] } }
    expect(removeAgyAllowRules(root)).toBe('remove')
    expect(root).toEqual({ permissions: { allow: ['mcp(fs/read)'], deny: ['command(rm)'] } })
  })
})
