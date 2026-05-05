// Agent capability matrix — scores each model's strengths across task categories.
// Scores are 1-5 (5 = strongest).
//
// DEFAULT RATINGS NOTE:
// These are estimated defaults based on general model capabilities as of March 2026.
// They are NOT based on formal benchmarks. Each AI agent uses a specific underlying
// model (e.g., Claude Code uses Sonnet 4, Codex uses codex-mini/o4-mini) which may
// change over time. Users can customize these ratings in Settings > Agent Ratings.
//
// The AI conductor uses these ratings as hints when assigning tasks but makes its
// own judgment calls — so even imperfect ratings produce reasonable assignments.

export interface AgentCapability {
  agentId: string
  agentName: string
  strengths: {
    refactoring: number
    architecture: number
    testing: number
    documentation: number
    codeReview: number
    debugging: number
    frontend: number
    devops: number
    dataAnalysis: number
    bulkTasks: number
  }
  tokenCost: 'free' | 'low' | 'medium' | 'high'
  hasMcp: boolean
}

export type StrengthCategory = keyof AgentCapability['strengths']

export const STRENGTH_CATEGORIES: StrengthCategory[] = [
  'refactoring',
  'architecture',
  'testing',
  'documentation',
  'codeReview',
  'debugging',
  'frontend',
  'devops',
  'dataAnalysis',
  'bulkTasks',
]

export const DEFAULT_AGENT_CAPABILITIES: AgentCapability[] = [
  {
    agentId: 'claude',
    agentName: 'Claude Code',
    strengths: {
      refactoring: 5,
      architecture: 5,
      testing: 4,
      documentation: 4,
      codeReview: 5,
      debugging: 5,
      frontend: 4,
      devops: 3,
      dataAnalysis: 3,
      bulkTasks: 3,
    },
    tokenCost: 'high',
    hasMcp: true,
  },
  {
    agentId: 'codex',
    agentName: 'OpenAI Codex',
    strengths: {
      refactoring: 4,
      architecture: 3,
      testing: 5,
      documentation: 4,
      codeReview: 3,
      debugging: 4,
      frontend: 4,
      devops: 3,
      dataAnalysis: 4,
      bulkTasks: 4,
    },
    tokenCost: 'medium',
    hasMcp: true,
  },
  {
    agentId: 'gemini',
    agentName: 'Gemini CLI',
    strengths: {
      refactoring: 3,
      architecture: 4,
      testing: 3,
      documentation: 5,
      codeReview: 4,
      debugging: 3,
      frontend: 4,
      devops: 5,
      dataAnalysis: 5,
      bulkTasks: 3,
    },
    tokenCost: 'low',
    hasMcp: true,
  },
  {
    agentId: 'qwen-code',
    agentName: 'Qwen Code',
    strengths: {
      refactoring: 4,
      architecture: 3,
      testing: 3,
      documentation: 3,
      codeReview: 3,
      debugging: 3,
      frontend: 3,
      devops: 3,
      dataAnalysis: 4,
      bulkTasks: 5,
    },
    tokenCost: 'low',
    hasMcp: true,
  },
  {
    agentId: 'aider-qwen',
    agentName: 'Qwen AI',
    strengths: {
      refactoring: 3,
      architecture: 2,
      testing: 3,
      documentation: 2,
      codeReview: 2,
      debugging: 3,
      frontend: 2,
      devops: 2,
      dataAnalysis: 2,
      bulkTasks: 5,
    },
    tokenCost: 'free',
    hasMcp: false,
  },
]

// Custom overrides stored per-agent: { [agentId]: { [category]: score } }
export type AgentRatingOverrides = Record<string, Partial<AgentCapability['strengths']>>

/** Merge default capabilities with user overrides */
export function getEffectiveCapabilities(overrides?: AgentRatingOverrides): AgentCapability[] {
  if (!overrides) return DEFAULT_AGENT_CAPABILITIES
  return DEFAULT_AGENT_CAPABILITIES.map(agent => {
    const agentOverrides = overrides[agent.agentId]
    if (!agentOverrides) return agent
    return {
      ...agent,
      strengths: { ...agent.strengths, ...agentOverrides },
    }
  })
}

// Backwards-compatible export — consumers that import AGENT_CAPABILITIES get defaults
export const AGENT_CAPABILITIES = DEFAULT_AGENT_CAPABILITIES

export function getAgentCapability(agentId: string, overrides?: AgentRatingOverrides): AgentCapability | undefined {
  const caps = getEffectiveCapabilities(overrides)
  return caps.find(a => a.agentId === agentId)
}

/** Human-readable label for a strength category */
export const CATEGORY_LABELS: Record<StrengthCategory, string> = {
  refactoring: 'Refactoring',
  architecture: 'Architecture',
  testing: 'Testing',
  documentation: 'Documentation',
  codeReview: 'Code Review',
  debugging: 'Debugging',
  frontend: 'Frontend',
  devops: 'DevOps',
  dataAnalysis: 'Data Analysis',
  bulkTasks: 'Bulk Tasks',
}

/** Token cost labels for display */
export const TOKEN_COST_LABELS: Record<AgentCapability['tokenCost'], string> = {
  free: 'Free (local)',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}
