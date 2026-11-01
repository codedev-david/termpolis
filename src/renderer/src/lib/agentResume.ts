// agentResume.ts
//
// Which conversation a model switch should pick back up.
//
// `claude --continue` and `agy --continue` mean "the most recent conversation", and that is the
// wrong question: driven against the real CLIs, switching a model right after launch (before
// anything was said) made Claude Code answer "No conversation found to continue" and leave the
// terminal at a bare prompt, and made the Antigravity CLI quietly resume a conversation from a
// completely different project, because its "most recent" is global.
//
// But both agents say exactly which conversation to resume, as they exit, and say nothing when
// nothing was said:
//
//   Resume this session with:                      Resume with -c (or command below):
//   claude --resume <session id>                   agy --conversation=<conversation id>
//
// A model switch quits the agent anyway, so it can read that line from the terminal and resume
// precisely that conversation, or start a new one when there is none. Pure: text in, answer out.
// The id ends up on a shell command line, so only a UUID is ever accepted from terminal output.
//
// The one way this can be WRONG is deciding "nothing to resume" when there was something: starting a
// new conversation is silent and looks like success. So that conclusion is only drawn from output
// that has none of the marks of a resume hint (no id, none of the words), from a quit that was
// watched from the start, and it is always reported to the user.

import type { ModelProvider } from './modelCatalog'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_ONLY = new RegExp(`^${UUID}$`, 'i')
const UUID_ANYWHERE = new RegExp(UUID, 'i')

/** Is `value` a session id that is safe to put on a command line? A UUID, nothing else. */
export function isResumeId(value: unknown): value is string {
  return typeof value === 'string' && UUID_ONLY.test(value)
}

/** Each agent's exit line, up to and including the id. Not followed by more id-like characters, so
 *  a longer token is not read as its prefix. */
function hintPattern(provider: ModelProvider): RegExp {
  switch (provider) {
    case 'claude': return new RegExp(`\\bclaude(?:\\.exe)?\\s+--resume(?:\\s+|=)(${UUID})(?![0-9a-z-])`, 'gi')
    case 'codex': return new RegExp(`\\bcodex(?:\\.exe)?\\s+resume\\s+(${UUID})(?![0-9a-z-])`, 'gi')
    case 'gemini': return new RegExp(`\\bagy(?:\\.exe)?\\s+--conversation(?:\\s+|=)(${UUID})(?![0-9a-z-])`, 'gi')
  }
}

/** Anything that is plainly an exit resume hint, even one whose id this cannot read (a renamed
 *  session): that the agent said SOMETHING about resuming is not the same as having nothing to resume. */
const HINT_WORDS: Record<ModelProvider, RegExp> = {
  claude: /\bresume this session\b|\bclaude(?:\.exe)?\s+--resume\b/i,
  codex: /\bto continue this session\b|\bcodex(?:\.exe)?\s+resume\b/i,
  gemini: /\bresume with -c\b|\bagy(?:\.exe)?\s+--(?:conversation|continue)\b/i,
}

/** Words an exit hint is made of in any wording: if the output holds one of these, the agent may have
 *  said something about resuming that the patterns above do not know. The real zero-turn captures
 *  (tests/fixtures/agentExitOutput.ts) hold none of them. */
const RESUME_WORDS = /\b(?:resume|resumed|continue|session|conversation)\b/i

/**
 * The session `provider` named as it exited: the LAST hint in `output`, since a screen the agent
 * redraws on its way out can repeat older text (Claude Code repaints the launch line first, the
 * Antigravity CLI the whole conversation). `output` should have its escape sequences stripped
 * (they sit between the words of the Antigravity hint); null when no readable id is there.
 */
export function resumeIdFromOutput(provider: ModelProvider, output: string): string | null {
  let last: string | null = null
  for (const m of output.matchAll(hintPattern(provider))) last = m[1].toLowerCase()
  return last
}

/** The output without its last line. The window a quit is read from ends with the shell's prompt,
 *  and a prompt carries the folder and branch names (`~/session-manager (feat/resume-ui) $`): words
 *  that would read as a hint. A single line is kept whole, since it cannot be told from a message. */
function withoutPrompt(output: string): string {
  const text = output.replace(/\s+$/, '')
  const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
  return cut === -1 ? text : text.slice(0, cut)
}

/**
 * Could `output` hold a resume hint, readable or not? True for a known hint, for a UUID anywhere
 * (a session id in some wording this does not know), and for any of the words a hint is made of
 * outside the prompt line. Deliberately broad: being wrong in this direction only means a slower,
 * more careful relaunch.
 */
export function hasResumeHint(provider: ModelProvider, output: string): boolean {
  return HINT_WORDS[provider].test(output) || UUID_ANYWHERE.test(output) || RESUME_WORDS.test(withoutPrompt(output))
}

/**
 * The narrow form of hasResumeHint, for text that is NOT the quit itself (what the terminal showed
 * just before it): a known hint line, or a UUID. The broad word list is no use there, since a
 * running agent's own screen is full of ordinary words ("/resume" in a tip, "conversation" in a
 * message).
 */
export function hasStrictResumeHint(provider: ModelProvider, text: string): boolean {
  return HINT_WORDS[provider].test(text) || UUID_ANYWHERE.test(text)
}

/** What a relaunch should pick back up. */
export type ResumeTarget =
  /** Exactly this conversation: the one the agent named as it exited. */
  | { kind: 'id'; id: string }
  /** Whatever the agent itself calls its most recent (`--continue`, `resume --last`). The fallback
   *  when nothing better is known; it can come up empty, or be some other conversation. */
  | { kind: 'latest' }
  /** Start a new session. `empty`: the agent was watched quitting and said nothing about resuming,
   *  so there was nothing to resume. `unsure`: it could not be told which conversation to resume, and
   *  guessing wrong is worse than starting over. */
  | { kind: 'none'; reason?: 'empty' | 'unsure' }

/** What to do when it cannot be told which conversation to resume: the agent's own latest, except
 *  for the Antigravity CLI, whose latest is global and can be another project's conversation: a
 *  wrong guess there is worse than starting over. */
export function unsureResumeTarget(provider: ModelProvider): ResumeTarget {
  return provider === 'gemini' ? { kind: 'none', reason: 'unsure' } : { kind: 'latest' }
}

/**
 * Decide from what the agent printed as it was quit.
 *
 * `watched` says this quit was observed from the start: the OS had just said the agent was RUNNING,
 * the output was marked before the quit keys, and none of it was lost. Only then does "no hint" mean
 * "nothing was said": Claude Code and the Antigravity CLI print one for any conversation with a turn
 * in it, and only then. If the agent had already exited, or the OS could not say, a missing hint is
 * just a hint printed before the mark.
 *
 * Anything less sure resumes the agent's latest instead of discarding a conversation that may exist
 * — except for the Antigravity CLI, whose latest is GLOBAL and can be another project's conversation:
 * there, guessing wrong is worse than starting over, so it starts over, and says so. Codex's exit
 * wording has not been confirmed against the real CLI, so its missing hint is never read as "nothing".
 */
export function resumeTargetFrom(provider: ModelProvider, output: string | null, watched: boolean): ResumeTarget {
  const unsure = unsureResumeTarget(provider)
  if (output === null) return unsure
  const id = resumeIdFromOutput(provider, output)
  if (id) return { kind: 'id', id }
  if (watched && provider !== 'codex' && !hasResumeHint(provider, output)) return { kind: 'none', reason: 'empty' }
  return unsure
}
