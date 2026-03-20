import { useState, useRef } from 'react'
import { detectAgent, type AgentInfo } from '../lib/agentDetector'
import { parseCostFromOutput, type CostInfo } from '../lib/costTracker'
import { parseConversation } from '../lib/conversationParser'
import { useTerminalStore } from '../store/terminalStore'

const AGENT_SCAN_LIMIT = 2048
const COST_SCAN_INTERVAL = 5
const CONVERSATION_PARSE_INTERVAL = 10

interface AgentDetectionState {
  detectedAgent: AgentInfo | null
  costInfo: CostInfo | null
  /** Call from onData handler with stripped (ANSI-free) output */
  processAgentDetection: (strippedOutput: string, dataLength: number, terminalId: string, terminalName: string) => void
  /** Ref indicating if agent has been detected */
  agentDetectedRef: React.RefObject<boolean>
}

export function useAgentDetection(): AgentDetectionState {
  const [detectedAgent, setDetectedAgent] = useState<AgentInfo | null>(null)
  const [costInfo, setCostInfo] = useState<CostInfo | null>(null)

  const agentDetectedRef = useRef(false)
  const agentScanBytesRef = useRef(0)
  const costScanCounterRef = useRef(0)
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

    // Cost tracking: scan periodically when an agent is active
    if (agentDetectedRef.current) {
      costScanCounterRef.current++
      if (costScanCounterRef.current % COST_SCAN_INTERVAL === 0) {
        const parsed = parseCostFromOutput(strippedOutput)
        if (parsed) {
          setCostInfo(prev => ({
            tokensIn: parsed.tokensIn ?? prev?.tokensIn ?? 0,
            tokensOut: parsed.tokensOut ?? prev?.tokensOut ?? 0,
            estimatedCost: parsed.estimatedCost ?? prev?.estimatedCost ?? 0,
            lastUpdated: parsed.lastUpdated ?? Date.now(),
          }))
        }
      }
    }

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
    costInfo,
    processAgentDetection,
    agentDetectedRef,
  }
}
