// secondOpinion.ts
//
// "Second Opinion": run a DIFFERENT installed agent (or a different Claude model) over the
// most recent output of a terminal and get concise review feedback back. A review is
// READ-ONLY — it reads the provided text and responds — and every provider is launched in a
// mode its own CLI enforces as read-only, never with a permission-bypass flag. That matters
// because the reviewed text is scraped from a terminal: it is untrusted input to an agent,
// and a reviewer that could run tools would hand whatever that text says to the user's machine.
//
// The prompt-building and per-agent argv are PURE (the actual process spawn is an injected
// `deliver` seam), so they're fully unit-tested with zero child_process/electron. The argv
// carries a PROMPT_TOKEN placeholder rather than the prompt itself, so `deliver` can pass
// the untrusted (terminal-scraped) prompt out-of-band — via a temp file / env var, never on
// a shell command line — and a scraped prompt can't inject a command.

import { isSafeModelId } from './modelCatalog'

export type SecondOpinionAgent = 'claude' | 'codex' | 'gemini'

// Claude model aliases valid for `--model` (mirrors agentCommandSanitizer.AGENT_MODEL_ALIASES).
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** Placeholder that stands in for the prompt inside the argv. `deliver` substitutes the
 *  real prompt out-of-band (temp file / env) so it never touches a shell command line. */
export const PROMPT_TOKEN = '\u0000TP_SECOND_OPINION_PROMPT\u0000'

/** Default review budget. `deliver` stops the agent when it runs out. agy's own print limit
 *  and the deadline backstop are derived from the same number, so the three can't drift
 *  apart. */
export const SECOND_OPINION_TIMEOUT_MS = 90_000

/** Claude's mutating built-ins. Denied by name as well as left out of `--tools`: a deny rule
 *  outranks every allow rule and permission mode, so the lock holds even for a CLI version
 *  that ignored the allowlist. MultiEdit is left out because current CLIs no longer have it
 *  and warn on stderr about a rule that matches nothing, and that warning would open every
 *  error message the user sees. `--tools` still keeps it out of any CLI that has it.
 *  PowerShell is Bash's Windows twin, and the CLI always knows it by name, so it can't warn. */
export const CLAUDE_MUTATING_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'] as const

/** Wrap captured terminal output in a concise "give a second opinion" instruction. Pure.
 *  The content is tail-trimmed to `maxChars` so a huge scrollback can't blow the arg. */
export function buildReviewPrompt(content: string, opts: { maxChars?: number } = {}): string {
  const max = Math.max(200, opts.maxChars ?? 6000)
  const clean = (content || '').trim()
  const trimmed = clean.length > max ? clean.slice(-max) : clean
  return [
    "You are giving a SECOND OPINION on another AI agent's recent work in a terminal.",
    'Below is the recent terminal output. Focus on the MOST RECENT solution, answer, or task.',
    'Give concise, constructive feedback: what looks correct, what is risky or wrong, and what you',
    'would do differently. A few specific bullet points — do NOT restate the whole content, and do',
    'not run tools or make changes; just review.',
    '',
    '--- RECENT TERMINAL OUTPUT ---',
    trimmed || '(the terminal output was empty)',
    '--- END ---',
  ].join('\n')
}

/**
 * The model flag for `agent`, or nothing — an invalid/absent model is dropped and the agent
 * runs its own default. Validation differs by provider because their namespaces do. Claude's
 * four aliases are a closed enum, so they are matched exactly. Codex and Gemini ids are
 * DISCOVERED at runtime (see modelCatalog.ts) and version fast, so an exact enum here would go
 * stale within weeks; they are gated on isSafeModelId instead — alphanumeric-leading,
 * [A-Za-z0-9._-] only, so nothing flag-shaped or shell-significant can become an argv token.
 * The caller additionally checks the id against the fetched catalog (isAllowedModel), making
 * this the second gate, not the only one. Pure.
 */
export function modelArgs(agent: SecondOpinionAgent, model?: string): string[] {
  if (agent === 'claude') return model && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(model) ? ['--model', model] : []
  if (!isSafeModelId(model)) return []
  // Codex's `-p` is `--profile`, so its model flag is `-m`.
  return agent === 'codex' ? ['-m', model] : ['--model', model]
}

/**
 * Claude in a read-only headless shape (flags verified against `claude --help`, 2.1.x):
 *  - `--permission-mode plan` — an explicit mode, so a `defaultMode` from the user's settings
 *    (which may well be bypassPermissions) is never inherited;
 *  - `--tools <list>` — the only built-ins that exist for the run (`''` = none at all);
 *  - `--disallowedTools` — the mutating built-ins, denied by name as a second lock;
 *  - `--strict-mcp-config` with no `--mcp-config` — no MCP servers, so none of the user's (or
 *    Termpolis's own auto-approved terminal) tools are reachable either.
 * `--tools` and `--disallowedTools` are variadic, so each is followed by another flag and never
 * by the positional prompt, which they would otherwise swallow as one more tool name. Pure.
 */
export function claudeReadOnlyArgs(model: string | undefined, tools: string): string[] {
  return [
    '--permission-mode', 'plan',
    '--tools', tools,
    '--disallowedTools', CLAUDE_MUTATING_TOOLS.join(','),
    '--strict-mcp-config',
    ...modelArgs('claude', model),
    '-p', PROMPT_TOKEN,
  ]
}

/**
 * The Antigravity CLI (`agy`) in its non-editing mode (flags verified against `agy --help`,
 * 1.2.x): `--mode` takes accept-edits or plan, and plan is the one that doesn't edit.
 * `--print-timeout` makes agy end its own turn at the same budget `deliver` enforces. That
 * covers a run Termpolis can't stop, such as one orphaned by a crash, where an agy stuck on an
 * approval it can never get would otherwise run on. `0s` is agy's own "no limit", used when
 * the caller set none. `extra` flags go after the mode; every flag precedes `-p <prompt>`. Pure.
 */
export function agyReadOnlyArgs(model: string | undefined, timeoutMs: number, extra: readonly string[] = []): string[] {
  const secs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0
  return ['--mode', 'plan', ...extra, '--print-timeout', `${secs}s`, ...modelArgs('gemini', model), '-p', PROMPT_TOKEN]
}

/**
 * Full argv (binary + args, with PROMPT_TOKEN where the prompt goes) for a one-shot headless
 * review. Per-agent because the CLIs differ; none of them gets a bypass/yolo flag:
 *  - claude:  `claude --permission-mode plan --tools "" --disallowedTools Bash,PowerShell,Edit,
 *             Write,NotebookEdit --strict-mcp-config [--model <alias>] -p <prompt>` — a review
 *             needs no tools, so it gets none (see claudeReadOnlyArgs)
 *  - codex:   `codex exec --sandbox read-only --skip-git-repo-check [-m <model>] <prompt>`  (`exec`
 *             is the non-interactive entry point; the OS sandbox means a review can't touch the
 *             repo; `-m`/`--model` must precede the positional prompt)
 *  - gemini:  `agy --mode plan --disable-slash-commands --print-timeout <secs>s [--model <model>]
 *             -p <prompt>`  (Gemini's headless access is now the Antigravity CLI `agy` — the old
 *             `gemini` free-tier headless client was deprecated; see agyReadOnlyArgs. Slash
 *             command and skill expansion is off because the prompt carries scraped text.)
 * `timeoutMs` only shapes agy's own time limit. Pure.
 */
export function secondOpinionCommand(agent: SecondOpinionAgent, model?: string, timeoutMs: number = SECOND_OPINION_TIMEOUT_MS): { bin: string; args: string[] } {
  switch (agent) {
    case 'claude':
      return { bin: 'claude', args: claudeReadOnlyArgs(model, '') }
    case 'codex':
      return { bin: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...modelArgs('codex', model), PROMPT_TOKEN] }
    case 'gemini':
      // Gemini is accessed through the Antigravity CLI (`agy`) now, not `gemini`.
      return { bin: 'agy', args: agyReadOnlyArgs(model, timeoutMs, ['--disable-slash-commands']) }
  }
}

/** A PowerShell single-quoted literal: nothing inside one is special except `'`, which doubles. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * Resolve the actual process to spawn for a review. PURE — no fs/spawn — so the argv shaping
 * (the security-sensitive part) is unit-tested. On other platforms the binary is spawned
 * directly with the token swapped for the prompt (no shell). On Windows the agent runs
 * through Windows PowerShell 5.1 with the untrusted prompt read from a temp file into `$p`
 * (never on the command line): the token position becomes `$p` and every other argv token
 * is a single-quoted literal. The caller writes `prompt` (UTF-8) to the temp file referenced
 * by `$env:TP_SO_FILE` before spawning on Windows.
 *
 * 5.1 hands a native command a string argument as `"<arg>"` when the arg has whitespace
 * outside quotes, bare otherwise, and escapes nothing — so an embedded `"` would end the
 * argument early and let the rest of the prompt become flags. The script therefore escapes
 * `$p` the way the child's argv parser unescapes it (`\"` for each quote, backslashes doubled
 * before a quote and before the closing quote), and prefixes a space when there is no
 * whitespace ahead of the first quote, which guarantees the wrapping quotes that escaping
 * assumes (review prompts start with "You are", so they are never changed). An empty token
 * becomes `'""'`, since 5.1 drops an empty argument altogether. The binary is resolved first
 * so a .cmd/.bat shim can be refused: cmd.exe re-parses its command line with rules no
 * escaping survives (quotes just toggle, `&` chains a command, a newline ends the line).
 */
export function secondOpinionSpawnPlan(isWindows: boolean, bin: string, args: string[], promptToken: string, prompt: string): { cmd: string; cmdArgs: string[] } {
  if (isWindows) {
    const psArgs = args.map((a) => (a === promptToken ? '$p' : psQuote(a === '' ? '""' : a))).join(' ')
    const script = [
      "$ErrorActionPreference='Stop'",
      // [string]: an empty file gives no pipeline output at all, which would pass NO argument.
      '$p = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $env:TP_SO_FILE)',
      `if ($p -notmatch '^[^"]*\\s') { $p = ' ' + $p }`,
      `$p = ($p -replace '(\\\\*)"', '$1$1\\"') -replace '(\\\\+)\\z', '$1$1'`,
      `$c = Get-Command -Name ${psQuote(bin)} -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1`,
      `if ($c.CommandType -eq 'Application' -and $c.Path -match '\\.(bat|cmd)$') { throw ($c.Path + ' is a batch-file shim; Termpolis will not pass an untrusted prompt through cmd.exe') }`,
      `& $c ${psArgs}`,
    ].join('; ')
    return { cmd: 'powershell.exe', cmdArgs: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return { cmd: bin, cmdArgs: args.map((a) => (a === promptToken ? prompt : a)) }
}

/** Injected spawn seam. Runs the resolved argv (with `promptToken` swapped for the real
 *  prompt, out-of-band) with the child's STDIN closed (some agents, e.g. `codex exec`, read
 *  stdin and would otherwise block), and resolves (never rejects) with stdout/stderr/code.
 *  It stops the run itself once `opts.timeoutMs` is up. The app's deliver
 *  (secondOpinionDeliver.ts) ends the agent's whole process tree when it does. */
export type DeliverFn = (bin: string, args: string[], prompt: string, promptToken: string, opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr?: string; code: number }>

/** How long `deliver` gets past its own timeout before the call is abandoned. */
export const DELIVER_GRACE_MS = 5_000

// setTimeout fires at once for a delay past 2^31-1 ms, which would fail a legitimately long run.
const MAX_TIMER_MS = 2_147_483_647

/** The prompt as the CLI must see it: a positional, never a flag or a subcommand. Each agent
 *  CLI reads an argv entry that starts with `-` as an option (claude's `--settings=<json>` can
 *  add hooks, and a bypass flag would undo the read-only argv) and a lone word as a subcommand
 *  (`claude update`, `codex exec review`). Either gets a leading space, which the model
 *  ignores. A headless task is sent bare when there is no primer, so this is reachable. Pure. */
export function positionalPrompt(prompt: string): string {
  return /^-|^\S*$/.test(prompt) ? ` ${prompt}` : prompt
}

/** `deliver`, bounded. `deliver` stops its own run at `timeoutMs`; the app's deliver ends the
 *  agent's whole process tree and settles soon after, even if `close` never fires. This is
 *  the backstop for a `deliver` that still hasn't settled. It settles the call itself at
 *  `timeoutMs + graceMs`, rejecting with a legible error, whatever the child is doing. A
 *  zero, negative or non-finite `timeoutMs` means "no timeout" to `deliver` and gets no
 *  deadline here. Every one-shot prompt passes through here, so this is also where it is
 *  made positional. */
export function deliverWithDeadline(
  deliver: DeliverFn,
  bin: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
  graceMs: number = DELIVER_GRACE_MS,
): ReturnType<DeliverFn> {
  const run = deliver(bin, args, positionalPrompt(prompt), PROMPT_TOKEN, { timeoutMs })
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return run
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${bin} did not finish within ${Math.round(timeoutMs / 1000)}s`)), Math.min(timeoutMs + graceMs, MAX_TIMER_MS))
  })
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer))
}

// ESC-introduced sequences: CSI (`ESC [ … final`), OSC/DCS/SOS/PM/APC strings (ended by BEL or
// ST), and the short ESC forms. Removed whole so their parameters don't survive as visible
// garbage; anything this misses still loses its ESC to CONTROL_CHARS. A string body stops at
// the next ESC/BEL, which keeps the scan linear on hostile output (the main process runs it).
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g
// Every C0 control except TAB and LF, plus DEL and the C1 block (0x9b is a one-byte CSI).
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/** Review text made safe to paste into a terminal. The renderer drops it into a bracketed
 *  paste, so an escape sequence in the reply — a model can echo one straight from the output
 *  it was shown — could end the paste early and have the rest typed as live input. Only
 *  printable text, tabs and newlines survive; CRLF and a lone CR become LF. Pure. */
export function cleanReviewText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARS, '')
}

export interface SecondOpinionResult { ok: boolean; feedback?: string; error?: string }

/** Run a second-opinion review: build the prompt, resolve the argv, spawn via the injected
 *  `deliver`, and return trimmed feedback — or a friendly error that surfaces the agent's
 *  own stderr (so e.g. an auth/eligibility failure is legible, not a bare exit code). Both
 *  are cleaned of terminal control sequences, since both are pasted into a terminal. Pure
 *  given `deliver`. */
export async function runSecondOpinion(
  opts: { agent: SecondOpinionAgent; model?: string; content: string; timeoutMs?: number; maxChars?: number },
  deliver: DeliverFn,
): Promise<SecondOpinionResult> {
  const prompt = buildReviewPrompt(opts.content, { maxChars: opts.maxChars })
  const timeoutMs = opts.timeoutMs ?? SECOND_OPINION_TIMEOUT_MS
  const { bin, args } = secondOpinionCommand(opts.agent, opts.model, timeoutMs)
  try {
    const { stdout, stderr, code } = await deliverWithDeadline(deliver, bin, args, prompt, timeoutMs)
    const out = cleanReviewText(stdout || '').trim()
    if (code === 0 && out.length > 0) return { ok: true, feedback: out }
    const errText = cleanReviewText(stderr || '').trim() || out
    return { ok: false, error: errText ? errText.slice(0, 600) : `${bin} exited with code ${code} and produced no output` }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'second opinion failed' }
  }
}
