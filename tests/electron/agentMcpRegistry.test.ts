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
} from '../../src/main/agentMcpRegistry'

const ADAPTER = '/path/to/stdio-adapter.cjs'

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
})
