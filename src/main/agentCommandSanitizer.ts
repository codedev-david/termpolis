// Valid agent launch commands — run_command on swarm terminals must match one of these.
// If the conductor tries to add -p, --sandbox, or append a prompt, we fix it.
export const AGENT_COMMAND_ALLOWLIST: Record<string, string> = {
  'claude': 'claude --dangerously-skip-permissions',
  'codex': 'codex --full-auto',
  'gemini': 'gemini',
  'qwen': 'qwen',
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

  // The conductor tried to add extra flags (e.g. -p, --sandbox, a prompt).
  // Replace with the correct command.
  return allowed
}
