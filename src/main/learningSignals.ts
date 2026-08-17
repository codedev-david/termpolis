// learningSignals.ts
//
// The producers for the two WorkEvents that outcomeSignals already knows how to grade.
//
// WHY: deriveOutcome (outcomeSignals.ts:28) has understood 'git-commit' and 'test-run'
// since the competence layer shipped, but nothing EMITTED them for ordinary work. The
// only commit that ever counted was one made through the in-app Git panel, and the only
// test run was swarm:run-command. A commit typed into a terminal pane — which is how
// most people actually commit — and a test suite run by an agent both went past the
// brain unseen, so every domain sat at attempts:0 / "unproven" forever.
//
// Two watchers, both narrow on purpose:
//   - a git HEAD poller over the open projects, modelled on the resolution the workflow
//     trigger supervisor already performs every tick (triggers.ts:431)
//   - a classifier over agent tool_call/tool_result pairs, which is where a terminal test
//     run is already visible as structured data — no PTY text scraping
//
// Precision beats volume here. A false positive doesn't just add noise: a build or lint
// failure booked as a 'test-run' failure lowers the repo's competence on evidence that
// was never about correctness. So an unclassified command emits NOTHING, exactly as
// deriveOutcome returns null (outcomeSignals.ts:37).
//
// Everything external is injected, so the whole module runs in plain Node with no
// Electron, no clock and no git repo.

import { gitDirOf, headRef, resolveRef, type ReadBytes } from './workflow/triggers'
import type { FsLike } from './workflow/workflowStore'
import type { AgentEvent } from './agentEventBus'
import type { WorkEvent } from './outcomeSignals'

/** setInterval's handle type differs between the DOM and Node libs — it travels opaquely. */
type TimerHandle = ReturnType<typeof setInterval>

export interface LearningSignalDeps {
  /** Project cwds currently open in the app. Re-read every tick, so opening a repo arms it
   *  and closing one disarms it without any explicit registration. */
  openProjects: () => string[]
  /** The cwd a terminal is running in, or null/undefined when it can't be resolved. */
  cwdForTerminal: (terminalId: string) => string | null | undefined
  /** cwd -> competence domain. MUST be normalizeProjectSlug (swarmMemory.ts:89): a bare
   *  basename bypasses the home-directory rejection and re-creates the v1.26.2 bug where
   *  the user's own account name became a competence domain. '' means "not a project". */
  normalizeProject: (cwd: string) => string
  /** Where a derived event goes — recordWorkOutcome, which runs it through deriveOutcome. */
  emit: (e: WorkEvent) => void
  /** agentEventBus.subscribe; returns its unsubscribe. */
  subscribe: (cb: (e: AgentEvent) => void) => () => void
  /** Only the two reads the git plumbing performs. Widened to FsLike at the call site so
   *  callers don't have to hand over a write-capable fs just to read a sha. */
  fs: Pick<FsLike, 'existsSync' | 'readFileSync'>
  /** Raw byte reader for packed-refs — never a >512 MiB utf8 string (see fileLines.ts). */
  readBytes: ReadBytes
  tickMs?: number
  setInterval?: (fn: () => void, ms: number) => TimerHandle
  clearInterval?: (h: TimerHandle) => void
}

/** Matches the trigger supervisor's cadence (triggers.ts:62) — the poll is a couple of
 *  small file reads per open repo, and a commit is not time-critical. */
const DEFAULT_TICK_MS = 15_000

/** How long a tool_call stays eligible to be paired with a tool_result. A suite that ran
 *  half an hour ago is not the thing this result belongs to. */
const MAX_PAIR_MS = 30 * 60_000

/** Cap on in-flight test calls. An entry is dropped on the very next tool_call or
 *  tool_result for that terminal, so this only bounds runs that were abandoned. */
const MAX_PENDING = 64

interface HeadState {
  ref: string
  sha: string
}

interface PendingTest {
  project: string
  ts: number
}

const heads = new Map<string, HeadState>()
const pending = new Map<string, PendingTest>()
let stopTimer: (() => void) | null = null
let unsubscribe: (() => void) | null = null

// ── test-run classification ──────────────────────────────────────────────────

/** Shell separators. `cd repo && npm test` is two commands and only the second is a test
 *  run; splitting on them is also what keeps `cat vitest.config.ts` from ever matching,
 *  because every runner pattern below is anchored to the start of a segment. */
const SEPARATORS = /\r?\n|&&|\|\||[;|]/

/** A leading launcher that isn't part of the runner's identity: `npx vitest` IS a vitest run. */
const LAUNCHER = /^(?:npx|bunx|pnpm\s+exec|yarn\s+dlx)\s+/

/** Deliberately short. SAFE_RUNNERS (gitCommand.ts:134) allows npm, make, tsc and friends
 *  because it answers "is this safe to execute"; this list answers a different question —
 *  "did this command produce ground truth about whether the work is correct" — and a build
 *  or a lint pass does not. Anything not listed here is simply not a signal. */
const TEST_RUNNERS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/, // npm test, pnpm run test:unit
  /^(?:vitest|jest)\b/,
  /^pytest\b/,
  /^python3?\s+-m\s+pytest\b/,
  /^cargo\s+test\b/,
  /^go\s+test\b/,
  /^dotnet\s+test\b/,
]

/** Is this shell command a test-suite run? High precision, low recall by design. */
export function isTestCommand(command: string): boolean {
  for (const segment of command.split(SEPARATORS)) {
    const s = segment.trim().replace(LAUNCHER, '')
    if (TEST_RUNNERS.some((re) => re.test(s))) return true
  }
  return false
}

/** The shell command a tool_call ran, or '' when the tool didn't run one. Claude publishes
 *  `{ tool, input }` with the Bash tool's `{ command }` inside (claudeCodeWatcher.ts:170);
 *  other producers hand over the string directly. */
function commandOf(payload: Record<string, unknown>): string {
  const input = payload.input
  if (typeof input === 'string') return input
  if (typeof input === 'object' && input !== null) {
    const command = (input as Record<string, unknown>).command
    if (typeof command === 'string') return command
  }
  return typeof payload.command === 'string' ? payload.command : ''
}

function noteToolCall(d: LearningSignalDeps, ev: AgentEvent): void {
  // ANY tool call supersedes the last one on that terminal. Without this, a test run
  // followed by an unrelated Read would be handed the Read's result — and a Read almost
  // never errors, so a failing suite would silently book as a pass.
  pending.delete(ev.terminalId)
  if (!isTestCommand(commandOf(ev.payload))) return
  const cwd = d.cwdForTerminal(ev.terminalId)
  const project = cwd ? d.normalizeProject(cwd) : ''
  if (!project) return
  if (pending.size >= MAX_PENDING) pending.clear()
  pending.set(ev.terminalId, { project, ts: ev.ts })
}

function resolveToolCall(d: LearningSignalDeps, ev: AgentEvent): void {
  const call = pending.get(ev.terminalId)
  if (!call) return
  pending.delete(ev.terminalId)
  // Only Claude's watcher carries is_error (claudeCodeWatcher.ts:182). Without the flag we
  // don't know whether the suite passed, and defaulting to "passed" would hand out a free
  // success — the exact dishonesty this signal exists to remove.
  const isError = ev.payload.isError
  if (typeof isError !== 'boolean') return
  // A result this far from its call is not its result; the pair was lost.
  if (ev.ts - call.ts > MAX_PAIR_MS) return
  d.emit({ kind: 'test-run', project: call.project, exitCode: isError ? 1 : 0 })
}

function onAgentEvent(d: LearningSignalDeps, ev: AgentEvent): void {
  // The bus wraps every subscriber in try/catch (agentEventBus.ts:181), so a throw here
  // can't break other subscribers — no second net needed.
  if (ev.kind === 'tool_call') {
    noteToolCall(d, ev)
    return
  }
  if (ev.kind === 'tool_result') resolveToolCall(d, ev)
}

// ── git HEAD watcher ─────────────────────────────────────────────────────────

function checkHead(d: LearningSignalDeps, cwd: string): void {
  const project = d.normalizeProject(cwd)
  if (!project) return
  const fs = d.fs as FsLike
  const gitDir = gitDirOf(cwd, fs)
  if (!gitDir) return
  // Follow HEAD's symbolic ref while attached. Detached, headRef is null and the literal
  // 'HEAD' resolves to the raw sha in the HEAD file, so a commit made on a detached HEAD
  // still counts instead of being invisible.
  const ref = headRef(gitDir, fs) ?? 'HEAD'
  const sha = resolveRef(gitDir, ref, fs, d.readBytes)
  if (!sha) return
  const prev = heads.get(cwd)
  heads.set(cwd, { ref, sha })
  // Unseeded, or the ref itself changed (branch switch / checkout): adopt the new position
  // silently. Only movement OF THE SAME ref is a commit — the same rule checkGit applies
  // at triggers.ts:442, and without it every `git switch` would book a phantom commit.
  if (!prev || prev.ref !== ref) return
  if (prev.sha === sha) return
  d.emit({ kind: 'git-commit', project, ok: true })
}

function pollGitHeads(d: LearningSignalDeps): void {
  let open: string[]
  try {
    open = d.openProjects()
  } catch {
    return // a broken session read must not kill the ticker — the next tick retries
  }
  const seen = new Set<string>()
  for (const cwd of open) {
    seen.add(cwd)
    try {
      checkHead(d, cwd)
    } catch {
      /* one unreadable repo must never stop the others */
    }
  }
  // Forget projects that closed, so the map tracks open repos rather than every repo the
  // app has ever seen this launch.
  for (const cwd of heads.keys()) if (!seen.has(cwd)) heads.delete(cwd)
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Arm both watchers. Idempotent: starting again replaces the previous run. */
export function startLearningSignals(d: LearningSignalDeps): void {
  stopLearningSignals()
  unsubscribe = d.subscribe((ev) => onAgentEvent(d, ev))
  const every = d.tickMs ?? DEFAULT_TICK_MS
  const setTimer = d.setInterval ?? setInterval
  const clearTimer = d.clearInterval ?? clearInterval
  const handle = setTimer(() => pollGitHeads(d), every)
  stopTimer = () => clearTimer(handle)
}

/** Disarm both watchers and forget all remembered state. Safe to call when not started. */
export function stopLearningSignals(): void {
  if (stopTimer) stopTimer()
  if (unsubscribe) unsubscribe()
  stopTimer = null
  unsubscribe = null
  heads.clear()
  pending.clear()
}
