import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../store/terminalStore'
import { resolveAgentCommand, testDelay } from './testAgents'
import { buildConductorPrompt } from './conductorPrompt'

interface ConductorState {
  terminalId: string | null
  status: 'idle' | 'starting' | 'authenticating' | 'ready' | 'running' | 'error' | 'done'
  error: string | null
}

let conductorState: ConductorState = { terminalId: null, status: 'idle', error: null }
let monitoringInterval: ReturnType<typeof setInterval> | null = null

export function getConductorState(): ConductorState {
  return { ...conductorState }
}

// Step 1: Check if Claude Code is installed
export async function checkClaudeInstalled(): Promise<boolean> {
  const res = await window.termpolis.detectAgents()
  return res.success && res.data?.claude === true
}

// Step 2: Spawn the conductor terminal (hidden)
export async function startConductor(cwd: string): Promise<{ success: boolean; error?: string; needsAuth?: boolean }> {
  conductorState = { terminalId: null, status: 'starting', error: null }

  const id = uuid()
  const shellType = navigator.platform.startsWith('Win') ? 'powershell' as const : 'bash' as const
  const res = await window.termpolis.createTerminal(id, shellType, cwd)

  if (!res.success) {
    conductorState = { terminalId: null, status: 'error', error: res.error || 'Failed to create terminal' }
    return { success: false, error: conductorState.error! }
  }

  // Add hidden conductor terminal to store
  const store = useTerminalStore.getState()
  store.addTerminal({
    id,
    name: 'Swarm Conductor',
    color: '#22D3EE',
    shellType,
    cwd,
    fontSize: 14,
    theme: 'dark',
    fontFamily: 'Consolas, "Courier New", monospace',
    agentCommand: 'claude',
    hidden: true,
    isConductor: true,
    isSwarm: true,
  })

  conductorState.terminalId = id

  // Wait for shell init
  await new Promise(r => setTimeout(r, testDelay(3000)))

  // Send claude command
  window.termpolis.writeToTerminal(id, resolveAgentCommand('claude') + '\r')

  // Auto-trust at 9s
  setTimeout(() => {
    if (conductorState.terminalId === id) {
      window.termpolis.writeToTerminal(id, '\r')
    }
  }, testDelay(9000))

  // Wait and check for auth
  await new Promise(r => setTimeout(r, testDelay(12000)))

  // Read terminal output to check if authenticated
  const bufferRes = await window.termpolis.readTerminalBuffer(id)
  const output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''

  // Check for auth prompts
  const needsAuth = /sign in|log in|authenticate|visit.*to sign in|https:\/\/.*auth/i.test(output)

  if (needsAuth) {
    conductorState.status = 'authenticating'
    return { success: true, needsAuth: true }
  }

  conductorState.status = 'ready'
  return { success: true, needsAuth: false }
}

// Step 3: Wait for authentication to complete
export async function waitForAuth(timeoutMs: number = 60000): Promise<boolean> {
  const start = Date.now()
  const id = conductorState.terminalId
  if (!id) return false

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000))
    const bufferRes = await window.termpolis.readTerminalBuffer(id)
    const output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''

    // Check for successful auth indicators
    if (/authenticated|logged in|welcome|claude>/i.test(output) && !/sign in|log in/i.test(output.slice(-500))) {
      conductorState.status = 'ready'
      return true
    }
  }

  conductorState = { ...conductorState, status: 'error', error: 'Authentication timed out' }
  return false
}

// Step 4: Send the task to the conductor
export async function sendTask(taskDescription: string, cwd: string): Promise<void> {
  const id = conductorState.terminalId
  if (!id || conductorState.status !== 'ready') return

  conductorState.status = 'running'

  // Get installed agents
  const agentsRes = await window.termpolis.detectAgents()
  const installedAgents = agentsRes.success && agentsRes.data ? agentsRes.data : {}

  // Build and send the conductor prompt
  const prompt = buildConductorPrompt({
    taskDescription,
    installedAgents,
    projectCwd: cwd,
  })

  // Send prompt to conductor terminal
  window.termpolis.writeToTerminal(id, prompt + '\r')

  // Set swarm as active
  const store = useTerminalStore.getState()
  store.setSwarmActive(true)

  // Post initial message to swarm bus
  await window.swarmAPI.sendMessage(
    'conductor',
    'all',
    'info',
    `Conductor analyzing task: ${taskDescription.slice(0, 200)}...`
  )

  // Start monitoring
  startMonitoring()
}

// Monitoring loop
function startMonitoring(): void {
  if (monitoringInterval) clearInterval(monitoringInterval)

  monitoringInterval = setInterval(async () => {
    if (conductorState.status !== 'running') {
      if (monitoringInterval) clearInterval(monitoringInterval)
      return
    }

    try {
      // Check if conductor terminal still exists
      const store = useTerminalStore.getState()
      const conductorTerminal = store.terminals.find(t => t.id === conductorState.terminalId)
      if (!conductorTerminal) {
        conductorState = { ...conductorState, status: 'error', error: 'Conductor terminal closed unexpectedly' }
        store.setSwarmNotification({ message: 'Conductor stopped unexpectedly', type: 'error' })
        if (monitoringInterval) clearInterval(monitoringInterval)
        return
      }

      // Check task completion
      const tasksRes = await window.swarmAPI.getTasks()
      if (tasksRes.success && tasksRes.data && tasksRes.data.length > 0) {
        const allCompleted = tasksRes.data.every(
          (t: { status: string }) => t.status === 'completed' || t.status === 'failed'
        )
        if (allCompleted) {
          conductorState.status = 'done'
          store.setSwarmNotification({
            message: `Swarm complete — ${tasksRes.data.length} task${tasksRes.data.length !== 1 ? 's' : ''} finished`,
            type: 'success',
          })
          if (monitoringInterval) clearInterval(monitoringInterval)
        }
      }

      // Check conductor output for errors/token limits
      if (conductorState.terminalId) {
        const bufferRes = await window.termpolis.readTerminalBuffer(conductorState.terminalId)
        const output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''
        const recent = output.slice(-1000)
        if (/context.*(limit|window|exceeded)|token.*(limit|budget)/i.test(recent)) {
          store.setSwarmNotification({
            message: 'Conductor reached token limit. Agents continue but without coordination.',
            type: 'error',
          })
        }
      }
    } catch {
      // Monitoring error — continue silently
    }
  }, testDelay(15000))
}

// Cleanup
export function stopConductor(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }

  if (conductorState.terminalId) {
    window.termpolis.killTerminal(conductorState.terminalId)
    const store = useTerminalStore.getState()
    store.removeTerminal(conductorState.terminalId)
  }

  conductorState = { terminalId: null, status: 'idle', error: null }
}

// Reveal conductor terminal for debugging
export function revealConductor(): void {
  if (!conductorState.terminalId) return
  const store = useTerminalStore.getState()
  store.updateTerminal(conductorState.terminalId, { hidden: false })
  store.setActiveTerminal(conductorState.terminalId)
}
