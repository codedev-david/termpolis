import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildInventory } from '../../src/main/mcpInventory'

let dir: string
const paths = (): { claude: string; globalMcp: string; codex: string; gemini: string } => ({
  claude: join(dir, 'settings.json'),
  globalMcp: join(dir, '.mcp.json'),
  codex: join(dir, 'config.toml'),
  gemini: join(dir, 'gemini.json'),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-inv-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildInventory', () => {
  it('reports every file source as missing when nothing exists', () => {
    const inv = buildInventory(paths(), [])
    expect(inv.servers).toEqual([])
    expect(inv.sources.map(s => s.id)).toEqual(['claude', 'globalMcp', 'codex', 'gemini', 'gateway'])
    expect(inv.sources.filter(s => s.id !== 'gateway').every(s => s.status === 'missing')).toBe(true)
    expect(inv.sources.find(s => s.id === 'gateway')!.status).toBe('ok')
    expect(inv.sources.every(s => typeof s.label === 'string' && s.label.length > 0)).toBe(true)
  })

  it('merges one server seen in two agents and flags drift', () => {
    writeFileSync(paths().claude, JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }))
    writeFileSync(paths().codex, '[mcp_servers.github]\ncommand = "gh-mcp"\n')
    const github = buildInventory(paths(), []).servers.find(s => s.name === 'github')!
    expect(github.sources).toEqual({
      claude: true, globalMcp: false, codex: true, gemini: false, gateway: false,
    })
    expect(github.drift).toBe(true)
  })

  it('does not flag drift when all three agents agree', () => {
    const spec = JSON.stringify({ mcpServers: { a: { command: 'x' } } })
    writeFileSync(paths().claude, spec)
    writeFileSync(paths().gemini, spec)
    writeFileSync(paths().codex, '[mcp_servers.a]\ncommand = "x"\n')
    expect(buildInventory(paths(), []).servers.find(s => s.name === 'a')!.drift).toBe(false)
  })

  it('does not let the gateway or ~/.mcp.json alone create drift', () => {
    // Both are Termpolis/Claude surfaces, not a third agent. Counting either would
    // report drift on a server that is in fact consistent everywhere it matters.
    writeFileSync(paths().globalMcp, JSON.stringify({ mcpServers: { solo: { command: 'x' } } }))
    const solo = buildInventory(paths(), [{ id: 'solo', command: 'x' }]).servers[0]
    expect(solo.sources.globalMcp).toBe(true)
    expect(solo.sources.gateway).toBe(true)
    expect(solo.drift).toBe(false)
  })

  it('marks a corrupt source without losing the healthy ones', () => {
    writeFileSync(paths().claude, '{ not json')
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { ok: { command: 'x' } } }))
    const inv = buildInventory(paths(), [])
    const claude = inv.sources.find(s => s.id === 'claude')!
    expect(claude.status).toBe('corrupt')
    expect(claude.error).toBeTruthy()
    expect(inv.servers.map(s => s.name)).toEqual(['ok'])
  })

  it('treats an empty config as corrupt rather than as an empty server list', () => {
    writeFileSync(paths().claude, '   \n')
    expect(buildInventory(paths(), []).sources.find(s => s.id === 'claude')!.error).toBe('empty file')
  })

  it('reports an unreadable path as corrupt for both JSON and TOML sources', () => {
    // A directory where a file is expected: exists, but readFileSync throws.
    mkdirSync(paths().claude)
    mkdirSync(paths().codex)
    const inv = buildInventory(paths(), [])
    expect(inv.sources.find(s => s.id === 'claude')!.status).toBe('corrupt')
    expect(inv.sources.find(s => s.id === 'codex')!.status).toBe('corrupt')
    expect(inv.sources.find(s => s.id === 'codex')!.error).toBeTruthy()
  })

  it('accepts valid JSON that carries no usable mcpServers table', () => {
    writeFileSync(paths().claude, JSON.stringify({ other: 1 }))
    writeFileSync(paths().globalMcp, JSON.stringify([1, 2, 3]))
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: ['not', 'a', 'table'] }))
    const inv = buildInventory(paths(), [])
    expect(inv.servers).toEqual([])
    expect(inv.sources.filter(s => s.id !== 'gateway').every(s => s.status !== 'corrupt')).toBe(true)
  })

  it('ignores fields of the wrong type instead of trusting them', () => {
    writeFileSync(paths().claude, JSON.stringify({
      mcpServers: {
        bad: { command: 42, args: 'not-an-array', url: null, env: ['nope'] },
        mixed: { command: 'x', args: ['keep', 7, 'also'], env: { N: 5 } },
        naked: null,
      },
    }))
    const servers = buildInventory(paths(), []).servers
    const bad = servers.find(s => s.name === 'bad')!
    expect(bad.command).toBeUndefined()
    expect(bad.args).toBeUndefined()
    expect(bad.url).toBeUndefined()
    expect(servers.find(s => s.name === 'mixed')!.args).toEqual(['keep', 'also'])
    expect(servers.find(s => s.name === 'naked')).toBeDefined()
  })

  it('masks every env value and redacts credential-shaped args', () => {
    const token = 'ghp_' + 'a'.repeat(36)
    writeFileSync(paths().claude, JSON.stringify({
      mcpServers: { s: { command: 'x', args: ['--token', token], env: { TOKEN: 'plaintext', N: 5 } } },
    }))
    const server = buildInventory(paths(), []).servers.find(s => s.name === 's')!
    const serialized = JSON.stringify(server)
    expect(serialized).not.toContain('plaintext')
    expect(serialized).not.toContain(token)
    expect(server.args![0]).toBe('--token')
    // Keys survive so the panel can still say which credentials a server expects.
    expect(Object.keys(server.env!).sort()).toEqual(['N', 'TOKEN'])
    expect(Object.values(server.env!).every(v => v === '••••')).toBe(true)
  })

  it('masks a credential embedded in a url', () => {
    const token = 'ghp_' + 'b'.repeat(36)
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { r: { url: `https://x.test/?k=${token}` } } }))
    expect(buildInventory(paths(), []).servers[0].url).not.toContain(token)
  })

  it('includes gateway servers as their own source', () => {
    const inv = buildInventory(paths(), [{ id: 'local', command: 'npx', args: ['srv'] }])
    const local = inv.servers.find(s => s.name === 'local')!
    expect(local.sources.gateway).toBe(true)
    expect(local.transport).toBe('stdio')
    expect(local.args).toEqual(['srv'])
  })

  it('classifies a url-only entry as http', () => {
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { remote: { url: 'https://x.test' } } }))
    expect(buildInventory(paths(), []).servers.find(s => s.name === 'remote')!.transport).toBe('http')
  })

  it('back-fills details from a later source when the first one omits them', () => {
    // Claude names the server but records nothing about how to run it; Codex does.
    writeFileSync(paths().claude, JSON.stringify({ mcpServers: { p: {} } }))
    writeFileSync(paths().codex, '[mcp_servers.p]\ncommand = "run"\nargs = ["--flag"]\n')
    writeFileSync(paths().gemini, JSON.stringify({ mcpServers: { p: { url: 'https://later.test' } } }))
    const p = buildInventory(paths(), []).servers[0]
    expect(p.command).toBe('run')
    expect(p.args).toEqual(['--flag'])
    expect(p.url).toBe('https://later.test')
  })

  it('sorts servers by name so the panel does not reshuffle between reads', () => {
    writeFileSync(paths().claude, JSON.stringify({ mcpServers: { zeta: {}, alpha: {}, mid: {} } }))
    expect(buildInventory(paths(), []).servers.map(s => s.name)).toEqual(['alpha', 'mid', 'zeta'])
  })
})
