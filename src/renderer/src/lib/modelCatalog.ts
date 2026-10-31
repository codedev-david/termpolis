// modelCatalog.ts (renderer)
//
// Renderer-side view of the per-provider model catalog that src/main/modelCatalog.ts
// discovers at launch. The shapes are mirrored rather than imported because
// tsconfig.web.json compiles only src/renderer/src/** — same arrangement as
// types/index.ts mirroring src/main/types.ts. The values arrive as plain JSON over the
// `models:catalog` IPC, already shape-validated in main.
//
// This module answers the two questions the terminal pane asks:
//   1. which provider is this terminal running?  (providerForAgent)
//   2. what models may I offer for it?           (modelOptionsFor)
//
// Claude keeps the broker's hand-authored rows because they carry the "% cheaper"
// economics the picker shows; codex/gemini rows come from the catalog, which is the
// only place their (fast-moving, versioned) ids exist.

import { CLAUDE_MODEL_OPTIONS, type ModelOption } from './modelBroker'
import { isResumeId, type ResumeTarget } from './agentResume'

export type ModelProvider = 'claude' | 'codex' | 'gemini'

export interface CatalogModel {
  id: string
  label: string
  note?: string
}

export interface ProviderCatalog {
  provider: ModelProvider
  models: CatalogModel[]
  source: 'builtin' | 'cli' | 'cache'
  fetchedAt: number
}

export type ModelCatalog = Record<ModelProvider, ProviderCatalog>

/** The binary each provider's picker relaunches. Mirrors AGENT_COMMAND_ALLOWLIST's keys. */
export const PROVIDER_BIN: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'agy',
}

export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  claude: 'Claude',
  codex: 'OpenAI Codex',
  gemini: 'Gemini',
}

/** The `installedAgents` key that gates each provider (Gemini ships as the Antigravity CLI). */
export const PROVIDER_INSTALL_KEY: Record<ModelProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'agy',
}

/**
 * Map a detected agent identity to a provider. Accepts every display name the two
 * detectors produce — agentDetector's launch-command path says 'OpenAI Codex' while its
 * output-scrape path says plain 'Codex', and both must resolve here or a Codex terminal
 * silently loses its picker. Pure.
 */
export function providerForAgent(agentName: string | null | undefined): ModelProvider | null {
  const n = (agentName || '').toLowerCase()
  if (!n) return null
  if (n.includes('claude')) return 'claude'
  if (n.includes('codex')) return 'codex'
  if (n.includes('gemini') || n.includes('antigravity')) return 'gemini'
  return null
}

/**
 * The rows to render in the picker for one provider. Pure.
 *
 * Claude returns the broker's options unchanged: its aliases are always-latest by
 * construction (Claude Code resolves `opus` to the newest Opus itself), and they carry
 * the savings percentages the picker shows. Everyone else returns discovered rows —
 * an empty list means "this agent's own default only", which the caller renders as a
 * single disabled row rather than an empty dropdown.
 */
export function modelOptionsFor(provider: ModelProvider | null, catalog: ModelCatalog | null | undefined): ModelOption[] {
  if (!provider) return []
  if (provider === 'claude') return CLAUDE_MODEL_OPTIONS
  const models = catalog?.[provider]?.models ?? []
  return models.map((m) => ({
    alias: m.id,
    label: m.label,
    savingsPct: 0,
    ...(m.note ? { note: m.note } : {}),
  }))
}

/** Is `id` offered for `provider`? The renderer's mirror of main's isAllowedModel. Pure. */
export function isOfferedModel(provider: ModelProvider | null, id: string, catalog: ModelCatalog | null | undefined): boolean {
  if (!provider || !id) return false
  return modelOptionsFor(provider, catalog).some((o) => o.alias === id)
}

/** Which agent a launch command starts: its first word, minus a path and `.exe`/`.cmd`. Pure. */
export function providerForCommand(command: string | null | undefined): ModelProvider | null {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? ''
  const name = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase()
  for (const provider of Object.keys(PROVIDER_BIN) as ModelProvider[]) {
    if (PROVIDER_BIN[provider] === name) return provider
  }
  return null
}

/** The flags, per agent, that name a model. */
const MODEL_FLAGS: Record<ModelProvider, readonly string[]> = {
  claude: ['--model'],
  codex: ['--model', '-m'],
  gemini: ['--model'],
}

/** The flags that pick, continue or branch a conversation and take a value. Claude's
 *  `--resume` and `--from-pr` take theirs optionally (`claude --resume` alone opens a picker). */
const RESUME_VALUED_FLAGS: Record<ModelProvider, readonly string[]> = {
  claude: ['--resume', '-r', '--from-pr', '--session-id'],
  codex: [],
  gemini: ['--conversation'],
}

/** The ones that stand alone. */
const RESUME_BARE_FLAGS: Record<ModelProvider, readonly string[]> = {
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
export function launchFlag(provider: ModelProvider, token: string): LaunchFlag | null {
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
export function commandPicksModelOrSession(provider: ModelProvider, command: string | null | undefined): boolean {
  return (command ?? '').trim().split(/\s+/).slice(1).some((t) => launchFlag(provider, t) !== null)
}

/** Words a relaunch can re-type faithfully: letters and digits in any script, and the punctuation
 *  of flags, paths and `name=value` pairs (brackets too: `opus[1m]` is a real model name). No quote,
 *  operator, variable, glob character or comment marker. */
const PLAIN_WORD = /^[\p{L}\p{N}\p{M}_.:=/\\@%+,~[\]-]+$/u

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
export function carryLaunchArgs(provider: ModelProvider, launchCommand: string | null | undefined): LaunchCarry {
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
export function carriedLaunchArgs(provider: ModelProvider, launchCommand: string | null | undefined): string[] {
  return carryLaunchArgs(provider, launchCommand).args
}

/**
 * The shell command that relaunches `provider` on model `id`. Returns '' when the model isn't
 * offered, or a conversation id isn't a UUID, so nothing unvalidated can reach a PTY. Pure.
 *
 *   resume.kind 'id'     - exactly that conversation (`--resume <id>`, `resume <id>`, `--conversation=<id>`)
 *   resume.kind 'latest' - the agent's own "most recent" (`--continue`, `resume --last`); the default,
 *                          and what a relaunch does when it has nothing better
 *   resume.kind 'none'   - a new session
 *
 * `launchCommand`, when given, is what the terminal was started with: its flags other than the
 * model and the conversation are kept (see carriedLaunchArgs), placed before `--model` because
 * Codex wants its options ahead of the `resume` subcommand.
 */
export function relaunchCommandFor(
  provider: ModelProvider | null,
  id: string,
  catalog: ModelCatalog | null | undefined,
  launchCommand?: string | null,
  resume: ResumeTarget = { kind: 'latest' },
): string {
  if (!provider || !isOfferedModel(provider, id, catalog)) return ''
  if (resume.kind === 'id' && !isResumeId(resume.id)) return ''
  const head = [PROVIDER_BIN[provider], ...carriedLaunchArgs(provider, launchCommand), '--model', id].join(' ')
  switch (resume.kind) {
    case 'none':
      return head
    case 'latest':
      return provider === 'codex' ? `${head} resume --last` : `${head} --continue`
    case 'id':
      if (provider === 'codex') return `${head} resume ${resume.id}`
      return provider === 'gemini' ? `${head} --conversation=${resume.id}` : `${head} --resume ${resume.id}`
  }
}

/**
 * Sentinel value for the picker's "retry discovery" row, shown only when a provider's
 * list came back empty. Leading underscores fail isSafeModelId, so it can never collide
 * with a real model id and can never be mistaken for one on the way to an argv.
 */
export const REFRESH_MODELS_VALUE = '__refresh__'
