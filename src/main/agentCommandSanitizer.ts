// Valid agent launch commands — run_command on swarm terminals must match one of these.
// If the conductor tries to add -p, --sandbox, or append a prompt, we fix it.
export const AGENT_COMMAND_ALLOWLIST: Record<string, string> = {
  'claude': 'claude --dangerously-skip-permissions',
  'codex': 'codex --full-auto',
  'gemini': 'gemini',
  'qwen': 'qwen',
}

// The ONLY model aliases the model broker may pass through `--model`, per agent.
// This is the AUTHORITATIVE security allowlist (the renderer's modelBroker.ts
// AGENT_MODEL_TIERS must stay in sync with these values). Claude only today:
// Claude Code's --model accepts the opus/sonnet/haiku aliases. Agents absent here
// get no --model flag at all (they run their own default model). An alias must
// match EXACTLY — nothing else can ride along on the command.
export const AGENT_MODEL_ALIASES: Record<string, string[]> = {
  'claude': ['opus', 'sonnet', 'haiku'],
}

// Find a single, exactly-allowlisted `--model <alias>` (or `--model=<alias>`) in a
// command. Returns the alias, or null if none is present/valid. Whitespace-tokenized
// and matched against the enum, so a quoted, concatenated, or injected value never
// matches — the caller rebuilds the command from the trusted base + this alias.
function extractModelAlias(command: string, aliases: string[]): string | null {
  const tokens = command.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    let candidate: string | null = null
    if (t === '--model') candidate = tokens[i + 1] ?? null
    else if (t.startsWith('--model=')) candidate = t.slice('--model='.length)
    if (candidate !== null) {
      const clean = candidate.replace(/^['"]/, '').replace(/['"]$/, '')
      if (aliases.includes(clean)) return clean
    }
  }
  return null
}

export function sanitizeAgentCommand(command: string): string {
  const trimmed = command.trim()

  // Identify which agent binary is being invoked
  const firstToken = trimmed.split(/\s+/)[0].toLowerCase()
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

  // The conductor added something. The ONLY permitted addition is a strictly-
  // validated `--model <alias>` for agents that support model brokering — and we
  // REBUILD the command from the trusted base so nothing the conductor appended
  // (a prompt, an injection, any other flag) can ride along.
  const aliases = AGENT_MODEL_ALIASES[agentKey]
  if (aliases) {
    const model = extractModelAlias(trimmed, aliases)
    if (model) return `${allowed} --model ${model}`
  }

  // Otherwise replace with the correct base command (strips -p, --sandbox, prompts).
  return allowed
}
