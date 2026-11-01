import { useCallback, useEffect, useRef } from 'react'
import { agentFromCommand, isAntigravityCommand, type AgentInfo } from '../lib/agentDetector'
import { createReprimeController, type ReprimeController } from '../lib/compactionReprime'
import { createSessionReflectionController, type SessionReflectionController } from '../lib/sessionReflection'
import { useTerminalStore } from '../store/terminalStore'
import { isAwaitingAnswer, tailSlice } from '../lib/promptAutoDismiss'
import { psQuote } from '../../../shared/shellQuote'

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
//
// The same rule from the other side: the pointer is only safe at an AGENT's input. Pasted with its
// Enter at a shell's prompt it is a command line, and an agent that died while it started (a
// missing binary, a failed sign-in, a crash on boot) leaves exactly that prompt, which the screen
// can't always tell from an agent at its input. So before the paste, and again before the Enter,
// the OS is asked whether anything but the shell runs in the terminal (shellAloneNow). An answer
// of "only the shell" before the paste is put to the OS again, a little later, before it is
// believed (ALONE_ASKS): an agent that is still starting is not on the console yet either.
//
// That question takes a second or two on Windows, and a person starts typing into a fresh agent in
// that time. So the idle check is not made once, ahead of it: it is made LAST, after the OS and the
// screen, right before the paste and again right before the Enter (canTypePointer). A draft that
// shows up in between holds the paste back, or, when the pointer is already pasted, the Enter.

const SETTING_KEY = 'termpolis.memory.autoPrimerOnLaunch'
const INJECT_DELAY_MS = 1500 // let the agent CLI finish booting before we paste

// Bracketed-paste markers so the pointer lands as ONE paste in the agent's
// input — not interpreted by shell completion, and not split across lines.
const BP_START = '\x1b[200~'
const BP_END = '\x1b[201~'

/** Pause between the pasted pointer and the Enter that submits it. Long enough
 *  that a TUI's paste-burst detector has closed the burst and reads the Return
 *  as a keystroke. Mirrors SUBMIT_SETTLE_MS in src/main/remoteBridge/dispatcher. */
export const PRIMER_SUBMIT_SETTLE_MS = 150

// What a folder's name may be made of for the pointer to name it: letters, marks and digits of
// any script, a space, and  _.,:/\+@~=#()[]{}-  Each is inert in every shell the pointer could
// reach (POSIX shells, fish, PowerShell, cmd.exe) and in the paste itself, which no control
// character may be part of: an Escape in a name could end the bracketed paste early and type the
// rest. A name is data somebody else chose (a cloned repository's directory), so it is checked
// against what is allowed, not against what is known to be bad. primerPointerShell.test.ts types
// the pointer into the real bash, PowerShell and cmd.exe to prove it.
const NAMEABLE_FOLDER = /^[\p{L}\p{M}\p{N} _.,:/\\+@~=#()[\]{}-]+$/u

/**
 * The folder as the pointer names it: a single-quoted literal (shellQuote.ts), in which nothing is
 * special to a POSIX shell, fish or PowerShell, and which holds nothing cmd.exe (it has no single
 * quotes) would read as code. Between double quotes a shell expands $(...) and backticks in the name,
 * and a name can close the quotes itself and comment out the rest of the pointer (x"; cmd; #), which
 * ran in Git Bash and Windows PowerShell. null for a name outside NAMEABLE_FOLDER and for one ending
 * in a backslash (fish reads it as an escaped closing quote): the pointer then names no folder at all.
 */
function pointerFolder(cwd: string): string | null {
  return NAMEABLE_FOLDER.test(cwd) && !cwd.endsWith('\\') ? psQuote(cwd) : null
}

// The behavioral contract pasted into the agent's input. Single line, paste-safe
// (no backticks/newlines). It must (1) route the agent to the MCP tool so the
// digest loads behind the scenes, (2) frame the memory as background only — the
// agent must NOT start acting on it or resuming past work, and (3) pin a minimal
// ack so an Enter on the bare pointer doesn't turn into spontaneous work.
export function buildPrimerPointer(cwd: string, selfRecord = false): string {
  const folder = cwd ? pointerFolder(cwd) : null
  const target = folder ? `with cwd set to ${folder}` : 'with no arguments'
  let pointer =
    `Termpolis memory: call the termpolis MCP tool memory_primer ${target} and read it as background only — ` +
    'do NOT act on it, resume past work, or summarize it. Reply exactly "Memory loaded." then wait. ' +
    'Use memory_search before re-deriving a stored fix; if memory_primer is unavailable, reply "Memory tools unavailable." then wait.'
  if (selfRecord) {
    // Agents without a parseable on-disk transcript can't be auto-learned
    // FROM the way Claude/Codex are, so ask it to record its own lesson via MCP —
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

/**
 * True unless the agent's screen can be read and shows nothing waiting for an answer
 * (isAwaitingAnswer). A screen that can't be read counts as a prompt: nothing is typed
 * into a terminal whose state is unknown.
 */
export async function promptShowing(terminalId: string): Promise<boolean> {
  try {
    const res = await window.termpolis?.readTerminalBuffer?.(terminalId)
    if (!res?.success || !res.data) return true
    return isAwaitingAnswer(tailSlice(res.data.output || ''))
  } catch {
    return true
  }
}

/**
 * True only when the OS says nothing runs in the terminal but its shell (terminalShellAlone,
 * shellAlone.ts, the question the model switcher asks): the agent started in it has exited, and the
 * pointer would land at the shell's prompt. Anything less sure is false and the pointer goes in as
 * it always did: null (a shell the OS can't read, WSL, a query that failed), a failed or missing
 * call (an older preload, a test double) and a throw. Holding every pointer back whenever the OS is
 * silent would turn recall off for those shells.
 */
export async function shellAloneNow(terminalId: string): Promise<boolean> {
  try {
    const res = await window.termpolis?.terminalShellAlone?.(terminalId)
    return res?.success === true && res.data === true
  } catch {
    return false
  }
}

/** How long to wait before asking the OS again when it says only the shell runs, and how many
 *  answers in all it takes to believe that. An agent that is still starting is not on the console
 *  yet either (a slow start on a busy Windows laptop), and that early answer reads exactly like the
 *  one for an agent that has gone. A dead agent stays dead, so asking again only costs time, and
 *  only when nothing is going to be typed anyway. */
export const ALONE_RECHECK_MS = 2000
export const ALONE_ASKS = 3

/** True when the OS has said `asks` times, `ALONE_RECHECK_MS` apart, that only the shell runs. */
async function agentGone(terminalId: string, asks: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let answered = 1; ; answered++) {
    if (!(await shellAloneNow(terminalId))) return false
    if (answered >= asks) return true
    await sleep(ALONE_RECHECK_MS)
  }
}

/**
 * Whether the pointer may be typed into this terminal right now: an agent runs in it (the OS does
 * not say that only the shell does), its screen shows nothing waiting for an answer, and the line
 * is still idle (`stillIdle`, the caller's own look at the user's draft). The OS is asked FIRST,
 * the screen next and the draft LAST. The OS takes a second or two on Windows, and a person starts
 * typing into a fresh agent in that time, so the draft look has to come after the slowest question
 * and right before the write; so does the screen look, which is what keeps an Enter from answering
 * a trust or approval prompt that came up while the OS was answering.
 *
 * `asks` is how many times a "only the shell runs" answer is put to the OS before it is believed:
 * several before the paste, where the agent may simply not be up yet, one before the Enter, where
 * the agent was there a moment ago.
 */
async function canTypePointer(
  terminalId: string,
  sleep: (ms: number) => Promise<void>,
  asks: number,
  stillIdle?: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (await agentGone(terminalId, asks, sleep)) return false
  if (await promptShowing(terminalId)) return false
  return stillIdle ? await stillIdle() : true
}

// Check that relevant memory exists for this project and, if so, paste a short
// pointer into the freshly-launched agent terminal directing it to load the
// digest via the memory_primer MCP tool (behind the scenes — no on-screen dump).
// Best-effort and silent: a no-op if the API is unavailable or there is no
// relevant memory yet. Returns whether it injected. `stillIdle` is the caller's look at the user's
// draft, asked last before the paste and again before the Enter (canTypePointer): false means the
// user is typing, and nothing more is written.
export async function injectAutoPrimer(
  terminalId: string,
  cwd: string,
  selfRecord = false,
  notify = false,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  stillIdle?: () => boolean | Promise<boolean>,
): Promise<boolean> {
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
    // The pointer goes in with an Enter, and an Enter on a trust or approval prompt answers
    // it — which is how a paste 1.5 s into a Codex launch used to accept its folder-trust
    // prompt. At a SHELL's prompt the same Enter runs the pointer as a command, and that is where
    // an agent that died while it started has left the terminal. Checked after the recall, right
    // before typing, and again before the Enter (canTypePointer).
    if (!(await canTypePointer(terminalId, sleep, ALONE_ASKS, stillIdle))) return false
    const wrapped = BP_START + buildPrimerPointer(cwd, selfRecord) + BP_END
    api.writeToTerminal(terminalId, wrapped)
    // Then submit it. Pasting alone left the pointer sitting in the agent's
    // composer forever — the "this paragraph keeps getting repeated in the input
    // area" report from Codex on Linux — where it is in the way of everything
    // the user types next, and where a later prime appends to it rather than
    // replacing it.
    //
    // The Enter MUST be a separate write, after a pause. Fused as one string, a
    // TUI's paste-burst heuristic reads `<paste>\r` as part of the paste and
    // deliberately does NOT submit (Codex behaves exactly this way); two writes
    // separated by ~150 ms read as a human pressing Return. Same reasoning, and
    // the same constant, as SUBMIT_SETTLE_MS in the remote dispatcher, which
    // fixed the identical symptom for messages sent from the phone.
    await sleep(PRIMER_SUBMIT_SETTLE_MS)
    // A prompt can have come up since the paste, the agent can have exited, or the user can have
    // started typing. What was pasted then stays where it is and is never submitted: an Enter now
    // would send their draft together with it.
    if (!(await canTypePointer(terminalId, sleep, 1, stillIdle))) return false
    api.writeToTerminal(terminalId, '\r')
    // Observable recall (#1): on a LAUNCH prime (notify), show the same 🧠 "Loaded N
    // memories" banner Claude gets — so Codex/Gemini recall doesn't look like
    // nothing happened. Compaction re-primes pass notify=false and stay silent. Said only once
    // the Enter is in: a pointer left unsent at a skip above has loaded nothing.
    if (notify) {
      const n = countPrimerMemories(String(res.data))
      const label = project || 'this project'
      useTerminalStore.getState().setMemoryNotice(`🧠 Loaded ${n} ${n === 1 ? 'memory' : 'memories'} for "${label}"`)
    }
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
    /**
     * The un-submitted draft on the pane's input line, '' when it is idle. Looked at again right
     * before the paste and before the Enter, after the OS question has had its time. It is the
     * pane's own record of the user's keystrokes, not `pending`: main stages what is written to an
     * AI-flagged terminal, the pointer's own paste included, so `pending` would hold back the Enter
     * for the paste just made.
     */
    draft?: () => string
    /** A prompt is on screen (promptShowing). Waited out like a draft. */
    awaiting?: (id: string) => Promise<boolean>
    inject?: (id: string, cwd: string) => Promise<boolean>
    sleep?: (ms: number) => Promise<void>
    pollMs?: number
    maxWaitMs?: number
  },
): Promise<boolean> {
  if (opts.isLaunchPrimed()) return false // rule 1 — it re-primes itself, silently
  const pending = opts.pending ?? inputPending
  const awaiting = opts.awaiting ?? promptShowing
  const draft = opts.draft
  const inject = opts.inject ?? ((id, c) => injectAutoPrimer(id, c, false, false, undefined, draft && (() => draft() === '')))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? REPRIME_IDLE_POLL_MS
  const maxWaitMs = opts.maxWaitMs ?? REPRIME_IDLE_MAX_WAIT_MS

  let waited = 0
  // A compaction can land while the agent waits on an approval prompt; the pointer's Enter
  // would answer it. Wait that out the same way as a draft.
  while ((await pending(terminalId)) || (await awaiting(terminalId))) {
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
  /** The command the agent was launched with, when known. */
  launchCommand?: () => string | null | undefined
}

/** Agents whose sessions Termpolis can't learn from on disk, so the launch pointer asks them to
 *  record their own lesson with memory_write. Only agy (Gemini) today: Claude and Codex
 *  transcripts are read, and so are the older `gemini` CLI's, while agy's sessions live in a store
 *  Termpolis doesn't parse. Decided by the launch command, since both Gemini CLIs share a name. */
export function selfRecordsLessons(command: string | null | undefined): boolean {
  return isAntigravityCommand(command)
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
    /** Pastes the pointer; `selfRecord` asks the agent to record its own lesson (selfRecordsLessons). */
    inject?: (id: string, cwd: string, selfRecord: boolean) => Promise<boolean>
    /** A prompt is on screen (promptShowing). Waited out after the boot delay. */
    awaiting?: (id: string) => Promise<boolean>
    sleep?: (ms: number) => Promise<void>
    stopped?: () => boolean
    pollMs?: number
    maxWaitMs?: number
    delayMs?: number
  } = {},
): Promise<boolean> {
  const awaiting = opts.awaiting ?? promptShowing
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stopped = opts.stopped ?? (() => false)
  const pollMs = opts.pollMs ?? PRIMER_GATE_POLL_MS
  const maxWaitMs = opts.maxWaitMs ?? PRIMER_GATE_MAX_WAIT_MS
  const delayMs = opts.delayMs ?? INJECT_DELAY_MS

  const open = (): boolean => gate.launchedAgent() != null && gate.draft().length === 0
  // Claude and Codex are learned from their on-disk transcripts. agy (Gemini) keeps its sessions
  // where Termpolis doesn't read them, so it is asked to record its own lesson (selfRecordsLessons).
  // notify=true → this launch prime shows the 🧠 Loaded-N banner (parity with Claude).
  // The gate is looked at once more inside the inject, after the OS question and right before each
  // write: the person keeps typing while it answers. A pane that has gone is not looked at either,
  // since the gate then reads a draft that nothing feeds any more.
  const inject =
    opts.inject ?? ((id, c, selfRecord) => injectAutoPrimer(id, c, selfRecord, true, undefined, () => !stopped() && open()))
  let waited = 0
  while (!open()) {
    if (waited >= maxWaitMs) return false
    await sleep(pollMs)
    if (stopped()) return false
    waited += pollMs
  }
  await sleep(delayMs)
  if (stopped()) return false
  // A folder-trust prompt the agent put up while it booted is the user's to answer. Wait for
  // it to go, within the same budget as the gate.
  while (await awaiting(terminalId)) {
    if (waited >= maxWaitMs) return false
    await sleep(pollMs)
    if (stopped()) return false
    waited += pollMs
  }
  if (!open()) return false // they started typing while the CLI was booting
  return inject(terminalId, cwd, selfRecordsLessons(gate.launchCommand?.()))
}

// Fire injectAutoPrimer once per terminal, on the first output that looks like an agent — but
// only once PrimerGate says an agent was really launched AND the input line is idle.
//
// "Once per terminal" is enforced on the TERMINAL, not on this hook's mount. One TerminalPane
// mounts this per terminal, but that pane is remounted whenever the layout changes — toggling
// split view, hiding/unhiding a terminal, switching workspaces — and a useRef guard resets with
// it. That is the "this paragraph keeps getting repeated in the input area" bug: every remount
// pasted the pointer again, each one stacking onto the last in the agent's composer.
//
// The flag is set BEFORE the attempt rather than after it lands, so a pane that unmounts
// mid-wait cannot leave a second attempt behind. A prime lost that way is a nuisance; a prompt
// box full of duplicated pointer text is a bug — the same trade this file makes everywhere.
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
    const store = useTerminalStore.getState()
    const term = store.terminals.find(t => t.id === terminalId)
    if (term?.primerPointed) return
    primedRef.current = true
    // The ref above only survives this mount; the flag is what survives the pane.
    // Best-effort on purpose: if there is no record to mark, or the store this is
    // running against has no setter, the ref still holds for the life of the mount
    // — exactly the old behavior, never worse.
    if (term) store.updateTerminal?.(terminalId, { primerPointed: true })
    // Skip the typed launch pointer if this terminal was already seeded at launch
    // (e.g. Claude via --append-system-prompt-file). Compaction re-prime is a
    // separate path and still runs.
    if (term?.launchPrimed) return

    // Without a gate from the pane, fall back to the one signal this hook can read on its own:
    // the launch command Termpolis recorded for the terminal. Still authoritative, just blind
    // to a hand-typed launch — which is the safe direction to be blind in.
    const launchCommand = (): string | undefined => useTerminalStore.getState().terminals.find(t => t.id === terminalId)?.agentCommand
    const fallback: PrimerGate = {
      launchedAgent: () => agentFromCommand(launchCommand()),
      draft: () => '',
      launchCommand,
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
  draft?: () => string,
): (stripped: string) => void {
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const draftRef = useRef(draft)
  draftRef.current = draft
  const agentRef = useRef<string | null>(detectedAgent?.name ?? null)
  agentRef.current = detectedAgent?.name ?? null

  const controllerRef = useRef<ReprimeController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createReprimeController({
      hasAgent: () => agentRef.current != null,
      reprime: () => {
        void reprimeAfterCompaction(terminalId, cwdRef.current, {
          // The pane's draft is read at fire time too, through the ref: the accessor can change.
          draft: () => draftRef.current?.() ?? '',
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
