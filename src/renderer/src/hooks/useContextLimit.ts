import { useState, useRef, useCallback } from 'react'
import { captureHandoffContext, type HandoffContext } from '../lib/contextCapture'
import { useTerminalStore } from '../store/terminalStore'
import { CONTEXT_LIMIT_PATTERN } from '../lib/outputPatterns'

interface ContextLimitState {
  contextLimitReached: boolean
  showHandoffModal: boolean
  handoffContext: HandoffContext | null
  /** Call from onData handler with stripped output; only processes when agent is active */
  processContextLimit: (strippedOutput: string) => void
  dismissContextLimit: () => void
  setShowHandoffModal: (show: boolean) => void
  /** Build handoff context and open the modal */
  handleHandoffSwitchTo: (agentCommand: string) => Promise<void>
  /** Ref indicating if context limit has already fired */
  contextLimitFiredRef: React.RefObject<boolean>
}

export function useContextLimit(
  cwd: string,
  parsedCwd: string | null,
  detectedAgentName: string | null,
  outputBufferRef: React.MutableRefObject<string>,
): ContextLimitState {
  const [contextLimitReached, setContextLimitReached] = useState(false)
  const [showHandoffModal, setShowHandoffModal] = useState(false)
  const [handoffContext, setHandoffContext] = useState<HandoffContext | null>(null)
  const contextLimitFiredRef = useRef(false)
  const lastContextCheckRef = useRef(0)

  const processContextLimit = useCallback((strippedOutput: string) => {
    if (contextLimitFiredRef.current) return

    // Throttle: only check once per second
    const now = Date.now()
    if (now - lastContextCheckRef.current < 1000) return
    lastContextCheckRef.current = now

    if (CONTEXT_LIMIT_PATTERN.test(strippedOutput)) {
      contextLimitFiredRef.current = true
      setContextLimitReached(true)
    }
  }, [])

  const dismissContextLimit = useCallback(() => {
    setContextLimitReached(false)
  }, [])

  const handleHandoffSwitchTo = useCallback(async (_agentCommand: string) => {
    const effectiveCwd = parsedCwd || cwd
    const agentName = detectedAgentName || 'AI Agent'
    const stripped = outputBufferRef.current
      .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    const ctx = await captureHandoffContext(effectiveCwd, agentName, stripped)
    setHandoffContext(ctx)
    useTerminalStore.getState().setLastHandoffContext(ctx)
    setShowHandoffModal(true)
  }, [parsedCwd, cwd, detectedAgentName, outputBufferRef])

  return {
    contextLimitReached,
    showHandoffModal,
    handoffContext,
    processContextLimit,
    dismissContextLimit,
    setShowHandoffModal,
    handleHandoffSwitchTo,
    contextLimitFiredRef,
  }
}
