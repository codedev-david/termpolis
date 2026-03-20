/**
 * Swarm Bridge — signal detection and message formatting for non-MCP agents.
 *
 * Non-MCP agents (Codex, Gemini, Aider) cannot call swarm tools directly.
 * This module parses their terminal output to detect meaningful signals
 * (completions, questions, errors) and formats incoming swarm messages
 * for injection into their terminals.
 */

export interface SwarmBridgeConfig {
  terminalId: string
  agentName: string
  pollIntervalMs: number // how often to check output (default 5000ms)
}

export interface DetectedSignal {
  type: 'result' | 'question' | 'error' | 'info' | null
  content: string
  newOffset: number
}

// Strip ANSI escape codes for clean pattern matching
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
}

/**
 * Detect meaningful signals in new terminal output.
 * Returns the detected signal type, a trimmed content snippet, and the new read offset.
 */
export function detectSwarmSignals(output: string, lastOffset: number): DetectedSignal {
  const newContent = output.slice(lastOffset)
  if (newContent.length < 20) {
    return { type: null, content: '', newOffset: lastOffset + newContent.length }
  }

  const clean = stripAnsi(newContent)

  // Detect task completion
  if (/\b(done|complete|finished|ready for review|all tests pass|successfully)\b/i.test(clean)) {
    return { type: 'result', content: clean.slice(-500), newOffset: lastOffset + newContent.length }
  }

  // Detect questions / prompts for input
  if (/\?\s*$|\bshould I\b|\bwhich\b.*\?|\bdo you want\b/i.test(clean)) {
    return { type: 'question', content: clean.slice(-300), newOffset: lastOffset + newContent.length }
  }

  // Detect errors
  if (/\b(error|failed|exception|FAIL|ERR!)\b/i.test(clean)) {
    return { type: 'error', content: clean.slice(-500), newOffset: lastOffset + newContent.length }
  }

  // Substantial new output treated as general info
  if (clean.length > 200) {
    return { type: 'info', content: clean.slice(-300), newOffset: lastOffset + newContent.length }
  }

  return { type: null, content: '', newOffset: lastOffset + newContent.length }
}

/**
 * Format an incoming swarm message for injection into a terminal.
 */
export function formatIncomingMessage(from: string, content: string): string {
  return `\n--- Message from ${from} ---\n${content}\n--- End message ---\n`
}
