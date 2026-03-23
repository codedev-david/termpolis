// Agent capability matrix — scores each model's strengths across task categories.
// Scores are 1-5 (5 = strongest). These are opinionated but tunable over time.

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

export const AGENT_CAPABILITIES: AgentCapability[] = [
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
    agentId: 'aider-qwen',
    agentName: 'Aider + Qwen3',
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

export function getAgentCapability(agentId: string): AgentCapability | undefined {
  return AGENT_CAPABILITIES.find(a => a.agentId === agentId)
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
