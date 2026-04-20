import * as fs from 'fs'
import * as path from 'path'
import { publish } from '../agentEventBus'
import { tailFile, resolvePathWithinRoot, type TailHandle } from './baseWatcher'

/**
 * Aider transcript watcher.
 *
 * Aider writes a markdown chat history to the working directory:
 *   .aider.chat.history.md
 *
 * Format is markdown with "####" headers for turns. We parse boundaries
 * and emit message events. Token data is not reliably available in this
 * file — we approximate via character count where needed.
 */

export interface AiderWatcherHandle {
  terminalId: string
  historyFile: string
  stop(): void
}

export function findAiderHistory(cwd: string): string | null {
  if (!cwd) return null
  const file = path.join(cwd, '.aider.chat.history.md')
  try {
    if (fs.existsSync(file)) {
      // Security: the history file must be within the cwd root
      resolvePathWithinRoot(cwd, file)
      return file
    }
  } catch {}
  return null
}

interface AiderParserState {
  currentRole: 'user' | 'assistant' | null
  buffer: string[]
}

function flush(state: AiderParserState, terminalId: string): void {
  if (!state.currentRole) return
  const text = state.buffer.join('\n').trim()
  if (text) {
    publish({
      terminalId,
      agentType: 'aider',
      kind: 'message',
      summary: `${state.currentRole}: ${text.slice(0, 200)}`,
      payload: { role: state.currentRole, length: text.length },
    })
  }
  state.buffer = []
}

/**
 * Process one line of Aider's chat history. State is passed in because
 * Aider messages span many lines.
 */
export function processAiderLine(
  line: string,
  terminalId: string,
  state: AiderParserState,
): void {
  // Aider uses "#### " prefix for user messages and ">" or plain text for assistant
  if (line.startsWith('#### ')) {
    flush(state, terminalId)
    state.currentRole = 'user'
    state.buffer = [line.slice(5).trim()]
    return
  }
  // Heuristic: a blank line after user message → start of assistant turn
  if (state.currentRole === 'user' && line.trim() === '' && state.buffer.length > 0) {
    flush(state, terminalId)
    state.currentRole = 'assistant'
    state.buffer = []
    return
  }
  state.buffer.push(line)
}

export function newAiderParserState(): AiderParserState {
  return { currentRole: null, buffer: [] }
}

export function attachAiderWatcher(terminalId: string, cwd: string): AiderWatcherHandle | null {
  const historyFile = findAiderHistory(cwd)
  if (!historyFile) return null

  const state = newAiderParserState()
  const tail: TailHandle = tailFile(historyFile, (line) => processAiderLine(line, terminalId, state))

  return {
    terminalId,
    historyFile,
    stop: () => tail.stop(),
  }
}
