import { useCallback, useEffect, useRef } from 'react'
import { agentFromCommand, type AgentInfo } from '../lib/agentDetector'
import { createReprimeController, type ReprimeController } from '../lib/compactionReprime'
import { createSessionReflectionController, type SessionReflectionController } from '../lib/sessionReflection'
import { useTerminalStore } from '../store/terminalStore'

// Auto context-primer: point a freshly-launched agent at this project's memory digest via the
// memory_primer MCP tool, so every invocation starts already knowing prior decisions and context
// — WITHOUT a wall of text on screen and WITHOUT the agent treating the memory as a task to
// resume. Only primed when relevant memory actually exists (we build the digest first, as the
// relevance check). Opt-out in Settings.
//
// TWO DELIVERY CHANNELS, and the difference matters:
//
//   Claude  → the instruction is seeded INVISIBLY into the system prompt at launch, via
//             `--append-system-prompt-file` (see aiProfiles.ts). Nothing is typed. And because a
//             system prompt is re-sent on every request, it SURVIVES compaction — so the seed
//             also tells Claude to re-call memory_primer itself if its context gets compacted.
//             It re-primes behind the scenes. We never write to its input. Not once.
//
//   Others  → Codex/Gemini have no system-prompt file to append to, so the one-line pointer
//             is pasted into their input at launch, while the line is still empty.
//
// The hard rule for anything that writes to a terminal the user did not ask for: writeToTerminal
// APPENDS AT THE CURSOR, and the line buffer belongs to the agent's TUI, not to us. A write that
// lands while the user is mid-sentence is concatenated onto their draft. (Exactly the fact that
// made pre-send prompt redaction impossible in v1.25.2.) So an unprompted write must first check
// that the input is idle — see reprimeAfterCompaction and, for the launch prime, PrimerGate.

const SETTING_KEY = 'termpolis.memory.autoPrimerOnLaunch'
const INJECT_DELAY_MS = 1500 // let the agent CLI finish booting before we paste

// Bracketed-paste markers so the pointer lands as ONE paste in the agent's
// input — not auto-submitted, not interpreted by shell completion.
const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'

// The behavioral contract pasted into the agent's input. Single line, paste-safe
// (no backticks/newlines). It must (1) route the agent to the MCP tool so the
// digest loads behind the scenes, (2) frame the memory as background only — the
// agent must NOT start acting on it or resuming past work, and (3) pin a minimal
// ack so an Enter on the bare pointer doesn't turn into spontaneous work.
export function buildPrimerPointer(cwd: string, selfRecord = false): string {
  const target = cwd ? `with cwd set to "${cwd}"` : 'with no arguments'
  let pointer =
    `Termpolis memory: call the termpolis MCP tool memory_primer ${target} and read it as background only — ` +
    'do NOT act on it, resume past work, or summarize it. Reply exactly "Memory loaded." then wait. ' +
    'Use memory_search before re-deriving a stored fix; if memory_primer is unavailable, reply "Memory tools unavailable." then wait.'
  if (selfRecord) {
    // Agents without a parseable on-disk transcript can't be auto-learned
    // FROM the way Claude/Codex/Gemini are, so ask it to record its own lesson via MCP —
    // that is how its work reaches the shared brain. One paste-safe line (no newline/backtick).
    pointer +=
      ' Also, when you finish a task or before ending this session, call the termpolis memory_write tool once with a short lesson' +
      ' (the problem, the fix or decision, and any gotcha) tagged to this project — your sessions are not auto-recorded, so this is how your work is remembered for other agents.'
  }
  return pointer
}

/** Auto-primer is ON by default; users opt out in Settings. */
export function isAutoPrimerEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setAutoPrimerEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// Count the gate-passed recall lines in a primer digest — the honest "how many
// memories" metric, matching the Claude launch banner (digest lines start with
// "- [", one per recalled memory; header/competence/curiosity lines don't).
function countPrimerMemories(digest: string): number {
  return digest.split('\n').filter((l) => l.startsWith('- [')).length
}

// Check that relevant memory exists for this project and, if so, paste a short
// pointer into the freshly-launched agent terminal directing it to load the
// digest via the memory_primer MCP tool (behind the scenes — no on-screen dump).
// Best-effort and silent: a no-op if the API is unavailable or there is no
// relevant memory yet. Returns whether it injected.
export async function injectAutoPrimer(terminalId: string, cwd: string, selfRecord = false, notify = false): Promise<boolean> {
  try {
    const api = window.termpolis
    if (!api?.memoryBuildPrimer || !api?.writeToTerminal) return false
    const project = cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' : ''
    const query = project
      ? `recent work, decisions, conventions, and context for ${project}`
      : 'recent work, key decisions, and conventions'
    // Relevance check: build the digest (cwd → current-project precedence) but
    // paste only the pointer — the agent pulls the content itself over MCP.
    const res = await api.memoryBuildPrimer(query, undefined, cwd || undefined)
    if (!res?.success || !res.data) return false
    // Observable recall (#1): on a LAUNCH prime (notify), show the same 🧠 "Loaded N
    // memories" banner Claude gets — so Codex/Gemini recall doesn't look like
    // nothing happened. Compaction re-primes pass notify=false and stay silent.
    if (notify) {
      const n = countPrimerMemories(String(res.data))
      const label = project || 'this project'
      useTerminalStore.getState().setMemoryNotice(`🧠 Loaded ${n} ${n === 1 ? 'memory' : 'memories'} for "${label}"`)
    }
    const wrapped = BP_START + buildPrimerPointer(cwd, selfRecord) + BP_END
    api.writeToTerminal(terminalId, wrapped)
    return true
  } catch {
    return false
  }
}

/** How long we'll wait for the input line to go idle before giving up on a re-prime. */
export const REPRIME_IDLE_POLL_MS = 1500
export const REPRIME_IDLE_MAX_WAIT_MS = 120_000

/** True when the user has an un-submitted draft in this terminal's input line. */
async function inputPending(terminalId: string): Promise<boolean> {
  try {
    const res = await window.aiSecurity?.inputPending?.(terminalId)
    return res?.success === true && res.data === true
  } catch {
    return false // can't tell → don't block the re-prime on a broken bridge
  }
}

/**
 * Re-prime a terminal after its agent compacted away the memory digest.
 *
 * Two rules, both learned the hard way:
 *
 * 1. If the terminal was seeded at launch via --append-system-prompt-file (Claude), DO NOTHING.
 *    A system prompt is re-sent on every request, so compaction — which summarizes the
 *    *conversation* — cannot remove it. The seed already tells the agent to re-call
 *    memory_primer itself when its context is compacted, so it re-primes behind the scenes.
 *    Pasting on top of that is pure noise: it is the text users actually see appear in their
 *    prompt box out of nowhere, and it is redundant.
 *
 * 2. Otherwise the paste is the only channel we have (a manually-typed `codex`/`claude` has no
 *    system prompt we can append to). But NEVER paste over a draft. writeToTerminal appends at
 *    the cursor and the line buffer belongs to the agent's TUI, not to us — so a paste that
 *    lands mid-sentence is concatenated onto whatever the user was typing. Wait for the input
 *    to go idle (it resets on Enter) and paste into an empty line. If they never submit, skip
 *    the re-prime entirely: losing a re-prime is a nuisance, corrupting a prompt is a bug.
 */
export async function reprimeAfterCompaction(
  terminalId: string,
  cwd: string,
  opts: {
    isLaunchPrimed: () => boolean
    pending?: (id: string) => Promise<boolean>
    inject?: (id: string, cwd: string) => Promise<boolean>
    sleep?: (ms: number) => Promise<void>
    pollMs?: number
    maxWaitMs?: number
  },
): Promise<boolean> {
  if (opts.isLaunchPrimed()) return false // rule 1 — it re-primes itself, silently
  const pending = opts.pending ?? inputPending
  const inject = opts.inject ?? ((id, c) => injectAutoPrimer(id, c))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? REPRIME_IDLE_POLL_MS
  const maxWaitMs = opts.maxWaitMs ?? REPRIME_IDLE_MAX_WAIT_MS

  let waited = 0
  while (await pending(terminalId)) {
    if (waited >= maxWaitMs) return false // rule 2 — skip rather than clobber a draft
    await sleep(pollMs)
    waited += pollMs
  }
  return inject(terminalId, cwd)
}

/** How often the launch prime re-checks its gate, and how long it waits before giving up. */
export const PRIMER_GATE_POLL_MS = 500
export const PRIMER_GATE_MAX_WAIT_MS = 180_000

/**
 * The two things that must both be true before the launch pointer may be pasted.
 *
 * They exist because output keyword-scraping (detectAgent) is NOT evidence that an agent is
 * running — it only says the word appeared on screen. In a plain PowerShell terminal PSReadLine
 * repaints the whole input line on every keystroke, so the moment the user has typed `claude`
 * the scraper matches, and 1.5 s later the pointer was pasted onto their still-unsubmitted
 * command: `claudeTermpolis memory: call the termpolis MCP tool ...`. The same regex fires on
 * `cat claude-notes.md`, a grep hit for "gemini", or an MOTD mentioning OpenAI — and then the
 * paste lands in a plain shell, which will happily try to RUN it on the next Enter.
 */
export interface PrimerGate {
  /**
   * The agent Termpolis can actually PROVE is running: the launch command Termpolis itself
   * typed (`agentCommand`), or a launch command the user actually SUBMITTED. Null while they
   * are still typing it — and null forever if the keyword only ever appeared in output.
   */
  launchedAgent: () => AgentInfo | null
  /** The user's un-submitted draft on this terminal's input line; '' when the line is idle. */
  draft: () => string
}

/**
 * Wait for a safe moment, then paste the launch pointer.
 *
 * Gate first, THEN the boot delay — so the 1.5 s is measured from the launch actually being
 * submitted, not from the first time the agent's name flickered through the output stream.
 * The gate is re-checked after that delay, because the user can start typing during it.
 *
 * Gives up silently rather than pasting into a terminal we are not sure about: losing a prime
 * is a nuisance, corrupting the user's command line is a bug.
 */
export async function primeOnLaunch(
  terminalId: string,
  cwd: string,
  gate: PrimerGate,
  opts: {
    inject?: (id: string, cwd: string) => Promise<boolean>
    sleep?: (ms: number) => Promise<void>
    stopped?: () => boolean
    pollMs?: number
    maxWaitMs?: number
    delayMs?: number
  } = {},
): Promise<boolean> {
  // All built-in agents (Claude / Codex / Gemini) have parseable on-disk transcripts, so none
  // need the self-record primer path; keep it wired for future agents that might.
  // notify=true → this launch prime shows the 🧠 Loaded-N banner (parity with Claude).
  const inject = opts.inject ?? ((id, c) => injectAutoPrimer(id, c, false, true))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stopped = opts.stopped ?? (() => false)
  const pollMs = opts.pollMs ?? PRIMER_GATE_POLL_MS
  const maxWaitMs = opts.maxWaitMs ?? PRIMER_GATE_MAX_WAIT_MS
  const delayMs = opts.delayMs ?? INJECT_DELAY_MS

  const open = (): boolean => gate.launchedAgent() != null && gate.draft().length === 0
  let waited = 0
  while (!open()) {
    if (waited >= maxWaitMs) return false
    await sleep(pollMs)
    if (stopped()) return false
    waited += pollMs
  }
  await sleep(delayMs)
  if (stopped()) return false
  if (!open()) return false // they started typing while the CLI was booting
  return inject(terminalId, cwd)
}

// Fire injectAutoPrimer once per terminal, on the first output that looks like an agent — but
// only once PrimerGate says an agent was really launched AND the input line is idle. One
// TerminalPane mounts this per terminal, so the ref scopes the "prime once" guard to that
// terminal's lifetime.
export function useAutoPrimer(
  terminalId: string,
  detectedAgent: AgentInfo | null,
  cwd: string,
  gate?: PrimerGate,
): void {
  const primedRef = useRef(false)
  // Read at FIRE time, not mount time — the gate closes over refs that keep changing.
  const gateRef = useRef<PrimerGate | undefined>(gate)
  gateRef.current = gate
  const agentName = detectedAgent?.name ?? null
  useEffect(() => {
    if (!agentName || !terminalId) return
    if (primedRef.current) return
    if (!isAutoPrimerEnabled()) return
    // Skip the typed launch pointer if this terminal was already seeded at launch
    // (e.g. Claude via --append-system-prompt-file). Compaction re-prime is a
    // separate path and still runs.
    if (useTerminalStore.getState().terminals.find(t => t.id === terminalId)?.launchPrimed) {
      primedRef.current = true
      return
    }
    primedRef.current = true

    // Without a gate from the pane, fall back to the one signal this hook can read on its own:
    // the launch command Termpolis recorded for the terminal. Still authoritative, just blind
    // to a hand-typed launch — which is the safe direction to be blind in.
    const fallback: PrimerGate = {
      launchedAgent: () =>
        agentFromCommand(useTerminalStore.getState().terminals.find(t => t.id === terminalId)?.agentCommand),
      draft: () => '',
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let wake: (() => void) | null = null
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(() => {
          wake = null
          timer = null
          resolve()
        }, ms)
      })

    void primeOnLaunch(terminalId, cwd, gateRef.current ?? fallback, {
      sleep,
      stopped: () => cancelled,
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      timer = null
      // Resume the loop so it observes `cancelled` and unwinds, instead of leaving a
      // never-settled promise holding this closure alive.
      wake?.()
      wake = null
    }
  }, [terminalId, agentName, cwd])
}

// Watch a terminal's live output for a Claude Code compaction and, once it settles,
// re-inject the most relevant memories so the agent recovers the context it just
// summarized away. Returns a STABLE `onOutput(stripped)` to call from the terminal's
// data handler; current cwd/agent are read through refs so the callback never goes
// stale. One TerminalPane mounts this per terminal. Opt-out in Settings.
export function useCompactionReprimer(
  terminalId: string,
  detectedAgent: AgentInfo | null,
  cwd: string,
): (stripped: string) => void {
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const agentRef = useRef<string | null>(detectedAgent?.name ?? null)
  agentRef.current = detectedAgent?.name ?? null

  const controllerRef = useRef<ReprimeController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createReprimeController({
      hasAgent: () => agentRef.current != null,
      reprime: () => {
        void reprimeAfterCompaction(terminalId, cwdRef.current, {
          // Read at FIRE time, not mount time: the flag is set when the agent profile launches,
          // which can land after this controller is constructed.
          isLaunchPrimed: () =>
            useTerminalStore.getState().terminals.find((t) => t.id === terminalId)?.launchPrimed === true,
        })
      },
    })
  }

  useEffect(() => () => controllerRef.current?.dispose(), [])

  return useCallback((stripped: string) => {
    controllerRef.current?.onOutput(stripped)
  }, [])
}

// Map a detected / badged agent identity to its transcript source id (the value the
// reflect-session IPC uses to locate + parse the right transcript).
function agentSourceId(a: AgentInfo | null): string | null {
  const n = a?.name?.toLowerCase() ?? ''
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex')) return 'codex'
  if (n.includes('gemini')) return 'gemini'
  return null
}

// Learn from a SOLO agent session: watch a terminal's output for a task pause
// (idle-settle) and, on that pause or on terminal close, reflect the session's
// transcript delta into the learning brain — so self-competence + reusable lessons grow
// from individual Claude / Codex / Gemini terminals, not only completed swarm tasks.
// Returns a STABLE onOutput to feed from the terminal's data handler; cwd/agent are read
// through refs so it never goes stale. One TerminalPane mounts this per terminal. Opt-out
// in Settings. Best-effort: a gone-away window or missing API is a silent no-op.
export function useSessionReflection(
  terminalId: string,
  detectedAgent: AgentInfo | null,
  cwd: string,
): (stripped: string) => void {
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const cur = agentSourceId(detectedAgent)
  const agentRef = useRef<string | null>(cur)
  agentRef.current = cur
  // Keep the last known agent so a flush at close still has an id even if the badge
  // has already cleared by the time the pane unmounts.
  const lastAgentRef = useRef<string | null>(cur)
  if (cur) lastAgentRef.current = cur

  const controllerRef = useRef<SessionReflectionController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createSessionReflectionController({
      hasAgent: () => agentRef.current != null,
      reflect: () => {
        const agent = lastAgentRef.current
        if (!agent) return
        void window.termpolis?.memoryReflectSession?.(terminalId, cwdRef.current, agent)
      },
    })
  }

  useEffect(
    () => () => {
      controllerRef.current?.flush()
      controllerRef.current?.dispose()
    },
    [],
  )

  return useCallback((stripped: string) => {
    controllerRef.current?.onOutput(stripped)
  }, [])
}
