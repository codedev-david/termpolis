// modelSwitchState.ts
//
// Which terminals are in the middle of a model switch.
//
// A switch is a multi-second async sequence (Ctrl+C presses, a wait for the agent to exit, a
// retype) that outlives the React component that started it: opening Settings, toggling split or
// tab view, or splitting a pane unmounts the TerminalPane while the sequence keeps running. If
// "a switch is in flight" lived in that component's state, the pane that mounts next would show an
// enabled picker, and a second pick would start a second sequence into the same PTY — its Ctrl+C
// presses landing on the agent the first one had just relaunched. So it lives here, keyed by
// terminal, and every pane for a terminal reads the same answer.

import { useSyncExternalStore } from 'react'

const switching = new Map<string, string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Claim `terminalId` for a switch to `modelId`. False when it is already being switched, in which
 * case nothing may be sent to it. One call both checks and claims, so two picks racing each other
 * cannot both pass.
 */
export function beginModelSwitch(terminalId: string, modelId: string): boolean {
  if (switching.has(terminalId)) return false
  switching.set(terminalId, modelId)
  emit()
  return true
}

/** Release `terminalId`, whatever happened. */
export function endModelSwitch(terminalId: string): void {
  if (switching.delete(terminalId)) emit()
}

/** The model `terminalId` is being switched to, or undefined when it is not being switched. */
export function modelSwitchTarget(terminalId: string): string | undefined {
  return switching.get(terminalId)
}

/** React: the model `terminalId` is being switched to (undefined when idle), live. */
export function useModelSwitch(terminalId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => switching.get(terminalId), () => undefined)
}

/** Test seam: forget every switch, so one test cannot leave the next one locked out. */
export function resetModelSwitches(): void {
  switching.clear()
  emit()
}
