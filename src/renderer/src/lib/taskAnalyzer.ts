// NLP-lite task analyzer — breaks a task description into categorized subtasks
// using deterministic keyword matching (no AI/ML, fast and predictable).

import type { StrengthCategory } from './agentCapabilities'
import { CATEGORY_LABELS } from './agentCapabilities'

export interface SubTask {
  title: string
  description: string
  category: StrengthCategory
  complexity: number // 1-5
  tokenIntensity: 'low' | 'medium' | 'high'
}

export interface TaskBreakdown {
  subtasks: SubTask[]
  totalComplexity: number
}

// ---- Keyword → category mapping ----

interface CategoryRule {
  category: StrengthCategory
  keywords: RegExp[]
  baseComplexity: number
  tokenIntensity: 'low' | 'medium' | 'high'
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    // "Build/create/make" — the most common task type, often implicit
    category: 'frontend',
    keywords: [
      /\bbuild\b/i, /\bcreate\b/i, /\bmake\b/i, /\bimplement/i, /\bdevelop/i,
      /\bwrite\s+(?:a|an|the)\b/i, /\bcod(?:e|ing)\b/i, /\badd\b/i,
      /\bapp\b/i, /\bapplication/i, /\bgame\b/i, /\btool\b/i, /\bwebsite/i, /\bpage\b/i,
      /\bfeature/i, /\bfunction/i, /\bmodule/i, /\bservice/i, /\bapi\b/i, /\bendpoint/i,
      /\bI\s+want\b/i, /\bI\s+need\b/i,
    ],
    baseComplexity: 4,
    tokenIntensity: 'high',
  },
  {
    category: 'refactoring',
    keywords: [
      /\brefactor/i, /\brewrite/i, /\brestructur/i, /\bclean\s*up/i, /\bmoderniz/i, /\bmigrat/i,
      /\bupgrade/i, /\bupdate\b/i, /\bimprove/i, /\boptimiz/i, /\bperformance/i, /\bconvert\s+(?:to|from)/i,
    ],
    baseComplexity: 4,
    tokenIntensity: 'high',
  },
  {
    category: 'architecture',
    keywords: [/\bdesign/i, /\barchitect/i, /\bplan/i, /\bstructur/i, /\bsystem\s+design/i, /\bblueprint/i],
    baseComplexity: 4,
    tokenIntensity: 'medium',
  },
  {
    category: 'testing',
    keywords: [/\btest/i, /\bspec\b/i, /\bcoverage/i, /\bassertion/i, /\bunit\s+test/i, /\be2e/i, /\bintegration\s+test/i],
    baseComplexity: 3,
    tokenIntensity: 'medium',
  },
  {
    category: 'documentation',
    keywords: [/\bdocument/i, /\breadme/i, /\bcomment/i, /\bexplain/i, /\bjsdoc/i, /\btsdoc/i, /\bapi\s+doc/i],
    baseComplexity: 2,
    tokenIntensity: 'high',
  },
  {
    category: 'codeReview',
    keywords: [/\breview/i, /\baudit/i, /\bsecurity/i, /\bvulnerabilit/i, /\bcode\s+quality/i, /\blint/i],
    baseComplexity: 3,
    tokenIntensity: 'medium',
  },
  {
    category: 'debugging',
    keywords: [/\bdebug/i, /\bfix/i, /\berror/i, /\bbug/i, /\bcrash/i, /\bissue/i, /\btroubleshoot/i],
    baseComplexity: 4,
    tokenIntensity: 'high',
  },
  {
    category: 'frontend',
    keywords: [/\bui\b/i, /\bfrontend/i, /\bcomponent/i, /\bcss/i, /\blayout/i, /\bstyl/i, /\bux\b/i, /\bresponsiv/i],
    baseComplexity: 3,
    tokenIntensity: 'medium',
  },
  {
    category: 'devops',
    keywords: [/\bdeploy/i, /\bci\b/i, /\bcd\b/i, /\bdocker/i, /\bkubernetes/i, /\bpipeline/i, /\binfra/i, /\bcloud/i, /\bterraform/i, /\bset\s*up/i, /\bconfig/i],
    baseComplexity: 3,
    tokenIntensity: 'medium',
  },
  {
    category: 'dataAnalysis',
    keywords: [/\bdata\b/i, /\banalys/i, /\bparse/i, /\btransform/i, /\bcsv/i, /\bjson\s+process/i, /\bscript/i, /\betl/i],
    baseComplexity: 3,
    tokenIntensity: 'medium',
  },
  {
    category: 'bulkTasks',
    keywords: [/\bbatch/i, /\bbulk/i, /\bmany\s+files/i, /\bconvert/i, /\brepetitiv/i, /\bmass\s+/i, /\ball\s+files/i],
    baseComplexity: 2,
    tokenIntensity: 'high',
  },
]

// ---- Complexity modifiers ----

const COMPLEXITY_MODIFIERS: { pattern: RegExp; delta: number }[] = [
  { pattern: /\bcomprehensiv/i, delta: 1 },
  { pattern: /\bthorough/i, delta: 1 },
  { pattern: /\bcomplex/i, delta: 1 },
  { pattern: /\badvanced/i, delta: 1 },
  { pattern: /\bsimple/i, delta: -1 },
  { pattern: /\bquick/i, delta: -1 },
  { pattern: /\bsmall/i, delta: -1 },
  { pattern: /\bminor/i, delta: -1 },
]

function detectComplexityModifier(text: string): number {
  let modifier = 0
  for (const { pattern, delta } of COMPLEXITY_MODIFIERS) {
    if (pattern.test(text)) modifier += delta
  }
  return modifier
}

// ---- Category detection ----

interface DetectedCategory {
  category: StrengthCategory
  complexity: number
  tokenIntensity: 'low' | 'medium' | 'high'
  matchedKeyword: string
}

function detectCategories(description: string): DetectedCategory[] {
  const detected: DetectedCategory[] = []
  const complexityMod = detectComplexityModifier(description)

  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      const match = description.match(kw)
      if (match) {
        // Avoid duplicating a category
        if (!detected.some(d => d.category === rule.category)) {
          const complexity = Math.max(1, Math.min(5, rule.baseComplexity + complexityMod))
          detected.push({
            category: rule.category,
            complexity,
            tokenIntensity: rule.tokenIntensity,
            matchedKeyword: match[0],
          })
        }
        break
      }
    }
  }

  return detected
}

// ---- Title and description generation ----

function generateSubtaskTitle(category: StrengthCategory, _description: string): string {
  const titles: Record<StrengthCategory, string> = {
    refactoring: 'Refactor and restructure code',
    architecture: 'Design system architecture',
    testing: 'Write comprehensive tests',
    documentation: 'Document the codebase',
    codeReview: 'Review code for quality and security',
    debugging: 'Debug and fix issues',
    frontend: 'Build and implement the application',
    devops: 'Set up DevOps and infrastructure',
    dataAnalysis: 'Process and analyze data',
    bulkTasks: 'Execute bulk file operations',
  }
  return titles[category]
}

function generateSubtaskDescription(category: StrengthCategory, fullDescription: string): string {
  // Split by common delimiters: "and", commas, semicolons, periods, "also"
  const segments = fullDescription.split(/\band\b|[,;.]+|\balso\b/i).map(s => s.trim()).filter(s => s.length > 3)
  const rule = CATEGORY_RULES.find(r => r.category === category)

  if (rule && segments.length > 1) {
    // Find the segment that best matches this category
    for (const segment of segments) {
      for (const kw of rule.keywords) {
        if (kw.test(segment)) return segment
      }
    }
  }

  // For the primary build/coding task, use the full description
  if (category === 'frontend') {
    return fullDescription
  }

  // Fallback: use the full description with a category-specific prefix
  return `${CATEGORY_LABELS[category]}: ${fullDescription}`
}

// ---- Main analyzer ----

export function analyzeTask(description: string): TaskBreakdown {
  const categories = detectCategories(description)
  const subtasks: SubTask[] = []

  for (const cat of categories) {
    subtasks.push({
      title: generateSubtaskTitle(cat.category, description),
      description: generateSubtaskDescription(cat.category, description),
      category: cat.category,
      complexity: cat.complexity,
      tokenIntensity: cat.tokenIntensity,
    })
  }

  // If no specific categories detected, create a general "implementation" task
  if (subtasks.length === 0) {
    subtasks.push({
      title: 'Implement task',
      description,
      category: 'refactoring',
      complexity: 3,
      tokenIntensity: 'medium',
    })
  }

  return {
    subtasks,
    totalComplexity: subtasks.reduce((sum, t) => sum + t.complexity, 0),
  }
}
