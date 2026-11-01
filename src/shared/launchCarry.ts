// What a command line that starts an agent says, taken apart by one rule for every relaunch: the
// model switcher (modelRelaunch.ts) and the account switch (accountSwitch.ts) both re-type the line
// the agent was started with, so both need to know which words are the agent, its model, its
// conversation, and which flags can be repeated faithfully. Two copies of this drifted once
// (`--conversation=x` was a resume in one and not the other), so there is one. Pure: no I/O.

export type LaunchProvider = 'claude' | 'codex' | 'gemini'

/** The binary each provider is started with. */
export const LAUNCH_BIN: Record<LaunchProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'agy',
}

/** Which agent a launch command starts: its first word, minus a path and `.exe`/`.cmd`. Pure. */
export function providerForCommand(command: string | null | undefined): LaunchProvider | null {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? ''
  const name = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase()
  for (const provider of Object.keys(LAUNCH_BIN) as LaunchProvider[]) {
    if (LAUNCH_BIN[provider] === name) return provider
  }
  return null
}

/** The flags, per agent, that name a model. */
const MODEL_FLAGS: Record<LaunchProvider, readonly string[]> = {
  claude: ['--model'],
  codex: ['--model', '-m'],
  gemini: ['--model'],
}

/** The flags that pick, continue or branch a conversation and take a value. Claude's
 *  `--resume` and `--from-pr` take theirs optionally (`claude --resume` alone opens a picker). */
const RESUME_VALUED_FLAGS: Record<LaunchProvider, readonly string[]> = {
  claude: ['--resume', '-r', '--from-pr', '--session-id'],
  codex: [],
  gemini: ['--conversation'],
}

/** The ones that stand alone. */
const RESUME_BARE_FLAGS: Record<LaunchProvider, readonly string[]> = {
  claude: ['--continue', '-c', '--fork-session'],
  codex: ['--last', '--all'],
  gemini: ['--continue', '-c'],
}

export interface LaunchFlag {
  /** Names the model, or has to do with which conversation runs. */
  kind: 'model' | 'resume'
  /** The value is the next token (not `--flag=value`, not `-mvalue`). */
  takesValue: boolean
}

/**
 * What one token of a launch command does to the model or the conversation, or null when it does
 * neither. The ONE rule behind both "does this command already pick its own model?" (so a default
 * is not added) and "which flags does a relaunch keep?" — two copies of it had already drifted
 * apart (`--conversation=x` was a resume in one and not the other). Pure.
 */
export function launchFlag(provider: LaunchProvider, token: string): LaunchFlag | null {
  const eq = token.indexOf('=')
  const name = eq > 0 ? token.slice(0, eq) : token
  const inline = eq > 0
  if (MODEL_FLAGS[provider].includes(name)) return { kind: 'model', takesValue: !inline }
  if (RESUME_VALUED_FLAGS[provider].includes(name)) return { kind: 'resume', takesValue: !inline }
  if (!inline && RESUME_BARE_FLAGS[provider].includes(token)) return { kind: 'resume', takesValue: false }
  // Codex resumes with a subcommand: `codex resume [id]`.
  if (provider === 'codex' && token === 'resume') return { kind: 'resume', takesValue: true }
  // A short flag with its value attached: `-mgpt-5.5`, `-rabc`.
  if (/^-[A-Za-z]./.test(token)) {
    const short = token.slice(0, 2)
    if (MODEL_FLAGS[provider].includes(short)) return { kind: 'model', takesValue: false }
    if (RESUME_VALUED_FLAGS[provider].includes(short)) return { kind: 'resume', takesValue: false }
  }
  return null
}

/** Does `command` already name its model, or pick the conversation it runs? Judged on every word, so
 *  a quoted value that happens to hold one of these flags counts too: the safe direction, since the
 *  only consequence is that a default is not added. Pure. */
export function commandPicksModelOrSession(provider: LaunchProvider, command: string | null | undefined): boolean {
  return (command ?? '').trim().split(/\s+/).slice(1).some((t) => launchFlag(provider, t) !== null)
}

/** Words a relaunch can re-type faithfully: letters and digits in any script, and the punctuation
 *  of flags, paths and `name=value` pairs (brackets too: `opus[1m]` is a real model name). No quote,
 *  operator, variable, glob character or comment marker. */
const PLAIN_WORD = /^[\p{L}\p{N}\p{M}_.:=/\\@%+,~[\]-]+$/u

/** A word that is plain, or plain with whole quoted runs in it (a double quote with no backslash,
 *  backtick or `$`; a single quote): what a command line holds when nothing in it is an operator. */
const SIMPLE_WORD = /^(?:[\p{L}\p{N}\p{M}_.:=/\\@%+,~[\]-]|"[^"\\`$]*"|'[^']*')+$/u

/** Flags that never take a value, so a word after one is NOT its value but a prompt or slash command.
 *  Only the ones people put in profiles. A flag missing here is read as taking a value, so a prompt
 *  written right after it WOULD be repeated: keep the list to what is known to be boolean. */
const BOOLEAN_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--verbose',
  '--ide',
  '--chrome',
  '--no-chrome',
  '--strict-mcp-config',
  '--include-partial-messages',
  '--yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--oss',
  '--search',
  '--skip-git-repo-check',
  '--no-alt-screen',
])

export interface LaunchCarry {
  /** The flags to repeat, in order. */
  args: string[]
  /** False when the command held options that could NOT be repeated faithfully, so the relaunch
   *  starts with the agent's defaults instead: the caller should say so. */
  complete: boolean
}

/**
 * Split a command on whitespace the way a shell would, but only as far as a SIMPLE quote goes: a
 * single-quoted run, or a double-quoted one with no backslash, backtick or `$` inside. Each word
 * comes back as written, quotes included. null for anything else (an unclosed quote, an escape,
 * an expansion), which is not safe to take apart. Pure.
 */
function splitSimpleWords(text: string): string[] | null {
  const words: string[] = []
  let word = ''
  let open = false // inside a word, quoted or not
  let quote: '"' | "'" | null = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && (ch === '\\' || ch === '`' || ch === '$')) return null
      word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      open = true
      word += ch
    } else if (/\s/.test(ch)) {
      if (open) words.push(word)
      word = ''
      open = false
    } else {
      word += ch
      open = true
    }
  }
  if (quote) return null
  if (open) words.push(word)
  return words
}

/**
 * The flags a terminal was launched with that a relaunch should keep, in order: permission mode,
 * approvals, effort and the like. The model and anything that picks a conversation are dropped,
 * because the relaunch names its own model and decides the conversation itself.
 *
 * Without this a switch re-typed the bare command, so an agent started with
 * `--dangerously-skip-permissions` or `--yolo` came back asking for approval on every step.
 *
 * Only a command that is plainly "the agent and its flags" is rebuilt. Splitting on spaces and
 * joining again would change what any of these does, so they carry NOTHING (and report it):
 *   - a quote, an operator, a variable, a glob or a comment in anything that would be KEPT: a
 *     wrapper, a compound command, a value with spaces in it (a quoted system prompt holding `-r`
 *     came back with an unclosed quote). A quoted value that is DROPPED anyway is fine, so
 *     `--model 'opus[1m]'` (zsh needs the quotes) does not stop the rest being carried;
 *   - a word that is neither a flag nor the value right after one: a prompt or slash command
 *     (`claude /review`), a lone `--` (everything after it is a prompt), or the second value of a
 *     flag that takes several. Repeating a prompt would submit it again at every switch, and
 *     dropping a value could loosen a restriction;
 *   - a command that is not this agent's at all (nothing to repeat, nothing to report).
 * Pure.
 */
export function carryLaunchArgs(provider: LaunchProvider, launchCommand: string | null | undefined): LaunchCarry {
  if (providerForCommand(launchCommand) !== provider) return { args: [], complete: true }
  const text = (launchCommand ?? '').trim()
  const hadOptions = text.split(/\s+/).filter(Boolean).length > 1
  const bare: LaunchCarry = { args: [], complete: !hadOptions }
  // A line break is whitespace to split() but a command separator to a shell: two commands are not
  // one command's flags. The same goes for any other control character.
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text)) return bare
  const words = splitSimpleWords(text)
  if (!words) return bare
  const out: string[] = []
  let awaitsValue = false // the last kept word was a flag whose value may be the next word
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const flag = launchFlag(provider, w)
    if (flag) {
      // Dropped, with its value: the next word, unless that is itself a flag (`claude --resume --verbose`).
      const next = words[i + 1]
      if (flag.takesValue && next !== undefined && !next.startsWith('-')) i++
      awaitsValue = false
      continue
    }
    if (w === '--' || !PLAIN_WORD.test(w)) return bare
    if (w.startsWith('-')) {
      out.push(w)
      awaitsValue = !w.includes('=') && !BOOLEAN_FLAGS.has(w)
      continue
    }
    if (!awaitsValue) return bare
    out.push(w)
    awaitsValue = false
  }
  return { args: out, complete: true }
}

/** The flags only; see carryLaunchArgs. */
export function carriedLaunchArgs(provider: LaunchProvider, launchCommand: string | null | undefined): string[] {
  return carryLaunchArgs(provider, launchCommand).args
}

/** Is `word` one a relaunch can re-type faithfully (see PLAIN_WORD)? */
export function isPlainLaunchWord(word: unknown): word is string {
  return typeof word === 'string' && PLAIN_WORD.test(word)
}

// ── Reading the line an agent was started with, for a switch of its account ──────────────────

/** Where a typed line starts an agent: at its start, after `;`, `&`, `|`, `{` or `call` (so after
 *  the account line Termpolis puts in front of it, in any shell), never in the middle of a word. */
const AGENT_LAUNCH = /(?:^|[;&|{]|\bcall\b)\s*(claude|codex|agy)(?=[\s}]|$)/

/** The agent a typed line starts, or null. */
export function agentOfLaunch(line: string): 'claude' | 'codex' | 'agy' | null {
  const m = AGENT_LAUNCH.exec(line)
  return m ? (m[1] as 'claude' | 'codex' | 'agy') : null
}

/** The agent's own command inside a typed line, from the agent's name to the end: the account line
 *  before it is left out, and so is the brace that closes PowerShell's `& { ... }`. Null for a line
 *  that starts no agent. */
export function agentCommandIn(line: string): string | null {
  const m = AGENT_LAUNCH.exec(line)
  if (!m) return null
  let command = line.slice(m.index + m[0].length - m[1].length).trim()
  if (/^&\s*\{/.test(line.trim()) && command.endsWith('}')) command = command.slice(0, -1).trim()
  return command
}

/** What Termpolis itself adds to the line it types for an agent, and the relaunch supplies again by
 *  itself where it applies: Claude Code's primer file (the SessionStart hook replaces it on a resume),
 *  and Codex's `-c developer_instructions=` (the relaunch passes its own). They are quoted, so the
 *  rule for repeating a line would give up on them; they are not the user's options. */
const INJECTED: readonly RegExp[] = [
  /\s--append-system-prompt-file(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g,
  /\s-c\s+(?:"developer_instructions=[^"]*"|'developer_instructions=[^']*')/g,
]

export function withoutInjected(command: string): string {
  return INJECTED.reduce((text, re) => text.replace(re, ''), command)
}

/** `'x'` and `"x"` as the plain word x. */
const unquoted = (w: string): string => (/^(["']).*\1$/.test(w) && w.length >= 2 ? w.slice(1, -1) : w)

/** The model a launch command names, in any form (`--model x`, `--model=x`, `-m x`, `-mx`, quoted or
 *  not), or undefined. */
export function modelOfCommand(provider: LaunchProvider, command: string): string | undefined {
  const words = splitSimpleWords(command)
  if (!words) return undefined
  for (let i = 1; i < words.length; i++) {
    const flag = launchFlag(provider, words[i])
    if (!flag || flag.kind !== 'model') continue
    const w = words[i]
    const value = flag.takesValue ? words[i + 1] : w.includes('=') ? w.slice(w.indexOf('=') + 1) : w.slice(2)
    return value === undefined || value === '' ? undefined : unquoted(value)
  }
  return undefined
}

/** The account agent a command line runs: its first word, minus a path and `.exe`/`.cmd`, is exactly
 *  `claude`, `codex` or `agy`. A wrapper (`claude-sandbox`, `claudex`) is none of them: relaunching it
 *  as the bare agent would drop whatever the wrapper adds, a sandbox included, so it has no account,
 *  no chip and no switch (D13: it launches as it did before accounts). */
export function agentNamed(command: string | null | undefined): 'claude' | 'codex' | 'agy' | null {
  const provider = providerForCommand(command)
  return provider === null ? null : provider === 'gemini' ? 'agy' : provider
}

/**
 * The command a "New terminal on <account>" starts: the same agent with the same options, but not the
 * conversation the source terminal runs (`--resume x`, `-r x`, `--continue`, `--session-id x`,
 * `--fork-session`, Codex's `resume [id]` and `--last`, agy's `--conversation=x`). The new terminal
 * is a second agent beside the first, and two agents on one conversation write one transcript (R8);
 * `--continue` would take the newest conversation in the folder, perhaps another agent's.
 *
 * A command that is not an agent's (a test shim) is returned as it is. A command that picks a
 * conversation and cannot be taken apart (a quote with a `$` or an escape in it) is null: nothing is
 * guessed. Pure.
 */
export function freshCommand(command: string): string | null {
  const provider = providerForCommand(command)
  if (provider === null) return command
  const text = command.trim()
  const picks = (word: string): boolean => launchFlag(provider, word)?.kind === 'resume'
  // Nothing picks a conversation: nothing to drop, and the line is returned as it is.
  if (!text.split(/\s+/).slice(1).some(picks)) return command
  // Something does, and what is dropped must be exactly what picks it. A word with an operator, a
  // variable or an escape in it (`--resume $(cat id)`) cannot be taken apart by whitespace, so it is
  // not taken apart: the caller says so, and nothing is started.
  const words = /[\x00-\x08\x0a-\x1f\x7f]/.test(text) ? null : splitSimpleWords(text)
  if (words === null || !words.slice(1).every((w) => SIMPLE_WORD.test(w))) return null
  const out = [words[0]]
  for (let i = 1; i < words.length; i++) {
    if (picks(words[i])) {
      const next = words[i + 1]
      if (launchFlag(provider, words[i])?.takesValue && next !== undefined && !next.startsWith('-')) i++
      continue
    }
    out.push(words[i])
  }
  return out.join(' ')
}
