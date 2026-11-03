import { v4 as uuid } from 'uuid'
import { useTerminalStore } from '../store/terminalStore'
import { resolveAgentCommand, testDelay } from './testAgents'
import { buildConductorPrompt } from './conductorPrompt'
import { conductorRunScript, conductorLaunchCommand, conductorLimitOf, findConductorExit, type ConductorExit } from './conductorLaunch'
import { clearSwarmRestarts, liveRestartDeps, offerConductorRun } from './swarmRestart'
import { getTerminalDefaults } from './terminalDefaults'
import { CONDUCTOR_CLAUDE_HOME_FILE } from '../../../shared/conductorFiles'
import { unofferedLoginOwner } from '../../../shared/accountLimits'
import { recordSwarmError } from './sentry'
import { stopAllBridges } from './swarmBridgeManager'
import type { TerminalSession } from '../types'

interface ConductorState {
  terminalId: string | null
  status: 'idle' | 'starting' | 'authenticating' | 'ready' | 'running' | 'error' | 'done'
  error: string | null
  cwd: string | null
  preSwarmSha: string | null
  /** The id this launch's `claude -p` was started with (`--session-id`), whose transcript Trace
   *  follows. Null until sendTask launches it. */
  sessionId: string | null
  /** The task sendTask handed it: a conductor run again on another account at its limit gets it
   *  again, when it can't resume (§9). */
  taskDescription?: string
  /** The account it was run again on (§9); until then, the one Termpolis's environment gives it. */
  accountId?: string
  /** The run on now is a resume of its earlier conversation (§9): one whose transcript turns out not to be there is run once more
   *  as a new session (SWARM-R3-5). Cleared once that has been tried, so it cannot loop. */
  resumed?: boolean
}

/** What Claude Code prints, and exits 1 on, for a session it was told to resume that has no transcript. */
const NO_CONVERSATION = /No conversation found with session ID/

/** What was already there when the conductor was launched, and so says nothing about this run.
 *  The swarm bus is emptied only by the dashboard's Clear: a swarm started after another one
 *  found that swarm's finished tasks and SWARM COMPLETE still on it, and was declared done on its
 *  first check. The launcher's own messages are set aside here too: the goal quoted in the first
 *  one could read as a completion ("make sure all tasks complete"). */
interface LaunchBaseline {
  /** Where the conductor terminal's output stood. Before it: the shell, `claude --version`, and a
   *  run launched earlier in the same terminal. */
  outputOffset: number
  taskIds: Set<string>
  messageIds: Set<string>
}

let conductorState: ConductorState = { terminalId: null, status: 'idle', error: null, cwd: null, preSwarmSha: null, sessionId: null }
/** The conductor session whose transcript Trace follows (watchConductorTrace). Every launch starts
 *  with startConductor, which forgets it. */
let traceWatchedFor: string | null = null
let monitoringInterval: ReturnType<typeof setInterval> | null = null
let monitoringStartTime: number = 0
let launch: LaunchBaseline = { outputOffset: 0, taskIds: new Set(), messageIds: new Set() }
/** When each swarm worker's terminal was in the store, from the launch on (noteWorkers): who can
 *  have sent a message without a name (byConductor). `left` is Infinity while it is there; one the
 *  store held at the launch, which a swarm before left running, has been there since before it. */
let workerSpans: Array<{ id: string; entered: number; left: number }> = []
let stopNotingWorkers: () => void = () => {}

/** How much of the conductor's last output an exit report quotes, at most. */
const EXIT_REPORT_MAX_CHARS = 2000
/** How long after a worker's terminal left the store a message without a name can still be that
 *  worker's: what it sent as its terminal was closed reaches the bus a moment later. */
const WORKER_CLOSE_MARGIN_MS = 2000

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
  // A new swarm is under way: the last one's restart offers and their clocks go (F2, and again in sendTask, for those
  // opened while the wizard was).
  clearSwarmRestarts(liveRestartDeps())

  // Mark starting synchronously so the UI can update immediately; SHA capture
  // below happens async and is merged in once resolved.
  conductorState = { terminalId: null, status: 'starting', error: null, cwd, preSwarmSha: null, sessionId: null }
  traceWatchedFor = null

  // Capture pre-swarm HEAD so SwarmReviewPanel can show the full delta of
  // everything the swarm touched. Fine to be null — review UI just hides.
  try {
    const shaRes = await window.termpolis.gitRevParseHead(cwd)
    if (shaRes.success) conductorState.preSwarmSha = shaRes.data ?? null
  } catch { /* ignore — not a git repo */ }

  // Set swarm active immediately to prevent duplicate launches; clear any prior completion dialog
  const storeInit = useTerminalStore.getState()
  storeInit.setSwarmActive(true)
  storeInit.setSwarmCompletionSummary(null)

  const id = uuid()
  const isWindows = navigator.platform.startsWith('Win')
  const shellType = isWindows ? 'powershell' as const : 'bash' as const
  // Marked as watched (R6): a StopFailure hook then opens no window on another account at the
  // conductor's limit, which would --continue the swarm folder's newest session.
  const res = await window.termpolis.createTerminal(id, shellType, cwd, undefined, true, undefined, 'claude') // conductor always runs `claude`

  if (!res.success) {
    conductorState = { terminalId: null, status: 'error', error: res.error || 'Failed to create terminal', cwd: null, preSwarmSha: null, sessionId: null }
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
    ...getTerminalDefaults(),
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

// Expose for tests and the review panel so we can show pre-swarm SHA.
export function getPreSwarmSha(): string | null {
  return conductorState.preSwarmSha
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
  conductorState.taskDescription = taskDescription

  const isWindows = navigator.platform.startsWith('Win')
  const prompt = await promptFor(taskDescription, cwd)
  // A new session for each launch: the id names the transcript Trace follows, which must be this
  // launch's alone.
  const sessionId = uuid()
  conductorState.sessionId = sessionId
  const runCmd = await writeRun(cwd, prompt, sessionId, {})
  // The last swarm's workers, which only Clear closes, are none of this one's: their bridges
  // would post to the new conductor under their agents' names, and their stops be reported to it.
  stopAllBridges()
  useTerminalStore.getState().setSwarmAgents([])
  // Nor are their restart offers (F2): an offer's clock would, five minutes on, tell the new conductor to close a worker
  // of the old swarm, and its card stay clickable. Nobody is told: the old conductor has nothing to wait for any more.
  clearSwarmRestarts(liveRestartDeps())
  // Before the baseline, so that whatever is posted after it was posted while its workers were noted.
  noteWorkers()
  // Read before the line is typed, so nothing the new conductor does can land in the baseline.
  launch = await readLaunchBaseline(id)
  window.termpolis.writeToTerminal(id, runCmd + '\r')
  // Diagnostic hook — E2E tests read this to verify the launch command shape
  // without having to monkey-patch the frozen contextBridge-exposed termpolis API.
  try { (window as any).__termpolis_last_launch_cmd = runCmd } catch {}
  // Trace from the conductor's first step: main follows its session's transcript once claude writes it.
  watchConductorTrace()

  // Post initial message to swarm bus
  const posted = [
    await window.swarmAPI.sendMessage(
      'conductor',
      'all',
      'info',
      `Conductor analyzing task: ${taskDescription.slice(0, 200)}...`
    ),
    await window.swarmAPI.sendMessage(
      'system',
      'all',
      'info',
      `Conductor launched in ${isWindows ? 'PowerShell' : 'Bash'}. Click Debug to see conductor output. If nothing happens after 60s, the conductor may have an issue connecting to MCP tools.`
    ),
  ]
  for (const res of posted) if (res?.data?.id) launch.messageIds.add(res.data.id)

  // Start monitoring
  startMonitoring()
}

/** The conductor's prompt for a task. A worker can be restarted on another account (§9) only where
 *  its agent has two accounts or more. */
async function promptFor(taskDescription: string, cwd: string): Promise<string> {
  const agentsRes = await window.termpolis.detectAgents()
  const installedAgents = agentsRes.success && agentsRes.data ? agentsRes.data : {}
  const view = useTerminalStore.getState().accountsView
  return buildConductorPrompt({
    taskDescription,
    installedAgents,
    projectCwd: cwd,
    shellType: navigator.platform.startsWith('Win') ? 'powershell' : 'bash',
    agentRatingOverrides: useTerminalStore.getState().agentRatingOverrides,
    restartOffer: !!view && (['claude', 'codex'] as const).some((agent) => view.accounts.filter((r) => r.agent === agent).length > 1),
  })
}

/** Writes a launch's task file and run script, and answers the line that runs it. */
async function writeRun(cwd: string, prompt: string, sessionId: string, on: { account?: { profile: string | null }; resume?: boolean }): Promise<string> {
  const isWindows = navigator.platform.startsWith('Win')
  // Write prompt to a temp file
  const homedirRes = await window.termpolis.getHomedir()
  const homedir = homedirRes.success && homedirRes.data ? homedirRes.data : cwd
  const homeSlash = homedir.replace(/\\/g, '/')
  const tempFile = homeSlash + '/.termpolis-conductor-task.md'
  await window.termpolis.writeConfigFile(tempFile, prompt)

  // Headless `claude -p` does NOT auto-load user-scope MCP plugins that
  // `claude mcp list` reports as connected. Without an explicit
  // --mcp-config, the conductor spins up with ZERO Termpolis tools and
  // silently bypasses the swarm — even when the MCP server is healthy,
  // the adapter file ships in the installer, and Claude's settings.json
  // is fully wired. The userData-scoped claude-mcp-config.json is written
  // on every app start (src/main/index.ts around line 966), so the path
  // is guaranteed to point at a valid config once main is up.
  const mcpCfgRes = await window.termpolis.getMcpConfigPath()
  const mcpConfigPath = mcpCfgRes.success && mcpCfgRes.data ? mcpCfgRes.data : ''

  // Launch Claude Code with -p, its prompt piped in from the temp file (see conductorLaunch.ts).
  // Claude -p with --dangerously-skip-permissions HAS full tool access
  // (MCP tools, file read/write, bash execution) — it's just non-interactive.
  //
  // In E2E test mode the command is substituted to a node-based mock shim, which can't pass
  // the production script's `--version` probe, so the script runs it directly instead.
  const claudeCmd = resolveAgentCommand('claude')
  const testCommand = claudeCmd !== 'claude' ? claudeCmd : undefined
  const native = (p: string): string => (isWindows ? p.replace(/\//g, '\\') : p)
  const scriptFile = homeSlash + (isWindows ? '/.termpolis-conductor-run.ps1' : '/.termpolis-conductor-run.sh')
  await window.termpolis.writeConfigFile(
    scriptFile,
    conductorRunScript(isWindows, {
      taskFile: native(tempFile),
      mcpConfigPath: native(mcpConfigPath),
      sessionId,
      claudeHomeFile: native(`${homeSlash}/${CONDUCTOR_CLAUDE_HOME_FILE}`),
      testCommand,
      ...on,
    }),
  )
  return conductorLaunchCommand(isWindows, native(scriptFile))
}

/** What a conductor run again on another account with its own session is told (§9). */
export const CONDUCTOR_RESUMED = 'You stopped at a usage limit, and Termpolis runs you again on another account. A swarm is in progress. ' +
  'Read swarm_list_tasks and swarm_read_messages before you create tasks, then carry on from where you stopped.'
/** What a conductor run again without its session gets after its whole prompt (§9). */
export const CONDUCTOR_IN_PROGRESS = 'A swarm is in progress. Read swarm_list_tasks and swarm_read_messages before you create tasks.'

/** The account the conductor's claude runs on: the one it was last run again on, else the one
 *  Termpolis's environment gives a terminal with no account line. */
function conductorAccountId(): string | null {
  return conductorState.accountId ?? useTerminalStore.getState().accountsView?.envAccount?.claude ?? null
}

/**
 * Runs the conductor again in its terminal, on the account `targetId`, after its usage limit ended
 * it (§9, P2): the run script puts claude on that account, and it resumes its own session by its
 * id where that account can see the transcript (both profiles share projects/), or starts anew
 * with the same goal and a word that a swarm is in progress. The swarm's workers and tasks stay.
 * Answers why it couldn't, or null.
 */
export async function relaunchConductor(targetId: string, fresh = false): Promise<string | null> {
  const { terminalId: id, cwd, taskDescription } = conductorState
  const store = useTerminalStore.getState()
  if (!id || !cwd || taskDescription === undefined || conductorState.status !== 'error' || !store.terminals.some((t) => t.id === id)) {
    return 'the conductor is gone: start the swarm again from its dashboard'
  }
  const view = store.accountsView
  const target = view?.accounts.find((r) => r.id === targetId && r.agent === 'claude')
  if (!target) return 'that account isn\'t registered any more'
  const from = view!.accounts.find((r) => r.id === conductorAccountId())
  const seesTranscripts = (r: { isDefault: boolean; shares: string[] }): boolean => r.isDefault || r.shares.includes('projects')
  const resume = !fresh && !!conductorState.sessionId && !!from && seesTranscripts(from) && seesTranscripts(target)
  const prompt = resume ? CONDUCTOR_RESUMED : `${await promptFor(taskDescription, cwd)}\n\n${CONDUCTOR_IN_PROGRESS}`
  const sessionId = resume ? conductorState.sessionId! : uuid()
  const runCmd = await writeRun(cwd, prompt, sessionId, { account: { profile: target.profile }, resume })
  // What the terminal showed before, its last report among it, is no part of this run.
  launch = { ...launch, outputOffset: (await readLaunchBaseline(id)).outputOffset }
  conductorState = { ...conductorState, status: 'running', error: null, sessionId, accountId: target.id, ...(resume ? { resumed: true } : { resumed: false }) }
  if (!resume) traceWatchedFor = null
  store.setSwarmActive(true)
  store.setSwarmNotification(null)
  window.termpolis.writeToTerminal(id, runCmd + '\r')
  watchConductorTrace()
  try {
    await window.swarmAPI.sendMessage('system', 'all', 'info', `Conductor run again on ${target.label} after its usage limit, ${resume ? 'resuming its session' : 'with a new session'}.`)
  } catch {}
  startMonitoring()
  return null
}

/** [Run the conductor again on <account>] on the conductor's offer: runs it, and says how it went.
 *  Its conversation off an account not offered automatically asks once more first (R17), unless
 *  `confirmed`. */
export async function runConductorOn(groupId: string, targetId: string, confirmed = false): Promise<void> {
  const store = useTerminalStore.getState()
  const g = store.swarmRestarts.find((x) => x.id === groupId)
  if (!g || (g.phase.kind !== 'offered' && g.phase.kind !== 'confirm')) return
  const rows = store.accountsView?.accounts ?? []
  const from = rows.find((r) => r.id === g.accountId)
  const to = rows.find((r) => r.id === targetId)
  // The account the conductor's conversation is on: the row itself when it is kept from the automatic offers, else the one whose login
  // the profile holds (the conductor runs in the default profile, and the logins move between the folders: SWARM-R3-1).
  const kept = from ? (from.autoOffer ? unofferedLoginOwner(rows, from) : from) : undefined
  if (!confirmed && from && to && kept) {
    const who = kept === from ? `${from.label} isn't offered automatically.` : `${from.label} is signed in as ${kept.label}, which isn't offered automatically.`
    store.putSwarmRestart({ ...g, phase: { kind: 'confirm', targetId, question: `${who} Carry the conductor's conversation to ${to.label}?` } })
    return
  }
  store.putSwarmRestart({ ...g, phase: { kind: 'restarting', targetId } })
  const label = store.accountsView?.accounts.find((r) => r.id === targetId)?.label ?? 'that account'
  let why: string | null
  try {
    why = await relaunchConductor(targetId)
  } catch (e) {
    why = e instanceof Error ? e.message : String(e)
  }
  const now = useTerminalStore.getState().swarmRestarts.find((x) => x.id === groupId)
  if (now) useTerminalStore.getState().putSwarmRestart({ ...now, phase: { kind: 'done', lines: [why ? `The conductor wasn't run again: ${why}.` : `The conductor runs again on ${label}.`] } })
}

/** The baseline for a run (LaunchBaseline). A read that fails sets nothing aside, which is how
 *  the monitor behaved before there was a baseline. */
async function readLaunchBaseline(terminalId: string): Promise<LaunchBaseline> {
  const [buffer, tasks, messages] = await Promise.allSettled([
    window.termpolis.readTerminalBuffer(terminalId),
    window.swarmAPI.getTasks(),
    window.swarmAPI.getMessages(),
  ])
  const data = <T,>(r: PromiseSettledResult<{ success: boolean; data?: T } | undefined>): T | undefined =>
    r.status === 'fulfilled' && r.value?.success ? r.value.data : undefined
  return {
    outputOffset: data(buffer)?.nextOffset ?? 0,
    taskIds: new Set((data(tasks) ?? []).map((t) => t.id)),
    messageIds: new Set((data(messages) ?? []).map((m) => m.id)),
  }
}

// Monitoring loop
function startMonitoring(): void {
  if (monitoringInterval) clearInterval(monitoringInterval)
  monitoringStartTime = Date.now()
  let stallWarned = false
  let exitNoted = false

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

      // The conductor's output since launch, and claude's exit when the run script reported it.
      let output = ''
      let exit: ConductorExit | null = null
      if (conductorState.terminalId) {
        const bufferRes = await window.termpolis.readTerminalBuffer(conductorState.terminalId, launch.outputOffset)
        output = bufferRes.success && bufferRes.data ? bufferRes.data.output : ''
        exit = findConductorExit(output)
      }
      const recent = output.slice(-3000)
      const tasksRes = await window.swarmAPI.getTasks()
      const tasks = tasksRes.success && tasksRes.data ? tasksRes.data.filter((t) => !launch.taskIds.has(t.id)) : []

      // The guesses below read the conductor's words, and `claude -p` prints only its final
      // answer, as it exits: they would decide how every finished run is labelled. They decide
      // only a run nothing else does (GitHub #36). A conductor that created a task had its tools
      // and took the task on, so its tasks end the swarm; one that exited with an error gets its
      // exit report, below, which is also what a run stopped by its context or token limit gets.
      const undecided = tasks.length === 0 && (exit === null || exit.code === 0)
      if (undecided) {
        // Detect conductor refusal — Claude may refuse unethical/dangerous/illegal tasks. Whole
        // words: "Gemini cannot" holds "i cannot".
        if (/\bI (?:can't|cannot|won't|will not|am unable to)\b|\bI'm not able to\b|\brefuse to\b|\bnot (?:something|able)\b|\bagainst (?:my|the) (?:guidelines|policy|terms)\b|\bpotentially (?:harmful|dangerous|illegal|unethical)\b/i.test(recent) &&
            !/swarm_create_task|create_terminal/i.test(recent)) {
          // Extract a snippet of the refusal for the notification
          const refusalMatch = recent.match(/(\bI (?:can't|cannot|won't|will not)\b[^.]*\.)/i)
          const snippet = refusalMatch ? refusalMatch[1].slice(0, 150) : 'The conductor declined this task.'
          conductorState = { ...conductorState, status: 'error', error: 'Conductor refused the task' }
          store.setSwarmNotification({
            message: `Conductor refused the task: "${snippet}" — Click Debug to see full response.`,
            type: 'error',
          })
          // Post the refusal to the swarm message bus so it's visible in the dashboard. As system,
          // as Termpolis's other notes after launch are: conductor is the conductor's own name.
          try {
            await window.swarmAPI.sendMessage('system', 'all', 'info', `Task refused: ${snippet}`)
          } catch {}
          store.setSwarmActive(false)
          if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null }
          return
        }

        // Detect fatal errors in conductor output
        if (/error.*mcp|mcp.*error|cannot connect|ECONNREFUSED|tool.*not found|Unknown tool/i.test(recent) &&
            !/Conductor analyzing/i.test(recent)) {
          store.setSwarmNotification({
            message: 'Conductor may have trouble connecting to MCP tools. Click Debug to check output.',
            type: 'error',
          })
        }

        // Detect the "bypassed swarm" case — conductor couldn't see MCP tools,
        // silently gave up on orchestration, and built/answered directly. This
        // is distinct from a connection error: the conductor DID run to
        // completion, just without any swarm coordination.  Without this
        // detection the user gets no completion screen and no clear signal that
        // the swarm didn't actually do anything multi-agent.
        // Broader "MCP tools aren't registered/available/loaded" phrasing.
        // Claude paraphrases the bypass a dozen different ways ("the
        // orchestration MCP tools (`a`, `b`, etc.) aren't registered in this
        // session", "swarm MCP tools were not available", "tools are not
        // loaded", ...). Using a lazy [\s\S] window so periods inside the
        // list of listed tools (e.g. `etc.`) don't short-circuit the match.
        const strongBypassSignals = [
          /MCP\s+tools?[\s\S]{0,160}?(?:aren'?t|are not|weren'?t|were not|is not|isn'?t)\s+(?:registered|available|loaded|connected)/i,
          /(?:aren'?t|are not|weren'?t|were not)\s+(?:registered|available|loaded|connected)[\s\S]{0,40}?MCP/i,
          /unable to use (?:the )?(?:swarm |orchestration )?MCP/i,
        ]
        const weakBypassSignals = [
          // "built it directly", "built the SPA directly", "did this directly"
          /(?:built|did|wrote|created|shipped|made) (?:it|this|the [\w-]+) directly (?:rather than|instead of)/i,
          // "rather than sitting idle" / "instead of idling" — Claude often
          // justifies the bypass with an idleness rationale.
          /rather than (?:sitting |remaining )?idl(?:e|ing)/i,
          /instead of (?:sitting |remaining )?idl(?:e|ing)/i,
          /without (?:orchestrat|coordinat).*(?:agents?|swarm)/i,
        ]
        // Only treat a tool name as evidence of real invocation when it
        // appears in invocation-shape syntax (function call `foo(`, MCP tool
        // id `mcp__termpolis__foo`, or a "Created task:" result line) — NOT
        // when Claude merely name-drops it inside backticks while explaining
        // which tools were missing. The v1.11.6 prod regression hit exactly
        // this corner: Claude listed the missing tool names by name, and the
        // old exclusion falsely suppressed the bypass notification.
        const lookedLikeRealInvocation = /(?:mcp__termpolis__(?:swarm_create_task|create_terminal))|(?<![`\w])(?:swarm_create_task|create_terminal)\s*(?:\(|:\s*\{)|Created task:\s*[a-z0-9-]+/i.test(recent)
        const bypassMatch =
          strongBypassSignals.some((p) => p.test(recent)) ||
          weakBypassSignals.some((p) => p.test(recent))
        if (bypassMatch && !lookedLikeRealInvocation) {
          conductorState = {
            ...conductorState,
            status: 'error',
            error: 'Conductor bypassed swarm — MCP tools unavailable',
          }
          store.setSwarmNotification({
            message:
              'Conductor ran WITHOUT swarm tools — it built directly instead of orchestrating agents. ' +
              'Restart Termpolis so the MCP server re-registers with Claude Code, then try again.',
            type: 'error',
          })
          try {
            await window.swarmAPI.sendMessage(
              'system',
              'all',
              'info',
              'MCP tools unavailable — conductor bypassed orchestration. Restart Termpolis to re-register the MCP server.',
            )
          } catch {}
          // Exit the swarm flow cleanly (mirror the refusal-handling pattern so
          // we don't overwrite our error notification with a success one from
          // markSwarmDone).
          store.setSwarmActive(false)
          if (monitoringInterval) {
            clearInterval(monitoringInterval)
            monitoringInterval = null
          }
          return
        }
      }

      // Check task-based completion (conductor used swarm_create_task)
      if (tasks.length > 0) {
        const allCompleted = tasks.every((t) => t.status === 'completed' || t.status === 'failed')
        if (allCompleted) {
          const completedCount = tasks.filter((t) => t.status === 'completed').length
          const failedCount = tasks.filter((t) => t.status === 'failed').length
          const msg = failedCount > 0
            ? `${completedCount} task${completedCount !== 1 ? 's' : ''} succeeded, ${failedCount} failed`
            : `${completedCount} task${completedCount !== 1 ? 's' : ''} completed successfully`
          markSwarmDone(store, msg, tasks)
          return
        }
      }

      // The conductor's own word that the swarm is done (STEP 8 of its prompt), for a conductor that
      // skipped swarm_create_task. Only what the swarm posted since launch counts: not Termpolis's
      // own notes. Nothing else ends a swarm (GitHub #36 item 3): a worker's screen or a message
      // that merely says "complete" used to, and so did any message typed `result`, which a Claude
      // worker reporting on its own task sends too. MCP files a message under the name its caller
      // gives (mcp-client for none), and the conductor's prompt has it give 'conductor'. One with no
      // name is the conductor's only if nothing else could have sent it when it was posted: no task
      // yet, and no worker's terminal in the store, this swarm's or one a swarm before left running
      // (workerThere). Taken for a worker's, a plan without its name didn't count against the stall
      // warning, and a run that built the task itself and exited cleanly ended as an error. Judged by
      // the store as a tick found it, a worker's result counted once its terminal had closed before
      // the monitor looked, and a plan posted just before the first worker started didn't count.
      const msgsRes = await window.swarmAPI.getMessages()
      const posted = msgsRes.success && msgsRes.data
        ? msgsRes.data.filter((m) => !launch.messageIds.has(m.id) && m.from !== 'system')
        : []
      const byConductor = (m: { from: string; timestamp: number }): boolean =>
        fromConductor(m.from) || (m.from === 'mcp-client' && tasks.every((t) => t.createdAt > m.timestamp) && !workerThere(m.timestamp))
      // Asked for again only if asking at launch failed.
      watchConductorTrace()

      const completionMsg = posted.find((m) => isSwarmComplete(m, byConductor))
      if (completionMsg) {
        markSwarmDone(store, completionMsg.content)
        return
      }

      // claude has exited: the run script reported it (findConductorExit). Its terminal's own shell
      // lives on, so the check above that the terminal exists never noticed. An exit with an error,
      // or with no task created, ends the swarm. A clean exit after handing out tasks leaves them
      // to finish it: the completion check above ends the swarm once every one is done.
      if (exit) {
        if (exit.code !== 0 || tasks.length === 0) {
          await endOnConductorExit(store, exit)
          return
        }
        if (!exitNoted) {
          exitNoted = true
          const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'failed').length
          try {
            await window.swarmAPI.sendMessage(
              'system',
              'all',
              'info',
              `Conductor exited (code 0) with ${open} of ${tasks.length} task${tasks.length !== 1 ? 's' : ''} still open. ` +
                'The swarm ends when every task is completed or failed (Done or Fail in the Tasks tab).',
            )
          } catch {}
        }
      }

      // Stall detection — no task and no word from the conductor a minute after launch. The
      // launcher's own two messages don't count (they were always there, so this never fired), and
      // nor does what Termpolis, a worker's bridge or a worker the last swarm left running posts:
      // only the conductor's own messages.
      if (!stallWarned) {
        const elapsed = Date.now() - monitoringStartTime
        const heard = posted.some((m) => byConductor(m))
        if (elapsed > 60000 && tasks.length === 0 && !heard) {
          stallWarned = true
          store.setSwarmNotification({
            message: 'Conductor has not created any tasks or agents yet. Click Debug in the Swarm Dashboard to see its output and check for errors.',
            type: 'error',
          })
        }
      }
    } catch (err) {
      // The monitoring loop is what drives the entire swarm — if it
      // crashes silently, the user sees a swarm that "did nothing" with
      // no error message. Surface it so we can fix the underlying bug.
      recordSwarmError('conductor.monitor.failed', err, {
        terminalId: conductorState.terminalId,
        status: conductorState.status,
      })
    }
  }, testDelay(15000))
}

/** STEP 8's message: swarm_send_message(from='conductor', type='result', content='SWARM COMPLETE:
 *  ...'), from a sender `byConductor` takes for the conductor. Not a worker's own result in those
 *  words, which ended the swarm with a task still open. */
function isSwarmComplete(
  m: { from: string; type: string; content: string; timestamp: number },
  byConductor: (m: { from: string; timestamp: number }) => boolean,
): boolean {
  return m.type === 'result' && byConductor(m) && /^\s*SWARM COMPLETE\b/i.test(m.content)
}

/** Notes when each swarm worker's terminal enters the store and leaves it (workerSpans), from now
 *  on until the next launch or stopConductor. App.tsx adds one the moment main says the conductor
 *  created it, and removes it as it closes; the monitor, looking every 15 seconds, could miss one
 *  that opened and closed between two looks. */
function noteWorkers(): void {
  stopNotingWorkers()
  const workers = (terminals: TerminalSession[]): string[] => terminals.filter((t) => t.isSwarm && !t.isConductor).map((t) => t.id)
  workerSpans = workers(useTerminalStore.getState().terminals).map((id) => ({ id, entered: -Infinity, left: Infinity }))
  stopNotingWorkers = useTerminalStore.subscribe((s, prev) => {
    if (s.terminals === prev.terminals) return
    const now = Date.now()
    const there = new Set(workers(s.terminals))
    // A span still open ends when its terminal is gone; a terminal with none open starts one.
    for (const span of workerSpans) if (span.left === Infinity && !there.delete(span.id)) span.left = now
    for (const id of there) workerSpans.push({ id, entered: now, left: Infinity })
  })
}

/** Whether a worker's terminal was in the store at `time`, or had left it at most
 *  WORKER_CLOSE_MARGIN_MS before, so that the worker can have sent what was posted then. */
function workerThere(time: number): boolean {
  return workerSpans.some((s) => s.entered <= time && time <= s.left + WORKER_CLOSE_MARGIN_MS)
}

/** Whether a message is the conductor's, however it wrote its name ("Conductor"): taken for a
 *  worker's, its plan didn't count against the stall warning, and a run that finished with no task
 *  ended as an error. */
function fromConductor(from: string): boolean {
  return from.trim().toLowerCase() === 'conductor'
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
  store.setSwarmCompletionSummary({ message, tasks, projectCwd: conductorState.cwd, preSwarmSha: conductorState.preSwarmSha })
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }
}

/** The conductor exited with an error, or before it created a task: the swarm is over. Says so
 *  where the user looks, with claude's exit code and what it printed last (GitHub #36: an early
 *  exit used to leave the swarm "running" forever with nothing on the dashboard). */
async function endOnConductorExit(
  store: ReturnType<typeof useTerminalStore.getState>,
  exit: ConductorExit,
): Promise<void> {
  const error = `Conductor exited (code ${exit.code})`
  conductorState = { ...conductorState, status: 'error', error }
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }
  // `claude -p --resume <id>` of a conversation that is not there prints "No conversation found with session ID" and exits 1 before any
  // login check: a run again that resumed such a one is run once more as a new session on the same account, once (SWARM-R3-5).
  if (conductorState.resumed && conductorState.accountId && NO_CONVERSATION.test(exit.lastLines.join('\n'))) {
    conductorState = { ...conductorState, resumed: false }
    if ((await relaunchConductor(conductorState.accountId, true)) === null) return
  }
  store.setSwarmNotification({
    message: `${error}. Its last output is in the Swarm Dashboard's Messages tab, and Debug there shows all of it.`,
    type: 'error',
  })
  store.setSwarmActive(false)
  // The end of the output is what explains an exit, so a long tail loses its start.
  const tail = exit.lastLines.join('\n')
  const quoted = tail.length > EXIT_REPORT_MAX_CHARS ? `…${tail.slice(-EXIT_REPORT_MAX_CHARS)}` : tail
  try {
    await window.swarmAPI.sendMessage('system', 'all', 'info', `${error}: ${quoted || '(no output)'}`)
  } catch {}
  // At its usage limit: run it again on another account, where one is a way out (§9, P2).
  const limit = conductorLimitOf(exit)
  if (limit) {
    try { await offerConductorRun(limit, conductorAccountId(), liveRestartDeps()) } catch { /* the exit report stands */ }
  }
}

// Cleanup
/** Follow the conductor's Claude Code transcript, which is what fills the Trace tab. Up to 1.53 a
 *  pane did it as it mounted, once Debug had unhidden the conductor's terminal. Debug now reads the
 *  output without a pane, so sendTask asks for it at launch, and the monitor again on each tick
 *  until main says it follows it; killing the terminal detaches it. Main follows this launch's own
 *  session, the one `--session-id` named (conductorLaunch.ts), from its first line. It used to
 *  follow the newest transcript in the swarm's folder, from when this launch's conductor had acted:
 *  that missed its first steps, and could be the last swarm's conductor or a Claude Code worker. */
export function watchConductorTrace(): void {
  const { terminalId, cwd, sessionId } = conductorState
  if (!terminalId || !cwd || !sessionId || traceWatchedFor === sessionId) return
  traceWatchedFor = sessionId
  Promise.resolve()
    .then(() => window.agentActivity?.attachWatcher(terminalId, cwd, 'claude', sessionId))
    .then((res) => { if (!res?.data?.attached && traceWatchedFor === sessionId) traceWatchedFor = null })
    .catch(() => { if (traceWatchedFor === sessionId) traceWatchedFor = null })
}

export function stopConductor(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval)
    monitoringInterval = null
  }
  stopNotingWorkers()
  stopNotingWorkers = () => {}

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

  conductorState = { terminalId: null, status: 'idle', error: null, cwd: null, preSwarmSha: null, sessionId: null }
}
