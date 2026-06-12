import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TerminalSession, Workspace, ViewMode, ShellType, PaneNode, AIProfile, PromptTemplate, WorkflowTemplate, CustomKeybinding } from '../types'
import { DEFAULT_KEYBINDINGS, type KeybindingMap } from '../lib/keybindings'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../lib/voice/voiceTypes'
import type { ConversationIndex, ConversationTurn } from '../lib/conversationParser'
import type { AgentRatingOverrides } from '../lib/agentCapabilities'

// ---- Pane tree helpers ----

export function buildPaneTree(terminalIds: string[], depth = 0): PaneNode | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return { type: 'terminal', terminalId: terminalIds[0] }
  // Alternate directions for a grid layout: rows first (horizontal), then columns (vertical).
  // Weight the ratio by leaf count so every terminal gets equal area regardless of N.
  const direction = depth % 2 === 0 ? 'horizontal' : 'vertical'
  const mid = Math.ceil(terminalIds.length / 2)
  const left = buildPaneTree(terminalIds.slice(0, mid), depth + 1)
  const right = buildPaneTree(terminalIds.slice(mid), depth + 1)
  if (!left) return right
  if (!right) return left
  const ratio = mid / terminalIds.length
  return { type: 'split', direction, ratio, children: [left, right] }
}

function findAndReplace(node: PaneNode, terminalId: string, replacement: PaneNode): PaneNode | null {
  if (node.type === 'terminal') {
    return node.terminalId === terminalId ? replacement : null
  }
  const leftResult = findAndReplace(node.children[0], terminalId, replacement)
  if (leftResult) return { ...node, children: [leftResult, node.children[1]] }
  const rightResult = findAndReplace(node.children[1], terminalId, replacement)
  if (rightResult) return { ...node, children: [node.children[0], rightResult] }
  return null
}

function removeFromTree(node: PaneNode, terminalId: string): PaneNode | null {
  if (node.type === 'terminal') {
    return node.terminalId === terminalId ? null : node
  }
  const leftResult = removeFromTree(node.children[0], terminalId)
  const rightResult = removeFromTree(node.children[1], terminalId)
  if (!leftResult && !rightResult) return null
  if (!leftResult) return rightResult
  if (!rightResult) return leftResult
  return { ...node, children: [leftResult, rightResult] }
}

export type SwarmAgentStatus = 'starting' | 'thinking' | 'waiting_for_input' | 'working' | 'idle' | 'errored' | 'completed' | 'blocked'

export interface SwarmAgentEntry {
  terminalId: string
  agentName: string
  role: string
  status: SwarmAgentStatus
  /** One-line summary of what the agent is doing */
  summary?: string
}

interface TerminalStore {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  activeTerminalId: string | null
  // Bumped on every terminal switch and on every explicit focus request. Each
  // TerminalPane's focus effect watches this so the active terminal's input line
  // is (re)focused and ready to type — on Alt+<n>/click switches AND after voice
  // dictation stops (even when re-selecting the already-active terminal).
  focusNonce: number
  viewMode: ViewMode
  defaultShell: ShellType
  showSettings: boolean
  autocompleteEnabled: boolean
  sidebarCollapsed: boolean
  keybindings: KeybindingMap
  customKeybindings: CustomKeybinding[]
  voiceSettings: VoiceSettings
  paneTree: PaneNode | null
  aiProfiles: AIProfile[]
  promptTemplates: PromptTemplate[]
  userWorkflows: WorkflowTemplate[]
  conversations: ConversationIndex[]
  swarmActive: boolean
  swarmAgents: SwarmAgentEntry[]
  launchingAgent: string | null
  swarmNotification: { message: string; type: 'success' | 'error' } | null
  swarmCompletionSummary: { message: string; tasks: Array<{ id: string; title: string; status: string; result?: string }>; projectCwd?: string | null; preSwarmSha?: string | null } | null
  agentRatingOverrides: AgentRatingOverrides

  addTerminal: (t: TerminalSession) => void
  removeTerminal: (id: string) => void
  updateTerminal: (id: string, patch: Partial<Omit<TerminalSession, 'id'>>) => void
  setActiveTerminal: (id: string | null) => void
  /** Re-focus the active terminal's input line (e.g. right after voice dictation stops). */
  focusActiveTerminal: () => void
  toggleViewMode: () => void
  setShowSettings: (show: boolean) => void
  setDefaultShell: (shell: ShellType) => void
  addWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  updateWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void
  setAutocompleteEnabled: (enabled: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setKeybinding: (action: keyof KeybindingMap, binding: string) => void
  resetKeybindings: () => void
  addCustomKeybinding: (binding: CustomKeybinding) => void
  updateCustomKeybinding: (id: string, patch: Partial<Omit<CustomKeybinding, 'id'>>) => void
  removeCustomKeybinding: (id: string) => void
  setVoiceSettings: (patch: Partial<VoiceSettings>) => void
  setPaneTree: (tree: PaneNode | null) => void
  splitTerminal: (terminalId: string, direction: 'horizontal' | 'vertical', newTerminalId: string) => void
  removePaneTerminal: (terminalId: string) => void
  addAIProfile: (profile: AIProfile) => void
  removeAIProfile: (id: string) => void
  addPromptTemplate: (template: PromptTemplate) => void
  removePromptTemplate: (id: string) => void
  addUserWorkflow: (workflow: WorkflowTemplate) => void
  updateUserWorkflow: (id: string, patch: Partial<Omit<WorkflowTemplate, 'id'>>) => void
  removeUserWorkflow: (id: string) => void
  setUserWorkflows: (workflows: WorkflowTemplate[]) => void
  addConversationTurn: (terminalId: string, terminalName: string, agentName: string, turn: ConversationTurn) => void
  clearConversations: (terminalId: string) => void
  setSwarmActive: (active: boolean) => void
  setSwarmAgents: (agents: SwarmAgentEntry[]) => void
  updateSwarmAgentStatus: (terminalId: string, status: SwarmAgentStatus, summary?: string) => void
  setLaunchingAgent: (name: string | null) => void
  setSwarmNotification: (notification: { message: string; type: 'success' | 'error' } | null) => void
  setSwarmCompletionSummary: (summary: { message: string; tasks: Array<{ id: string; title: string; status: string; result?: string }>; projectCwd?: string | null; preSwarmSha?: string | null } | null) => void
  setAgentRatingOverrides: (overrides: AgentRatingOverrides) => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  terminals: [],
  workspaces: [],
  activeTerminalId: null,
  focusNonce: 0,
  viewMode: 'tabs',
  defaultShell: navigator.platform.startsWith('Win') ? 'powershell' : navigator.platform.startsWith('Mac') ? 'zsh' : 'bash',
  showSettings: false,
  autocompleteEnabled: true,
  sidebarCollapsed: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  customKeybindings: [],
  voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
  paneTree: null,
  aiProfiles: [],
  promptTemplates: [],
  userWorkflows: [],
  conversations: [],
  swarmActive: false,
  swarmAgents: [],
  launchingAgent: null,
  swarmNotification: null,
  swarmCompletionSummary: null,
  agentRatingOverrides: {},

  addTerminal: (t) => set(s => {
    const visibleCount = s.terminals.filter(t => !t.hidden).length
    if (visibleCount >= 20 && !t.hidden) {
      console.warn(`[Termpolis] ${visibleCount + 1} terminals open — consider closing unused terminals to reduce memory usage`)
    }
    const newTerminals = [...s.terminals, t]
    let newTree = s.paneTree
    if (s.viewMode === 'split' && !t.hidden) {
      const visibleIds = newTerminals.filter(x => !x.hidden).map(x => x.id)
      newTree = buildPaneTree(visibleIds)
    }
    return {
      terminals: newTerminals,
      activeTerminalId: t.id,
      showSettings: false,
      paneTree: newTree,
      focusNonce: s.focusNonce + 1,
    }
  }),

  removeTerminal: (id) => set(s => {
    const remaining = s.terminals.filter(t => t.id !== id)
    const nextActive = s.activeTerminalId === id
      ? (remaining[remaining.length - 1]?.id ?? null)
      : s.activeTerminalId
    // Rebuild from scratch so every remaining pane gets equal area in split view.
    const newTree = s.viewMode === 'split'
      ? buildPaneTree(remaining.filter(t => !t.hidden).map(t => t.id))
      : (s.paneTree ? removeFromTree(s.paneTree, id) : null)
    return { terminals: remaining, activeTerminalId: nextActive, paneTree: newTree, focusNonce: s.focusNonce + 1 }
  }),

  updateTerminal: (id, patch) => set(s => ({
    terminals: s.terminals.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTerminal: (id) => set(s => ({ activeTerminalId: id, showSettings: false, focusNonce: s.focusNonce + 1 })),
  focusActiveTerminal: () => set(s => ({ focusNonce: s.focusNonce + 1 })),

  toggleViewMode: () => set(s => {
    const newMode: ViewMode = s.viewMode === 'tabs' ? 'split' : 'tabs'
    // Always rebuild the pane tree on entering split mode so every pane gets equal area.
    const newTree = newMode === 'split'
      ? buildPaneTree(s.terminals.filter(t => !t.hidden).map(t => t.id))
      : s.paneTree
    return { viewMode: newMode, paneTree: newTree }
  }),

  setShowSettings: (show) => set(s => ({
    showSettings: show,
    // Don't clear activeTerminalId — preserve it so closing settings returns to the same terminal
    activeTerminalId: !show && !s.activeTerminalId ? (s.terminals[0]?.id || null) : s.activeTerminalId,
  })),

  setDefaultShell: (shell) => set({ defaultShell: shell }),

  addWorkspace: (name) => set(s => ({
    workspaces: [...s.workspaces, {
      id: uuid(),
      name,
      terminals: s.terminals.map(({ id, ...rest }) => rest),
    }],
  })),

  renameWorkspace: (id, name) => set(s => ({
    workspaces: s.workspaces.map(w => w.id === id ? { ...w, name } : w),
  })),

  updateWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.map(w => w.id === id
      ? { ...w, terminals: s.terminals.map(({ id, ...rest }) => rest) }
      : w
    ),
  })),

  removeWorkspace: (id) => set(s => ({
    workspaces: s.workspaces.filter(w => w.id !== id),
  })),

  setAutocompleteEnabled: (enabled) => set({ autocompleteEnabled: enabled }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setKeybinding: (action, binding) => set(s => ({
    keybindings: { ...s.keybindings, [action]: binding },
  })),

  resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),

  addCustomKeybinding: (binding) => set(s => ({
    customKeybindings: [...s.customKeybindings, binding],
  })),

  updateCustomKeybinding: (id, patch) => set(s => ({
    customKeybindings: s.customKeybindings.map(c => c.id === id ? { ...c, ...patch, id } : c),
  })),

  removeCustomKeybinding: (id) => set(s => ({
    customKeybindings: s.customKeybindings.filter(c => c.id !== id),
  })),

  setVoiceSettings: (patch) => set(s => ({ voiceSettings: { ...s.voiceSettings, ...patch } })),

  setPaneTree: (tree) => set({ paneTree: tree }),

  splitTerminal: (terminalId, direction, newTerminalId) => set(s => {
    if (!s.paneTree) return {}
    const replacement: PaneNode = {
      type: 'split',
      direction,
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId },
        { type: 'terminal', terminalId: newTerminalId },
      ],
    }
    const newTree = findAndReplace(s.paneTree, terminalId, replacement)
    return { paneTree: newTree || s.paneTree, activeTerminalId: newTerminalId }
  }),

  removePaneTerminal: (terminalId) => set(s => {
    if (!s.paneTree) return {}
    const newTree = removeFromTree(s.paneTree, terminalId)
    return { paneTree: newTree }
  }),

  addAIProfile: (profile) => set(s => ({
    aiProfiles: [...s.aiProfiles, profile],
  })),

  removeAIProfile: (id) => set(s => ({
    aiProfiles: s.aiProfiles.filter(p => p.id !== id),
  })),

  addPromptTemplate: (template) => set(s => ({
    promptTemplates: [...s.promptTemplates, template],
  })),

  removePromptTemplate: (id) => set(s => ({
    promptTemplates: s.promptTemplates.filter(t => t.id !== id),
  })),

  addUserWorkflow: (workflow) => set(s => ({
    userWorkflows: [...s.userWorkflows, workflow],
  })),

  updateUserWorkflow: (id, patch) => set(s => ({
    userWorkflows: s.userWorkflows.map(w => w.id === id ? { ...w, ...patch, id } : w),
  })),

  removeUserWorkflow: (id) => set(s => ({
    userWorkflows: s.userWorkflows.filter(w => w.id !== id),
  })),

  setUserWorkflows: (workflows) => set({ userWorkflows: workflows }),

  addConversationTurn: (terminalId, terminalName, agentName, turn) => set(s => {
    const existing = s.conversations.find(c => c.terminalId === terminalId)
    if (existing) {
      return {
        conversations: s.conversations.map(c =>
          c.terminalId === terminalId
            ? { ...c, turns: [...c.turns, turn] }
            : c
        ),
      }
    }
    return {
      conversations: [...s.conversations, {
        turns: [turn],
        terminalId,
        terminalName,
        agentName,
        startedAt: Date.now(),
      }],
    }
  }),

  clearConversations: (terminalId) => set(s => ({
    conversations: s.conversations.filter(c => c.terminalId !== terminalId),
  })),

  setSwarmActive: (active) => set({ swarmActive: active }),

  setSwarmAgents: (agents) => set({ swarmAgents: agents }),

  updateSwarmAgentStatus: (terminalId, status, summary) => set(s => ({
    swarmAgents: s.swarmAgents.map(a =>
      a.terminalId === terminalId ? { ...a, status, ...(summary !== undefined && { summary }) } : a
    ),
  })),

  setLaunchingAgent: (name) => set({ launchingAgent: name }),

  setSwarmNotification: (notification) => set({ swarmNotification: notification }),

  setSwarmCompletionSummary: (summary) => set({ swarmCompletionSummary: summary }),
  setAgentRatingOverrides: (overrides) => set({ agentRatingOverrides: overrides }),
}))
