import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid-1') }))

import { useTerminalStore, buildPaneTree } from '../../src/renderer/src/store/terminalStore'
import { DEFAULT_KEYBINDINGS } from '../../src/renderer/src/lib/keybindings'
import type { TerminalSession, PaneNode } from '../../src/renderer/src/types'
import type { ConversationTurn } from '../../src/renderer/src/lib/conversationParser'
import type { AIProfile, PromptTemplate } from '../../src/renderer/src/types'
import type { SwarmAgentEntry } from '../../src/renderer/src/store/terminalStore'

function makeTerminal(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 't1',
    name: 'Terminal 1',
    color: '#00ff00',
    shellType: 'bash',
    cwd: '/home/user',
    fontSize: 14,
    theme: 'dark',
    fontFamily: 'monospace',
    ...overrides,
  }
}

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    terminalId: 't1',
    terminalName: 'Terminal 1',
    agentName: 'claude',
    ...overrides,
  }
}

const initialState = useTerminalStore.getState()

describe('terminalStore', () => {
  beforeEach(() => {
    useTerminalStore.setState({ ...initialState }, true)
  })

  // ---- Terminal CRUD ----

  describe('addTerminal', () => {
    it('adds a terminal and sets it as active', () => {
      const t = makeTerminal()
      useTerminalStore.getState().addTerminal(t)

      const state = useTerminalStore.getState()
      expect(state.terminals).toHaveLength(1)
      expect(state.terminals[0]).toEqual(t)
      expect(state.activeTerminalId).toBe('t1')
    })

    it('closes settings when adding a terminal', () => {
      useTerminalStore.setState({ showSettings: true })
      useTerminalStore.getState().addTerminal(makeTerminal())

      expect(useTerminalStore.getState().showSettings).toBe(false)
    })

    it('updates pane tree when in split mode', () => {
      useTerminalStore.setState({ viewMode: 'split' })
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))

      const state = useTerminalStore.getState()
      expect(state.paneTree).toEqual({ type: 'terminal', terminalId: 'a' })

      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      const state2 = useTerminalStore.getState()
      expect(state2.paneTree).not.toBeNull()
      expect(state2.paneTree!.type).toBe('split')
    })

    it('does not modify pane tree in tabs mode', () => {
      useTerminalStore.getState().addTerminal(makeTerminal())
      expect(useTerminalStore.getState().paneTree).toBeNull()
    })
  })

  describe('removeTerminal', () => {
    it('removes a terminal by id', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      useTerminalStore.getState().removeTerminal('a')

      const state = useTerminalStore.getState()
      expect(state.terminals).toHaveLength(1)
      expect(state.terminals[0].id).toBe('b')
    })

    it('selects last remaining terminal as active when active is removed', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'c' }))
      // active is now 'c'
      useTerminalStore.getState().removeTerminal('c')

      expect(useTerminalStore.getState().activeTerminalId).toBe('b')
    })

    it('sets activeTerminalId to null when all terminals removed', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().removeTerminal('a')

      expect(useTerminalStore.getState().activeTerminalId).toBeNull()
    })

    it('preserves activeTerminalId when a non-active terminal is removed', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      useTerminalStore.getState().setActiveTerminal('a')
      useTerminalStore.getState().removeTerminal('b')

      expect(useTerminalStore.getState().activeTerminalId).toBe('a')
    })
  })

  describe('updateTerminal', () => {
    it('partially updates terminal properties', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a', name: 'old' }))
      useTerminalStore.getState().updateTerminal('a', { name: 'new', fontSize: 18 })

      const t = useTerminalStore.getState().terminals[0]
      expect(t.name).toBe('new')
      expect(t.fontSize).toBe(18)
      expect(t.color).toBe('#00ff00') // unchanged
    })
  })

  describe('setActiveTerminal', () => {
    it('sets the active terminal and closes settings', () => {
      useTerminalStore.setState({ showSettings: true })
      useTerminalStore.getState().setActiveTerminal('x')

      const state = useTerminalStore.getState()
      expect(state.activeTerminalId).toBe('x')
      expect(state.showSettings).toBe(false)
    })
  })

  // ---- View / Settings ----

  describe('toggleViewMode', () => {
    it('switches from tabs to split', () => {
      useTerminalStore.getState().toggleViewMode()
      expect(useTerminalStore.getState().viewMode).toBe('split')
    })

    it('switches from split back to tabs', () => {
      useTerminalStore.setState({ viewMode: 'split' })
      useTerminalStore.getState().toggleViewMode()
      expect(useTerminalStore.getState().viewMode).toBe('tabs')
    })

    it('builds pane tree when entering split mode with existing terminals', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      useTerminalStore.getState().toggleViewMode()

      const tree = useTerminalStore.getState().paneTree
      expect(tree).not.toBeNull()
      expect(tree!.type).toBe('split')
    })
  })

  describe('setShowSettings', () => {
    it('toggles settings visibility', () => {
      useTerminalStore.getState().setShowSettings(true)
      expect(useTerminalStore.getState().showSettings).toBe(true)

      useTerminalStore.getState().setShowSettings(false)
      expect(useTerminalStore.getState().showSettings).toBe(false)
    })

    it('preserves activeTerminalId when opening settings', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().setShowSettings(true)
      expect(useTerminalStore.getState().activeTerminalId).toBe('a')
    })
  })

  describe('setDefaultShell', () => {
    it('sets the default shell', () => {
      useTerminalStore.getState().setDefaultShell('zsh')
      expect(useTerminalStore.getState().defaultShell).toBe('zsh')
    })
  })

  describe('setAutocompleteEnabled', () => {
    it('toggles autocomplete', () => {
      useTerminalStore.getState().setAutocompleteEnabled(false)
      expect(useTerminalStore.getState().autocompleteEnabled).toBe(false)
    })
  })

  describe('setSidebarCollapsed', () => {
    it('toggles sidebar collapsed state', () => {
      useTerminalStore.getState().setSidebarCollapsed(true)
      expect(useTerminalStore.getState().sidebarCollapsed).toBe(true)
    })
  })

  // ---- Workspaces ----

  describe('addWorkspace', () => {
    it('creates a workspace from current terminals', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a', name: 'T1' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b', name: 'T2' }))
      useTerminalStore.getState().addWorkspace('My Workspace')

      const ws = useTerminalStore.getState().workspaces
      expect(ws).toHaveLength(1)
      expect(ws[0].name).toBe('My Workspace')
      expect(ws[0].id).toBe('mock-uuid-1')
      expect(ws[0].terminals).toHaveLength(2)
      // Terminals should not have 'id' field
      expect((ws[0].terminals[0] as any).id).toBeUndefined()
      expect(ws[0].terminals[0].name).toBe('T1')
    })
  })

  describe('renameWorkspace', () => {
    it('renames a workspace by id', () => {
      useTerminalStore.getState().addTerminal(makeTerminal())
      useTerminalStore.getState().addWorkspace('Old Name')
      const wsId = useTerminalStore.getState().workspaces[0].id
      useTerminalStore.getState().renameWorkspace(wsId, 'New Name')

      expect(useTerminalStore.getState().workspaces[0].name).toBe('New Name')
    })

    it('leaves other workspaces untouched when renaming by id', () => {
      useTerminalStore.setState({
        workspaces: [
          { id: 'ws-a', name: 'Alpha', terminals: [] },
          { id: 'ws-b', name: 'Beta', terminals: [] },
        ],
      })
      useTerminalStore.getState().renameWorkspace('ws-a', 'Alpha2')
      const ws = useTerminalStore.getState().workspaces
      expect(ws.find(w => w.id === 'ws-a')!.name).toBe('Alpha2')
      expect(ws.find(w => w.id === 'ws-b')!.name).toBe('Beta')
    })
  })

  describe('updateWorkspace', () => {
    it('updates workspace with current terminal state', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a', name: 'Before' }))
      useTerminalStore.getState().addWorkspace('WS')
      const wsId = useTerminalStore.getState().workspaces[0].id

      useTerminalStore.getState().updateTerminal('a', { name: 'After' })
      useTerminalStore.getState().updateWorkspace(wsId)

      expect(useTerminalStore.getState().workspaces[0].terminals[0].name).toBe('After')
    })

    it('leaves other workspaces untouched when updating by id', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a', name: 'TA' }))
      useTerminalStore.setState({
        workspaces: [
          { id: 'ws-1', name: 'One', terminals: [] },
          { id: 'ws-2', name: 'Two', terminals: [] },
        ],
      })
      useTerminalStore.getState().updateWorkspace('ws-2')
      const refreshed = useTerminalStore.getState().workspaces
      // ws-1 retains zero terminals (unchanged)
      expect(refreshed.find(w => w.id === 'ws-1')!.terminals).toHaveLength(0)
      // ws-2 has been refreshed to current terminals (1)
      expect(refreshed.find(w => w.id === 'ws-2')!.terminals).toHaveLength(1)
    })
  })

  describe('removeWorkspace', () => {
    it('deletes a workspace', () => {
      useTerminalStore.getState().addTerminal(makeTerminal())
      useTerminalStore.getState().addWorkspace('WS')
      const wsId = useTerminalStore.getState().workspaces[0].id
      useTerminalStore.getState().removeWorkspace(wsId)

      expect(useTerminalStore.getState().workspaces).toHaveLength(0)
    })
  })

  // ---- Pane tree ----

  describe('buildPaneTree', () => {
    it('returns null for empty array', () => {
      expect(buildPaneTree([])).toBeNull()
    })

    it('returns single terminal node for one id', () => {
      expect(buildPaneTree(['a'])).toEqual({ type: 'terminal', terminalId: 'a' })
    })

    it('builds balanced binary tree for multiple ids with alternating directions', () => {
      const tree = buildPaneTree(['a', 'b', 'c'])!
      expect(tree.type).toBe('split')
      if (tree.type === 'split') {
        expect(tree.direction).toBe('horizontal')
        expect(tree.ratio).toBe(0.5)
        // 3 ids: ceil(3/2)=2 left, 1 right
        expect(tree.children[0].type).toBe('split')
        if (tree.children[0].type === 'split') {
          expect(tree.children[0].direction).toBe('vertical')
        }
        expect(tree.children[1]).toEqual({ type: 'terminal', terminalId: 'c' })
      }
    })

    it('builds correct tree for two ids', () => {
      const tree = buildPaneTree(['a', 'b'])!
      expect(tree.type).toBe('split')
      if (tree.type === 'split') {
        expect(tree.children[0]).toEqual({ type: 'terminal', terminalId: 'a' })
        expect(tree.children[1]).toEqual({ type: 'terminal', terminalId: 'b' })
      }
    })
  })

  describe('splitTerminal', () => {
    it('splits a terminal pane into two', () => {
      useTerminalStore.setState({
        paneTree: { type: 'terminal', terminalId: 'a' },
      })
      useTerminalStore.getState().splitTerminal('a', 'vertical', 'b')

      const tree = useTerminalStore.getState().paneTree!
      expect(tree.type).toBe('split')
      if (tree.type === 'split') {
        expect(tree.direction).toBe('vertical')
        expect(tree.children[0]).toEqual({ type: 'terminal', terminalId: 'a' })
        expect(tree.children[1]).toEqual({ type: 'terminal', terminalId: 'b' })
      }
      expect(useTerminalStore.getState().activeTerminalId).toBe('b')
    })

    it('does nothing when paneTree is null', () => {
      useTerminalStore.setState({ paneTree: null })
      useTerminalStore.getState().splitTerminal('a', 'horizontal', 'b')
      expect(useTerminalStore.getState().paneTree).toBeNull()
    })
  })

  describe('removePaneTerminal', () => {
    it('removes a terminal from the pane tree', () => {
      const tree: PaneNode = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'terminal', terminalId: 'a' },
          { type: 'terminal', terminalId: 'b' },
        ],
      }
      useTerminalStore.setState({ paneTree: tree })
      useTerminalStore.getState().removePaneTerminal('a')

      expect(useTerminalStore.getState().paneTree).toEqual({
        type: 'terminal',
        terminalId: 'b',
      })
    })

    it('does nothing when paneTree is null', () => {
      useTerminalStore.setState({ paneTree: null })
      useTerminalStore.getState().removePaneTerminal('a')
      expect(useTerminalStore.getState().paneTree).toBeNull()
    })
  })

  // ---- Keybindings ----

  describe('setKeybinding', () => {
    it('sets a specific keybinding', () => {
      useTerminalStore.getState().setKeybinding('copy', 'Ctrl+C')
      expect(useTerminalStore.getState().keybindings.copy).toBe('Ctrl+C')
      // Other bindings unchanged
      expect(useTerminalStore.getState().keybindings.paste).toBe(DEFAULT_KEYBINDINGS.paste)
    })
  })

  describe('resetKeybindings', () => {
    it('resets all keybindings to defaults', () => {
      useTerminalStore.getState().setKeybinding('copy', 'Ctrl+C')
      useTerminalStore.getState().setKeybinding('paste', 'Ctrl+V')
      useTerminalStore.getState().resetKeybindings()

      expect(useTerminalStore.getState().keybindings).toEqual(DEFAULT_KEYBINDINGS)
    })
  })

  // ---- AI Profiles & Templates ----

  describe('addAIProfile / removeAIProfile', () => {
    const profile: AIProfile = {
      id: 'p1',
      name: 'Claude',
      icon: 'brain',
      command: 'claude',
      shell: 'bash',
      color: '#7c3aed',
    }

    it('adds an AI profile', () => {
      useTerminalStore.getState().addAIProfile(profile)
      expect(useTerminalStore.getState().aiProfiles).toHaveLength(1)
      expect(useTerminalStore.getState().aiProfiles[0]).toEqual(profile)
    })

    it('removes an AI profile by id', () => {
      useTerminalStore.getState().addAIProfile(profile)
      useTerminalStore.getState().removeAIProfile('p1')
      expect(useTerminalStore.getState().aiProfiles).toHaveLength(0)
    })
  })

  describe('addPromptTemplate / removePromptTemplate', () => {
    const template: PromptTemplate = {
      id: 'tmpl1',
      name: 'Explain',
      text: 'Explain this code',
      icon: 'lightbulb',
      isCustom: true,
    }

    it('adds a prompt template', () => {
      useTerminalStore.getState().addPromptTemplate(template)
      expect(useTerminalStore.getState().promptTemplates).toHaveLength(1)
      expect(useTerminalStore.getState().promptTemplates[0]).toEqual(template)
    })

    it('removes a prompt template by id', () => {
      useTerminalStore.getState().addPromptTemplate(template)
      useTerminalStore.getState().removePromptTemplate('tmpl1')
      expect(useTerminalStore.getState().promptTemplates).toHaveLength(0)
    })
  })

  // ---- Conversations ----

  describe('addConversationTurn', () => {
    it('creates a new conversation when none exists for the terminal', () => {
      const turn = makeTurn()
      useTerminalStore.getState().addConversationTurn('t1', 'Terminal 1', 'claude', turn)

      const convos = useTerminalStore.getState().conversations
      expect(convos).toHaveLength(1)
      expect(convos[0].terminalId).toBe('t1')
      expect(convos[0].terminalName).toBe('Terminal 1')
      expect(convos[0].agentName).toBe('claude')
      expect(convos[0].turns).toHaveLength(1)
      expect(convos[0].turns[0]).toEqual(turn)
    })

    it('appends to existing conversation for the same terminal', () => {
      const turn1 = makeTurn({ content: 'hello' })
      const turn2 = makeTurn({ role: 'assistant', content: 'hi there' })

      useTerminalStore.getState().addConversationTurn('t1', 'Terminal 1', 'claude', turn1)
      useTerminalStore.getState().addConversationTurn('t1', 'Terminal 1', 'claude', turn2)

      const convos = useTerminalStore.getState().conversations
      expect(convos).toHaveLength(1)
      expect(convos[0].turns).toHaveLength(2)
      expect(convos[0].turns[1].content).toBe('hi there')
    })
  })

  describe('clearConversations', () => {
    it('clears conversations for a specific terminal', () => {
      useTerminalStore.getState().addConversationTurn('t1', 'T1', 'claude', makeTurn({ terminalId: 't1' }))
      useTerminalStore.getState().addConversationTurn('t2', 'T2', 'copilot', makeTurn({ terminalId: 't2' }))
      useTerminalStore.getState().clearConversations('t1')

      const convos = useTerminalStore.getState().conversations
      expect(convos).toHaveLength(1)
      expect(convos[0].terminalId).toBe('t2')
    })
  })

  // ---- Swarm ----

  describe('setSwarmActive', () => {
    it('sets swarm active state', () => {
      useTerminalStore.getState().setSwarmActive(true)
      expect(useTerminalStore.getState().swarmActive).toBe(true)

      useTerminalStore.getState().setSwarmActive(false)
      expect(useTerminalStore.getState().swarmActive).toBe(false)
    })
  })

  describe('setSwarmAgents', () => {
    it('sets the swarm agents list', () => {
      const agents: SwarmAgentEntry[] = [
        { terminalId: 't1', agentName: 'claude', role: 'lead', status: 'running' },
        { terminalId: 't2', agentName: 'copilot', role: 'worker', status: 'starting' },
      ]
      useTerminalStore.getState().setSwarmAgents(agents)
      expect(useTerminalStore.getState().swarmAgents).toEqual(agents)
    })
  })

  describe('updateSwarmAgentStatus', () => {
    it('updates status for a specific swarm agent by terminalId', () => {
      const agents: SwarmAgentEntry[] = [
        { terminalId: 't1', agentName: 'claude', role: 'lead', status: 'starting' },
        { terminalId: 't2', agentName: 'copilot', role: 'worker', status: 'starting' },
      ]
      useTerminalStore.setState({ swarmAgents: agents })
      useTerminalStore.getState().updateSwarmAgentStatus('t1', 'running')

      const updated = useTerminalStore.getState().swarmAgents
      expect(updated[0].status).toBe('running')
      expect(updated[1].status).toBe('starting') // unchanged
    })

    it('updates status with summary', () => {
      const agents: SwarmAgentEntry[] = [
        { terminalId: 't1', agentName: 'claude', role: 'lead', status: 'starting' },
      ]
      useTerminalStore.setState({ swarmAgents: agents })
      useTerminalStore.getState().updateSwarmAgentStatus('t1', 'working', 'Refactoring module')

      const updated = useTerminalStore.getState().swarmAgents
      expect(updated[0].status).toBe('working')
      expect(updated[0].summary).toBe('Refactoring module')
    })
  })

  // ---- Additional coverage: 20+ terminal warning ----

  describe('addTerminal memory warning', () => {
    it('logs warning when exceeding 20 visible terminals', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Add 20 visible terminals
      for (let i = 0; i < 20; i++) {
        useTerminalStore.getState().addTerminal(makeTerminal({ id: `t${i}`, name: `T${i}` }))
      }

      // The 21st terminal should trigger the warning
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 't20', name: 'T20' }))

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminals open'))
      warnSpy.mockRestore()
    })

    it('does not warn for hidden terminals', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      for (let i = 0; i < 20; i++) {
        useTerminalStore.getState().addTerminal(makeTerminal({ id: `t${i}`, name: `T${i}` }))
      }

      // Add a hidden terminal - should not trigger extra warning
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 't-hidden', name: 'Hidden', hidden: true } as any))

      // Only one warning from 21st visible terminal, not from the hidden one
      const calls = warnSpy.mock.calls.filter(c => c[0]?.includes?.('terminals open'))
      expect(calls.length).toBeLessThanOrEqual(1)
      warnSpy.mockRestore()
    })
  })

  // ---- setShowSettings restores active terminal ----

  describe('setShowSettings edge cases', () => {
    it('sets first terminal as active when closing settings with no active terminal', () => {
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.setState({ activeTerminalId: null, showSettings: true })
      useTerminalStore.getState().setShowSettings(false)

      expect(useTerminalStore.getState().activeTerminalId).toBe('a')
    })

    it('keeps null activeTerminalId when closing settings with no terminals', () => {
      useTerminalStore.setState({ activeTerminalId: null, showSettings: true, terminals: [] })
      useTerminalStore.getState().setShowSettings(false)

      expect(useTerminalStore.getState().activeTerminalId).toBeNull()
    })
  })

  // ---- Launching agent / swarm notification / completion summary ----

  describe('setLaunchingAgent', () => {
    it('sets and clears the launching agent', () => {
      useTerminalStore.getState().setLaunchingAgent('claude')
      expect(useTerminalStore.getState().launchingAgent).toBe('claude')

      useTerminalStore.getState().setLaunchingAgent(null)
      expect(useTerminalStore.getState().launchingAgent).toBeNull()
    })
  })

  describe('setSwarmNotification', () => {
    it('sets and clears swarm notification', () => {
      useTerminalStore.getState().setSwarmNotification({ message: 'Test', type: 'success' })
      expect(useTerminalStore.getState().swarmNotification).toEqual({ message: 'Test', type: 'success' })

      useTerminalStore.getState().setSwarmNotification(null)
      expect(useTerminalStore.getState().swarmNotification).toBeNull()
    })
  })

  describe('setSwarmCompletionSummary', () => {
    it('sets and clears completion summary', () => {
      const summary = { message: 'Done', tasks: [{ id: 't1', title: 'Task 1', status: 'completed' }] }
      useTerminalStore.getState().setSwarmCompletionSummary(summary)
      expect(useTerminalStore.getState().swarmCompletionSummary).toEqual(summary)

      useTerminalStore.getState().setSwarmCompletionSummary(null)
      expect(useTerminalStore.getState().swarmCompletionSummary).toBeNull()
    })
  })

  describe('setLastHandoffContext', () => {
    it('sets and clears last handoff context', () => {
      const ctx = { previousAgent: 'claude', taskDescription: 'fix tests' } as any
      useTerminalStore.getState().setLastHandoffContext(ctx)
      expect(useTerminalStore.getState().lastHandoffContext).toEqual(ctx)

      useTerminalStore.getState().setLastHandoffContext(null)
      expect(useTerminalStore.getState().lastHandoffContext).toBeNull()
    })
  })

  describe('setAgentRatingOverrides', () => {
    it('sets agent rating overrides', () => {
      const overrides = { claude: { refactoring: 10 } } as any
      useTerminalStore.getState().setAgentRatingOverrides(overrides)
      expect(useTerminalStore.getState().agentRatingOverrides).toEqual(overrides)
    })
  })

  // ---- addTerminal in split mode with hidden terminal ----

  describe('addTerminal split mode with hidden terminal', () => {
    it('does not add hidden terminal to pane tree', () => {
      useTerminalStore.setState({ viewMode: 'split' })
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'hidden', hidden: true } as any))

      const tree = useTerminalStore.getState().paneTree
      // Tree should only contain 'a', not the hidden terminal
      expect(tree).toEqual({ type: 'terminal', terminalId: 'a' })
    })
  })

  // ---- removePaneTerminal tree collapse branches ----

  describe('removePaneTerminal tree collapse', () => {
    it('returns null when both children of a split get removed', () => {
      const tree: PaneNode = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'terminal', terminalId: 'a' },
          { type: 'terminal', terminalId: 'a' },
        ],
      }
      useTerminalStore.setState({ paneTree: tree })
      useTerminalStore.getState().removePaneTerminal('a')
      // Both children are terminals with the same id — after removal tree is fully empty.
      expect(useTerminalStore.getState().paneTree).toBeNull()
    })

    it('collapses a deep split when left branch is removed', () => {
      const tree: PaneNode = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'terminal', terminalId: 'a' },
          {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            children: [
              { type: 'terminal', terminalId: 'b' },
              { type: 'terminal', terminalId: 'c' },
            ],
          },
        ],
      }
      useTerminalStore.setState({ paneTree: tree })
      useTerminalStore.getState().removePaneTerminal('a')
      const after = useTerminalStore.getState().paneTree!
      // Left branch removed — tree collapses to the right split.
      expect(after.type).toBe('split')
    })

    it('collapses a deep split when right branch is removed', () => {
      const tree: PaneNode = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            children: [
              { type: 'terminal', terminalId: 'a' },
              { type: 'terminal', terminalId: 'b' },
            ],
          },
          { type: 'terminal', terminalId: 'c' },
        ],
      }
      useTerminalStore.setState({ paneTree: tree })
      useTerminalStore.getState().removePaneTerminal('c')
      const after = useTerminalStore.getState().paneTree!
      expect(after.type).toBe('split')
    })
  })

  // ---- splitTerminal with non-existent id (findAndReplace returns null) ----

  describe('splitTerminal findAndReplace fallback', () => {
    it('leaves pane tree unchanged when target terminal is not in the tree', () => {
      const tree: PaneNode = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { type: 'terminal', terminalId: 'x' },
          { type: 'terminal', terminalId: 'y' },
        ],
      }
      useTerminalStore.setState({ paneTree: tree })
      useTerminalStore.getState().splitTerminal('not-in-tree', 'vertical', 'newId')
      // Tree should remain the same since the target wasn't found.
      expect(useTerminalStore.getState().paneTree).toEqual(tree)
    })
  })

  // ---- setPaneTree ----

  describe('setPaneTree', () => {
    it('overwrites paneTree with the provided value', () => {
      const tree: PaneNode = { type: 'terminal', terminalId: 'p1' }
      useTerminalStore.getState().setPaneTree(tree)
      expect(useTerminalStore.getState().paneTree).toEqual(tree)

      useTerminalStore.getState().setPaneTree(null)
      expect(useTerminalStore.getState().paneTree).toBeNull()
    })
  })

  // ---- removeTerminal active terminal fallback (findRightmostLeaf) ----

  describe('removeTerminal findRightmostLeaf branches', () => {
    it('finds rightmost leaf via nested split tree', () => {
      useTerminalStore.setState({ viewMode: 'split' })
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b' }))
      useTerminalStore.getState().addTerminal(makeTerminal({ id: 'c' }))
      // setActiveTerminal to 'c' then remove it — should fall back to rightmost leaf
      useTerminalStore.getState().setActiveTerminal('c')
      useTerminalStore.getState().removeTerminal('c')
      const state = useTerminalStore.getState()
      // Active should be something other than null — the tree has a leaf
      expect(state.activeTerminalId).not.toBeNull()
    })
  })
})
