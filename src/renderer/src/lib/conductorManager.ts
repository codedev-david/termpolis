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

// Step 2: Spawn the conductor terminal (hidden) and verify Claude is accessible
export async function startConductor(cwd: string): Promise<{ success: boolean; error?: string; needsAuth?: boolean }> {
  // Kill any existing conductor first to prevent duplicates
  if (conductorState.terminalId) {
    stopConductor()
  }

  conductorState = { terminalId: null, status: 'starting', error: null }

  // Set swarm active immediately to prevent duplicate launches; clear any prior completion dialog
  const storeInit = useTerminalStore.getState()
  storeInit.setSwarmActive(true)
  storeInit.setSwarmCompletionSummary(null)

  const id = uuid()
  const isWindows = navigator.platform.startsWith('Win')
  const shellType = isWindows ? 'powershell' as const : 'bash' as const
  const res = await window.termpolis.createTerminal(id, shellType, cwd)

  if (!res.success) {
    conductorState = { terminalId: null, status: 'error', error: res.error || 'Failed to create terminal' }
    storeInit.setSwarmActive(false)
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

  // Wait for shell init then check if Claude is authenticated
  await new Promise(r => setTimeout(r, testDelay(2000)))
  window.termpolis.writeToTerminal(id, resolveAgentCommand('claude') + ' --version\r')
  await new Promise(r => setTimeout(r, testDelay(5000)))

  const bufferRes = await window.termpolis.readTerminalBuffer(id)
  const output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''

  // Check for auth prompts in the output
  const needsAuth = /sign in|log in|authenticate|visit.*to sign in|https:\/\/.*auth/i.test(output)

  if (needsAuth) {
    conductorState.status = 'authenticating'
    return { success: true, needsAuth: true }
  }

  conductorState.status = 'ready'
  return { success: true, needsAuth: false }
}

// Step 3: Wait for authentication to complete
export async function waitForAuth(timeoutMs: number = 120000): Promise<boolean> {
  const start = Date.now()
  const id = conductorState.terminalId
  if (!id) return false

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 4000))

    // Re-run --version to check if auth is now complete
    window.termpolis.writeToTerminal(id, resolveAgentCommand('claude') + ' --version\r')
    await new Promise(r => setTimeout(r, testDelay(3000)))

    const bufferRes = await window.termpolis.readTerminalBuffer(id)
    const output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''
    const recent = output.slice(-1500)

    // Auth complete when we see a version number and no auth prompts
    const hasVersion = /claude.*\d+\.\d+|\d+\.\d+.*claude/i.test(recent)
    const hasAuthPrompt = /sign in|log in|authenticate|visit.*to sign in|https:\/\/.*auth/i.test(recent)

    if (hasVersion && !hasAuthPrompt) {
      conductorState.status = 'ready'
      return true
    }
  }

  conductorState = { ...conductorState, status: 'error', error: 'Authentication timed out' }
  return false
}

// Step 4: Send the task to the conductor via a temp file (reliable multi-line delivery)
export async function sendTask(taskDescription: string, cwd: string): Promise<void> {
  const id = conductorState.terminalId
  if (!id || conductorState.status !== 'ready') {
    // Post diagnostic message so the user can see what went wrong
    try {
      await window.swarmAPI.sendMessage(
        'system',
        'all',
        'info',
        `Conductor not ready (status: ${conductorState.status}, terminal: ${id ?? 'none'}). Please clear the swarm and try again.`
      )
    } catch {}
    return
  }

  conductorState.status = 'running'

  // Get installed agents
  const agentsRes = await window.termpolis.detectAgents()
  const installedAgents = agentsRes.success && agentsRes.data ? agentsRes.data : {}

  // Build the conductor prompt
  const isWindows = navigator.platform.startsWith('Win')
  const prompt = buildConductorPrompt({
    taskDescription,
    installedAgents,
    projectCwd: cwd,
    shellType: isWindows ? 'powershell' : 'bash',
  })

  // Write prompt to a temp file
  const homedirRes = await window.termpolis.getHomedir()
  const homedir = homedirRes.success && homedirRes.data ? homedirRes.data : cwd
  const homeSlash = homedir.replace(/\\/g, '/')
  const tempFile = homeSlash + '/.termpolis-conductor-task.md'
  await window.termpolis.writeConfigFile(tempFile, prompt)

  // Write a launch script so the full prompt is passed to claude -p without any
  // shell escaping issues (PowerShell here-string / bash heredoc handle all chars)
  const claudeCmd = resolveAgentCommand('claude')
  let runCmd: string
  if (isWindows) {
    // PowerShell here-string (@'...'@) is fully literal — no escaping needed.
    // '@ must be at the start of a line, so the script ends with \n'@\n
    const scriptFile = homeSlash + '/.termpolis-conductor-run.ps1'
    const psScript = `$task = @'\n${prompt}\n'@\n${claudeCmd} -p $task --dangerously-skip-permissions\n`
    await window.termpolis.writeConfigFile(scriptFile, psScript)
    runCmd = `powershell -ExecutionPolicy Bypass -File "${scriptFile}"`
  } else {
    // Bash: input-redirect from temp file into claude --print (agent mode)
    const scriptFile = homeSlash + '/.termpolis-conductor-run.sh'
    const shScript = `#!/bin/bash\n${claudeCmd} -p "$(cat '${tempFile}')" --dangerously-skip-permissions\n`
    await window.termpolis.writeConfigFile(scriptFile, shScript)
    runCmd = `bash "${scriptFile}"`
  }
  window.termpolis.writeToTerminal(id, runCmd + '\r')

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
      const store = useTerminalStore.getState()

      // Check if conductor terminal still exists
      const conductorTerminal = store.terminals.find(t => t.id === conductorState.terminalId)
      if (!conductorTerminal) {
        conductorState = { ...conductorState, status: 'error', error: 'Conductor terminal closed unexpectedly' }
        store.setSwarmNotification({ message: 'Conductor stopped unexpectedly', type: 'error' })
        if (monitoringInterval) clearInterval(monitoringInterval)
        return
      }

      // Check task-based completion (conductor used swarm_create_task)
      const tasksRes = await window.swarmAPI.getTasks()
      if (tasksRes.success && tasksRes.data && tasksRes.data.length > 0) {
        const allCompleted = tasksRes.data.every(
          (t: { status: string }) => t.status === 'completed' || t.status === 'failed'
        )
        if (allCompleted) {
          const completedCount = tasksRes.data.filter((t: { status: string }) => t.status === 'completed').length
          const failedCount = tasksRes.data.filter((t: { status: string }) => t.status === 'failed').length
          const msg = failedCount > 0
            ? `${completedCount} task${completedCount !== 1 ? 's' : ''} succeeded, ${failedCount} failed`
            : `${completedCount} task${completedCount !== 1 ? 's' : ''} completed successfully`
          markSwarmDone(store, msg, tasksRes.data)
          return
        }
      }

      // Also detect completion from messages (catches cases where conductor
      // skipped swarm_create_task but still posted a result/completion message)
      const msgsRes = await window.swarmAPI.getMessages()
      if (msgsRes.success && msgsRes.data && msgsRes.data.length > 0) {
        const recent = msgsRes.data.slice(-15)
        const completionMsg = recent.find((m: { type: string; content: string }) =>
          m.type === 'result' ||
          /SWARM COMPLETE|TASK COMPLETE|all tasks.*complet|swarm.*finished/i.test(m.content)
        )
        if (completionMsg) {
          markSwarmDone(store, completionMsg.content || 'Swarm finished')
          return
        }
      }

      // Check conductor output for token limit errors
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

function markSwarmDone(
  store: ReturnType<typeof useTerminalStore.getState>,
  message: string,
  tasks: Array<{ id: string; title: string; status: string; result?: string }> = []
): void {
  conductorState.status = 'done'
  // Allow a new swarm to be started
  store.setSwarmActive(false)
  store.setSwarmNotification({ message, type: 'success' })
  store.setSwarmCompletionSummary({ message, tasks })
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }
}

// Cleanup
export function stopConductor(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }

  if (conductorState.terminalId) {
    try { window.termpolis.killTerminal(conductorState.terminalId) } catch {}
    const store = useTerminalStore.getState()
    store.removeTerminal(conductorState.terminalId)
  }

  // Also clean up any orphaned conductor terminals
  const store = useTerminalStore.getState()
  const orphanedConductors = store.terminals.filter(t => t.isConductor)
  for (const t of orphanedConductors) {
    try { window.termpolis.killTerminal(t.id) } catch {}
    store.removeTerminal(t.id)
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
