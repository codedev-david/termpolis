// Smart task router — assigns subtasks to agents based on capability scores,
// token cost efficiency, load balancing, and MCP support.

import type { SubTask } from './taskAnalyzer'
import {
  AGENT_CAPABILITIES,
  CATEGORY_LABELS,
  TOKEN_COST_LABELS,
  getEffectiveCapabilities,
  type AgentCapability,
  type AgentRatingOverrides,
} from './agentCapabilities'

export interface TaskAssignment {
  subtask: SubTask
  agentId: string
  agentName: string
  score: number // 0-100
  reason: string // human-readable explanation
}

// ---- Reason generation ----

function generateReason(agent: AgentCapability, subtask: SubTask): string {
  const catLabel = CATEGORY_LABELS[subtask.category]
  const strength = agent.strengths[subtask.category]
  const costLabel = TOKEN_COST_LABELS[agent.tokenCost]

  const parts: string[] = []

  // Strength mention
  if (strength >= 5) {
    parts.push(`top-rated for ${catLabel.toLowerCase()} (${strength}/5)`)
  } else if (strength >= 4) {
    parts.push(`strong at ${catLabel.toLowerCase()} (${strength}/5)`)
  } else if (strength >= 3) {
    parts.push(`capable at ${catLabel.toLowerCase()} (${strength}/5)`)
  } else {
    parts.push(`${catLabel.toLowerCase()} (${strength}/5)`)
  }

  // Cost mention for token-heavy tasks
  if (subtask.tokenIntensity === 'high' && agent.tokenCost === 'low') {
    parts.push('low token cost for this text-heavy task')
  }

  // Cost label
  parts.push(`${costLabel.toLowerCase()} cost`)

  return `${agent.agentName}: ${parts.join(', ')}`
}

// ---- Router ----

export function routeTasks(
  subtasks: SubTask[],
  availableAgentIds: string[],
  overrides?: AgentRatingOverrides,
): TaskAssignment[] {
  const agents = getEffectiveCapabilities(overrides).filter(a => availableAgentIds.includes(a.agentId))

  if (agents.length === 0) return []

  // Ensure we have at least as many subtasks as agents so every agent gets work.
  // If the task analyzer produced fewer subtasks than agents, duplicate the most
  // complex subtask with adjusted descriptions so each agent participates.
  const expandedSubtasks = [...subtasks]
  while (expandedSubtasks.length < agents.length) {
    // Clone the highest-complexity subtask with a variation
    const base = [...expandedSubtasks].sort((a, b) => b.complexity - a.complexity)[0]
    expandedSubtasks.push({
      ...base,
      title: `Support: ${base.title}`,
      description: `Assist with and review: ${base.description}`,
    })
  }

  const assignments: TaskAssignment[] = []
  const agentLoad = new Map<string, number>()

  // Sort subtasks by complexity (hardest first — assign best agents to hardest work)
  const sorted = [...expandedSubtasks].sort((a, b) => b.complexity - a.complexity)

  for (const subtask of sorted) {
    let bestAgent = agents[0]
    let bestScore = -Infinity
    let bestReason = ''

    for (const agent of agents) {
      let score = agent.strengths[subtask.category] * 20 // 0-100 base score

      // Bonus for token efficiency on token-heavy tasks
      if (subtask.tokenIntensity === 'high') {
        if (agent.tokenCost === 'free') score += 15
        else if (agent.tokenCost === 'low') score += 10
        else if (agent.tokenCost === 'medium') score += 5
      }

      // Heavy penalty for agents that already have tasks — ensures distribution
      // across all selected agents before doubling up
      const currentLoad = agentLoad.get(agent.agentId) || 0
      const unassignedAgents = agents.filter(a => !agentLoad.has(a.agentId) || agentLoad.get(a.agentId) === 0)
      const isUnassigned = currentLoad === 0
      if (currentLoad > 0 && unassignedAgents.length > 0 && !isUnassigned) {
        score -= 50 // strong penalty to force work to unassigned agents first
      } else {
        score -= currentLoad * 15
      }

      // Bonus for MCP-capable agents (better swarm integration)
      if (agent.hasMcp) score += 5

      if (score > bestScore) {
        bestScore = score
        bestAgent = agent
        bestReason = generateReason(agent, subtask)
      }
    }

    const finalScore = Math.min(100, Math.max(0, bestScore))

    assignments.push({
      subtask,
      agentId: bestAgent.agentId,
      agentName: bestAgent.agentName,
      score: finalScore,
      reason: bestReason,
    })

    agentLoad.set(bestAgent.agentId, (agentLoad.get(bestAgent.agentId) || 0) + 1)
  }

  return assignments
}

// ---- Reassignment helper ----

/** Reassign a specific subtask to a different agent and recalculate its score/reason */
export function reassignTask(
  assignment: TaskAssignment,
  newAgentId: string,
): TaskAssignment {
  const agent = AGENT_CAPABILITIES.find(a => a.agentId === newAgentId)
  if (!agent) return assignment

  let score = agent.strengths[assignment.subtask.category] * 20
  if (assignment.subtask.tokenIntensity === 'high') {
    if (agent.tokenCost === 'low') score += 10
    else if (agent.tokenCost === 'medium') score += 5
  }
  if (agent.hasMcp) score += 5

  return {
    ...assignment,
    agentId: agent.agentId,
    agentName: agent.agentName,
    score: Math.min(100, Math.max(0, score)),
    reason: generateReason(agent, assignment.subtask),
  }
}

// ---- Token cost estimation ----

export interface CostEstimate {
  agentId: string
  agentName: string
  estimatedTokens: number
  estimatedCost: string // formatted dollar amount
}

const COST_PER_1K_TOKENS: Record<AgentCapability['tokenCost'], number> = {
  free: 0,
  low: 0.004,
  medium: 0.015,
  high: 0.03,
}

const TOKEN_INTENSITY_MULTIPLIER: Record<SubTask['tokenIntensity'], number> = {
  low: 5000,
  medium: 15000,
  high: 25000,
}

export function estimateCosts(assignments: TaskAssignment[]): CostEstimate[] {
  const agentTokens = new Map<string, { name: string; tokens: number; cost: AgentCapability['tokenCost'] }>()

  for (const a of assignments) {
    const agent = AGENT_CAPABILITIES.find(c => c.agentId === a.agentId)
    if (!agent) continue

    const tokens = TOKEN_INTENSITY_MULTIPLIER[a.subtask.tokenIntensity] * (a.subtask.complexity / 3)
    const existing = agentTokens.get(a.agentId)

    if (existing) {
      existing.tokens += tokens
    } else {
      agentTokens.set(a.agentId, { name: agent.agentName, tokens, cost: agent.tokenCost })
    }
  }

  const estimates: CostEstimate[] = []
  for (const [agentId, data] of agentTokens) {
    const roundedTokens = Math.round(data.tokens / 1000) * 1000
    const dollarCost = (roundedTokens / 1000) * COST_PER_1K_TOKENS[data.cost]
    estimates.push({
      agentId,
      agentName: data.name,
      estimatedTokens: roundedTokens,
      estimatedCost: `$${dollarCost.toFixed(2)}`,
    })
  }

  return estimates
}

/** Total estimated cost formatted as a string */
export function totalEstimatedCost(estimates: CostEstimate[]): string {
  const total = estimates.reduce((sum, e) => sum + parseFloat(e.estimatedCost.replace('$', '')), 0)
  return `$${total.toFixed(2)}`
}
