export interface HandoffContext {
  task: string
  recentCommands: string[]
  recentOutput: string
  gitDiff: string
  gitBranch: string
  cwd: string
  filesModified: string[]
  previousAgent: string
  timestamp: string
}

/**
 * Build a handoff context by gathering git info, recent commands, and terminal output.
 */
export async function captureHandoffContext(
  cwd: string,
  previousAgent: string,
  recentOutput: string,
): Promise<HandoffContext> {
  // Get git info (branch, status, diff)
  let gitBranch = ''
  let filesModified: string[] = []
  let gitDiff = ''

  try {
    const gitInfoResult = await window.termpolis.getGitInfo(cwd)
    if (gitInfoResult.success && gitInfoResult.data) {
      filesModified = gitInfoResult.data.status
        .split('\n')
        .filter((l: string) => l.trim())
        .map((l: string) => l.trim())
    }
  } catch {}

  try {
    const diffResult = await window.termpolis.getGitDiff(cwd)
    if (diffResult.success && diffResult.data) {
      gitDiff = diffResult.data
    }
  } catch {}

  try {
    const statusResult = await window.termpolis.getTerminalStatus('', cwd)
    if (statusResult.success && statusResult.data) {
      gitBranch = statusResult.data.gitBranch
    }
  } catch {}

  // Parse recent commands from output (lines starting with $ or common prompt patterns)
  const recentCommands = extractRecentCommands(recentOutput)

  // Try to infer the task from recent output
  const task = inferTask(recentOutput)

  return {
    task,
    recentCommands,
    recentOutput: recentOutput.slice(-2048),
    gitDiff,
    gitBranch,
    cwd,
    filesModified,
    previousAgent,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Extract recent commands from terminal output by looking for prompt-like patterns.
 */
function extractRecentCommands(output: string): string[] {
  const lines = output.split('\n')
  const commands: string[] = []
  // Match lines that look like shell prompts: "$ cmd", "> cmd", "user@host:~$ cmd"
  const promptPattern = /(?:^|\s)[\$>]\s+(.+)/
  for (const line of lines) {
    const match = line.match(promptPattern)
    if (match && match[1].trim()) {
      commands.push(match[1].trim())
    }
  }
  // Return last 10
  return commands.slice(-10)
}

/**
 * Try to infer what the user was working on from recent output.
 * Looks for common patterns like commit messages, file edits, error messages.
 */
function inferTask(output: string): string {
  // Look for git commit messages
  const commitMatch = output.match(/commit.*?[:\-]\s*(.+)/i)
  if (commitMatch) return commitMatch[1].trim()

  // Look for "feat:", "fix:", "chore:" patterns
  const conventionalMatch = output.match(/(feat|fix|chore|refactor|docs|test|build)[\s:(]+(.{10,80})/i)
  if (conventionalMatch) return `${conventionalMatch[1]}: ${conventionalMatch[2].trim()}`

  return ''
}

/**
 * Format the handoff context into a prompt suitable for pasting into a new AI agent.
 */
export function formatHandoffPrompt(ctx: HandoffContext): string {
  const sections: string[] = []

  sections.push(
    `I'm continuing work from a previous AI coding session (${ctx.previousAgent}) that ran out of context. Here's the context:`
  )

  if (ctx.task) {
    sections.push(`## Task\n${ctx.task}`)
  } else {
    sections.push(`## Task\nContinuing previous work session`)
  }

  sections.push(`## Working Directory\n${ctx.cwd}`)

  if (ctx.gitBranch) {
    sections.push(`## Git Branch\n${ctx.gitBranch}`)
  }

  if (ctx.recentCommands.length > 0) {
    sections.push(`## Recent Commands\n${ctx.recentCommands.map(c => '$ ' + c).join('\n')}`)
  }

  if (ctx.filesModified.length > 0) {
    sections.push(`## Files Modified\n${ctx.filesModified.join('\n')}`)
  }

  if (ctx.gitDiff) {
    sections.push(`## Recent Changes (git diff summary)\n${ctx.gitDiff.slice(0, 2000)}`)
  }

  if (ctx.recentOutput) {
    sections.push(`## Last Terminal Output\n${ctx.recentOutput.slice(0, 1000)}`)
  }

  sections.push(
    `Please review the context above and continue where the previous session left off. Ask me if you need clarification on what we were working on.`
  )

  // Cap total length at ~3000 chars
  let prompt = sections.join('\n\n')
  if (prompt.length > 3000) {
    prompt = prompt.slice(0, 2950) + '\n\n[Context truncated for brevity]'
  }

  return prompt
}
