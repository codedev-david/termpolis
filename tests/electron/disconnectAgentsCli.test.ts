// @vitest-environment node
// The command the Linux .deb's prerm runs for each user as Electron-in-Node-mode:
// disconnectAgentsCli.ts, and disconnectAgentsEntry.ts, which calls it (resources/disconnect-agents.cjs).
// Every run here is pointed at the fixture's throwaway home through TERMPOLIS_TEST_AGENT_HOME, and
// where userData is left to the default rule, homedir() and the disconnect are both injected. So no
// test can reach the real ~/.claude, ~/.claude.json, ~/.codex, ~/.gemini or ~/.config/termpolis.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { disconnectAgentIntegration, setAgentIntegration } from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationPaths } from '../../src/main/agentIntegrationManager'
import type { AgentIntegrationChange } from '../../src/shared/agentIntegration'
import { formatDisconnectRow, linuxUserDataDir, runDisconnectAgentsCli } from '../../src/main/disconnectAgentsCli'
import { createSandbox, readJson, readText, writeLedger } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

let sb: Sandbox

beforeEach(() => {
  sb = createSandbox()
})

afterEach(() => {
  vi.restoreAllMocks()
  sb.dispose()
})

/** Connect every agent, as Settings > Agent integration > Connect does. */
function connectAll(): void {
  for (const d of [sb.paths.claudeDir, sb.paths.codexHome, sb.paths.geminiDir]) mkdirSync(d, { recursive: true })
  writeLedger(sb)
  setAgentIntegration(sb.rt, { connect: true })
}

/** A disconnect that touches nothing and remembers the paths it was handed. */
function fakeDisconnect(rows: AgentIntegrationChange[] = []): {
  fn: typeof disconnectAgentIntegration
  seen: AgentIntegrationPaths[]
} {
  const seen: AgentIntegrationPaths[] = []
  return {
    seen,
    fn: (paths) => {
      seen.push(paths)
      return rows
    },
  }
}

describe('linuxUserDataDir', () => {
  it("is ~/.config/termpolis, Electron's userData on Linux, when XDG_CONFIG_HOME is not set", () => {
    expect(linuxUserDataDir('/home/alice', {})).toBe(join('/home/alice', '.config', 'termpolis'))
  })

  it('follows XDG_CONFIG_HOME when it is set', () => {
    expect(linuxUserDataDir('/home/alice', { XDG_CONFIG_HOME: '/srv/cfg' })).toBe(join('/srv/cfg', 'termpolis'))
  })

  it('ignores an empty XDG_CONFIG_HOME, as Electron does', () => {
    expect(linuxUserDataDir('/home/alice', { XDG_CONFIG_HOME: '' })).toBe(join('/home/alice', '.config', 'termpolis'))
  })
})

describe('formatDisconnectRow', () => {
  it('prints a row the way `--disconnect-agents` does in index.ts', () => {
    expect(formatDisconnectRow({ agent: 'codex', file: '/h/.codex/config.toml', action: 'remove', what: 'MCP server' }))
      .toBe('codex: remove MCP server (/h/.codex/config.toml)')
  })

  it('adds the error when the row has one', () => {
    expect(formatDisconnectRow({ agent: 'gemini', file: '/h/.gemini/settings.json', action: 'skipped', what: 'MCP server', error: 'EACCES' }))
      .toBe('gemini: skipped MCP server (/h/.gemini/settings.json) - EACCES')
  })
})

describe('runDisconnectAgentsCli', () => {
  it("takes Termpolis back out of every agent it connected, using the userData folder it is handed", () => {
    connectAll()
    expect(readJson(sb.files.claudeJson).mcpServers.termpolis).toBeDefined()
    const lines: string[] = []
    const errors: string[] = []

    // homedir() and the disconnect are the real ones here: the fixture's test home wins over the OS
    // home, and the userData folder comes from argv, so the default rule is never consulted.
    const code = runDisconnectAgentsCli([sb.paths.userData], process.env, {
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
    })

    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(readJson(sb.files.claudeJson).mcpServers?.termpolis).toBeUndefined()
    expect(readJson(sb.files.gemini).mcpServers?.termpolis).toBeUndefined()
    expect(readText(sb.files.codex)).not.toContain('[mcp_servers.termpolis]')
    expect(readJson(sb.ledgerFile).consent).toBeNull()
    expect(lines).toContain(`claude: remove MCP server (${sb.files.claudeJson})`)
    expect(lines).toContain(`codex: remove MCP server (${sb.files.codex})`)
    expect(lines).toContain(`gemini: remove MCP server (${sb.files.gemini})`)
  })

  it('prints exactly the rows the disconnect returned, in order', () => {
    connectAll()
    const real = vi.fn(disconnectAgentIntegration)
    const lines: string[] = []
    expect(runDisconnectAgentsCli([sb.paths.userData], process.env, { disconnect: real, log: (l) => lines.push(l) })).toBe(0)
    expect(real).toHaveBeenCalledTimes(1)
    expect(real.mock.calls[0][0]).toEqual(sb.paths)
    const rows = real.mock.results[0].value as AgentIntegrationChange[]
    expect(rows.length).toBeGreaterThan(0)
    expect(lines).toEqual(rows.map(formatDisconnectRow))
  })

  it('prints nothing and succeeds when nothing was connected', () => {
    const lines: string[] = []
    expect(runDisconnectAgentsCli([sb.paths.userData], process.env, { log: (l) => lines.push(l) })).toBe(0)
    expect(lines).toEqual([])
  })

  it("without a userData argument, uses Electron's folder under XDG_CONFIG_HOME in the user's home", () => {
    const d = fakeDisconnect()
    const env = { XDG_CONFIG_HOME: '/srv/cfg' }
    expect(runDisconnectAgentsCli([], env, { homedir: () => '/home/alice', disconnect: d.fn })).toBe(0)
    expect(d.seen).toHaveLength(1)
    expect(d.seen[0].userData).toBe(join('/srv/cfg', 'termpolis'))
    expect(d.seen[0].home).toBe('/home/alice')
    expect(d.seen[0].claudeJson).toBe(join('/home/alice', '.claude.json'))
  })

  it('treats an empty userData argument as missing, and falls back to ~/.config', () => {
    const d = fakeDisconnect()
    expect(runDisconnectAgentsCli([''], {}, { homedir: () => '/home/alice', disconnect: d.fn })).toBe(0)
    expect(d.seen[0].userData).toBe(join('/home/alice', '.config', 'termpolis'))
  })

  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME from the environment it runs in, as the app does", () => {
    const d = fakeDisconnect()
    const env = { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' }
    runDisconnectAgentsCli(['/ud'], env, { homedir: () => '/home/alice', disconnect: d.fn })
    expect(d.seen[0]).toMatchObject({
      userData: '/ud',
      claudeDir: '/cfg/claude',
      claudeJson: join('/cfg/claude', '.claude.json'),
      codexHome: '/cfg/codex',
    })
  })

  it('prints to stdout by default, one line per row, errors included', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const d = fakeDisconnect([
      { agent: 'claude', file: '/h/.claude.json', action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: '/h/.codex/config.toml', action: 'skipped', what: 'MCP server', error: 'EACCES' },
    ])
    expect(runDisconnectAgentsCli(['/ud'], {}, { homedir: () => '/h', disconnect: d.fn })).toBe(0)
    expect(out.mock.calls).toEqual([
      ['claude: remove MCP server (/h/.claude.json)'],
      ['codex: skipped MCP server (/h/.codex/config.toml) - EACCES'],
    ])
  })

  it('returns 1 and reports the error when the disconnect throws, for the prerm to log', () => {
    const lines: string[] = []
    const errors: string[] = []
    const code = runDisconnectAgentsCli(['/ud'], {}, {
      homedir: () => '/h',
      disconnect: () => {
        throw new Error('EACCES: permission denied')
      },
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
    })
    expect(code).toBe(1)
    expect(lines).toEqual([])
    expect(errors).toEqual(['Could not disconnect agents: EACCES: permission denied'])
  })

  it('reports a thrown value that is not an Error, on stderr by default', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = (value: unknown) => (): never => {
      throw value
    }
    expect(runDisconnectAgentsCli(['/ud'], {}, { homedir: () => '/h', disconnect: throwing('no home') })).toBe(1)
    expect(runDisconnectAgentsCli(['/ud'], {}, { homedir: () => '/h', disconnect: throwing(null) })).toBe(1)
    expect(err.mock.calls).toEqual([['Could not disconnect agents: no home'], ['Could not disconnect agents: null']])
  })

  it('returns 1 when even the home folder cannot be found', () => {
    const errors: string[] = []
    const code = runDisconnectAgentsCli([], {}, {
      homedir: () => {
        throw new Error('no passwd entry')
      },
      error: (l) => errors.push(l),
    })
    expect(code).toBe(1)
    expect(errors).toEqual(['Could not disconnect agents: no passwd entry'])
  })
})

describe('disconnectAgentsEntry (resources/disconnect-agents.cjs)', () => {
  it('reads the userData folder from argv after the script path, disconnects, and sets the exit code', async () => {
    connectAll()
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const argv = process.argv
    const exitCode = process.exitCode
    // Under ELECTRON_RUN_AS_NODE=1, argv is [termpolis, disconnect-agents.cjs, userData].
    process.argv = [process.execPath, '/opt/Termpolis/resources/disconnect-agents.cjs', sb.paths.userData]
    try {
      vi.resetModules()
      await import('../../src/main/disconnectAgentsEntry')
      expect(process.exitCode).toBe(0)
    } finally {
      process.argv = argv
      process.exitCode = exitCode
    }
    expect(readJson(sb.files.claudeJson).mcpServers?.termpolis).toBeUndefined()
    expect(readJson(sb.ledgerFile).consent).toBeNull()
    expect(out.mock.calls).toContainEqual([`claude: remove MCP server (${sb.files.claudeJson})`])
  })
})
