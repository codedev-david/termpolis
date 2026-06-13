export interface AgentInfo {
  name: string
  icon: string
  color: string
}

const AI_AGENT_PATTERNS = [
  { name: 'Claude Code', pattern: /claude|anthropic/i, icon: 'fa-solid fa-robot', color: '#D97706' },
  { name: 'Codex', pattern: /codex|openai/i, icon: 'fa-solid fa-microchip', color: '#10B981' },
  { name: 'Gemini CLI', pattern: /gemini|google ai/i, icon: 'fa-brands fa-google', color: '#4285F4' },
  { name: 'Qwen Code', pattern: /qwen/i, icon: 'fa-solid fa-feather', color: '#A855F7' },
]

/**
 * Detect if an AI coding agent is running based on terminal output.
 * Returns the first matching agent or null.
 */
export function detectAgent(output: string): AgentInfo | null {
  for (const { name, pattern, icon, color } of AI_AGENT_PATTERNS) {
    if (pattern.test(output)) {
      return { name, icon, color }
    }
  }
  return null
}

// Maps the command a terminal was LAUNCHED with to the agent identity. Names +
// colors match the AI profiles so the badge is consistent with the sidebar.
const AGENT_COMMAND_MAP: { prefix: string; info: AgentInfo }[] = [
  { prefix: 'claude', info: { name: 'Claude Code', icon: 'fa-solid fa-robot', color: '#D97706' } },
  { prefix: 'codex', info: { name: 'OpenAI Codex', icon: 'fa-solid fa-microchip', color: '#10B981' } },
  { prefix: 'gemini', info: { name: 'Gemini CLI', icon: 'fa-brands fa-google', color: '#4285F4' } },
  { prefix: 'qwen', info: { name: 'Qwen Code', icon: 'fa-solid fa-feather', color: '#A855F7' } },
]

/**
 * Identify the agent from the command a terminal was LAUNCHED with (the
 * authoritative `agentCommand` Termpolis records), instead of scraping keywords
 * from scrollback. Output-scraping mislabels a terminal whenever words like
 * "codex"/"openai" merely appear in the text — e.g. a Claude session that
 * discusses OpenAI gets badged "Codex". Prefer this for the status-bar badge;
 * fall back to detectAgent() only for an agent started by hand in a plain shell.
 */
export function agentFromCommand(command: string | null | undefined): AgentInfo | null {
  if (!command) return null
  const c = command.trim().toLowerCase()
  for (const { prefix, info } of AGENT_COMMAND_MAP) {
    if (c.startsWith(prefix)) return { ...info }
  }
  return null
}
