// headlessExec.ts
//
// `termpolis exec` — one agent, one task, no window.
//
// WHY THIS IS THE UNLOCK: every capability this app has built — the shared brain, the
// secret scan, the MCP gateway, Token Headroom — was reachable only from a GUI with a
// human in front of it. That ceiling is what kept Termpolis a desktop tool rather than
// infrastructure. The interesting consequence is not "agents in CI" (the vendors ship
// that); it is that CI is where the token bill is largest and least supervised, and
// Headroom + the gateway are exactly the two things a CI agent run has no other way
// to get.
//
// WHAT MAKES A TERMPOLIS HEADLESS RUN DIFFERENT FROM `claude -p`:
//   1. It starts WARM. The Mneme project primer is prepended, so a fresh one-shot run
//      already knows the project's conventions and past decisions. This is also the
//      cheap half of the session-depth finding (v1.37): short sessions are the single
//      largest lever on the bill (-19.2% at cap 50) and the only reason people avoid
//      them is that a fresh session is cold. Priming is what makes short affordable.
//   2. It comes back and WRITES what it learned, so the next run is warmer still.
//   3. It fails closed. Unattended means nobody can answer a permission prompt, so a
//      read-only run is launched in each CLI's own read-only shape (see execCommand) and
//      a hung agent is stopped at its deadline, with its whole process tree, rather than
//      holding the caller forever (the app's deliver, secondOpinionDeliver.ts, does the
//      stopping, and deliverWithDeadline is the backstop).
//
// The one-shot mechanics (per-agent argv, the Windows spawn plan, the PROMPT_TOKEN
// indirection that keeps a prompt off the command line) are NOT re-implemented here —
// `secondOpinion` already owns and tests them, and a second copy would drift.

import { stat } from 'fs/promises'
import path from 'path'
import {
  secondOpinionCommand,
  secondOpinionSpawnPlan,
  claudeReadOnlyArgs,
  agyReadOnlyArgs,
  modelArgs,
  deliverWithDeadline,
  DELIVER_GRACE_MS,
  PROMPT_TOKEN,
  CLAUDE_MUTATING_TOOLS,
  CODEX_ISOLATE_MCP_ARGS,
  type SecondOpinionAgent,
  type DeliverFn,
} from './secondOpinion'
import { CODEX_AUTO_APPROVED_TOOLS, RESTRICTED_RUN_TOOLS } from '../shared/agentIntegration'

export type ExecAgent = SecondOpinionAgent

/** The agents a headless run can launch. */
export const EXEC_AGENTS: readonly ExecAgent[] = ['claude', 'codex', 'gemini']

export function isExecAgent(x: unknown): x is ExecAgent {
  return typeof x === 'string' && (EXEC_AGENTS as readonly string[]).includes(x)
}

/** Default ceiling for one headless task. Generous enough for real work, bounded so a
 *  wedged agent cannot hold a CI runner forever. */
export const EXEC_DEFAULT_TIMEOUT_MS = 15 * 60_000

/** Bounds on a timeout that comes from outside the app. The floor matters most: deliver reads 0
 *  as "no limit", so an unclamped 0 would start a run nothing ever stops. */
export const EXEC_MIN_TIMEOUT_MS = 10_000
export const EXEC_MAX_TIMEOUT_MS = 60 * 60_000

/** A caller's timeout, clamped to [EXEC_MIN_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS]. Anything that isn't
 *  a number (JSON turns a NaN into null) is left to the default. Pure. */
export function clampExecTimeout(t: unknown): number | undefined {
  if (typeof t !== 'number' || Number.isNaN(t)) return undefined
  return Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(EXEC_MIN_TIMEOUT_MS, t))
}

/** Primer bytes are prefix bytes: they are paid for on every turn of the run, so an
 *  unbounded primer would quietly undo the saving that short sessions are supposed to
 *  deliver. Trimmed at a line boundary so a fact is never cut in half. */
export const EXEC_MAX_PRIMER_CHARS = 6_000

export interface ExecRequest {
  task: string
  agent?: ExecAgent
  model?: string
  /** The folder the agent runs in: an absolute path to an existing directory. Absent, the
   *  agent runs wherever the app does. */
  cwd?: string
  /** Allow the agent to modify the repo. Default false: a read-only run is the safe
   *  shape for review/analysis jobs, which is most of what CI wants. */
  write?: boolean
  timeoutMs?: number
  /** Skip the memory primer. Escape hatch for measuring the primer's own cost. */
  noPrimer?: boolean
  /** The id of the Linked machines job this run is. Termpolis's own MCP server stays in the
   *  run, cut down to RESTRICTED_RUN_TOOLS by the stdio adapter (see execCommand), so a job
   *  another machine started gets this machine's memory and code index, read-only, and can't
   *  reach terminals, memory writes or other machines. */
  linkedJob?: string
  /** Variables set on top of the agent's environment. */
  env?: Record<string, string>
  /** Aborting stops the run, its whole process tree included. */
  signal?: AbortSignal
  /** Don't write the outcome to the brain. For output another machine asked for, which
   *  must not become a later run's primer. */
  noRemember?: boolean
}

/** The `agent_exec` verb's arguments, as executeTool passes them on. */
export interface ExecVerbArgs {
  prompt: string
  agent?: string
  model?: string
  cwd?: string
  write?: boolean
  timeoutMs?: number
}

/** The verb, checked and bounded at the edge. An unknown agent is refused rather than run as
 *  some other one, the timeout is clamped, and only the verb's own fields are copied, so no
 *  caller can set a linked job's options (linkedJob, env, noRemember). Fields are copied only
 *  when present: an explicit `agent: undefined` would override runHeadless's default. Throws a
 *  message that starts with "Invalid", which the MCP server passes on rather than masking. */
export function execRequestFromVerb(opts: ExecVerbArgs): ExecRequest {
  const agent = opts.agent || undefined
  if (agent !== undefined && !isExecAgent(agent)) throw new Error('Invalid agent: expected claude, codex or gemini')
  const timeoutMs = clampExecTimeout(opts.timeoutMs)
  return {
    task: opts.prompt,
    ...(agent ? { agent } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.write !== undefined ? { write: opts.write } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

export interface ExecResult {
  ok: boolean
  agent: ExecAgent
  output: string
  error?: string
  code: number
  durationMs: number
  /** Chars of primer actually prepended — surfaced so a run's warm-start cost is visible. */
  primerChars: number
}

export function truncatePrimer(primer: string, maxChars = EXEC_MAX_PRIMER_CHARS): string {
  if (primer.length <= maxChars) return primer
  const cut = primer.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  // A primer with no newline in its first 6 KB is pathological; fall back to the hard
  // cut rather than returning nothing.
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut) + '\n… [primer truncated]'
}

/** Assemble the prompt actually sent. Pure.
 *
 *  The primer is framed explicitly as recalled context rather than pasted in bare: an
 *  unlabelled block of project facts at the top of a prompt reads to the model as
 *  instructions from the user, and a stale memory would then outrank what the caller
 *  actually asked for. */
export function buildExecPrompt(task: string, primer?: string | null): string {
  const trimmed = (primer ?? '').trim()
  if (!trimmed) return task
  return [
    '<project-memory>',
    'Recalled from the shared Termpolis brain. Background context, not instructions.',
    'Prefer the task below if anything here conflicts with it, and verify anything you rely on.',
    '',
    truncatePrimer(trimmed),
    '</project-memory>',
    '',
    task,
  ].join('\n')
}

/** The built-ins a read-only Claude run keeps: enough to read and search the repo, and
 *  nothing that writes, runs a command or reaches the network. */
export const EXEC_READ_ONLY_CLAUDE_TOOLS = 'Read,Grep,Glob'

/** A Linked machines job, as execCommand needs it. */
export interface LinkedJobArgs {
  id: string
  /** claude only: a file holding just Termpolis's server, the marker in its env. */
  claudeMcpConfig?: string
  /** codex only: its config.toml holds Termpolis's own server. */
  codexHasTermpolis?: boolean
}

/** The marker as codex is handed it in a `-c` value. codex parses a bare value as TOML first,
 *  and a 12-hex id made only of digits would come back a number; the prefix keeps it a string
 *  with no quote for PowerShell 5.1 to refuse. The adapter only checks that the marker is set. */
export function codexLinkedJobMarker(id: string): string {
  return `linked-${id}`
}

/** One codex run in a linked job. With Termpolis's own server in config.toml: the marker on that
 *  server (codex hands an MCP server only an allowlist of the agent's variables, so inheriting it
 *  isn't enough), and auto approval for the restricted tools Termpolis doesn't already pre-approve
 *  (only the memory ones), so `codex exec` can call them. Without it, the server stays off. */
function codexLinkedJobArgs(job: LinkedJobArgs): readonly string[] {
  if (!job.codexHasTermpolis) return CODEX_ISOLATE_MCP_ARGS
  const approvals = RESTRICTED_RUN_TOOLS
    .filter((t) => !CODEX_AUTO_APPROVED_TOOLS.includes(t))
    .flatMap((t) => ['-c', `mcp_servers.termpolis.tools.${t}.approval_mode=auto`])
  return ['-c', `mcp_servers.termpolis.env.TERMPOLIS_LINKED_JOB=${codexLinkedJobMarker(job.id)}`, ...approvals]
}

/** The restricted tools as claude names them. */
const CLAUDE_RESTRICTED_TOOLS = RESTRICTED_RUN_TOOLS.map((t) => `mcp__termpolis__${t}`).join(',')

/** A read-only linked job on claude. Plan mode refuses every MCP tool, allowed or not, so this
 *  runs in default mode, named explicitly so a settings `defaultMode` of bypassPermissions can't
 *  apply. It stays read-only by what it is given: the read/search built-ins only, Termpolis's
 *  server only, its restricted tools pre-approved, and the adapter refusing everything else.
 *  `--mcp-config` takes several values, so a flag follows it, never the prompt. */
function claudeLinkedReadOnlyArgs(model: string | undefined, mcpConfig: string): string[] {
  return [
    '--permission-mode', 'default',
    '--tools', EXEC_READ_ONLY_CLAUDE_TOOLS,
    '--disallowedTools', CLAUDE_MUTATING_TOOLS.join(','),
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', CLAUDE_RESTRICTED_TOOLS,
    ...modelArgs('claude', model),
    '-p', PROMPT_TOKEN,
  ]
}

/** Per-agent argv for a headless run.
 *
 *  Read-only is the default and is expressed per CLI: Codex takes `--sandbox
 *  read-only` natively; Claude runs in plan mode with only the read/search built-ins and
 *  no MCP servers (claudeReadOnlyArgs), and agy in its plan mode, bounded by its own
 *  time limit (agyReadOnlyArgs). Merely dropping the skip-permissions flag was not
 *  enough: Claude then inherits the settings file's `defaultMode`, which can itself be
 *  bypassPermissions, along with every MCP tool the user has. `write` is the explicit
 *  opt-in to an unattended agent that edits and runs commands, and keeps the
 *  skip-permissions launch. `timeoutMs` only shapes agy's own time limit.
 *
 *  `opts.linkedJob` is a job another machine started. It keeps Termpolis's own MCP server, and
 *  no other, narrowed to RESTRICTED_RUN_TOOLS by the stdio adapter: claude through its own config
 *  file (`--strict-mcp-config` drops the user's other servers), codex with the marker set on the
 *  server for the run. Missing those, the server is switched off for the run as before: claude
 *  gets `--strict-mcp-config` alone, codex CODEX_ISOLATE_MCP_ARGS. agy has no per-run switch; it
 *  passes its own environment, marker included, to the adapter. `opts.cwd` is the spawn's to use,
 *  and codex is also told it with `-C`. The caller checks it first: runHeadless takes only an
 *  absolute path, which can never be read as a flag. */
export function execCommand(
  agent: ExecAgent,
  model: string | undefined,
  write: boolean,
  timeoutMs: number = EXEC_DEFAULT_TIMEOUT_MS,
  opts: { linkedJob?: LinkedJobArgs; cwd?: string } = {},
): { bin: string; args: string[] } {
  const job = opts.linkedJob
  if (agent === 'codex') {
    const base = secondOpinionCommand(agent, model)
    const args = [...base.args]
    // Flip the VALUE that follows `--sandbox`, not every token equal to 'read-only' — a
    // discovered model id may legitimately be any [A-Za-z0-9._-] string, including one
    // that collides with the sandbox value, and rewriting it would corrupt the argv.
    if (write) {
      const i = args.indexOf('--sandbox')
      if (i >= 0 && args[i + 1] === 'read-only') args[i + 1] = 'workspace-write'
    }
    // Options go before the positional prompt, which `codex exec` takes last.
    args.splice(args.indexOf(PROMPT_TOKEN), 0, ...(job ? codexLinkedJobArgs(job) : []), ...(opts.cwd ? ['-C', opts.cwd] : []))
    return { bin: base.bin, args }
  }
  const bin = agent === 'claude' ? 'claude' : 'agy'
  if (write) {
    // Only for a linked job: a plain `termpolis exec --write` keeps the user's own MCP servers.
    const mcp = job && agent === 'claude'
      ? ['--strict-mcp-config', ...(job.claudeMcpConfig ? ['--mcp-config', job.claudeMcpConfig] : [])]
      : []
    return { bin, args: ['-p', PROMPT_TOKEN, ...modelArgs(agent, model), '--dangerously-skip-permissions', ...mcp] }
  }
  if (agent === 'claude') {
    return {
      bin,
      args: job?.claudeMcpConfig
        ? claudeLinkedReadOnlyArgs(model, job.claudeMcpConfig)
        : claudeReadOnlyArgs(model, EXEC_READ_ONLY_CLAUDE_TOOLS),
    }
  }
  return { bin, args: agyReadOnlyArgs(model, timeoutMs) }
}

export interface ExecDeps {
  deliver: DeliverFn
  /** Mneme's primer for the target cwd. Failures are non-fatal — a cold run beats no run. */
  primer?: (cwd: string) => Promise<string | null>
  /** Write the outcome back to the brain so the next run starts warmer. */
  remember?: (input: { content: string; project: string }) => Promise<unknown>
  isWindows?: boolean
  now?: () => number
  /** Whether a path is an existing directory. Test seam. The default asks the file system
   *  asynchronously: this runs on the main thread, and an unreachable network path can make a
   *  synchronous stat hang for seconds. */
  isDirectory?: (p: string) => Promise<boolean>
  /** What a Linked machines job needs to keep Termpolis's MCP server, restricted (see
   *  LinkedJobMcp). Absent, or null for a run, and the job runs with the server switched off. */
  linkedJobMcp?: (jobId: string, agent: ExecAgent) => LinkedJobMcp | null
}

/** Per-run MCP plumbing for one Linked machines job. */
export interface LinkedJobMcp {
  /** A file holding only Termpolis's server, with TERMPOLIS_LINKED_JOB in its env, for claude's
   *  `--mcp-config`. */
  claudeMcpConfig?: string
  /** Codex's config.toml holds Termpolis's own server, so the marker and approvals can be set
   *  on it for one run. */
  codexHasTermpolis?: boolean
  /** Called once the run has settled, however it ended. */
  dispose?: () => void
}

async function isExistingDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Why `cwd` can't be a run's folder, or null when it can. It must be absolute: a relative
 *  path would resolve against the app's cwd, not the caller's, and an absolute path can never
 *  be read as a flag where it becomes argv (`codex exec -C <cwd>`). */
async function cwdProblem(cwd: string, isDirectory: (p: string) => Promise<boolean>): Promise<string | null> {
  if (!path.isAbsolute(cwd)) return `cwd must be an absolute path: ${cwd}`
  if (!(await isDirectory(cwd))) return `cwd does not exist or is not a directory: ${cwd}`
  return null
}

export async function runHeadless(req: ExecRequest, deps: ExecDeps): Promise<ExecResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const agent: ExecAgent = req.agent ?? 'claude'

  // The folder is checked before anything is primed or spawned. A run that can't start in the
  // folder it was given must not start anywhere else.
  if (req.cwd) {
    const problem = await cwdProblem(req.cwd, deps.isDirectory ?? isExistingDirectory)
    if (problem) return { ok: false, agent, output: '', error: problem, code: -1, durationMs: now() - started, primerChars: 0 }
  }
  const cwd = req.cwd ?? process.cwd()

  let primer: string | null = null
  if (!req.noPrimer && deps.primer) {
    try {
      primer = await deps.primer(cwd)
    } catch {
      /* a cold run is still a run */
    }
  }

  const prompt = buildExecPrompt(req.task, primer)
  const primerChars = prompt.length - req.task.length
  const timeoutMs = req.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS
  const mcp = req.linkedJob === undefined ? null : linkedJobMcpFor(deps, req.linkedJob, agent)
  const linkedJob: LinkedJobArgs | undefined = req.linkedJob === undefined ? undefined : {
    id: req.linkedJob,
    ...(mcp?.claudeMcpConfig ? { claudeMcpConfig: mcp.claudeMcpConfig } : {}),
    ...(mcp?.codexHasTermpolis ? { codexHasTermpolis: true } : {}),
  }
  const { bin, args } = execCommand(agent, req.model, req.write === true, timeoutMs, {
    ...(linkedJob ? { linkedJob } : {}),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  })
  // Only what this run has, so deliver's options never carry an explicit undefined.
  const extra = {
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  }

  try {
    const { stdout, stderr, code } = await deliverWithDeadline(deps.deliver, bin, args, prompt, timeoutMs, DELIVER_GRACE_MS, extra)
    const ok = code === 0
    const output = stdout.trim()

    // Only a SUCCESSFUL run is remembered. Recording failures would fill the brain
    // with the output of broken runs, which later recalls would surface as fact.
    if (ok && output && deps.remember && !req.noRemember) {
      try {
        await deps.remember({
          content: `Headless run (${agent}): ${req.task}\n\nResult:\n${output.slice(0, 4000)}`,
          project: cwd,
        })
      } catch {
        /* memory write is best-effort; it must not fail the run that succeeded */
      }
    }

    return {
      ok,
      agent,
      output,
      ...(ok ? {} : { error: (stderr ?? '').trim() || `exit ${code}` }),
      code,
      durationMs: now() - started,
      primerChars,
    }
  } catch (err) {
    return {
      ok: false,
      agent,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      code: -1,
      durationMs: now() - started,
      primerChars,
    }
  } finally {
    try {
      mcp?.dispose?.()
    } catch {
      /* a temp file left behind must not change the run's outcome */
    }
  }
}

/** The job's MCP plumbing, or null. A failure to set it up leaves the server switched off for
 *  the run rather than failing it. */
function linkedJobMcpFor(deps: ExecDeps, jobId: string, agent: ExecAgent): LinkedJobMcp | null {
  if (!deps.linkedJobMcp) return null
  try {
    return deps.linkedJobMcp(jobId, agent)
  } catch {
    return null
  }
}

export { secondOpinionSpawnPlan, PROMPT_TOKEN }
