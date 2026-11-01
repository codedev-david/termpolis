// What to tell the user once a model change has run (relaunchAgentWithModel's outcome): one line for
// the notice bar, and whether the picker has to go back to the model that is still running. The
// header's picker and the usage-limit card's model row say the same things, so the words live here.
import { EXIT_CEILING_MS, type RelaunchOutcome } from './modelRelaunch'
import { carryLaunchArgs, PROVIDER_BIN, type ModelProvider } from './modelCatalog'

export interface RelaunchNoticeContext {
  provider: ModelProvider
  /** The agent's name as the picker shows it. */
  label: string
  /** The model's name as the picker shows it. */
  target: string
  /** What the terminal was started with. */
  agentCommand: string | null | undefined
}

export interface RelaunchNotice {
  /** The line to show, or null when there is nothing to say (a clean relaunch). */
  text: string | null
  /** Nothing was started: the picker must not go on claiming the new model. */
  reverted: boolean
}

export function relaunchNotice(outcome: RelaunchOutcome, c: RelaunchNoticeContext): RelaunchNotice {
  const { label, target } = c
  // Options the launch command held that could not be repeated faithfully: the agent came back on its
  // defaults, which can be looser than what it was started with.
  const lostOptions = !carryLaunchArgs(c.provider, c.agentCommand).complete
  const lost = ' It was started with options Termpolis cannot repeat safely (quotes, operators or a prompt), so it came back with its defaults.'
  switch (outcome) {
    case 'relaunched':
      return { text: lostOptions ? `⚠️ ${label} restarted on ${target}.${lost}` : null, reverted: false }
    case 'started-new':
      // Quit before anything was said: there was nothing to lose, but say what happened.
      return { text: `ℹ️ ${label} had nothing to resume, so it started a new session on ${target}.${lostOptions ? lost : ''}`, reverted: false }
    case 'started-unsure':
      return { text: `ℹ️ Termpolis could not tell which ${label} conversation to resume, so it started a new session on ${target}. If there was an earlier conversation, it is still saved.${lostOptions ? lost : ''}`, reverted: false }
    case 'started-fresh':
      // The cause is not known (nothing to continue, a missing command, a crash): say only what is.
      return { text: `ℹ️ ${label} was not running after the resume, so Termpolis started a new session on ${target}.${lostOptions ? lost : ''}`, reverted: false }
    case 'unsupported': {
      // `claude-sandbox`, `claudex`: it starts with the agent's name, but is another program.
      const ran = (c.agentCommand ?? '').trim().split(/\s+/)[0] || label
      return { text: `⚠️ This ${label} terminal was started with "${ran}", not plain ${PROVIDER_BIN[c.provider]}, so Termpolis did not restart it: the bare agent would not run the way "${ran}" does. Open a new terminal on ${target} instead.`, reverted: true }
    }
    case 'still-running':
      return { text: `⚠️ ${label} had not quit after ${EXIT_CEILING_MS / 1000} s, so Termpolis left it alone: it pressed Ctrl+C three times and typed nothing else. If it is still running, it is on its previous model; if it is at a prompt, start ${label} again.`, reverted: true }
    default:
      // 'invalid': not a model the provider offers; nothing was sent.
      return { text: null, reverted: true }
  }
}
