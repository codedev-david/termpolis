import { v4 as uuidv4 } from 'uuid'
import { useTerminalStore } from '../store/terminalStore'

/** Split Right puts the new pane beside the old one; Split Down puts it underneath. */
export type SplitDirection = 'horizontal' | 'vertical'

/**
 * Split one pane: start a shell like it (same shell, folder, font and theme) and place it next to it.
 * The pane header buttons, the pane right-click menu and the command palette all come through here,
 * so a split from the palette is the same split as one from the pane.
 *
 * Returns the new terminal's id, or null when nothing was split (unknown pane, or the shell failed).
 */
export async function splitPane(terminalId: string, direction: SplitDirection): Promise<string | null> {
  const terminal = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
  if (!terminal) return null
  const newId = uuidv4()
  const res = await window.termpolis.createTerminal(newId, terminal.shellType, terminal.cwd)
  if (!res?.success) return null
  useTerminalStore.setState(s => ({
    terminals: [
      ...s.terminals,
      {
        id: newId,
        name: `${terminal.name} (split)`,
        color: terminal.color,
        shellType: terminal.shellType,
        cwd: terminal.cwd,
        fontSize: terminal.fontSize,
        theme: terminal.theme,
        fontFamily: terminal.fontFamily,
      },
    ],
  }))
  useTerminalStore.getState().splitTerminal(terminalId, direction, newId)
  return newId
}

/**
 * The command palette's Split Right / Split Down: split the active terminal. In tabs mode it first
 * switches to split view, because a split only exists in the pane tree that split view builds.
 */
export async function splitActivePane(direction: SplitDirection): Promise<string | null> {
  const state = useTerminalStore.getState()
  const activeId = state.activeTerminalId
  if (!activeId || !state.terminals.some(t => t.id === activeId)) return null
  if (state.viewMode === 'tabs') state.toggleViewMode()
  return splitPane(activeId, direction)
}

/** Ask the active terminal's pane to do something it already offers in its right-click menu. */
function sendToActivePane(eventName: string): boolean {
  const activeId = useTerminalStore.getState().activeTerminalId
  if (!activeId) return false
  window.dispatchEvent(new CustomEvent(eventName, { detail: activeId }))
  return true
}

/** The palette's Export Terminal Output: save the active terminal's full scrollback to a file. */
export function exportActivePane(): boolean {
  return sendToActivePane('termpolis:export-terminal')
}

/** The palette's Start/Stop Recording: start recording the active terminal, or stop and save it. */
export function toggleRecordingActivePane(): boolean {
  return sendToActivePane('termpolis:toggle-recording')
}
