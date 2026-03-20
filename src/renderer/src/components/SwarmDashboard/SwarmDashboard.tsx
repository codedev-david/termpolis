import React, { useEffect, useState, useCallback } from 'react'
import type { SwarmMessage, SwarmTask } from '../../types'
import { useTerminalStore } from '../../store/terminalStore'
import { subscribe, unsubscribe } from '../../lib/pollingService'

interface SwarmDashboardProps {
  onClose: () => void
}

type TabId = 'agents' | 'tasks' | 'messages'

export function SwarmDashboard({ onClose }: SwarmDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('agents')
  const [messages, setMessages] = useState<SwarmMessage[]>([])
  const [tasks, setTasks] = useState<SwarmTask[]>([])
  const terminals = useTerminalStore((s) => s.terminals)

  // New task form
  const [showNewTask, setShowNewTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  const [taskAssignTo, setTaskAssignTo] = useState('')

  // Broadcast form
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [broadcastContent, setBroadcastContent] = useState('')
  const [broadcastType, setBroadcastType] = useState<string>('info')

  const refresh = useCallback(async () => {
    const [msgRes, taskRes] = await Promise.all([
      window.swarmAPI.getMessages(),
      window.swarmAPI.getTasks(),
    ])
    if (msgRes.success && msgRes.data) setMessages(msgRes.data)
    if (taskRes.success && taskRes.data) setTasks(taskRes.data)
  }, [])

  // Poll every 3 seconds via centralized polling service
  useEffect(() => {
    refresh()
    const pollId = 'swarm-dashboard'
    subscribe(pollId, refresh, 3000)
    return () => unsubscribe(pollId)
  }, [refresh])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleCreateTask = async () => {
    if (!taskTitle.trim()) return
    await window.swarmAPI.createTask(taskTitle, taskDesc, 'dashboard', taskAssignTo || undefined)
    setTaskTitle('')
    setTaskDesc('')
    setTaskAssignTo('')
    setShowNewTask(false)
    refresh()
  }

  const handleBroadcast = async () => {
    if (!broadcastContent.trim()) return
    await window.swarmAPI.sendMessage('dashboard', 'all', broadcastType, broadcastContent)
    setBroadcastContent('')
    setShowBroadcast(false)
    refresh()
  }

  const handleClearSwarm = async () => {
    await window.swarmAPI.clear()
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

  const renderAgents = () => (
    <div className="space-y-2">
      {terminals.length === 0 ? (
        <p className="text-[#6b7280] text-sm text-center py-8">No terminals open. AI agents appear here when running in Termpolis terminals.</p>
      ) : (
        terminals.map((t) => (
          <div key={t.id} className="flex items-center gap-3 p-3 rounded-lg bg-[#2d2d2d] border border-[#3c3c3c] hover:border-[#555]">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.color }}></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[#d4d4d4] truncate">{t.name}</div>
              <div className="text-xs text-[#6b7280] truncate">{t.cwd}</div>
            </div>
            <span className="text-xs text-[#6b7280] bg-[#1e1e1e] px-2 py-0.5 rounded font-mono">{t.shellType}</span>
            <span className="text-xs text-[#6b7280] font-mono truncate max-w-[80px]" title={t.id}>{t.id.slice(0, 8)}</span>
          </div>
        ))
      )}
    </div>
  )

  const renderTaskColumn = (title: string, columnTasks: SwarmTask[], icon: string) => (
    <div className="flex-1 min-w-0">
      <div className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <i className={icon}></i>
        {title} <span className="text-[10px] normal-case">({columnTasks.length})</span>
      </div>
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
        {columnTasks.length === 0 ? (
          <p className="text-[#555] text-xs text-center py-4">None</p>
        ) : (
          columnTasks.map((task) => (
            <div key={task.id} className={`p-2.5 rounded-lg border ${statusColor(task.status)}`}>
              <div className="text-sm font-medium mb-1">{task.title}</div>
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
        <p className="text-[#6b7280] text-sm text-center py-8">No swarm messages yet. AI agents communicate here through MCP tools.</p>
      ) : (
        [...messages].reverse().map((msg) => (
          <div key={msg.id} className="flex items-start gap-2 p-2 rounded bg-[#2d2d2d] border border-[#3c3c3c] text-xs">
            <span className={`${typeColor(msg.type)} font-semibold uppercase w-14 shrink-0`}>{msg.type}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[#999] mb-0.5">
                <span className="text-[#d4d4d4]">{msg.from}</span>
                {' -> '}
                <span className="text-[#d4d4d4]">{msg.to}</span>
                <span className="ml-2 text-[#555]">{formatTime(msg.timestamp)}</span>
                {msg.read && <span className="ml-1.5 text-[#555]">(read)</span>}
              </div>
              <div className="text-[#bbb] whitespace-pre-wrap break-words">{msg.content}</div>
            </div>
          </div>
        ))
      )}
    </div>
  )

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'agents', label: 'Agents', icon: 'fa-solid fa-robot' },
    { id: 'tasks', label: 'Tasks', icon: 'fa-solid fa-list-check' },
    { id: 'messages', label: 'Messages', icon: 'fa-solid fa-comments' },
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
            <span className="text-xs text-[#6b7280]">
              {terminals.length} agent{terminals.length !== 1 ? 's' : ''} | {tasks.length} task{tasks.length !== 1 ? 's' : ''} | {messages.length} msg{messages.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
            <i className="fa-solid fa-xmark"></i>
          </button>
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
                  : 'text-[#6b7280] hover:text-[#d4d4d4] hover:bg-[#2d2d2d]'
              }`}
            >
              <i className={tab.icon}></i>
              {tab.label}
            </button>
          ))}
          <div className="flex-1"></div>
          <button
            onClick={() => setShowNewTask(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-[#22D3EE] hover:bg-[#37373d]"
            title="New Task"
          >
            <i className="fa-solid fa-plus"></i> Task
          </button>
          <button
            onClick={() => setShowBroadcast(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-[#22D3EE] hover:bg-[#37373d]"
            title="Broadcast Message"
          >
            <i className="fa-solid fa-bullhorn"></i> Broadcast
          </button>
          <button
            onClick={handleClearSwarm}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-[#E57373] hover:bg-[#37373d]"
            title="Clear all messages and tasks"
          >
            <i className="fa-solid fa-trash"></i> Clear
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'agents' && renderAgents()}
          {activeTab === 'tasks' && renderTasks()}
          {activeTab === 'messages' && renderMessages()}
        </div>

        {/* New Task Modal */}
        {showNewTask && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-xl" onClick={() => setShowNewTask(false)}>
            <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg p-5 w-96 space-y-3" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-[#d4d4d4]">New Swarm Task</h3>
              <input
                autoFocus
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Task title"
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none"
              />
              <textarea
                value={taskDesc}
                onChange={(e) => setTaskDesc(e.target.value)}
                placeholder="Description"
                rows={3}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none resize-none"
              />
              <select
                value={taskAssignTo}
                onChange={(e) => setTaskAssignTo(e.target.value)}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] focus:border-[#22D3EE] outline-none"
              >
                <option value="">Unassigned (pending)</option>
                {terminals.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.id.slice(0, 8)})</option>
                ))}
              </select>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowNewTask(false)} className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]">Cancel</button>
                <button onClick={handleCreateTask} className="px-3 py-1.5 text-xs bg-[#22D3EE]/20 text-[#22D3EE] rounded hover:bg-[#22D3EE]/30">Create</button>
              </div>
            </div>
          </div>
        )}

        {/* Broadcast Modal */}
        {showBroadcast && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-xl" onClick={() => setShowBroadcast(false)}>
            <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg p-5 w-96 space-y-3" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-[#d4d4d4]">Broadcast to All Agents</h3>
              <select
                value={broadcastType}
                onChange={(e) => setBroadcastType(e.target.value)}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] focus:border-[#22D3EE] outline-none"
              >
                <option value="info">Info</option>
                <option value="task">Task</option>
                <option value="question">Question</option>
                <option value="review">Review</option>
              </select>
              <textarea
                autoFocus
                value={broadcastContent}
                onChange={(e) => setBroadcastContent(e.target.value)}
                placeholder="Message content..."
                rows={4}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none resize-none"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowBroadcast(false)} className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]">Cancel</button>
                <button onClick={handleBroadcast} className="px-3 py-1.5 text-xs bg-[#22D3EE]/20 text-[#22D3EE] rounded hover:bg-[#22D3EE]/30">Send</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
