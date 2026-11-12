// Valid agent launch commands — run_command on swarm terminals must match one of these.
// If the conductor tries to add -p, --sandbox, or append a prompt, we fix it.
// Codex: `--full-auto` was removed from the CLI (0.153 rejects it outright), and a swarm
// worker can't stop for approvals — Termpolis no longer answers them. `-a never` returns a
// failed command to the model instead of asking; `-s workspace-write` keeps its sandbox:
// writes stay in the project, and no network. With its update check on, a Codex started while a
// newer one is out opens on an update offer, a menu that holds it until someone answers (GitHub #36).
export const AGENT_COMMAND_ALLOWLIST: Record<string, string> = {
  'claude': 'claude --dangerously-skip-permissions',
  'codex': 'codex -a never -s workspace-write -c check_for_update_on_startup=false',
  'agy': 'agy --dangerously-skip-permissions', // Gemini via the Antigravity CLI (autonomous swarm worker → auto-approve, like Claude)
  'gemini': 'gemini', // legacy fallback
}

// The ONLY model aliases the model broker may pass through `--model`, per agent.
// This is the AUTHORITATIVE security allowlist. Claude only today: Claude Code's
// --model accepts opus/sonnet/haiku (the broker's cost tiers) plus fable (Fable 5,
// the most-capable flagship — a manual pick ABOVE the tiers, so it is a valid alias
// here but intentionally absent from modelBroker.ts AGENT_MODEL_TIERS, which the
// swarm uses to DOWNSHIFT for savings and must never auto-upgrade). Keep this list =
// the broker's tier aliases + fable, plus opusplan (v1.55.0: Opus while planning, Sonnet
// while building, the task router's pick for a launch with no task yet). Agents absent here get
// no --model flag at all (they run their own default model). An alias must match EXACTLY —
// nothing else can ride along on the command.
export const AGENT_MODEL_ALIASES: Record<string, string[]> = {
  'claude': ['fable', 'opus', 'sonnet', 'haiku', 'opusplan'],
}

// v1.55.0: the effort levels Claude Code's `--effort` takes, the only other flag that may ride
// along. Same rule: exact match, rebuilt onto the trusted base.
export const AGENT_EFFORT_LEVELS: Record<string, string[]> = {
  'claude': ['low', 'medium', 'high', 'xhigh', 'max'],
}

// Find a single, exactly-allowlisted `<flag> <value>` (or `<flag>=<value>`) in a
// command. Returns the value, or null if none is present/valid. Whitespace-tokenized
// and matched against the enum, so a quoted, concatenated, or injected value never
// matches — the caller rebuilds the command from the trusted base + this alias.
function extractFlagValue(command: string, flag: string, aliases: string[]): string | null {
  const tokens = command.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    let candidate: string | null = null
    if (t === flag) candidate = tokens[i + 1] ?? null
    else if (t.startsWith(`${flag}=`)) candidate = t.slice(flag.length + 1)
    if (candidate !== null) {
      const clean = candidate.replace(/^['"]/, '').replace(/['"]$/, '')
      if (aliases.includes(clean)) return clean
    }
  }
  return null
}

/** Is this exactly one of the agent binaries above — a bare name, nothing appended? */
export function isAgentBinary(command: unknown): command is string {
  return typeof command === 'string' && Object.prototype.hasOwnProperty.call(AGENT_COMMAND_ALLOWLIST, command)
}

/** Soft signal: does an LLM-chosen swarm terminal NAME denote a Claude agent (e.g. "Claude (Build UI)")?
 *  Used to gate the always-on Headroom proxy env for swarm-spawned Claude workers. */
export function isClaudeAgentName(name: string): boolean {
  return /(^|[^a-z])claude/i.test(name || '')
}

export function sanitizeAgentCommand(command: string): string {
  const trimmed = command.trim()

  // Identify which agent binary is being invoked. A Windows launcher's extension is not part of
  // the name: `agy.exe -p "task"` or `claude.cmd -p` is the same agent, and passed through as-is it
  // started headless with the prompt on its command line, which is what this file exists to stop.
  const firstToken = trimmed.split(/\s+/)[0].toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
  const agentKey = Object.keys(AGENT_COMMAND_ALLOWLIST).find(
    k => firstToken === k || firstToken.endsWith('/' + k) || firstToken.endsWith('\\' + k)
  )

  if (!agentKey) {
    // Not an agent command — could be a shell utility, allow as-is
    return command
  }

  // If the command exactly matches the allowed command, pass through
  const allowed = AGENT_COMMAND_ALLOWLIST[agentKey]
  if (trimmed === allowed) return command

  // The conductor added something. The ONLY permitted additions are a strictly-
  // validated `--model <alias>` and `--effort <level>` for agents that support them — and
  // we REBUILD the command from the trusted base so nothing the conductor appended
  // (a prompt, an injection, any other flag) can ride along.
  const aliases = AGENT_MODEL_ALIASES[agentKey]
  const levels = AGENT_EFFORT_LEVELS[agentKey]
  const model = aliases ? extractFlagValue(trimmed, '--model', aliases) : null
  const effort = levels ? extractFlagValue(trimmed, '--effort', levels) : null
  if (model || effort) return `${allowed}${model ? ` --model ${model}` : ''}${effort ? ` --effort ${effort}` : ''}`

  // Otherwise replace with the correct base command (strips -p, --sandbox, prompts).
  return allowed
}
