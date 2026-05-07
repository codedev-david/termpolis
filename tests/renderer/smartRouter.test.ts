import { describe, it, expect } from 'vitest'
import { analyzeTask } from '../../src/renderer/src/lib/taskAnalyzer'
import { routeTasks, reassignTask, estimateCosts, totalEstimatedCost } from '../../src/renderer/src/lib/smartRouter'
import { AGENT_CAPABILITIES, CATEGORY_LABELS } from '../../src/renderer/src/lib/agentCapabilities'

// ═══════════════════════════════════════════════════════
// AGENT CAPABILITIES
// ═══════════════════════════════════════════════════════

describe('agentCapabilities', () => {
  it('has 4 agents defined', () => {
    expect(AGENT_CAPABILITIES.length).toBe(4)
  })

  it('each agent has all 10 strength categories', () => {
    const categories = ['refactoring', 'architecture', 'testing', 'documentation', 'codeReview', 'debugging', 'frontend', 'devops', 'dataAnalysis', 'bulkTasks']
    for (const agent of AGENT_CAPABILITIES) {
      for (const cat of categories) {
        expect(agent.strengths[cat as keyof typeof agent.strengths]).toBeGreaterThanOrEqual(1)
        expect(agent.strengths[cat as keyof typeof agent.strengths]).toBeLessThanOrEqual(5)
      }
    }
  })

  it('Claude Code is strongest at refactoring and code review', () => {
    const claude = AGENT_CAPABILITIES.find(a => a.agentId === 'claude')!
    expect(claude.strengths.refactoring).toBe(5)
    expect(claude.strengths.codeReview).toBe(5)
  })

  it('Codex is strongest at testing', () => {
    const codex = AGENT_CAPABILITIES.find(a => a.agentId === 'codex')!
    expect(codex.strengths.testing).toBe(5)
  })

  it('Gemini is strongest at documentation and devops', () => {
    const gemini = AGENT_CAPABILITIES.find(a => a.agentId === 'gemini')!
    expect(gemini.strengths.documentation).toBe(5)
    expect(gemini.strengths.devops).toBe(5)
  })

  it('Qwen Code is strongest at bulk tasks', () => {
    const qwen = AGENT_CAPABILITIES.find(a => a.agentId === 'qwen-code')!
    expect(qwen.strengths.bulkTasks).toBe(5)
  })

  it('Claude, Codex, Gemini, Qwen Code all have MCP', () => {
    expect(AGENT_CAPABILITIES.find(a => a.agentId === 'claude')!.hasMcp).toBe(true)
    expect(AGENT_CAPABILITIES.find(a => a.agentId === 'codex')!.hasMcp).toBe(true)
    expect(AGENT_CAPABILITIES.find(a => a.agentId === 'gemini')!.hasMcp).toBe(true)
    expect(AGENT_CAPABILITIES.find(a => a.agentId === 'qwen-code')!.hasMcp).toBe(true)
  })

  it('has labels for all categories', () => {
    expect(Object.keys(CATEGORY_LABELS).length).toBeGreaterThanOrEqual(10)
  })
})

// ═══════════════════════════════════════════════════════
// TASK ANALYZER
// ═══════════════════════════════════════════════════════

describe('taskAnalyzer', () => {
  it('detects refactoring tasks', () => {
    const result = analyzeTask('Refactor the auth module')
    expect(result.subtasks.some(t => t.category === 'refactoring')).toBe(true)
  })

  it('detects testing tasks', () => {
    const result = analyzeTask('Write comprehensive tests for the API')
    expect(result.subtasks.some(t => t.category === 'testing')).toBe(true)
  })

  it('detects documentation tasks', () => {
    const result = analyzeTask('Document the API endpoints and add a README')
    expect(result.subtasks.some(t => t.category === 'documentation')).toBe(true)
  })

  it('detects code review tasks', () => {
    const result = analyzeTask('Review the code for security vulnerabilities')
    expect(result.subtasks.some(t => t.category === 'codeReview')).toBe(true)
  })

  it('detects debugging tasks', () => {
    const result = analyzeTask('Fix the bug in the login flow')
    expect(result.subtasks.some(t => t.category === 'debugging')).toBe(true)
  })

  it('detects devops tasks', () => {
    const result = analyzeTask('Set up the Docker deployment pipeline')
    expect(result.subtasks.some(t => t.category === 'devops')).toBe(true)
  })

  it('detects frontend tasks', () => {
    const result = analyzeTask('Build the UI component for the dashboard')
    expect(result.subtasks.some(t => t.category === 'frontend')).toBe(true)
  })

  it('splits multi-part tasks into subtasks', () => {
    const result = analyzeTask('Refactor the auth, write tests, and document the API')
    expect(result.subtasks.length).toBeGreaterThanOrEqual(2)
  })

  it('returns at least one subtask for any input', () => {
    const result = analyzeTask('Do some work')
    expect(result.subtasks.length).toBeGreaterThanOrEqual(1)
  })

  it('assigns complexity scores', () => {
    const result = analyzeTask('Write comprehensive tests')
    for (const task of result.subtasks) {
      expect(task.complexity).toBeGreaterThanOrEqual(1)
      expect(task.complexity).toBeLessThanOrEqual(5)
    }
  })
})

// ═══════════════════════════════════════════════════════
// SMART ROUTER
// ═══════════════════════════════════════════════════════

describe('smartRouter', () => {
  it('assigns refactoring to Claude Code when available', () => {
    const breakdown = analyzeTask('Refactor the entire auth module')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const refactorTask = assignments.find(a => a.subtask.category === 'refactoring')
    expect(refactorTask?.agentId).toBe('claude')
  })

  it('assigns testing to Codex when available', () => {
    const breakdown = analyzeTask('Write comprehensive unit tests')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const testTask = assignments.find(a => a.subtask.category === 'testing')
    expect(testTask?.agentId).toBe('codex')
  })

  it('assigns documentation to Gemini when available', () => {
    const breakdown = analyzeTask('Write comprehensive readme documentation')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const docTask = assignments.find(a => a.subtask.category === 'documentation')
    expect(docTask?.agentId).toBe('gemini')
  })

  it('assigns devops to Gemini when available', () => {
    const breakdown = analyzeTask('Set up the Kubernetes deployment')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const devopsTask = assignments.find(a => a.subtask.category === 'devops')
    expect(devopsTask?.agentId).toBe('gemini')
  })

  it('provides scores between 0 and 100', () => {
    const breakdown = analyzeTask('Refactor and write tests')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex'])
    for (const a of assignments) {
      expect(a.score).toBeGreaterThanOrEqual(0)
      expect(a.score).toBeLessThanOrEqual(100)
    }
  })

  it('provides human-readable reasons', () => {
    const breakdown = analyzeTask('Refactor the auth module')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex'])
    for (const a of assignments) {
      expect(a.reason.length).toBeGreaterThan(10)
    }
  })

  it('distributes work across agents (load balancing)', () => {
    const breakdown = analyzeTask('Refactor the auth, write tests, document the API, and review security')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const agentIds = new Set(assignments.map(a => a.agentId))
    // With 4 subtasks and 3 agents, at least 2 agents should get work
    expect(agentIds.size).toBeGreaterThanOrEqual(2)
  })

  it('works with only 2 agents', () => {
    const breakdown = analyzeTask('Refactor and write tests')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex'])
    expect(assignments.length).toBeGreaterThanOrEqual(1)
    for (const a of assignments) {
      expect(['claude', 'codex']).toContain(a.agentId)
    }
  })

  it('reassignTask changes the agent', () => {
    const breakdown = analyzeTask('Refactor the auth module')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const original = assignments[0]
    const newAgentId = original.agentId === 'claude' ? 'codex' : 'claude'
    const reassigned = reassignTask(original, newAgentId)
    expect(reassigned.agentId).toBe(newAgentId)
    expect(reassigned.agentName).not.toBe(original.agentName)
  })

  it('estimateCosts returns per-agent estimates', () => {
    const breakdown = analyzeTask('Refactor and write tests and document')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex', 'gemini'])
    const costs = estimateCosts(assignments)
    expect(costs.length).toBeGreaterThan(0)
    for (const c of costs) {
      expect(c.estimatedTokens).toBeGreaterThan(0)
      expect(c.estimatedCost).toBeTruthy()
    }
  })

  it('totalEstimatedCost returns a formatted string', () => {
    const breakdown = analyzeTask('Refactor and write tests')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'codex'])
    const costs = estimateCosts(assignments)
    const total = totalEstimatedCost(costs)
    expect(total).toContain('$')
  })

  it('prefers Qwen Code for bulk tasks based on its 5/5 strength', () => {
    const breakdown = analyzeTask('Batch convert all the files in the project')
    const assignments = routeTasks(breakdown.subtasks, ['claude', 'qwen-code'])
    const bulkTask = assignments.find(a => a.subtask.category === 'bulkTasks')
    if (bulkTask) {
      expect(bulkTask.agentId).toBe('qwen-code')
    }
  })

  // ---- branch coverage for line 45 (free-tier mention on token-heavy) and
  // line 200 (existing.tokens += tokens when same agent gets multiple subtasks) ----

  it('reason mentions "low token cost" when a low-cost agent gets a high-intensity task', () => {
    const subtask = {
      id: 's1',
      category: 'bulkTasks' as const,
      description: 'Bulk convert',
      complexity: 3,
      tokenIntensity: 'high' as const,
    }
    // qwen-code is tokenCost='low', and we hand it the only choice so it WILL win.
    const assignments = routeTasks([subtask], ['qwen-code'])
    expect(assignments[0].agentId).toBe('qwen-code')
    expect(assignments[0].reason.toLowerCase()).toContain('low token cost')
  })

  it('aggregates tokens when one agent is assigned multiple subtasks', () => {
    const subtaskA = {
      id: 'a',
      category: 'refactoring' as const,
      description: 'r',
      complexity: 3,
      tokenIntensity: 'medium' as const,
    }
    const subtaskB = {
      id: 'b',
      category: 'codeReview' as const,
      description: 'cr',
      complexity: 3,
      tokenIntensity: 'medium' as const,
    }
    // Only Claude available — both subtasks must route to it, exercising the
    // existing.tokens += tokens path (line 200).
    const assignments = routeTasks([subtaskA, subtaskB], ['claude'])
    expect(assignments.every(a => a.agentId === 'claude')).toBe(true)
    const costs = estimateCosts(assignments)
    expect(costs.length).toBe(1)
    expect(costs[0].estimatedTokens).toBeGreaterThan(0)
  })
})
