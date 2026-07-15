import { useState, useRef } from 'react'
import { detectAgent, type AgentInfo } from '../lib/agentDetector'
import { parseConversation } from '../lib/conversationParser'
import { useTerminalStore } from '../store/terminalStore'

const AGENT_SCAN_LIMIT = 2048
const CONVERSATION_PARSE_INTERVAL = 10

interface AgentDetectionState {
  detectedAgent: AgentInfo | null
  /** Call from onData handler with stripped (ANSI-free) output */
  processAgentDetection: (strippedOutput: string, dataLength: number, terminalId: string, terminalName: string) => void
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
  ): void {
    // Agent detection: scan first ~2KB of output then stop
    if (!agentDetectedRef.current && agentScanBytesRef.current < AGENT_SCAN_LIMIT) {
      agentScanBytesRef.current += dataLength
      const agent = detectAgent(strippedOutput)
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
      conversationParsedCountRef.current++
      if (conversationParsedCountRef.current % CONVERSATION_PARSE_INTERVAL === 0) {
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
