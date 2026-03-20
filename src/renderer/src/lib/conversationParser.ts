export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  terminalId: string
  terminalName: string
  agentName: string
}

export interface ConversationIndex {
  turns: ConversationTurn[]
  terminalId: string
  terminalName: string
  agentName: string
  startedAt: number
}

// Patterns that indicate user input
const USER_PROMPT_PATTERNS = [
  /^>\s/m,           // > prompt
  /^\$\s/m,          // $ prompt
  /^❯\s/m,          // fish/starship prompt
  /^Human:\s/m,      // Claude Human: prefix
  /^╭─/m,           // Claude Code box drawing start
]

// Patterns that indicate assistant response
const ASSISTANT_PATTERNS = [
  /^Assistant:\s/m,   // Claude Assistant: prefix
  /^╰─/m,           // Claude Code box drawing end
]

/**
 * Strip ANSI escape sequences from text.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '')
}

/**
 * Parse terminal output into conversation turns.
 * This is best-effort heuristic parsing.
 */
export function parseConversation(
  rawOutput: string,
  terminalId: string,
  terminalName: string,
  agentName: string,
): ConversationTurn[] {
  const output = stripAnsi(rawOutput)
  const lines = output.split('\n')
  const turns: ConversationTurn[] = []

  let currentRole: 'user' | 'assistant' | null = null
  let currentContent: string[] = []
  const now = Date.now()

  const flushTurn = () => {
    if (currentRole && currentContent.length > 0) {
      const content = currentContent.join('\n').trim()
      if (content.length > 0) {
        turns.push({
          role: currentRole,
          content,
          timestamp: now,
          terminalId,
          terminalName,
          agentName,
        })
      }
    }
    currentContent = []
  }

  for (const line of lines) {
    const isUserLine = USER_PROMPT_PATTERNS.some(p => p.test(line))
    const isAssistantLine = ASSISTANT_PATTERNS.some(p => p.test(line))

    if (isUserLine) {
      flushTurn()
      currentRole = 'user'
      // Strip the prompt prefix
      const cleaned = line
        .replace(/^>\s/, '')
        .replace(/^\$\s/, '')
        .replace(/^❯\s/, '')
        .replace(/^Human:\s/, '')
        .replace(/^╭─.*/, '')
        .trim()
      if (cleaned) currentContent.push(cleaned)
    } else if (isAssistantLine) {
      flushTurn()
      currentRole = 'assistant'
      const cleaned = line
        .replace(/^Assistant:\s/, '')
        .replace(/^╰─.*/, '')
        .trim()
      if (cleaned) currentContent.push(cleaned)
    } else if (currentRole) {
      currentContent.push(line)
    }
  }

  // Flush any remaining content
  flushTurn()

  return turns
}
