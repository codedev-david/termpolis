// cliFlagProbe.ts
//
// Whether the agent CLI on this computer can run a job without saving its session.
//
// A job another computer runs here should leave nothing behind for this computer's memory to
// learn from. The indexer and the live readers already pass such a session over when they find
// one (shared/headlessPrompt), but the surest fix is that it is never written: Claude Code has
// `--no-session-persistence` and `codex exec` has `--ephemeral`. Only recent versions do, though,
// and an older CLI refuses a flag it doesn't know, which would fail every job sent to that
// computer. So each CLI is asked first, with its own --help, through the same deliver a job runs
// through, and the answer is kept a while. agy has no such flag, and Termpolis never reads its store.

import type { DeliverFn, SecondOpinionAgent } from './secondOpinion'

/** How each CLI is asked, and the flag its help must list. */
export const NO_PERSIST_FLAGS: Readonly<Record<SecondOpinionAgent, { bin: string; args: readonly string[]; flag: string } | null>> = {
  claude: { bin: 'claude', args: ['--help'], flag: '--no-session-persistence' },
  codex: { bin: 'codex', args: ['exec', '--help'], flag: '--ephemeral' },
  gemini: null,
}

/** How long an answer is kept. A CLI updated in the meantime gets the flag within this. */
export const PROBE_TTL_MS = 10 * 60_000

/** How soon a probe that got no answer (the CLI failed to start, timed out, exited non-zero) is
 *  tried again. Its jobs run without the flag until then, as on a CLI that has none. */
export const PROBE_RETRY_MS = 60_000

/** The probe's own limit. --help prints and exits in well under a second. */
export const PROBE_TIMEOUT_MS = 10_000

/** How long past its timeout a deliver that never settles is waited for. Every linked job of
 *  that agent waits on the probe, so it must end even if the process side never does. */
const PROBE_GRACE_MS = 5_000

/** The prompt token, which a --help argv never holds: deliver has nothing to swap in. */
const NO_PROMPT = '\u0000TP_NO_PROMPT\u0000'

export interface NoPersistProbeDeps {
  deliver: DeliverFn
  now?: () => number
  ttlMs?: number
  retryMs?: number
  timeoutMs?: number
}

interface Answer {
  supported: boolean
  /** The CLI printed its help. False when there is nothing to go on, which is retried sooner. */
  answered: boolean
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `agent` → whether its CLI lists the flag, probed at most once per TTL. A burst of jobs shares
 *  one probe: the promise is what is kept. It never rejects. */
export function createNoPersistProbe(deps: NoPersistProbeDeps): (agent: SecondOpinionAgent) => Promise<boolean> {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? PROBE_TTL_MS
  const retryMs = deps.retryMs ?? PROBE_RETRY_MS
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const kept = new Map<SecondOpinionAgent, { until: number; value: Promise<boolean> }>()

  async function ask(how: { bin: string; args: readonly string[]; flag: string }): Promise<Answer> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reply = await Promise.race([
        deps.deliver(how.bin, [...how.args], '', NO_PROMPT, { timeoutMs }),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs + PROBE_GRACE_MS))),
      ])
      if (!reply) return { supported: false, answered: false }
      const text = `${reply.stdout}\n${reply.stderr ?? ''}`
      // The flag as an option of its own, not the start of a longer one.
      if (new RegExp(`(?:^|[\\s,])${escapeRe(how.flag)}(?![\\w-])`, 'm').test(text)) return { supported: true, answered: true }
      return { supported: false, answered: reply.code === 0 && reply.stdout.trim().length > 0 }
    } catch {
      return { supported: false, answered: false }
    } finally {
      clearTimeout(timer)
    }
  }

  return (agent) => {
    const how = NO_PERSIST_FLAGS[agent]
    if (!how) return Promise.resolve(false)
    const hit = kept.get(agent)
    if (hit && now() < hit.until) return hit.value
    // Kept for as long as it runs, so every job that asks meanwhile waits on this one probe.
    const entry = { until: Number.POSITIVE_INFINITY, value: Promise.resolve(false) }
    entry.value = ask(how).then((answer) => {
      entry.until = now() + (answer.answered ? ttlMs : retryMs)
      return answer.supported
    })
    kept.set(agent, entry)
    return entry.value
  }
}
