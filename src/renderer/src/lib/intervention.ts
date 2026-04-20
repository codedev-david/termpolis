// Intervention controls for in-flight AI agents.
//
// Each swarm agent is a CLI running in a pty; we can pause or steer it by
// writing ASCII control sequences or new prompt text to the pty's stdin.
// The Activity Feed surfaces these as inline buttons, but the low-level
// actions (below) are kept pure so they're trivial to unit test.

export type InterventionKind = 'pause' | 'interrupt' | 'cancel' | 'steer' | 'resume'

export interface InterventionAction {
  kind: InterventionKind
  payload: string   // raw bytes/chars to write to the pty stdin
  label: string     // human-readable description (for logs / toasts)
}

// Canonical control sequences. We keep them here rather than inline so a
// future change (e.g. Codex wants a different cancel sequence) is one place.
export const CTRL_C = '\x03'
export const CTRL_D = '\x04'
export const ESC = '\x1b'

/** Cancel what the agent is currently doing. Equivalent to Ctrl-C in a shell. */
export function buildCancelAction(): InterventionAction {
  return { kind: 'cancel', payload: CTRL_C, label: 'Cancel current action (Ctrl-C)' }
}

/** Send ESC — claude-code treats this as "stop thinking" without killing session. */
export function buildPauseAction(): InterventionAction {
  return { kind: 'pause', payload: ESC, label: 'Pause agent (ESC)' }
}

/**
 * Steer the agent by writing a user message. A trailing newline is appended so
 * the agent actually submits, unless the text already ends with one.
 */
export function buildSteerAction(message: string): InterventionAction {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('buildSteerAction: message required')
  const suffix = trimmed.endsWith('\n') ? '' : '\n'
  return {
    kind: 'steer',
    payload: trimmed + suffix,
    label: `Steer: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}`,
  }
}

/** Double Ctrl-C — firm interrupt even if the agent ignored the first one. */
export function buildInterruptAction(): InterventionAction {
  return { kind: 'interrupt', payload: CTRL_C + CTRL_C, label: 'Hard interrupt (Ctrl-C x2)' }
}

interface TerminalWriter {
  writeToTerminal: (id: string, data: string) => void
}

/**
 * Dispatch an intervention against a terminal. Pure wrapper over writeToTerminal
 * so tests can swap in a stub writer without touching preload/IPC.
 * Returns false if terminalId is falsy — the caller is responsible for deciding
 * whether that is an error (UI shouldn't render buttons without a terminalId).
 */
export function sendIntervention(
  writer: TerminalWriter,
  terminalId: string | null | undefined,
  action: InterventionAction,
): boolean {
  if (!terminalId) return false
  if (!writer || typeof writer.writeToTerminal !== 'function') return false
  writer.writeToTerminal(terminalId, action.payload)
  return true
}
