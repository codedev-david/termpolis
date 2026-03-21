import React, { useState, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useTerminalStore, buildPaneTree } from '../../store/terminalStore'
import type { SwarmAgentEntry } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import type { ShellInfo, ShellType } from '../../types'
import { startBridgeForAgent } from '../../lib/swarmBridgeManager'
import { analyzeTask } from '../../lib/taskAnalyzer'
import { routeTasks, reassignTask, estimateCosts, totalEstimatedCost } from '../../lib/smartRouter'
import type { TaskAssignment as SmartTaskAssignment } from '../../lib/smartRouter'
import { AGENT_CAPABILITIES, CATEGORY_LABELS } from '../../lib/agentCapabilities'

// ---- Available agents ----

interface AgentDef {
  id: string
  name: string
  icon: string
  command: string
  shell: string
  color: string
}

const AVAILABLE_AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', icon: 'fa-solid fa-robot', command: 'claude', shell: 'bash', color: '#D97706' },
  { id: 'codex', name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', command: 'codex', shell: 'bash', color: '#10B981' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'fa-brands fa-google', command: 'gemini', shell: 'bash', color: '#4285F4' },
  { id: 'aider', name: 'Aider', icon: 'fa-solid fa-code', command: 'aider', shell: 'bash', color: '#8B5CF6' },
  { id: 'aider-qwen', name: 'Aider + Qwen3', icon: 'fa-solid fa-code-branch', command: 'aider --model qwen3', shell: 'bash', color: '#EC4899' },
]

// ---- Legacy task assignment for launch ----

interface LegacyTaskAssignment {
  agentId: string
  agentName: string
  role: string
  task: string
}

// ---- Shell resolution (matches AIProfiles logic) ----

function resolveShellType(profileShell: string, availableShells: ShellInfo[]): ShellType {
  const available = availableShells.map(s => s.type)
  if (profileShell === 'bash') {
    if (navigator.platform.startsWith('Win') && available.includes('gitbash')) return 'gitbash'
    if (available.includes('bash')) return 'bash'
  }
  if (available.includes(profileShell as ShellType)) return profileShell as ShellType
  return available[0] ?? 'bash'
}

// ---- Score color helper ----

function scoreColor(score: number): string {
  if (score >= 80) return '#10B981'  // green
  if (score >= 60) return '#D97706'  // amber
  return '#EF4444'                    // red
}

// ---- Component ----

interface StartSwarmModalProps {
  onClose: () => void
  onLaunched: () => void
}

type Step = 'select' | 'describe' | 'breakdown' | 'launching'

export function StartSwarmModal({ onClose, onLaunched }: StartSwarmModalProps) {
  const [step, setStep] = useState<Step>('select')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [taskDescription, setTaskDescription] = useState('')
  const [smartAssignments, setSmartAssignments] = useState<SmartTaskAssignment[]>([])
  const [reassignOpen, setReassignOpen] = useState<number | null>(null)
  const [launchProgress, setLaunchProgress] = useState('')
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({})
  const [detectingAgents, setDetectingAgents] = useState(true)

  const {
    addTerminal,
    setPaneTree,
    setSwarmActive,
    setSwarmAgents,
  } = useTerminalStore()

  // Fetch available shells on mount
  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setAvailableShells(res.data)
    })
    // Detect which AI agents are installed
    window.termpolis.detectAgents().then(res => {
      if (res.success && res.data) setInstalledAgents(res.data)
      setDetectingAgents(false)
    }).catch(() => setDetectingAgents(false))
  }, [])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'launching') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, step])

  const selectedAgents = AVAILABLE_AGENTS.filter(a => selectedIds.has(a.id))

  const toggleAgent = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleProceedToDescribe = () => {
    if (selectedIds.size < 2) return
    setStep('describe')
  }

  const handleProceedToBreakdown = () => {
    if (!taskDescription.trim()) return
    const breakdown = analyzeTask(taskDescription)
    const routed = routeTasks(breakdown.subtasks, Array.from(selectedIds))
    setSmartAssignments(routed)
    setReassignOpen(null)
    setStep('breakdown')
  }

  const handleReassign = (index: number, newAgentId: string) => {
    setSmartAssignments(prev =>
      prev.map((a, i) => i === index ? reassignTask(a, newAgentId) : a)
    )
    setReassignOpen(null)
  }

  // Convert smart assignments to legacy format for launch
  const assignments: LegacyTaskAssignment[] = smartAssignments.map(sa => ({
    agentId: sa.agentId,
    agentName: sa.agentName,
    role: `${CATEGORY_LABELS[sa.subtask.category]} (Score: ${sa.score})`,
    task: sa.subtask.description,
  }))

  // ---- LAUNCH ----
  const handleLaunch = useCallback(async () => {
    setStep('launching')
    const cwd = await getHomedir()
    const terminalIds: string[] = []
    const agentEntries: SwarmAgentEntry[] = []

    // Step 1: Create terminals
    for (const assignment of assignments) {
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignment.agentId)!
      const id = uuid()
      const shellType = resolveShellType(agent.shell, availableShells)

      setLaunchProgress(`Creating terminal for ${agent.name}...`)
      const res = await window.termpolis.createTerminal(id, shellType, cwd)
      if (!res.success) {
        setLaunchProgress(`Failed to create terminal for ${agent.name}: ${res.error}`)
        continue
      }

      addTerminal({
        id,
        name: agent.name,
        color: agent.color,
        shellType,
        cwd,
        fontSize: TERMINAL_DEFAULTS.fontSize,
        theme: TERMINAL_DEFAULTS.theme,
        fontFamily: TERMINAL_DEFAULTS.fontFamily,
      })

      terminalIds.push(id)
      agentEntries.push({
        terminalId: id,
        agentName: agent.name,
        role: assignment.role,
        status: 'starting',
      })
    }

    // Set swarm state immediately
    setSwarmActive(true)
    setSwarmAgents(agentEntries)

    // Step 2: Wait for shell init, then send agent commands one at a time
    setLaunchProgress('Waiting for shells to initialize...')
    await delay(2000)

    for (let i = 0; i < terminalIds.length; i++) {
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignments[i].agentId)!
      setLaunchProgress(`Starting ${agent.name}...`)
      window.termpolis.writeToTerminal(terminalIds[i], agent.command + '\r')
      // Stagger agent launches slightly so they don't all hit the shell at once
      await delay(500)
    }

    // Step 3: Wait for agents to fully initialize
    // Claude Code takes ~5-10s, Codex takes ~3-5s, Gemini ~3-5s
    setLaunchProgress('Waiting for agents to initialize (this takes 10-15 seconds)...')
    await delay(12000)

    // Step 4: Send task prompts as a SINGLE message (not line by line)
    // The agent should be fully started and waiting for input by now
    for (let i = 0; i < terminalIds.length; i++) {
      const assignment = assignments[i]
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignment.agentId)!
      setLaunchProgress(`Sending task to ${agent.name}...`)

      // Build the other agents list
      const othersList = assignments
        .filter((_, j) => j !== i)
        .map(a => `${a.agentName}: ${a.role}`)
        .join(', ')

      // Send as a single compact message — the agent reads it as one prompt
      const prompt = `You are part of a multi-agent swarm. Your role: ${assignment.role}. Your task: ${assignment.task}. Other agents: ${othersList}. If you have Termpolis MCP tools, use swarm_send_message and swarm_update_task to coordinate. Begin working now.`

      window.termpolis.writeToTerminal(terminalIds[i], prompt + '\r')
      await delay(500)
    }

    // Step 5: Create swarm tasks via API
    setLaunchProgress('Creating swarm tasks...')
    for (const assignment of assignments) {
      const termId = terminalIds[assignments.indexOf(assignment)]
      await window.swarmAPI.createTask(
        `${assignment.agentName}: ${assignment.role}`,
        assignment.task,
        'swarm-orchestrator',
        termId,
      )
    }

    // Step 6: Broadcast intro message
    setLaunchProgress('Broadcasting swarm introduction...')
    const introLines = assignments.map(a => `- ${a.agentName}: ${a.role}`).join('\n')
    await window.swarmAPI.sendMessage(
      'swarm-orchestrator',
      'all',
      'info',
      `Swarm launched with ${assignments.length} agents:\n${introLines}\n\nTask: ${taskDescription}`,
    )

    // Step 7: Build split pane tree and switch to split view
    setLaunchProgress('Setting up split view...')
    const store = useTerminalStore.getState()
    const allIds = store.terminals.map(t => t.id)
    const tree = buildPaneTree(allIds)
    setPaneTree(tree)

    // Switch to split view
    if (store.viewMode !== 'split') {
      useTerminalStore.setState({ viewMode: 'split', paneTree: tree })
    }

    // Step 8: Start swarm bridge for agents without native MCP support
    // Claude Code, Codex, and Gemini CLI all have native MCP — only Aider needs the bridge
    const MCP_NATIVE_AGENTS = ['Claude Code', 'OpenAI Codex', 'Gemini CLI']
    for (let i = 0; i < terminalIds.length; i++) {
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignments[i].agentId)!
      if (!MCP_NATIVE_AGENTS.includes(agent.name)) {
        startBridgeForAgent(terminalIds[i], agent.name)
      }
    }

    // Step 9: Start health monitoring
    startHealthMonitoring(terminalIds, agentEntries)

    setLaunchProgress('Swarm launched successfully!')
    await delay(800)
    onLaunched()
  }, [assignments, availableShells, taskDescription, addTerminal, setPaneTree, setSwarmActive, setSwarmAgents, onLaunched])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={step !== 'launching' ? onClose : undefined}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[640px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-3">
            <i className="fa-solid fa-rocket text-[#22D3EE]"></i>
            <h2 className="text-base font-semibold text-[#d4d4d4]">Start Swarm</h2>
            <div className="flex items-center gap-1.5 ml-2">
              {(['select', 'describe', 'breakdown', 'launching'] as Step[]).map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <div className="w-4 h-px bg-[#3c3c3c]"></div>}
                  <div
                    className={`w-2 h-2 rounded-full transition-colors ${
                      s === step ? 'bg-[#22D3EE]' : stepIndex(step) > i ? 'bg-[#22D3EE]/50' : 'bg-[#3c3c3c]'
                    }`}
                  ></div>
                </React.Fragment>
              ))}
            </div>
          </div>
          {step !== 'launching' && (
            <button onClick={onClose} className="text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
              <i className="fa-solid fa-xmark"></i>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === 'select' && renderSelectStep()}
          {step === 'describe' && renderDescribeStep()}
          {step === 'breakdown' && renderBreakdownStep()}
          {step === 'launching' && renderLaunchingStep()}
        </div>

        {/* Footer */}
        {step !== 'launching' && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#3c3c3c]">
            <button
              onClick={step === 'select' ? onClose : () => setStep(prevStep(step))}
              className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
            >
              {step === 'select' ? 'Cancel' : 'Back'}
            </button>
            <button
              onClick={
                step === 'select' ? handleProceedToDescribe :
                step === 'describe' ? handleProceedToBreakdown :
                handleLaunch
              }
              disabled={
                (step === 'select' && selectedIds.size < 2) ||
                (step === 'describe' && !taskDescription.trim())
              }
              className={`px-4 py-1.5 text-xs rounded font-medium transition-colors ${
                (step === 'select' && selectedIds.size < 2) || (step === 'describe' && !taskDescription.trim())
                  ? 'bg-[#3c3c3c] text-[#555] cursor-not-allowed'
                  : step === 'breakdown'
                    ? 'bg-[#22D3EE] text-[#1e1e1e] hover:bg-[#06b6d4]'
                    : 'bg-[#22D3EE]/20 text-[#22D3EE] hover:bg-[#22D3EE]/30'
              }`}
            >
              {step === 'breakdown' ? (
                <><i className="fa-solid fa-rocket mr-1.5"></i>Launch Swarm</>
              ) : (
                'Next'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  // ---- Step renderers ----

  function renderSelectStep() {
    return (
      <div>
        <p className="text-sm text-[#bbb] mb-4">
          {detectingAgents ? 'Detecting installed AI agents...' : 'Select 2 or more AI agents for the swarm.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {AVAILABLE_AGENTS.map(agent => {
            const selected = selectedIds.has(agent.id)
            const installed = detectingAgents ? true : installedAgents[agent.id] !== false
            const notInstalled = !detectingAgents && installedAgents[agent.id] === false
            return (
              <button
                key={agent.id}
                onClick={() => {
                  if (notInstalled) return
                  toggleAgent(agent.id)
                }}
                disabled={notInstalled}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                  notInstalled
                    ? 'bg-[#1e1e1e] border-[#2a2a2a] opacity-50 cursor-not-allowed'
                    : selected
                      ? 'bg-[#22D3EE]/10 border-[#22D3EE]/40'
                      : 'bg-[#2d2d2d] border-[#3c3c3c] hover:border-[#555]'
                }`}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center text-[10px] ${
                  notInstalled
                    ? 'border-[#333] text-transparent'
                    : selected ? 'bg-[#22D3EE] border-[#22D3EE] text-[#1e1e1e]' : 'border-[#555] text-transparent'
                }`}>
                  <i className="fa-solid fa-check"></i>
                </div>
                <i className={agent.icon} style={{ color: notInstalled ? '#555' : agent.color, fontSize: '14px' }}></i>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${notInstalled ? 'text-[#555]' : 'text-[#d4d4d4]'}`}>{agent.name}</span>
                    {!detectingAgents && installed && (
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Installed"></span>
                    )}
                    {notInstalled && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-red-900/30 text-red-400">Not installed</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[#6b7280] font-mono">{agent.command}</div>
                </div>
              </button>
            )
          })}
        </div>
        {selectedIds.size > 0 && selectedIds.size < 2 && (
          <p className="text-xs text-[#D97706] mt-3">
            <i className="fa-solid fa-triangle-exclamation mr-1"></i>
            Select at least 2 agents to form a swarm.
          </p>
        )}
      </div>
    )
  }

  function renderDescribeStep() {
    return (
      <div>
        <p className="text-sm text-[#bbb] mb-2">Describe what the swarm should work on.</p>
        <p className="text-xs text-[#6b7280] mb-4">
          Be specific -- the task will be split across {selectedAgents.length} agents.
        </p>
        <textarea
          autoFocus
          value={taskDescription}
          onChange={e => setTaskDescription(e.target.value)}
          placeholder='e.g. "Refactor the auth module, write comprehensive tests, and review for security issues"'
          rows={5}
          className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg px-4 py-3 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none resize-none"
        />
        <div className="flex items-center gap-2 mt-3">
          {selectedAgents.map(a => (
            <span key={a.id} className="flex items-center gap-1.5 text-xs bg-[#2d2d2d] px-2 py-1 rounded border border-[#3c3c3c]">
              <i className={a.icon} style={{ color: a.color, fontSize: '10px' }}></i>
              {a.name}
            </span>
          ))}
        </div>
      </div>
    )
  }

  function renderBreakdownStep() {
    const costEstimates = estimateCosts(smartAssignments)
    const total = totalEstimatedCost(costEstimates)
    const availableForReassign = AVAILABLE_AGENTS.filter(a => selectedIds.has(a.id))

    return (
      <div>
        <p className="text-sm text-[#bbb] mb-4">
          Smart routing analyzed your task and assigned each subtask to the best agent.
        </p>
        <div className="space-y-3">
          {smartAssignments.map((sa, i) => {
            const agent = AVAILABLE_AGENTS.find(a => a.id === sa.agentId)
            const agentIcon = agent?.icon ?? 'fa-solid fa-robot'
            const agentColor = agent?.color ?? '#6b7280'

            return (
              <div key={i} className="bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg p-4">
                {/* Task title and category badge */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[#d4d4d4]">{sa.subtask.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e1e1e] text-[#6b7280] border border-[#3c3c3c]">
                      {CATEGORY_LABELS[sa.subtask.category]}
                    </span>
                  </div>
                  <span
                    className="text-xs font-semibold"
                    style={{ color: scoreColor(sa.score) }}
                  >
                    {sa.score}/100
                  </span>
                </div>

                {/* Agent assignment */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-[#6b7280]">Assigned to:</span>
                  <i className={agentIcon} style={{ color: agentColor, fontSize: '11px' }}></i>
                  <span className="text-xs font-medium text-[#d4d4d4]">{sa.agentName}</span>
                </div>

                {/* Reason */}
                <p className="text-[11px] text-[#888] mb-3 leading-relaxed">{sa.reason}</p>

                {/* Reassign button */}
                <div className="relative">
                  <button
                    onClick={() => setReassignOpen(reassignOpen === i ? null : i)}
                    className="text-[10px] text-[#22D3EE] hover:text-[#06b6d4] flex items-center gap-1"
                  >
                    <i className="fa-solid fa-shuffle text-[9px]"></i>
                    Reassign
                    <i className={`fa-solid fa-chevron-${reassignOpen === i ? 'up' : 'down'} text-[8px]`}></i>
                  </button>
                  {reassignOpen === i && (
                    <div className="absolute left-0 top-6 z-10 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-xl py-1 min-w-[180px]">
                      {availableForReassign.map(alt => {
                        const cap = AGENT_CAPABILITIES.find(c => c.agentId === alt.id)
                        const strength = cap?.strengths[sa.subtask.category] ?? 0
                        const isCurrentAgent = alt.id === sa.agentId
                        return (
                          <button
                            key={alt.id}
                            onClick={() => handleReassign(i, alt.id)}
                            disabled={isCurrentAgent}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                              isCurrentAgent
                                ? 'text-[#555] cursor-default'
                                : 'text-[#d4d4d4] hover:bg-[#37373d]'
                            }`}
                          >
                            <i className={alt.icon} style={{ color: alt.color, fontSize: '10px' }}></i>
                            <span className="text-xs flex-1">{alt.name}</span>
                            <span className="text-[10px] text-[#6b7280]">{strength}/5</span>
                            {isCurrentAgent && (
                              <i className="fa-solid fa-check text-[9px] text-[#22D3EE]"></i>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Token budget estimate */}
        {costEstimates.length > 0 && (
          <div className="mt-4 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <i className="fa-solid fa-coins text-[#D97706] text-[11px]"></i>
              <span className="text-xs font-medium text-[#d4d4d4]">Token Budget Estimate</span>
            </div>
            <div className="space-y-1">
              {costEstimates.map(est => (
                <div key={est.agentId} className="flex items-center justify-between text-[11px]">
                  <span className="text-[#888]">{est.agentName}</span>
                  <span className="text-[#6b7280]">
                    ~{(est.estimatedTokens / 1000).toFixed(0)}K tokens
                    <span className="ml-2 text-[#d4d4d4]">{est.estimatedCost}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-[#3c3c3c] flex items-center justify-between text-xs">
              <span className="text-[#888]">Total estimated</span>
              <span className="font-medium text-[#d4d4d4]">~{total}</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  function renderLaunchingStep() {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="relative mb-6">
          <i className="fa-solid fa-rocket text-[#22D3EE] text-3xl animate-pulse"></i>
        </div>
        <h3 className="text-sm font-semibold text-[#d4d4d4] mb-2">Launching Swarm</h3>
        <p className="text-xs text-[#6b7280] text-center max-w-sm">{launchProgress}</p>
        <div className="mt-4 flex items-center gap-2">
          {assignments.map(a => {
            const agent = AVAILABLE_AGENTS.find(ag => ag.id === a.agentId)!
            return (
              <span key={a.agentId} className="flex items-center gap-1 text-[10px] bg-[#2d2d2d] px-2 py-1 rounded border border-[#3c3c3c]">
                <i className={agent.icon} style={{ color: agent.color, fontSize: '9px' }}></i>
                {agent.name}
              </span>
            )
          })}
        </div>
      </div>
    )
  }
}

// ---- Health monitoring ----

function startHealthMonitoring(_terminalIds: string[], agents: SwarmAgentEntry[]) {
  const TIMEOUT_MS = 10000
  const CHECK_INTERVAL_MS = 2000
  const startTime = Date.now()

  const interval = setInterval(() => {
    const store = useTerminalStore.getState()
    const elapsed = Date.now() - startTime

    for (const entry of agents) {
      const current = store.swarmAgents.find(a => a.terminalId === entry.terminalId)
      if (!current || current.status !== 'starting') continue

      // Check if the terminal still exists (not closed)
      const terminalExists = store.terminals.some(t => t.id === entry.terminalId)
      if (!terminalExists) {
        store.updateSwarmAgentStatus(entry.terminalId, 'error')
        continue
      }

      // If agent detection picked up the agent, mark as running
      // (We rely on the agent detector in TerminalPane to detect the agent)
      // For now, after 3.5s assume running since the command was sent at ~1.5s
      if (elapsed >= 3500) {
        store.updateSwarmAgentStatus(entry.terminalId, 'running')
      }

      // If still starting after timeout, mark as error
      if (elapsed >= TIMEOUT_MS && current.status === 'starting') {
        store.updateSwarmAgentStatus(entry.terminalId, 'error')
      }
    }

    // Stop monitoring once all agents are no longer 'starting'
    const allDone = store.swarmAgents.every(a => a.status !== 'starting')
    if (allDone || elapsed >= TIMEOUT_MS + 1000) {
      clearInterval(interval)
    }
  }, CHECK_INTERVAL_MS)
}

// ---- Utilities ----

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stepIndex(step: Step): number {
  return ['select', 'describe', 'breakdown', 'launching'].indexOf(step)
}

function prevStep(step: Step): Step {
  const steps: Step[] = ['select', 'describe', 'breakdown']
  const i = steps.indexOf(step)
  return i > 0 ? steps[i - 1] : steps[0]
}
