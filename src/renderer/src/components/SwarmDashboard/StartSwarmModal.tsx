import React, { useState, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useTerminalStore, buildPaneTree } from '../../store/terminalStore'
import type { SwarmAgentEntry } from '../../store/terminalStore'
import { getHomedir } from '../../lib/homedir'
import { TERMINAL_DEFAULTS } from '../../lib/terminalDefaults'
import type { ShellInfo, ShellType } from '../../types'
import { startBridgeForAgent } from '../../lib/swarmBridgeManager'

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
]

// ---- Task breakdown entry ----

interface TaskAssignment {
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

// ---- Smart role suggestions ----

function suggestRoles(agents: AgentDef[]): { agentId: string; role: string }[] {
  const rolePool = [
    'Lead -- analyze codebase and create plan',
    'Implementation -- execute the changes',
    'Testing & Review -- write tests and review',
    'Documentation & QA -- verify quality and document',
  ]
  return agents.map((a, i) => ({
    agentId: a.id,
    role: rolePool[i % rolePool.length],
  }))
}

function suggestTasks(taskDescription: string, agents: AgentDef[]): TaskAssignment[] {
  const roles = suggestRoles(agents)
  const taskParts = taskDescription.split(/[,;]+/).map(s => s.trim()).filter(Boolean)

  return agents.map((agent, i) => {
    const suggestedRole = roles[i]?.role ?? 'General'
    const suggestedTask = taskParts[i] ?? taskDescription
    return {
      agentId: agent.id,
      agentName: agent.name,
      role: suggestedRole,
      task: suggestedTask,
    }
  })
}

// ---- Helpers for sending text line by line ----

function sendLineByLine(terminalId: string, text: string, delayMs = 50): Promise<void> {
  return new Promise(resolve => {
    const lines = text.split('\n')
    let i = 0
    function sendNext() {
      if (i >= lines.length) {
        // Send Enter to submit
        setTimeout(() => {
          window.termpolis.writeToTerminal(terminalId, '\r')
          resolve()
        }, delayMs)
        return
      }
      const line = lines[i]
      window.termpolis.writeToTerminal(terminalId, line + (i < lines.length - 1 ? '\n' : ''))
      i++
      setTimeout(sendNext, delayMs)
    }
    sendNext()
  })
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
  const [assignments, setAssignments] = useState<TaskAssignment[]>([])
  const [launchProgress, setLaunchProgress] = useState('')
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

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
    const suggested = suggestTasks(taskDescription, selectedAgents)
    setAssignments(suggested)
    setStep('breakdown')
  }

  const updateAssignment = (index: number, field: 'role' | 'task', value: string) => {
    setAssignments(prev => prev.map((a, i) => i === index ? { ...a, [field]: value } : a))
  }

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

    // Step 2: Wait for shell init, then send agent commands
    setLaunchProgress('Waiting for shells to initialize...')
    await delay(1500)

    for (let i = 0; i < terminalIds.length; i++) {
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignments[i].agentId)!
      setLaunchProgress(`Starting ${agent.name}...`)
      window.termpolis.writeToTerminal(terminalIds[i], agent.command + '\r')
    }

    // Step 3: Wait for agents to initialize
    setLaunchProgress('Waiting for agents to initialize...')
    await delay(2000)

    // Step 4: Send task prompts
    for (let i = 0; i < terminalIds.length; i++) {
      const assignment = assignments[i]
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignment.agentId)!
      setLaunchProgress(`Sending task to ${agent.name}...`)

      // Build the other agents list
      const othersLines = assignments
        .filter((_, j) => j !== i)
        .map(a => `- ${a.agentName}: ${a.role}`)
        .join('\n')

      const prompt = [
        `You are part of a multi-agent swarm in Termpolis. Your role: ${assignment.role}`,
        '',
        `Your task: ${assignment.task}`,
        '',
        'Other agents in this swarm:',
        othersLines,
        '',
        'You can coordinate via the Termpolis MCP tools:',
        '- swarm_send_message: send a message to another agent',
        '- swarm_read_messages: check for messages from other agents',
        '- swarm_list_tasks: see all tasks',
        '- swarm_update_task: mark your task as complete with results',
        '',
        'Please begin working on your task. When done, use swarm_update_task to report your results.',
      ].join('\n')

      await sendLineByLine(terminalIds[i], prompt, 50)
      await delay(200)
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

    // Step 8: Start swarm bridge for non-MCP agents
    // Only Claude Code has MCP tools — bridge all others
    for (let i = 0; i < terminalIds.length; i++) {
      const agent = AVAILABLE_AGENTS.find(a => a.id === assignments[i].agentId)!
      if (agent.name !== 'Claude Code') {
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
        <p className="text-sm text-[#bbb] mb-4">Select 2 or more AI agents for the swarm.</p>
        <div className="grid grid-cols-2 gap-3">
          {AVAILABLE_AGENTS.map(agent => {
            const selected = selectedIds.has(agent.id)
            return (
              <button
                key={agent.id}
                onClick={() => toggleAgent(agent.id)}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                  selected
                    ? 'bg-[#22D3EE]/10 border-[#22D3EE]/40'
                    : 'bg-[#2d2d2d] border-[#3c3c3c] hover:border-[#555]'
                }`}
              >
                <div className={`w-5 h-5 rounded border flex items-center justify-center text-[10px] ${
                  selected ? 'bg-[#22D3EE] border-[#22D3EE] text-[#1e1e1e]' : 'border-[#555] text-transparent'
                }`}>
                  <i className="fa-solid fa-check"></i>
                </div>
                <i className={agent.icon} style={{ color: agent.color, fontSize: '14px' }}></i>
                <div>
                  <div className="text-sm font-medium text-[#d4d4d4]">{agent.name}</div>
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
    return (
      <div>
        <p className="text-sm text-[#bbb] mb-4">Review and edit the task breakdown for each agent.</p>
        <div className="space-y-3">
          {assignments.map((assignment, i) => {
            const agent = AVAILABLE_AGENTS.find(a => a.id === assignment.agentId)!
            return (
              <div key={assignment.agentId} className="bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <i className={agent.icon} style={{ color: agent.color, fontSize: '13px' }}></i>
                  <span className="text-sm font-medium text-[#d4d4d4]">{agent.name}</span>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-[#6b7280] mb-1 block">Role</label>
                    <input
                      value={assignment.role}
                      onChange={e => updateAssignment(i, 'role', e.target.value)}
                      className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-xs text-[#d4d4d4] outline-none focus:border-[#22D3EE]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-[#6b7280] mb-1 block">Task</label>
                    <textarea
                      value={assignment.task}
                      onChange={e => updateAssignment(i, 'task', e.target.value)}
                      rows={2}
                      className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-1.5 text-xs text-[#d4d4d4] outline-none focus:border-[#22D3EE] resize-none"
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
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
