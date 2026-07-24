// secondOpinion.ts
//
// "Second Opinion": run a DIFFERENT installed agent (or a different Claude model) over the
// most recent output of a terminal and get concise review feedback back. A review is
// READ-ONLY — it reads the provided text and responds — so unlike swarm worker agents it
// can safely use one-shot headless mode (no interactive tool access needed).
//
// The prompt-building and per-agent argv are PURE (the actual process spawn is an injected
// `deliver` seam), so they're fully unit-tested with zero child_process/electron. The argv
// carries a PROMPT_TOKEN placeholder rather than the prompt itself, so `deliver` can pass
// the untrusted (terminal-scraped) prompt out-of-band — via a temp file / env var, never on
// a shell command line — and a scraped prompt can't inject a command.

export type SecondOpinionAgent = 'claude' | 'codex' | 'gemini'

// Claude model aliases valid for `--model` (mirrors agentCommandSanitizer.AGENT_MODEL_ALIASES).
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** Placeholder that stands in for the prompt inside the argv. `deliver` substitutes the
 *  real prompt out-of-band (temp file / env) so it never touches a shell command line. */
export const PROMPT_TOKEN = '\u0000TP_SECOND_OPINION_PROMPT\u0000'

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
 * Full argv (binary + args, with PROMPT_TOKEN where the prompt goes) for a one-shot headless
 * review. Per-agent because the CLIs differ:
 *  - claude:  `claude -p <prompt> [--model <alias>] --dangerously-skip-permissions`
 *  - codex:   `codex exec --sandbox read-only --skip-git-repo-check <prompt>`  (its `-p` is
 *             `--profile`; `exec` is the non-interactive entry point; read-only so a review
 *             can't touch the repo)
 *  - gemini:  `agy -p <prompt> --dangerously-skip-permissions`  (Gemini's headless access is
 *             now the Antigravity CLI `agy` — the old `gemini` free-tier headless client was
 *             deprecated. Verified: `-p`/`--print` runs one prompt non-interactively;
 *             skip-permissions prevents a tool-approval prompt hanging the run.)
 * An invalid/absent Claude model alias is dropped (the prompt is never here, so nothing an
 * attacker controls reaches the argv). Pure.
 */
export function secondOpinionCommand(agent: SecondOpinionAgent, model?: string): { bin: string; args: string[] } {
  switch (agent) {
    case 'claude': {
      const args = ['-p', PROMPT_TOKEN]
      if (model && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(model)) args.push('--model', model)
      args.push('--dangerously-skip-permissions')
      return { bin: 'claude', args }
    }
    case 'codex':
      return { bin: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', PROMPT_TOKEN] }
    case 'gemini':
      // Gemini is accessed through the Antigravity CLI (`agy`) now, not `gemini`.
      return { bin: 'agy', args: ['-p', PROMPT_TOKEN, '--dangerously-skip-permissions'] }
  }
}

/**
 * Resolve the actual process to spawn for a review. PURE — no fs/spawn — so the argv shaping
 * (the security-sensitive part) is unit-tested. On Windows the .cmd/.ps1 shims run through
 * PowerShell with the untrusted prompt read from a temp file into `$p` (never on the command
 * line); the token position becomes `$p` and every other argv token is a single-quoted
 * literal. On other platforms the binary is spawned directly with the token swapped for the
 * prompt (no shell). The caller writes `prompt` to the temp file referenced by
 * `$env:TP_SO_FILE` before spawning on Windows.
 */
export function secondOpinionSpawnPlan(isWindows: boolean, bin: string, args: string[], promptToken: string, prompt: string): { cmd: string; cmdArgs: string[] } {
  if (isWindows) {
    const psArgs = args.map((a) => (a === promptToken ? '$p' : `'${a.replace(/'/g, "''")}'`)).join(' ')
    const script = `$ErrorActionPreference='Stop'; $p = Get-Content -Raw -LiteralPath $env:TP_SO_FILE; & '${bin.replace(/'/g, "''")}' ${psArgs}`
    return { cmd: 'powershell.exe', cmdArgs: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return { cmd: bin, cmdArgs: args.map((a) => (a === promptToken ? prompt : a)) }
}

/** Injected spawn seam. Runs the resolved argv (with `promptToken` swapped for the real
 *  prompt, out-of-band) with the child's STDIN closed (some agents, e.g. `codex exec`, read
 *  stdin and would otherwise block), and resolves (never rejects) with stdout/stderr/code. */
export type DeliverFn = (bin: string, args: string[], prompt: string, promptToken: string, opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr?: string; code: number }>

export interface SecondOpinionResult { ok: boolean; feedback?: string; error?: string }

/** Run a second-opinion review: build the prompt, resolve the argv, spawn via the injected
 *  `deliver`, and return trimmed feedback — or a friendly error that surfaces the agent's
 *  own stderr (so e.g. an auth/eligibility failure is legible, not a bare exit code). Pure
 *  given `deliver`. */
export async function runSecondOpinion(
  opts: { agent: SecondOpinionAgent; model?: string; content: string; timeoutMs?: number; maxChars?: number },
  deliver: DeliverFn,
): Promise<SecondOpinionResult> {
  const prompt = buildReviewPrompt(opts.content, { maxChars: opts.maxChars })
  const { bin, args } = secondOpinionCommand(opts.agent, opts.model)
  try {
    const { stdout, stderr, code } = await deliver(bin, args, prompt, PROMPT_TOKEN, { timeoutMs: opts.timeoutMs ?? 90_000 })
    const out = (stdout || '').trim()
    if (code === 0 && out.length > 0) return { ok: true, feedback: out }
    const errText = (stderr || '').trim() || out
    return { ok: false, error: errText ? errText.slice(0, 600) : `${bin} exited with code ${code} and produced no output` }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'second opinion failed' }
  }
}
