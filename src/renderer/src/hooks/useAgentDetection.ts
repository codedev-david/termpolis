import { useState, useRef } from 'react'
import { detectAgent, type AgentInfo } from '../lib/agentDetector'
import { parseConversation } from '../lib/conversationParser'
import { useTerminalStore } from '../store/terminalStore'

const AGENT_SCAN_LIMIT = 2048
const CONVERSATION_PARSE_INTERVAL = 10

interface AgentDetectionState {
  detectedAgent: AgentInfo | null
  /** Call from onData handler with stripped (ANSI-free) output. `messages` is how many chunks of output this call stands for
   *  (default 1): the side-effect pass of a pane covers every chunk since the last pass, and the conversation parse runs once
   *  per CONVERSATION_PARSE_INTERVAL chunks however they are batched. `detectText` is what the agent is looked for in, when
   *  that is more than the window `strippedOutput` (a pass longer than the window: the agent's banner may sit in its first
   *  half); the conversation parse always reads `strippedOutput`, the window, as it did when every chunk had its own call. */
  processAgentDetection: (strippedOutput: string, dataLength: number, terminalId: string, terminalName: string, messages?: number, detectText?: string) => void
  /** Ref indicating if agent has been detected */
  agentDetectedRef: React.RefObject<boolean>
}

export function useAgentDetection(): AgentDetectionState {
  const [detectedAgent, setDetectedAgent] = useState<AgentInfo | null>(null)

  const agentDetectedRef = useRef(false)
  const agentScanBytesRef = useRef(0)
  const conversationParsedCountRef = useRef(0)
  const detectedAgentRef = useRef<AgentInfo | null>(null)

  // Keep ref in sync
  detectedAgentRef.current = detectedAgent

  function processAgentDetection(
    strippedOutput: string,
    dataLength: number,
    terminalId: string,
    terminalName: string,
    messages = 1,
    detectText = strippedOutput,
  ): void {
    // Agent detection: scan first ~2KB of output then stop
    if (!agentDetectedRef.current && agentScanBytesRef.current < AGENT_SCAN_LIMIT) {
      agentScanBytesRef.current += dataLength
      const agent = detectAgent(detectText)
      if (agent) {
        agentDetectedRef.current = true
        setDetectedAgent(agent)
      }
    }

    // (Removed v1.27.0: a cost scan ran every 5th chunk, parsing the window and calling setCostInfo
    // with a FRESH object each time. That re-rendered TerminalPane on a hot path — and NOTHING read
    // costInfo. The Efficiency panel parses cost independently via costTracker. Dead state, deleted.)

    // Conversation parsing: periodically parse output when an agent is active
    if (agentDetectedRef.current) {
      // One parse each time the chunk count crosses a multiple of the interval: with one chunk per call that is every 10th
      // call, as always; a call that stands for 30 chunks crosses it at most once.
      const before = conversationParsedCountRef.current
      conversationParsedCountRef.current = before + messages
      if (Math.floor(conversationParsedCountRef.current / CONVERSATION_PARSE_INTERVAL) > Math.floor(before / CONVERSATION_PARSE_INTERVAL)) {
        const agentName = detectedAgentRef.current?.name ?? 'AI Agent'
        const turns = parseConversation(strippedOutput, terminalId, terminalName, agentName)
        const store = useTerminalStore.getState()
        const existingConv = store.conversations.find(c => c.terminalId === terminalId)
        const existingCount = existingConv?.turns.length ?? 0
        if (turns.length > existingCount) {
          const newTurns = turns.slice(existingCount)
          for (const turn of newTurns) {
            store.addConversationTurn(terminalId, terminalName, agentName, turn)
          }
        }
      }
    }
  }

  return {
    detectedAgent,
    processAgentDetection,
    agentDetectedRef,
  }
}
