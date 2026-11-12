// @vitest-environment node
// A Gemini worker the swarm conductor starts runs the Antigravity CLI (`agy`). Nothing here runs a
// real agent: the chain is followed from the conductor's prompt to the line typed into the
// worker's terminal, and from Agent Integration's write to the file agy reads its MCP servers from.
//
// Load-bearing:
//   * every agy launch the conductor's prompt teaches is the allowlisted one, so main never has to
//     rewrite it, and a launch the prompt marks WRONG is rewritten to it;
//   * create_terminal + run_command through the MCP tool layer reach main with the command, and the
//     line main types into a conductor-made terminal is the sanitized one: no prompt, no -p/--sandbox,
//     not even behind a Windows launcher extension (agy.exe);
//   * the worker reads its servers from <home>/.gemini/config/mcp_config.json, never from
//     CLAUDE_CONFIG_DIR / CODEX_HOME, and what Termpolis writes there is the same server the
//     conductor itself is launched with (one MCP server for the conductor and its workers);
//   * an agy that makes its folder after Termpolis started is registered at the next start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() } }))

import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'
import { AGENT_COMMAND_ALLOWLIST, sanitizeAgentCommand } from '../../src/main/agentCommandSanitizer'
import { executeTool } from '../../src/main/mcpServer'
import {
  bootAgentIntegration, conductorMcpConfig, resolveAgentIntegrationPaths,
} from '../../src/main/agentIntegrationManager'
import { AGY_ALLOW_RULES } from '../../src/main/agentMcpRegistry'
import { createSandbox, readJson, writeLedger } from './_agentIntegrationManagerFixture'
import type { Sandbox } from './_agentIntegrationManagerFixture'

const AGY = 'agy --dangerously-skip-permissions'

const prompt = (shellType: string): string => buildConductorPrompt({
  taskDescription: 'Write the docs',
  installedAgents: { claude: true, codex: true, gemini: true },
  projectCwd: '/work/project',
  shellType,
})

describe('launch args: what the conductor is taught to type, and what main types', () => {
  it('every agy launch in the prompt is exactly the allowlisted one, which main leaves as it is', () => {
    for (const shell of ['bash', 'powershell']) {
      const launches = [...prompt(shell).matchAll(/'(agy[^']*)'/g)].map((m) => m[1])
      expect(launches.length).toBeGreaterThanOrEqual(2) // the agent table and the worked example
      for (const cmd of launches) {
        expect(cmd).toBe(AGENT_COMMAND_ALLOWLIST.agy)
        expect(sanitizeAgentCommand(cmd)).toBe(cmd)
      }
    }
    expect(AGENT_COMMAND_ALLOWLIST.agy).toBe(AGY)
  })

  it('the prompt names agy as the Gemini launch, not the legacy gemini binary', () => {
    expect(prompt('bash')).toMatch(/Gemini CLI\s+→ 'agy --dangerously-skip-permissions'/)
  })

  it('a worker started through create_terminal + run_command gets the sanitized line typed into it', async () => {
    // Main's runCommand for a terminal the conductor created (index.ts): sanitize, then type.
    const conductorMade = new Set<string>()
    const typed: string[] = []
    const handlers = {
      createTerminal: vi.fn(async (name: string) => { const id = `w-${name}`; conductorMade.add(id); return id }),
      runCommand: vi.fn((id: string, command: string) => {
        typed.push(`${id}:${conductorMade.has(id) ? sanitizeAgentCommand(command) : command}\r`)
      }),
      outputOffset: vi.fn(() => 0),
    } as unknown as Parameters<typeof executeTool>[2]

    const made = await executeTool('create_terminal', { name: 'Gemini (Docs)', shell: 'bash', cwd: '/work/project' }, handlers) as { terminalId: string }
    expect(made).toEqual({ terminalId: 'w-Gemini (Docs)', name: 'Gemini (Docs)' })
    for (const cmd of [AGY, 'agy', 'agy -p "Write docs"', 'agy --sandbox -p "Write docs"', 'agy.exe -p "Write docs"', 'C:\\tools\\agy.cmd --print']) {
      await executeTool('run_command', { terminalId: made.terminalId, command: cmd }, handlers)
    }
    expect(typed).toEqual(Array(6).fill(`w-Gemini (Docs):${AGY}\r`))
    // The legacy name the prompt marks WRONG lands on its own allowlisted line, prompt stripped.
    expect(sanitizeAgentCommand('gemini --sandbox -p "Write docs"')).toBe('gemini')
  })
})

describe('MCP registration: the file agy reads, holding the conductor\'s own server', () => {
  let sb: Sandbox
  beforeEach(() => { sb = createSandbox() })
  afterEach(() => { sb.dispose() })

  const installAgy = (): void => {
    mkdirSync(dirname(sb.files.agyMcp), { recursive: true })
    mkdirSync(dirname(sb.files.agySettings), { recursive: true })
  }

  it('agy\'s file is <home>/.gemini/config/mcp_config.json, whatever CLAUDE_CONFIG_DIR and CODEX_HOME say', () => {
    const home = join(sb.root, 'os-home')
    const p = resolveAgentIntegrationPaths(home, join(sb.root, 'ud'), {
      CLAUDE_CONFIG_DIR: join(sb.root, 'elsewhere-claude'),
      CODEX_HOME: join(sb.root, 'elsewhere-codex'),
    })
    expect(p.geminiDir).toBe(join(home, '.gemini'))
    expect(sb.files.agyMcp).toBe(join(sb.paths.geminiDir, 'config', 'mcp_config.json'))
  })

  it('a connected user\'s start writes the conductor\'s server into agy\'s file, with the safe list beside it', () => {
    installAgy()
    writeLedger(sb, { consent: 'granted' })
    bootAgentIntegration(sb.rt)
    const { type, ...conductorServer } = conductorMcpConfig(sb.rt).mcpServers.termpolis as Record<string, unknown>
    expect(type).toBe('stdio')
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual(conductorServer)
    expect(conductorServer).toEqual({ command: 'node', args: [sb.adapter] })
    expect(readJson(sb.files.agySettings).permissions.allow).toEqual([...AGY_ALLOW_RULES])
  })

  it('an agy that makes its folder after Termpolis started is registered at the next start', () => {
    writeLedger(sb, { consent: 'granted' })
    mkdirSync(sb.paths.geminiDir, { recursive: true })
    bootAgentIntegration(sb.rt)
    expect(existsSync(sb.files.agyMcp)).toBe(false) // the writer never makes agy's folders
    installAgy()
    bootAgentIntegration(sb.rt)
    expect(readJson(sb.files.agyMcp).mcpServers.termpolis).toEqual({ command: 'node', args: [sb.adapter] })
  })
})
