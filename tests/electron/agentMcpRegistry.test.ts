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
  registerInQwen,
  resolveNodeCommand,
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

    it('is idempotent when already registered', () => {
      const p = join(dir, 'config.toml')
      writeFileSync(p, '[mcp_servers.termpolis]\ncommand = "node"\n')
      const r = registerInCodex(p, ADAPTER)
      expect(r.changed).toBe(false)
      expect(r.skipped).toBe('already-registered')
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

  describe('registerInQwen', () => {
    it('returns skipped=missing when settings absent', () => {
      const r = registerInQwen(join(dir, 'settings.json'), ADAPTER)
      expect(r.skipped).toBe('missing')
    })

    it('returns skipped=corrupt on malformed JSON', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{"mcp": broken}')
      const r = registerInQwen(p, ADAPTER)
      expect(r.skipped).toBe('corrupt')
    })

    it('registers into empty {} file', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      const r = registerInQwen(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
    })

    it('preserves unrelated MCP servers', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, JSON.stringify({
        mcpServers: { someone_else: { command: 'other', args: [] } },
      }))
      const r = registerInQwen(p, ADAPTER)
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
      const r = registerInQwen(p, ADAPTER)
      expect(r.skipped).toBe('already-registered')
    })

    it('recovers when root JSON is array (not an object)', () => {
      const p = join(dir, 'settings.json')
      writeFileSync(p, '[1,2,3]')
      const r = registerInQwen(p, ADAPTER)
      expect(r.changed).toBe(true)
      const v = JSON.parse(readFileSync(p, 'utf-8'))
      expect(v.mcpServers.termpolis.args[0]).toBe(ADAPTER)
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
    it('qwen: returns RegistryResult on every input', () => {
      const inputs = ['', '{', 'null', 'xxx', '[]', 'true']
      const p = join(dir, 'settings.json')
      for (const input of inputs) {
        writeFileSync(p, input)
        expect(() => registerInQwen(p, ADAPTER)).not.toThrow()
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
})
