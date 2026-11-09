// v1.55.0 Task 7: "Auto (best for the task)", the Claude default model that picks the model and
// effort per launch from the task the user typed (src/shared/taskRouter.ts). Everything here is the
// renderer's half: the launch arguments, the per-account memory of models an account can't use,
// the watch that spots Claude Code saying so, and the one-time seeding of Auto as the default.
import { routeTask, isClaudeModelWord, type ClaudeModelWord, type EffortLevel, type RouteDecision, type RouterTuning } from '../../../shared/taskRouter'
import { commandPicksModelOrSession } from '../../../shared/launchCarry'
import { useTerminalStore } from '../store/terminalStore'
import { AUTO_MODEL, getAgentModelDefaults, setAgentModelDefault } from './agentModelDefaults'

/** The effort levels Claude Code's `--effort` takes. */
export const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** ` --effort <level>` for a level Claude Code takes, else ''. */
export function claudeEffortArg(level: unknown): string {
  return typeof level === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(level) ? ` --effort ${level}` : ''
}

/** Does the command already choose its model, effort or conversation? Then Auto stays out. */
export function carriesModelOrEffort(command: string): boolean {
  return commandPicksModelOrSession('claude', command) || /(^|\s)--effort(=|\s|$)/.test(command)
}

export interface AutoLaunch {
  /** ` --model <word>`, or '' (the command's own choice, or the account can't use the pick). */
  modelArg: string
  /** ` --effort <level>`, or ''. */
  effortArg: string
  /** What the router decided; null when the command carried its own model or effort. */
  decision: RouteDecision | null
  /** The routed model, left off because this account can't use it. */
  skipped?: ClaudeModelWord
}

/** The arguments an Auto launch adds to `carried` (the command as configured). The user's own
 *  `--model` or `--effort` wins: nothing is added then. A routed model the account is known not to
 *  have is left off, so Claude Code starts on its own default, and the effort still goes on. */
export function autoLaunchArgs(
  task: string | undefined,
  carried: string,
  unavailable: readonly ClaudeModelWord[] = [],
  tune?: RouterTuning,
): AutoLaunch {
  if (carriesModelOrEffort(carried)) return { modelArg: '', effortArg: '', decision: null }
  const decision = routeTask({ prompt: task ?? '' }, tune)
  const effortArg = claudeEffortArg(decision.effort)
  if (unavailable.includes(decision.model)) return { modelArg: '', effortArg, decision, skipped: decision.model }
  return { modelArg: ` --model ${decision.model}`, effortArg, decision }
}

// ── Models an account can't use ───────────────────────────────────────────────────────────

export const UNAVAILABLE_KEY = 'termpolis.agent.modelUnavailable'
const DEFAULT_ACCOUNT = 'default'

function readUnavailable(): Record<string, ClaudeModelWord[]> {
  try {
    const raw = localStorage.getItem(UNAVAILABLE_KEY)
    const saved = raw ? (JSON.parse(raw) as unknown) : null
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    const out: Record<string, ClaudeModelWord[]> = {}
    for (const [account, words] of Object.entries(saved as Record<string, unknown>)) {
      if (Array.isArray(words)) out[account] = words.filter(isClaudeModelWord)
    }
    return out
  } catch {
    return {}
  }
}

/** The models Claude Code told this account it can't use. */
export function unavailableModels(account: string | null | undefined): ClaudeModelWord[] {
  return readUnavailable()[account || DEFAULT_ACCOUNT] ?? []
}

/** Remember that `account` can't use `word`, so the next Auto launch there leaves it off. */
export function rememberUnavailable(account: string | null | undefined, word: ClaudeModelWord): void {
  const all = readUnavailable()
  const key = account || DEFAULT_ACCOUNT
  const list = all[key] ?? []
  if (list.includes(word)) return
  all[key] = [...list, word]
  try {
    localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable: the model is just tried again next time */
  }
}

/** What Claude Code prints when the model on its command line isn't one the account has:
 *  "There's an issue with the selected model (haiku). It may not exist or you may not have access
 *  to it." The parenthesised model is required, and taskPromptArg strips parentheses from a task,
 *  so the echo of the typed launch line (the task included) can never match. */
export const MODEL_UNAVAILABLE = /selected\s*model\s*\([^)]{1,80}\)\.?\s*It\s*may\s*not\s*exist/i
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** How long after an Auto launch the terminal is watched for that message. */
export const UNAVAILABLE_WATCH_MS = 60_000

export interface UnavailableWatch {
  subscribe: (cb: (id: string, data: string) => void) => () => void
  terminalId: string
  ms?: number
  onFound: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

/** Watches one terminal's output for MODEL_UNAVAILABLE for `ms`; calls onFound at most once.
 *  Returns a stop function. Only the last 600 characters are kept, colour codes stripped. */
export function watchModelUnavailable(opts: UnavailableWatch): () => void {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let tail = ''
  let done = false
  let unsubscribe: (() => void) | null = null
  let timer: unknown = null
  const stop = (): void => {
    if (done) return
    done = true
    unsubscribe?.()
    if (timer !== null) clearTimer(timer)
  }
  try {
    unsubscribe = opts.subscribe((id, data) => {
      if (done || id !== opts.terminalId) return
      tail = (tail + data.replace(ANSI, '')).slice(-600)
      if (MODEL_UNAVAILABLE.test(tail)) {
        stop()
        opts.onFound()
      }
    })
  } catch {
    return stop
  }
  timer = setTimer(stop, opts.ms ?? UNAVAILABLE_WATCH_MS)
  return stop
}

const MODEL_LABEL: Record<ClaudeModelWord, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', opusplan: 'Opus Plan' }

export function unavailableNotice(word: ClaudeModelWord): string {
  return `⚠️ ${MODEL_LABEL[word]} isn't available on this account. Type /model to pick another now; Auto leaves it off from the next launch.`
}

export function skippedNotice(word: ClaudeModelWord): string {
  return `🤖 Auto picked ${MODEL_LABEL[word]}, which this account can't use, so Claude starts on its own default.`
}

// ── Auto as the default ─────────────────────────────────────────────────────────────────

export const AUTO_OFFERED_KEY = 'termpolis.agent.autoOffered'
const ONBOARDING_SEEN_KEY = 'termpolis.onboarding.seen.v1'

/** A new install (nothing saved, onboarding never seen) gets Auto as the Claude default. Anyone else
 *  who isn't on Auto gets one notice, once, pointing at the setting. Called once at startup. */
export function seedAutoDefault(): 'seeded' | 'offered' | 'none' {
  try {
    const defaults = getAgentModelDefaults()
    if (defaults.claude === AUTO_MODEL) return 'none'
    if (Object.keys(defaults).length === 0 && !localStorage.getItem(ONBOARDING_SEEN_KEY)) {
      setAgentModelDefault('claude', AUTO_MODEL)
      localStorage.setItem(AUTO_OFFERED_KEY, '1')
      return 'seeded'
    }
    if (localStorage.getItem(AUTO_OFFERED_KEY)) return 'none'
    localStorage.setItem(AUTO_OFFERED_KEY, '1')
    useTerminalStore.getState().setMemoryNotice(
      '🤖 New: Auto picks the Claude model and effort for each task. Try it in Settings › General › Default Models.',
    )
    return 'offered'
  } catch {
    return 'none'
  }
}

const MODEL_WORDS: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', opusplan: 'Opus Plan' }
const RULE_WORDS: Record<string, string> = {
  lookup: 'a short lookup',
  build: 'building or changing code',
  deep: 'design work or a hard bug',
  'no-task': 'no task given, so it plans first',
  relay: 'picking up a handed-off session',
  default: 'no rule matched, so the everyday default',
}

/** The agent header's chip for an Auto launch (v1.55.0): `Haiku · low · auto`. */
export function routedChipText(d: RouteDecision): string {
  return `${MODEL_WORDS[d.model] ?? d.model} · ${d.effort} · auto`
}

/** The chip's tooltip: why Auto picked it, in words. */
export function routedChipTitle(d: RouteDecision): string {
  return `Auto picked ${MODEL_WORDS[d.model] ?? d.model} at ${d.effort} effort: ${RULE_WORDS[d.rule] ?? d.rule}. `
    + 'The model is set once, at the start; switching it mid-session reads the whole conversation again at full price.'
}
