// Solo-session reflection trigger (framework-free core).
//
// The Mneme learning brain distils lessons + self-competence from finished SWARM tasks.
// Most real usage is individual agent terminals, though, so this controller extends
// learning to them: it treats any agent output as "activity" and, once the terminal has
// gone QUIET for `idleMs` (a natural task pause) — or on an explicit flush at terminal
// close — asks the caller to reflect the session's transcript delta. Pure state machine
// (no React, no DOM) so the debounce, gates, and flush are deterministically testable.

const SETTING_KEY = 'termpolis.memory.learnFromSessions'

/** Learning from solo agent sessions is ON by default; users opt out in Settings. */
export function isSoloLearningEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setSoloLearningEnabled(on: boolean): void {
  try {
    localStorage.setItem(SETTING_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// Fire a reflection pass once the terminal has been quiet for this long after activity.
// Long enough that it lands at a genuine task pause, not between two lines of one burst.
export const DEFAULT_SESSION_IDLE_MS = 60_000

export interface SessionReflectionController {
  /** Feed stripped terminal output — content is irrelevant, any output marks activity. */
  onOutput(stripped: string): void
  /** Reflect immediately if activity is pending (call on terminal close). */
  flush(): void
  /** Cancel any pending reflection (call on teardown). */
  dispose(): void
}

export interface SessionReflectionOptions {
  /** Called when a settled (or flushed) session should be reflected. */
  reflect: () => void
  /** Only accumulate activity while an AI agent is present. Default: always. */
  hasAgent?: () => boolean
  /** Gate on the user setting at fire time (so toggling takes effect live). */
  isEnabled?: () => boolean
  idleMs?: number
}

export function createSessionReflectionController(opts: SessionReflectionOptions): SessionReflectionController {
  const idleMs = opts.idleMs ?? DEFAULT_SESSION_IDLE_MS
  const isEnabled = opts.isEnabled ?? isSoloLearningEnabled
  const hasAgent = opts.hasAgent ?? (() => true)

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false // unreflected agent activity has accumulated

  function fire(): void {
    timer = null
    if (!dirty) return
    // Checked at fire time, not activity time, so a live toggle-off suppresses it.
    if (!isEnabled()) return
    dirty = false
    opts.reflect()
  }

  function onOutput(_stripped: string): void {
    if (!hasAgent()) return // never learn from a plain (non-agent) shell
    if (!isEnabled()) return
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, idleMs)
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    fire()
  }

  function dispose(): void {
    if (timer) clearTimeout(timer)
    timer = null
    dirty = false
  }

  return { onOutput, flush, dispose }
}
