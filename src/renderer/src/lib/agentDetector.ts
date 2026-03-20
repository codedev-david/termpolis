export interface AgentInfo {
  name: string
  icon: string
  color: string
}

const AI_AGENT_PATTERNS = [
  { name: 'Claude Code', pattern: /claude|anthropic/i, icon: 'fa-solid fa-robot', color: '#D97706' },
  { name: 'Codex', pattern: /codex|openai/i, icon: 'fa-solid fa-microchip', color: '#10B981' },
  { name: 'Aider', pattern: /aider/i, icon: 'fa-solid fa-code', color: '#8B5CF6' },
  { name: 'GitHub Copilot', pattern: /copilot/i, icon: 'fa-brands fa-github', color: '#6366F1' },
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
