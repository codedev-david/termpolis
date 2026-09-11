// Unit tests for agentMcpRegistry — proves that the four auto-register
// paths (Claude settings.json, ~/.mcp.json, Codex TOML, Gemini settings)
// survive corrupt, empty, truncated, and missing config files without
// throwing. Regression guard: v1.11.5 shipped with a corrupt-config
// death path that silently broke MCP for users who had hand-edited files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  registerInClaudeSettings,
  registerInGlobalMcp,
  registerInCodex,
  registerInGemini,
  resolveNodeCommand,
  resolveNodeRunner,
} from '../../src/main/agentMcpRegistry'

const ADAPTER = '/path/to/stdio-adapter.cjs'
const HOOK = '/path/to/mcp-adapter/memory-primer-hook.cjs'
// Windows-style absolute path (backslashes) — used to prove the registered
// command is normalized to a cross-platform forward-slash `node "..."` form.
const WIN_HOOK = 'C:\\Users\\me\\AppData\\Roaming\\termpolis\\resources\\mcp-adapter\\memory-primer-hook.cjs'

describe('agentMcpRegistry', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-registry-'))
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  describe('registerInClaudeSettings', () => {
    it('returns skipped=missing when file absent', () => {
      const r = registerInClaudeSettings(join(dir, 'nope.json'), ADAPTER)
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('missing')
    })

    it('returns skipped=corrupt on malformed JSON', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{"mcpServers": {not json')
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('corrupt')
      expect(r.error).toBeTruthy()
    })

    it('returns skipped=corrupt on empty file', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '')
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.skipped).toBe('corrupt')
    })

    it('returns skipped=corrupt on truncated JSON mid-key', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{"permissions": {"allow": ["mcp__oth')
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.skipped).toBe('corrupt')
    })

    it('registers into an empty {} settings file', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
      expect(v.permissions.allow).toContain('mcp__termpolis__*')
    })

    it('is a no-op when already fully registered', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
        permissions: { allow: ['mcp__termpolis__*'] },
      }))
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('already-registered')
    })

    it('purges legacy (*) matchers and adds wildcard', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
        permissions: { allow: ['mcp__termpolis__list_terminals(*)', 'mcp__other__*'] },
      }))
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.permissions.allow).not.toContain('mcp__termpolis__list_terminals(*)')
      expect(v.permissions.allow).toContain('mcp__termpolis__*')
      expect(v.permissions.allow).toContain('mcp__other__*') // unrelated entries preserved
    })

    it('updates adapter path if it changed', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: ['/old/adapter.cjs'] } },
        permissions: { allow: ['mcp__termpolis__*'] },
      }))
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('recovers when mcpServers is wrong type (string instead of object)', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({ mcpServers: 'garbage' }))
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('recovers when permissions.allow is wrong type (object instead of array)', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
        permissions: { allow: { not: 'array' } },
      }))
      const r = registerInClaudeSettings(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(Array.isArray(v.permissions.allow)).toBe(true)
      expect(v.permissions.allow).toContain('mcp__termpolis__*')
    })

    // 3-arg form: also register the portable SessionStart memory-primer hook
    // so every Termpolis install gets deterministic memory recall.
    describe('memory-primer hook (3-arg form)', () => {
      const primerCommands = (v: any): string[] =>
        (v?.hooks?.SessionStart ?? []).flatMap((g: any) =>
          Array.isArray(g?.hooks) ? g.hooks.map((h: any) => h?.command) : [])

      it('registers a SessionStart memory hook into an empty {} settings file', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, '{}')
        const r = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        // MCP + permissions still registered alongside the hook.
        expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
        expect(v.permissions.allow).toContain('mcp__termpolis__*')
        // SessionStart hook present, command references the primer script.
        expect(Array.isArray(v.hooks.SessionStart)).toBe(true)
        const cmds = primerCommands(v)
        expect(cmds.some((c) => typeof c === 'string' && c.includes('memory-primer-hook'))).toBe(true)
        expect(cmds.some((c) => typeof c === 'string' && c.includes(HOOK))).toBe(true)
        // Cross-platform shape: `node "<path>"`, no platform-specific shell.
        const cmd = cmds.find((c) => typeof c === 'string' && c.includes('memory-primer-hook')) as string
        expect(cmd.startsWith('node ')).toBe(true)
        expect(cmd.toLowerCase()).not.toContain('bash')
        expect(cmd).not.toContain('.sh')
        // The hook ships as a Node .cjs script.
        expect(cmd).toContain('memory-primer-hook.cjs')
      })

      it('normalizes a Windows backslash path to a cross-platform forward-slash command', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, '{}')
        const r = registerInClaudeSettings(p, ADAPTER, WIN_HOOK)
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        const cmd = primerCommands(v).find((c) => typeof c === 'string' && c.includes('memory-primer-hook')) as string
        expect(cmd).toBeTruthy()
        // (a) references the primer script; (b) invoked via node; (c) no shell.
        expect(cmd).toContain('memory-primer-hook')
        expect(cmd.startsWith('node ')).toBe(true)
        expect(cmd.toLowerCase()).not.toContain('bash')
        expect(cmd).not.toContain('.sh')
        // Backslashes normalized away → node accepts forward slashes on Windows.
        expect(cmd).not.toContain('\\')
        expect(cmd).toContain('C:/Users/me/')
        // Idempotent even when re-called with the raw backslash path.
        const r2 = registerInClaudeSettings(p, ADAPTER, WIN_HOOK)
        expect(r2.changed).toBe(false)
        expect(r2.skipped).toBe('already-registered')
        const v2 = JSON.parse(readFileSync(p, 'utf-8'))
        const matches = primerCommands(v2).filter((c) => typeof c === 'string' && c.includes('memory-primer-hook'))
        expect(matches.length).toBe(1)
      })

      it('is idempotent — second call does not duplicate the memory hook', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, '{}')
        const r1 = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r1.changed).toBe(true)
        const r2 = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r2.changed).toBe(false)
        expect(r2.skipped).toBe('already-registered')
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        const matches = primerCommands(v).filter((c) => typeof c === 'string' && c.includes('memory-primer-hook'))
        expect(matches.length).toBe(1)
      })

      it("preserves a user's pre-existing unrelated SessionStart hook (and other events)", () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, JSON.stringify({
          mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
          permissions: { allow: ['mcp__termpolis__*'] },
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo user-session-hook' }] },
            ],
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pretool' }] },
            ],
          },
        }))
        const r = registerInClaudeSettings(p, ADAPTER, HOOK)
        // Only the hook is newly added → changed must be true.
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        const cmds = primerCommands(v)
        expect(cmds).toContain('echo user-session-hook') // user's hook preserved
        expect(cmds.some((c) => typeof c === 'string' && c.includes('memory-primer-hook'))).toBe(true)
        // Unrelated hook event untouched.
        expect(v.hooks.PreToolUse[0].hooks[0].command).toBe('echo pretool')
      })

      it('recovers when settings.hooks is a wrong type (string instead of object)', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, JSON.stringify({
          mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
          permissions: { allow: ['mcp__termpolis__*'] },
          hooks: 'garbage',
        }))
        const r = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        expect(typeof v.hooks).toBe('object')
        expect(Array.isArray(v.hooks.SessionStart)).toBe(true)
        expect(primerCommands(v).some((c) => typeof c === 'string' && c.includes('memory-primer-hook'))).toBe(true)
      })

      it('recovers when hooks.SessionStart is a non-array (and keeps other events)', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, JSON.stringify({
          mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
          permissions: { allow: ['mcp__termpolis__*'] },
          hooks: { SessionStart: 'oops', PreToolUse: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] },
        }))
        const r = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        expect(Array.isArray(v.hooks.SessionStart)).toBe(true)
        expect(primerCommands(v).some((c) => typeof c === 'string' && c.includes('memory-primer-hook'))).toBe(true)
        expect(v.hooks.PreToolUse[0].hooks[0].command).toBe('keep-me')
      })

      it('does not add the hook when called with only 2 args (back-compat)', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, '{}')
        const r = registerInClaudeSettings(p, ADAPTER)
        expect(r.changed).toBe(true)
        const v = JSON.parse(readFileSync(p, 'utf-8'))
        expect(v.hooks).toBeUndefined()
      })

      it('returns already-registered when MCP + hook are all present', () => {
        const p = join(dir, 'settings.json')
        writeFileSync(p, JSON.stringify({
          mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
          permissions: { allow: ['mcp__termpolis__*'] },
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] },
        }))
        const r = registerInClaudeSettings(p, ADAPTER, HOOK)
        expect(r.changed).toBe(false)
        expect(r.skipped).toBe('already-registered')
      })
    })
  })

  describe('registerInGlobalMcp', () => {
    it('creates ~/.mcp.json if missing', () => {
      const p = join(dir, '.mcp.json')
      const r = registerInGlobalMcp(p, ADAPTER)
      expect(r.changed).toBe(true)
      expect(existsSync(p)).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('overwrites a corrupt ~/.mcp.json with a clean manifest', () => {
      const p = join(dir, '.mcp.json')
      writeFileSync(p, 'garbage{{{')
      const r = registerInGlobalMcp(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('removes legacy root-level termpolis entry', () => {
      const p = join(dir, '.mcp.json')
      writeFileSync(p, JSON.stringify({
        termpolis: { command: 'node', args: ['/old'] },
        mcpServers: {},
      }))
      const r = registerInGlobalMcp(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v).not.toHaveProperty('termpolis')
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('is idempotent when already registered', () => {
      const p = join(dir, '.mcp.json')
      const r1 = registerInGlobalMcp(p, ADAPTER)
      expect(r1.changed).toBe(true)
      const r2 = registerInGlobalMcp(p, ADAPTER)
      expect(r2.changed).toBe(false)
      expect(r2.skipped).toBe('already-registered')
    })

    it('writes the resolved runner, not a bare node', () => {
      const p = join(dir, '.mcp.json')
      registerInGlobalMcp(p, ADAPTER, { command: '/opt/electron', env: { ELECTRON_RUN_AS_NODE: '1' } })
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.command).toBe('/opt/electron')
      expect(v.mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    })

    it('rewrites a stale entry left by a build that hardcoded node', () => {
      // The ENOENT case: the file already names this adapter, so the old
      // already-registered short-circuit would have left `node` in place forever
      // on a machine that has no node on PATH.
      const p = join(dir, '.mcp.json')
      writeFileSync(p, JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } } }))
      const r = registerInGlobalMcp(p, ADAPTER, { command: '/opt/electron' })
      expect(r.changed).toBe(true)
      expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.termpolis.command).toBe('/opt/electron')
    })

    it('is still idempotent once the runner matches', () => {
      const p = join(dir, '.mcp.json')
      const node = { command: '/opt/electron', env: { ELECTRON_RUN_AS_NODE: '1' } }
      expect(registerInGlobalMcp(p, ADAPTER, node).changed).toBe(true)
      expect(registerInGlobalMcp(p, ADAPTER, node).skipped).toBe('already-registered')
    })
  })

  describe('registerInCodex', () => {
    it('returns skipped=missing when TOML absent', () => {
      const r = registerInCodex(join(dir, 'config.toml'), ADAPTER)
      expect(r.skipped).toBe('missing')
    })

    it('appends section when missing', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '# user config\nmodel = "gpt-5"\n')
      const r = registerInCodex(p, ADAPTER)
      expect(r.changed).toBe(true)
      const content = readFileSync(p, 'utf-8')
      expect(content).toMatch(/\[mcp_servers\.termpolis\]/)
      expect(content).toMatch(/command = "node"/)
    })

    it('writes atomically, leaving no temp file and the rest of the config intact', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '# user config\nmodel = "gpt-5"\n')
      expect(registerInCodex(p, ADAPTER).changed).toBe(true)
      const content = readFileSync(p, 'utf-8')
      expect(content).toContain('model = "gpt-5"')
      expect(content).toContain('[mcp_servers.termpolis]')
      expect(existsSync(p + '.tmp')).toBe(false)
    })

    it('replaces a stale section without treating $& in the entry as a substitution', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, `[mcp_servers.termpolis]\ncommand = "node"\nargs = ["/old"]\n\n[profile]\nx = 1\n`)
      expect(registerInCodex(p, ADAPTER, { command: "$&'" }).changed).toBe(true)
      const content = readFileSync(p, 'utf-8')
      expect(content).toContain(`command = "$&'"`)
      expect(content).not.toContain('/old')
      expect(content).toContain('[profile]')
      expect(existsSync(p + '.tmp')).toBe(false)
    })

    it('is idempotent when the section already says exactly what we would write', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, `[mcp_servers.termpolis]\ncommand = "node"\nargs = ["${ADAPTER}"]\n`)
      const r = registerInCodex(p, ADAPTER)
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('already-registered')
    })

    it('repairs a half-written section rather than trusting the header alone', () => {
      // Presence of `[mcp_servers.termpolis]` used to be enough to skip. It is
      // not: a section can name the wrong interpreter, point at an adapter path
      // from a previous install location, or — as here — be missing `args`
      // entirely, in which case Codex spawns node with no script and the MCP
      // server never comes up.
      const p = join(dir, 'config.toml')
      writeFileSync(p, '[mcp_servers.termpolis]\ncommand = "node"\n')
      expect(registerInCodex(p, ADAPTER).changed).toBe(true)
      expect(readFileSync(p, 'utf-8')).toContain(`args = ["${ADAPTER}"]`)
    })

    it('escapes backslashes in Windows adapter paths', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '')
      const winAdapter = 'C:\\Users\\me\\adapter.cjs'
      const r = registerInCodex(p, winAdapter)
      expect(r.changed).toBe(true)
      const content = readFileSync(p, 'utf-8')
      // Double-escaped in TOML string literal
      expect(content).toContain('"C:\\\\Users\\\\me\\\\adapter.cjs"')
    })

    it('preserves user content — append only', () => {
      const p = join(dir, 'config.toml')
      const before = '# MY CONFIG\nmodel = "gpt-5"\napi_key = "secret"\n'
      writeFileSync(p, before)
      registerInCodex(p, ADAPTER)
      const after = readFileSync(p, 'utf-8')
      expect(after.startsWith(before)).toBe(true)
    })
  })

  describe('registerInGemini', () => {
    it('returns skipped=missing when settings absent', () => {
      const r = registerInGemini(join(dir, 'settings.json'), ADAPTER)
      expect(r.skipped).toBe('missing')
    })

    it('returns skipped=corrupt on malformed JSON', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{"mcp": broken}')
      const r = registerInGemini(p, ADAPTER)
      expect(r.skipped).toBe('corrupt')
    })

    it('registers into empty {} file', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      const r = registerInGemini(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('preserves unrelated MCP servers', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { someone_else: { command: 'other', args: [] } },
      }))
      const r = registerInGemini(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.someone_else).toBeDefined()
      expect(v.mcpServers.termpolis).toBeDefined()
    })

    it('is idempotent when already registered', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } },
      }))
      const r = registerInGemini(p, ADAPTER)
      expect(r.skipped).toBe('already-registered')
    })
  })

  // Cross-cutting invariant: every helper must NEVER throw, even under
  // deliberately sabotaged input. Main process boot relies on these.
  describe('never-throws invariant', () => {
    it('claude: returns RegistryResult on every input', () => {
      const inputs = ['', '{', 'null', '[]', '"string"', '42', '{{{{{']
      const p = join(dir, 'settings.json')
      for (const input of inputs) {
        writeFileSync(p, input)
        expect(() => registerInClaudeSettings(p, ADAPTER)).not.toThrow()
      }
    })
    it('claude (3-arg): never throws with a hook path on sabotaged input', () => {
      const inputs = [
        '', '{', 'null', '[]', '"string"', '42', '{{{{{',
        '{"hooks": "garbage"}',
        '{"hooks": []}',
        '{"hooks": {"SessionStart": 42}}',
        '{"hooks": {"SessionStart": [null, 1, "x", {"hooks": "nope"}, {"hooks": [null, 7]}]}}',
      ]
      const p = join(dir, 'settings.json')
      for (const input of inputs) {
        writeFileSync(p, input)
        expect(() => registerInClaudeSettings(p, ADAPTER, HOOK)).not.toThrow()
      }
    })
    it('global-mcp: returns RegistryResult on every input', () => {
      const inputs = ['', '{', 'null', 'garbage{{{', '""', 'true']
      const p = join(dir, '.mcp.json')
      for (const input of inputs) {
        writeFileSync(p, input)
        expect(() => registerInGlobalMcp(p, ADAPTER)).not.toThrow()
      }
    })
    it('gemini: returns RegistryResult on every input', () => {
      const inputs = ['', '{', 'null', 'xxx', '[]']
      const p = join(dir, 'settings.json')
      for (const input of inputs) {
        writeFileSync(p, input)
        expect(() => registerInGemini(p, ADAPTER)).not.toThrow()
      }
    })
  })

  describe('resolveNodeCommand (#4 node-PATH robustness)', () => {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const sep = process.platform === 'win32' ? ';' : ':'

    it('returns the first node that actually exists on PATH', () => {
      const yesDir = join(dir, 'yes')
      const target = join(yesDir, exe)
      const env = { PATH: [join(dir, 'no'), yesDir].join(sep) } as NodeJS.ProcessEnv
      expect(resolveNodeCommand(env, (p) => p === target)).toBe(target)
    })

    it('checks well-known install dirs when PATH has nothing', () => {
      const backstop = process.platform === 'win32' ? 'C:\\Program Files\\nodejs' : '/usr/local/bin'
      const target = join(backstop, exe)
      expect(resolveNodeCommand({ PATH: '' } as NodeJS.ProcessEnv, (p) => p === target)).toBe(target)
    })

    it('falls back to bare "node" when nothing exists — never bakes a bad path', () => {
      expect(resolveNodeCommand({ PATH: join(dir, 'x') } as NodeJS.ProcessEnv, () => false)).toBe('node')
    })
  })

  describe('registerInClaudeSettings — nodeCommand (#4)', () => {
    const NODE = process.platform === 'win32' ? 'C:/Program Files/nodejs/node.exe' : '/usr/local/bin/node'
    const hookCmd = (s: any): string =>
      s.hooks.SessionStart.flatMap((g: any) => g.hooks).map((h: any) => h.command).find((c: string) => c.includes('memory-primer-hook'))

    it('bakes an absolute node into BOTH the MCP command and the (quoted) hook command', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      const r = registerInClaudeSettings(p, ADAPTER, HOOK, NODE)
      expect(r.changed).toBe(true)
      const s = JSON.parse(readFileSync(p, 'utf-8'))
      expect(s.mcpServers.termpolis.command).toBe(NODE)
      expect(hookCmd(s)).toBe(`"${NODE}" "${HOOK}"`)
    })

    it('defaults to bare "node" when no nodeCommand is given (back-compat)', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      registerInClaudeSettings(p, ADAPTER, HOOK)
      const s = JSON.parse(readFileSync(p, 'utf-8'))
      expect(s.mcpServers.termpolis.command).toBe('node')
      expect(hookCmd(s).startsWith('node "')).toBe(true)
    })

    it('upgrades a previously bare-node MCP command to the absolute path', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [ADAPTER] } } }))
      const r = registerInClaudeSettings(p, ADAPTER, undefined, NODE)
      expect(r.changed).toBe(true)
      expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.termpolis.command).toBe(NODE)
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
      const nodeDir = join(dir, 'nodedir')
      const runner = resolveNodeRunner(
        { PATH: nodeDir } as NodeJS.ProcessEnv,
        (p) => p === join(nodeDir, bin),
        ELECTRON,
      )
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
  })

  describe('registerInCodex \u2014 interpreter repair', () => {
    const NODE = '/usr/local/bin/node'
    const ELECTRON = { command: '/opt/Termpolis/termpolis', env: { ELECTRON_RUN_AS_NODE: '1' } }

    it('rewrites a stale bare-node section instead of calling it already-registered', () => {
      // THE upgrade bug. Every Linux user who ran an older build has this exact
      // file on disk. A short-circuit on "section present" leaves them broken
      // through every future update, because the section is always present.
      const p = join(dir, 'config.toml')
      writeFileSync(p, '[mcp_servers.termpolis]\ncommand = "node"\nargs = ["' + ADAPTER + '"]\n')
      const r = registerInCodex(p, ADAPTER, NODE)
      expect(r.changed).toBe(true)
      const out = readFileSync(p, 'utf-8')
      expect(out).toContain(`command = "${NODE}"`)
      expect(out).not.toContain('command = "node"')
      expect(out.match(/\[mcp_servers\.termpolis\]/g)).toHaveLength(1)
    })

    it('emits the interpreter environment as a TOML inline table', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '')
      expect(registerInCodex(p, ADAPTER, ELECTRON).changed).toBe(true)
      const out = readFileSync(p, 'utf-8')
      expect(out).toContain(`command = "${ELECTRON.command}"`)
      expect(out).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }')
    })

    it('leaves an identical section untouched', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '')
      registerInCodex(p, ADAPTER, NODE)
      const before = readFileSync(p, 'utf-8')
      expect(registerInCodex(p, ADAPTER, NODE)).toEqual({ changed: false, skipped: 'already-registered' })
      expect(readFileSync(p, 'utf-8')).toBe(before)
    })

    it('replaces only its own section, leaving the rest of the config intact', () => {
      // Text-blob editing has one job it must not get wrong: the user's model
      // settings and other MCP servers live in this file too.
      const p = join(dir, 'config.toml')
      writeFileSync(
        p,
        'model = "gpt-5"\n\n[mcp_servers.termpolis]\ncommand = "node"\nargs = ["old.cjs"]\n\n[mcp_servers.other]\ncommand = "other"\n',
      )
      expect(registerInCodex(p, ADAPTER, NODE).changed).toBe(true)
      const out = readFileSync(p, 'utf-8')
      expect(out).toContain('model = "gpt-5"')
      expect(out).toContain('[mcp_servers.other]\ncommand = "other"')
      expect(out).toContain(`args = ["${ADAPTER}"]`)
      expect(out).not.toContain('old.cjs')
    })

    it('drops a stale env when the interpreter no longer needs one', () => {
      // The reverse upgrade: a user who installed Node after the Electron
      // fallback was written must not keep ELECTRON_RUN_AS_NODE aimed at a
      // real node, where it means nothing, or at a stale Electron path.
      const p = join(dir, 'config.toml')
      writeFileSync(p, '')
      registerInCodex(p, ADAPTER, ELECTRON)
      expect(registerInCodex(p, ADAPTER, NODE).changed).toBe(true)
      expect(readFileSync(p, 'utf-8')).not.toContain('ELECTRON_RUN_AS_NODE')
    })
  })

  describe('registerInGemini / registerInClaudeSettings \u2014 runner env', () => {
    const ELECTRON = { command: '/opt/Termpolis/termpolis', env: { ELECTRON_RUN_AS_NODE: '1' } }

    it('stores the environment alongside the command for Gemini', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      expect(registerInGemini(p, ADAPTER, ELECTRON).changed).toBe(true)
      expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.termpolis).toEqual({
        command: ELECTRON.command,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        args: [ADAPTER],
      })
      expect(registerInGemini(p, ADAPTER, ELECTRON)).toEqual({ changed: false, skipped: 'already-registered' })
    })

    it('repairs a Gemini entry that has the right command but lost its env', () => {
      // Without ELECTRON_RUN_AS_NODE this command launches a second Termpolis
      // window instead of an MCP server, so the command matching is not enough.
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({ mcpServers: { termpolis: { command: ELECTRON.command, args: [ADAPTER] } } }))
      expect(registerInGemini(p, ADAPTER, ELECTRON).changed).toBe(true)
      expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    })

    it('prefixes the Claude SessionStart hook with the interpreter environment', () => {
      // Hook commands are shell strings — POSIX sh, Git Bash included — so
      // `K=V cmd` is how the variable reaches the process.
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      registerInClaudeSettings(p, ADAPTER, HOOK, ELECTRON)
      const s = JSON.parse(readFileSync(p, 'utf-8'))
      const cmd = s.hooks.SessionStart.flatMap((g: any) => g.hooks).map((h: any) => h.command)[0]
      expect(cmd).toBe(`ELECTRON_RUN_AS_NODE=1 "${ELECTRON.command}" "${HOOK}"`)
      expect(s.mcpServers.termpolis.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    })

    it('normalizes a Windows interpreter path in the hook command', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      registerInClaudeSettings(p, ADAPTER, WIN_HOOK, 'C:\\Program Files\\nodejs\\node.exe')
      const s = JSON.parse(readFileSync(p, 'utf-8'))
      const cmd = s.hooks.SessionStart.flatMap((g: any) => g.hooks).map((h: any) => h.command)[0]
      expect(cmd).toBe('"C:/Program Files/nodejs/node.exe" "' + WIN_HOOK.replace(/\\/g, '/') + '"')
      // The MCP entry keeps the native path — that one is spawned directly, not
      // through a shell, so it is never re-parsed.
      expect(s.mcpServers.termpolis.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    })
  })
})
