import { v4 as uuidv4 } from 'uuid'

export interface SwarmMessage {
  id: string
  from: string
  to: string
  type: 'task' | 'result' | 'question' | 'info' | 'review'
  content: string
  timestamp: number
  read: boolean
}

export interface SwarmTask {
  id: string
  title: string
  description: string
  assignedTo: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdBy: string
  result?: string
  createdAt: number
  completedAt?: number
}

const messages: SwarmMessage[] = []
const tasks: SwarmTask[] = []
const MAX_MESSAGES = 500 // prevent unbounded growth

export function sendMessage(
  from: string,
  to: string,
  type: SwarmMessage['type'],
  content: string
): SwarmMessage {
  const msg: SwarmMessage = {
    id: uuidv4(),
    from,
    to,
    type,
    content,
    timestamp: Date.now(),
    read: false,
  }
  messages.push(msg)
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES)
  return msg
}

export function readMessages(forTerminalId: string): SwarmMessage[] {
  const unread = messages.filter(
    (m) => !m.read && (m.to === forTerminalId || m.to === 'all')
  )
  unread.forEach((m) => (m.read = true))
  return unread
}

export function getAllMessages(): SwarmMessage[] {
  return [...messages]
}

export function createTask(
  title: string,
  description: string,
  createdBy: string,
  assignTo?: string
): SwarmTask {
  const task: SwarmTask = {
    id: uuidv4(),
    title,
    description,
    assignedTo: assignTo || '',
    status: assignTo ? 'in_progress' : 'pending',
    createdBy,
    createdAt: Date.now(),
  }
  tasks.push(task)
  return task
}

export function listTasks(): SwarmTask[] {
  return [...tasks]
}

export function updateTask(
  taskId: string,
  status: SwarmTask['status'],
  result?: string
): SwarmTask | null {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null
  task.status = status
  if (result) task.result = result
  if (status === 'completed' || status === 'failed') task.completedAt = Date.now()
  return task
}

export function clearSwarm(): void {
  messages.length = 0
  tasks.length = 0
}
