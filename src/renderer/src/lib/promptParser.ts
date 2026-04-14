/**
 * Parse terminal prompt output to extract cwd and git branch.
 * Works by matching common prompt patterns from the terminal's output buffer.
 */

// Git Bash prompt: "user@host MINGW64 ~/repos/project (branch)"
// or: "user@host MINGW64 /c/Users/name/repos (branch)"
const GIT_BASH_PROMPT = /MINGW\d*\s+([^\s(]+(?:\s[^\s(]+)*)\s*(?:\(([^)]+)\))?/

// Zsh/Bash with git: common patterns like "~/project (main)" or "[user@host ~/project (main)]"
const BASH_PROMPT_BRANCH = /[~\/][^\s(]*\s*\(([^)]+)\)/

// PowerShell prompt: "PS C:\Users\name\repos\project>"
const PS_PROMPT = /PS\s+([A-Za-z]:\\[^>]+)>/

// Generic path detection: lines ending with $ or > preceded by a path
const GENERIC_PROMPT = /([~\/][^\s$>]+|\b[A-Za-z]:\\[^\s$>]+)\s*[$>]\s*$/

// Git branch in parentheses: "(branch-name)" — common across many prompt configs
const BRANCH_IN_PARENS = /\(([^)]+)\)\s*[$>]?\s*$/

export interface PromptInfo {
  cwd: string | null
  gitBranch: string | null
}

// Detect "cd <path>" commands to track directory changes
const CD_COMMAND = /[$>]\s*cd\s+(.+?)\s*$/

export function parsePromptFromOutput(output: string, shellType: string): PromptInfo {
  // Take the last ~2000 chars to find the most recent prompt
  const recent = output.slice(-2000)
  const lines = recent.split('\n')

  let cwd: string | null = null
  let gitBranch: string | null = null
  let lastKnownPath: string | null = null
  let lastCdTarget: string | null = null

  // Scan lines from bottom up to find the most recent prompt
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue

    if (shellType === 'gitbash' || shellType === 'bash') {
      const gitBashMatch = line.match(GIT_BASH_PROMPT)
      if (gitBashMatch) {
        cwd = gitBashMatch[1]
        gitBranch = gitBashMatch[2] || null
        break
      }
    }

    if (shellType === 'powershell') {
      const psMatch = line.match(PS_PROMPT)
      if (psMatch) {
        cwd = psMatch[1]
        break
      }
    }

    // Try generic branch in parens
    if (!gitBranch) {
      const branchMatch = line.match(BRANCH_IN_PARENS)
      if (branchMatch) {
        gitBranch = branchMatch[1]
      }
    }

    // Try generic path
    if (!cwd) {
      const pathMatch = line.match(GENERIC_PROMPT)
      if (pathMatch) {
        if (!lastCdTarget) {
          cwd = pathMatch[1]
        } else {
          // We found a path AND saw a cd command below it — resolve the cd
          lastKnownPath = pathMatch[1]
        }
      }
    }

    // Track cd commands — if we see "cd X" after a prompt with a path, we can resolve the cwd
    if (!cwd && !lastCdTarget) {
      const cdMatch = line.match(CD_COMMAND)
      if (cdMatch) {
        lastCdTarget = cdMatch[1].trim()
      }
    }

    if (cwd) break

    // Don't scan more than 20 lines back
    if (lines.length - 1 - i > 20) break
  }

  // If we found a path and a cd command but no final cwd, resolve it
  if (!cwd && lastKnownPath && lastCdTarget) {
    if (lastCdTarget.startsWith('/') || lastCdTarget.startsWith('~') || /^[A-Za-z]:/.test(lastCdTarget)) {
      // Absolute path — use as-is
      cwd = lastCdTarget
    } else {
      // Relative path — append to last known path
      cwd = lastKnownPath.replace(/\/$/, '') + '/' + lastCdTarget
    }
  }

  return { cwd, gitBranch }
}
