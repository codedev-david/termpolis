import React, { useEffect, useRef, useState, useCallback } from 'react'
import type { SwarmMessage, SwarmTask } from '../../types'
import { useTerminalStore } from '../../store/terminalStore'
import { subscribe, unsubscribe } from '../../lib/pollingService'
import { StartSwarmModal } from './StartSwarmModal'
import { stopAllBridges } from '../../lib/swarmBridgeManager'
import { stopConductor, getConductorState, revealConductor } from '../../lib/conductorManager'
import { ConductorTrace } from '../ConductorTrace/ConductorTrace'
import { HandoffAnimation } from '../HandoffAnimation/HandoffAnimation'

interface SwarmDashboardProps {
  onClose: () => void
  initialCwd?: string | null
}

type TabId = 'tasks' | 'messages' | 'trace'

export function SwarmDashboard({ onClose, initialCwd }: SwarmDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('tasks')
  const [messages, setMessages] = useState<SwarmMessage[]>([])
  const [tasks, setTasks] = useState<SwarmTask[]>([])
  const swarmActive = useTerminalStore((s) => s.swarmActive)
  // Auto-open wizard if we have an initialCwd (came from Welcome/sidebar with directory already picked)
  const [showStartSwarm, setShowStartSwarm] = useState(!!initialCwd && !swarmActive)
  const [swarmCwd, setSwarmCwd] = useState<string | null>(initialCwd ?? null)
  const [conductorStatus, setConductorStatus] = useState<string>('idle')
  const [conductorTerminalId, setConductorTerminalId] = useState<string | null>(null)
  const [handoffEvent, setHandoffEvent] = useState<{ from?: string; to: string; key: string } | null>(null)

  // Poll conductor state every 3 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const state = getConductorState()
      setConductorStatus(state.status)
      setConductorTerminalId(state.terminalId)
    }, 3000)
    // Seed immediately
    const initial = getConductorState()
    setConductorStatus(initial.status)
    setConductorTerminalId(initial.terminalId)
    return () => clearInterval(interval)
  }, [])

  // Clear confirmation
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [msgRes, taskRes] = await Promise.all([
        window.swarmAPI.getMessages(),
        window.swarmAPI.getTasks(),
      ])
      if (msgRes.success && msgRes.data) setMessages(msgRes.data)
      if (taskRes.success && taskRes.data) setTasks(taskRes.data)
    } catch {
      // Swarm API may not be ready yet — ignore
    }
  }, [])

  // Poll every 3 seconds via centralized polling service
  useEffect(() => {
    refresh()
    const pollId = 'swarm-dashboard'
    subscribe(pollId, refresh, 3000)
    return () => unsubscribe(pollId)
  }, [refresh])

  // Detect task -> agent handoffs and fire brief animation
  const prevTasksRef = useRef<SwarmTask[]>([])
  useEffect(() => {
    const prev = prevTasksRef.current
    const prevById = new Map(prev.map((t) => [t.id, t]))
    for (const t of tasks) {
      const was = prevById.get(t.id)
      if (!was && t.status === 'in_progress' && t.assignedTo) {
        setHandoffEvent({ to: t.assignedTo, key: `${t.id}-${Date.now()}` })
        break
      }
      if (was && was.status !== 'in_progress' && t.status === 'in_progress' && t.assignedTo) {
        setHandoffEvent({ from: was.assignedTo, to: t.assignedTo, key: `${t.id}-${Date.now()}` })
        break
      }
    }
    prevTasksRef.current = tasks
  }, [tasks])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showStartSwarm) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, showStartSwarm])

  const handleClearSwarm = async () => {
    stopAllBridges()
    stopConductor()
    await window.swarmAPI.clear()
    // Close and kill all swarm terminals
    const store = useTerminalStore.getState()
    const swarmTerminals = store.terminals.filter(t => t.isSwarm)
    for (const t of swarmTerminals) {
      window.termpolis.killTerminal(t.id)
      store.removeTerminal(t.id)
    }
    store.setSwarmActive(false)
    store.setSwarmAgents([])
    refresh()
  }

  const handleUpdateTaskStatus = async (taskId: string, status: string) => {
    await window.swarmAPI.updateTask(taskId, status)
    refresh()
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const typeColor = (type: string) => {
    switch (type) {
      case 'task': return 'text-yellow-400'
      case 'result': return 'text-green-400'
      case 'question': return 'text-blue-400'
      case 'info': return 'text-gray-400'
      case 'review': return 'text-purple-400'
      default: return 'text-gray-400'
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
      case 'in_progress': return 'bg-blue-500/20 text-blue-400 border-blue-500/30'
      case 'completed': return 'bg-green-500/20 text-green-400 border-green-500/30'
      case 'failed': return 'bg-red-500/20 text-red-400 border-red-500/30'
      default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30'
    }
  }

  const pendingTasks = tasks.filter((t) => t.status === 'pending')
  const inProgressTasks = tasks.filter((t) => t.status === 'in_progress')
  const completedTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'failed')

  const renderTaskColumn = (title: string, columnTasks: SwarmTask[], icon: string) => (
    <div className="flex-1 min-w-0">
      <div className="text-xs font-semibold text-[#9ca3af] uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <i className={icon}></i>
        {title} <span className="text-[10px] normal-case">({columnTasks.length})</span>
      </div>
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
        {columnTasks.length === 0 ? (
          <p className="text-[#888] text-xs text-center py-4">None</p>
        ) : (
          columnTasks.map((task) => (
            <div
              key={task.id}
              className={`p-2.5 rounded-lg border ${statusColor(task.status)} ${
                task.status === 'in_progress' ? 'animate-pulse-border relative overflow-hidden' : ''
              }`}
            >
              {task.status === 'in_progress' && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-blue-400 to-transparent animate-shimmer"></div>
              )}
              <div className="text-sm font-medium mb-1 flex items-center gap-2">
                {task.status === 'in_progress' && (
                  <i className="fa-solid fa-spinner fa-spin text-blue-400 text-[10px]"></i>
                )}
                <span>{task.title}</span>
              </div>
              {task.description && (
                <div className="text-xs opacity-70 mb-1.5 line-clamp-2">{task.description}</div>
              )}
              <div className="flex items-center gap-2 text-[10px] opacity-60">
                <span>by {task.createdBy}</span>
                {task.assignedTo && <span>-&gt; {task.assignedTo}</span>}
                <span>{formatTime(task.createdAt)}</span>
              </div>
              {task.result && (
                <div className="mt-1.5 text-xs bg-black/20 rounded p-1.5 font-mono whitespace-pre-wrap max-h-20 overflow-y-auto">{task.result}</div>
              )}
              {task.status === 'pending' && (
                <div className="mt-2 flex gap-1">
                  <button onClick={() => handleUpdateTaskStatus(task.id, 'in_progress')} className="text-[10px] px-2 py-0.5 rounded bg-blue-500/30 hover:bg-blue-500/50 text-blue-300">Start</button>
                  <button onClick={() => handleUpdateTaskStatus(task.id, 'failed')} className="text-[10px] px-2 py-0.5 rounded bg-red-500/30 hover:bg-red-500/50 text-red-300">Cancel</button>
                </div>
              )}
              {task.status === 'in_progress' && (
                <div className="mt-2 flex gap-1">
                  <button onClick={() => handleUpdateTaskStatus(task.id, 'completed')} className="text-[10px] px-2 py-0.5 rounded bg-green-500/30 hover:bg-green-500/50 text-green-300">Done</button>
                  <button onClick={() => handleUpdateTaskStatus(task.id, 'failed')} className="text-[10px] px-2 py-0.5 rounded bg-red-500/30 hover:bg-red-500/50 text-red-300">Fail</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )

  const renderTasks = () => (
    <div>
      <div className="flex gap-4">
        {renderTaskColumn('Pending', pendingTasks, 'fa-solid fa-clock')}
        {renderTaskColumn('In Progress', inProgressTasks, 'fa-solid fa-spinner')}
        {renderTaskColumn('Completed', completedTasks, 'fa-solid fa-check-circle')}
      </div>
    </div>
  )

  const renderMessages = () => (
    <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
      {messages.length === 0 ? (
        <p className="text-[#9ca3af] text-sm text-center py-8">No swarm messages yet. AI agents communicate here through MCP tools.</p>
      ) : (
        [...messages].reverse().map((msg) => (
          <div key={msg.id} className="flex items-start gap-2 p-2 rounded bg-[#2d2d2d] border border-[#3c3c3c] text-xs">
            <span className={`${typeColor(msg.type)} font-semibold uppercase w-14 shrink-0`}>{msg.type}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[#999] mb-0.5">
                <span className="text-[#d4d4d4]">{msg.from}</span>
                {' -> '}
                <span className="text-[#d4d4d4]">{msg.to}</span>
                <span className="ml-2 text-[#888]">{formatTime(msg.timestamp)}</span>
                {msg.read && <span className="ml-1.5 text-[#888]">(read)</span>}
              </div>
              <div className="text-[#bbb] whitespace-pre-wrap break-words">{msg.content}</div>
            </div>
          </div>
        ))
      )}
    </div>
  )

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'tasks', label: 'Tasks', icon: 'fa-solid fa-list-check' },
    { id: 'messages', label: 'Messages', icon: 'fa-solid fa-comments' },
    { id: 'trace', label: 'Trace', icon: 'fa-solid fa-wave-square' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[800px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-3">
            <i className="fa-solid fa-network-wired text-[#22D3EE]"></i>
            <h2 className="text-base font-semibold text-[#d4d4d4]">Swarm Dashboard</h2>
            {(swarmActive || conductorStatus === 'done') && (
              <div className="flex items-center gap-2">
                {conductorStatus === 'done' ? (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
                    <i className="fa-solid fa-circle-check mr-1 text-[8px]"></i>
                    Swarm Complete
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-[#22D3EE]/15 text-[#22D3EE] border border-[#22D3EE]/30">
                    Swarm Active
                  </span>
                )}
                {conductorStatus !== 'idle' && conductorStatus !== 'done' && (
                  <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${
                    conductorStatus === 'running' ? 'bg-green-500/15 text-green-400 border-green-500/30' :
                    conductorStatus === 'error' ? 'bg-red-500/15 text-red-400 border-red-500/30' :
                    'bg-[#3c3c3c] text-[#9ca3af] border-[#3c3c3c]'
                  }`}>
                    <i className="fa-solid fa-brain mr-1 text-[8px]"></i>
                    Conductor: {conductorStatus}
                  </span>
                )}
              </div>
            )}
            <span className="text-xs text-[#9ca3af]">
              {tasks.length} task{tasks.length !== 1 ? 's' : ''} | {messages.length} msg{messages.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {swarmActive ? (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#3c3c3c] text-[#888] cursor-not-allowed" title="Clear the current swarm before starting a new one">
                <i className="fa-solid fa-lock text-[10px]"></i>
                Swarm Active
              </span>
            ) : (
              <button
                onClick={async () => {
                  const res = await window.termpolis.pickDirectory()
                  if (res.success && res.data) {
                    setSwarmCwd(res.data)
                    setShowStartSwarm(true)
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#22D3EE] text-[#1e1e1e] hover:bg-[#06b6d4] transition-colors"
              >
                <i className="fa-solid fa-rocket"></i>
                {conductorStatus === 'done' ? 'Start New Swarm' : 'Start Swarm'}
              </button>
            )}
            <button onClick={onClose} className="text-[#9ca3af] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-[#3c3c3c]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-[#37373d] text-[#22D3EE]'
                  : 'text-[#9ca3af] hover:text-[#d4d4d4] hover:bg-[#2d2d2d]'
              }`}
            >
              <i className={tab.icon}></i>
              {tab.label}
              {tab.id === 'tasks' && tasks.length > 0 && (
                <span className="ml-1 text-[10px] bg-[#22D3EE]/20 text-[#22D3EE] px-1.5 rounded-full">
                  {tasks.length}
                </span>
              )}
              {tab.id === 'messages' && messages.length > 0 && (
                <span className="ml-1 text-[10px] bg-[#22D3EE]/20 text-[#22D3EE] px-1.5 rounded-full">
                  {messages.length}
                </span>
              )}
            </button>
          ))}
          <div className="flex-1"></div>
          {swarmActive && (
            <button
              onClick={() => revealConductor()}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-[#D97706] hover:bg-[#37373d]"
              title="Reveal conductor terminal for debugging"
            >
              <i className="fa-solid fa-bug"></i> Debug
            </button>
          )}
          <button
            onClick={() => setShowClearConfirm(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-[#E57373] hover:bg-[#37373d]"
            title="Clear all messages and tasks"
          >
            <i className="fa-solid fa-trash"></i> Clear
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'tasks' && renderTasks()}
          {activeTab === 'messages' && renderMessages()}
          {activeTab === 'trace' && (
            <ConductorTrace conductorTerminalId={conductorTerminalId} />
          )}
        </div>

        {/* Clear Confirmation Modal */}
        {showClearConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-xl" onClick={() => setShowClearConfirm(false)}>
            <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg p-5 w-96 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-triangle-exclamation text-[#E57373]"></i>
                <h3 className="text-sm font-semibold text-[#d4d4d4]">Clear Swarm</h3>
              </div>
              <p className="text-xs text-[#bbb] leading-relaxed">
                This will stop all running agents, close their terminals, and delete all tasks and messages.
                <span className="text-[#E57373] font-medium"> All swarm work will be lost.</span>
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setShowClearConfirm(false)} className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]">Cancel</button>
                <button
                  onClick={() => { setShowClearConfirm(false); handleClearSwarm() }}
                  className="px-3 py-1.5 text-xs bg-[#E57373]/20 text-[#E57373] rounded hover:bg-[#E57373]/30 font-medium"
                >
                  <i className="fa-solid fa-trash mr-1"></i>Clear Swarm
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Start Swarm Modal */}
      {showStartSwarm && swarmCwd && (
        <StartSwarmModal
          projectCwd={swarmCwd}
          onClose={() => setShowStartSwarm(false)}
          onLaunched={() => {
            setShowStartSwarm(false)
            // Stay on the dashboard so user can watch agents work
          }}
        />
      )}

      {handoffEvent && (
        <HandoffAnimation
          key={handoffEvent.key}
          fromAgent={handoffEvent.from}
          toAgent={handoffEvent.to}
          onComplete={() => setHandoffEvent(null)}
        />
      )}
    </div>
  )
}
