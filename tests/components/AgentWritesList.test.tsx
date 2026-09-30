import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import {
  AGENT_INTEGRATION_WRITES,
  PRIMER_HOOK_DESCRIPTION,
  type AgentId,
  type AgentIntegrationStatus,
} from '../../src/shared/agentIntegration'
import {
  AGENT_LABELS,
  AGENT_ORDER,
  AgentWritesList,
  homeFromStatus,
  tildify,
} from '../../src/renderer/src/components/AgentIntegration/AgentWritesList'

function status(over: Partial<AgentIntegrationStatus> = {}, home = 'C:\\Users\\me'): AgentIntegrationStatus {
  return {
    consent: null,
    legacyDetected: false,
    connected: false,
    primerHook: true,
    agents: {
      claude: { installed: true, configPath: `${home}\\.claude\\settings.json`, registered: false },
      codex: { installed: false, configPath: `${home}\\.codex\\config.toml`, registered: false },
      gemini: { installed: true, configPath: `${home}\\.gemini\\settings.json`, registered: false },
    },
    autoAllowedTools: [],
    trustedFolders: [],
    codexHomeTrusted: false,
    ...over,
  }
}

function group(id: AgentId) {
  return screen.getByTestId(`agent-writes-${id}`)
}

describe('AgentWritesList', () => {
  it('lists every write main makes, word for word, grouped per agent in a fixed order', () => {
    render(<AgentWritesList />)
    const groups = within(screen.getByTestId('agent-writes-list')).getAllByTestId(/^agent-writes-(claude|codex|gemini)$/)
    expect(groups.map(g => g.dataset.testid)).toEqual(AGENT_ORDER.map(id => `agent-writes-${id}`))
    for (const id of AGENT_ORDER) {
      const g = group(id)
      expect(g).toHaveTextContent(AGENT_LABELS[id])
      const items = within(g).getAllByRole('listitem').map(li => li.textContent)
      const expected = [...AGENT_INTEGRATION_WRITES[id]]
      if (id === 'claude') expected.push(`Optional: ${PRIMER_HOOK_DESCRIPTION}`)
      expect(items).toEqual(expected)
    }
    expect(AGENT_LABELS).toEqual({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' })
  })

  it('names the SessionStart hook once, under Claude Code', () => {
    render(<AgentWritesList />)
    const hook = screen.getByTestId('agent-writes-hook')
    expect(hook.textContent).toBe(`Optional: ${PRIMER_HOOK_DESCRIPTION}`)
    expect(group('claude')).toContainElement(hook)
  })

  it('says nothing about installs or paths without a status', () => {
    const { rerender } = render(<AgentWritesList />)
    expect(screen.queryByTestId('agent-writes-claude-installed')).toBeNull()
    expect(screen.queryByTestId('agent-writes-claude-path')).toBeNull()
    rerender(<AgentWritesList status={null} />)
    expect(screen.queryByTestId('agent-writes-codex-installed')).toBeNull()
    expect(screen.queryByTestId('agent-writes-gemini-path')).toBeNull()
  })

  it('shows which agents are installed and where each config lives, with home as ~', () => {
    render(<AgentWritesList status={status()} />)
    const claude = screen.getByTestId('agent-writes-claude-installed')
    expect(claude).toHaveTextContent('Installed')
    expect(claude.className).toContain('text-[#7ee2a3]')
    const codex = screen.getByTestId('agent-writes-codex-installed')
    expect(codex).toHaveTextContent('Not installed: nothing is written for it')
    expect(codex.className).toContain('text-[#9ca3af]')
    expect(screen.getByTestId('agent-writes-claude-path').textContent).toBe('~\\.claude\\settings.json')
    expect(screen.getByTestId('agent-writes-codex-path').textContent).toBe('~\\.codex\\config.toml')
    expect(screen.getByTestId('agent-writes-gemini-path').textContent).toBe('~\\.gemini\\settings.json')
  })

  it('leaves out a path main could not work out, and shows full paths when home is unknown', () => {
    const s = status()
    s.agents.codex.configPath = ''
    s.agents.gemini.configPath = ''
    s.agents.claude.configPath = '/home/me/.claude/settings.json'
    render(<AgentWritesList status={s} />)
    expect(screen.queryByTestId('agent-writes-codex-path')).toBeNull()
    expect(screen.queryByTestId('agent-writes-gemini-path')).toBeNull()
    expect(screen.getByTestId('agent-writes-claude-path').textContent).toBe('/home/me/.claude/settings.json')
  })
})

describe('homeFromStatus', () => {
  it('reads home off the Gemini config path, on either kind of separator', () => {
    expect(homeFromStatus(status())).toBe('C:\\Users\\me')
    const posix = status()
    posix.agents.gemini.configPath = '/home/me/.gemini/settings.json'
    expect(homeFromStatus(posix)).toBe('/home/me')
  })

  it('is null when the path is empty, has no home before it, or is not where main keeps it', () => {
    const s = status()
    s.agents.gemini.configPath = ''
    expect(homeFromStatus(s)).toBeNull()
    s.agents.gemini.configPath = '/.gemini/settings.json'
    expect(homeFromStatus(s)).toBeNull()
    s.agents.gemini.configPath = '/home/me/gemini/settings.json'
    expect(homeFromStatus(s)).toBeNull()
  })
})

describe('tildify', () => {
  it('shortens home, and paths inside it, to ~', () => {
    expect(tildify('/home/me', '/home/me')).toBe('~')
    expect(tildify('/home/me/.codex/config.toml', '/home/me')).toBe('~/.codex/config.toml')
    expect(tildify('C:\\Users\\me\\.codex\\config.toml', 'C:\\Users\\me')).toBe('~\\.codex\\config.toml')
  })

  it('leaves everything else alone', () => {
    expect(tildify('/home/me/x', null)).toBe('/home/me/x')
    expect(tildify('/home/me/x', '')).toBe('/home/me/x')
    expect(tildify('/opt/me/x', '/home/me')).toBe('/opt/me/x')
    // A sibling folder that merely starts with the same letters is not inside home.
    expect(tildify('/home/meadow/x', '/home/me')).toBe('/home/meadow/x')
  })
})
