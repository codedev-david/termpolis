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

export function parsePromptFromOutput(output: string, shellType: string): PromptInfo {
  // Take the last ~2000 chars to find the most recent prompt
  const recent = output.slice(-2000)
  const lines = recent.split('\n')

  let cwd: string | null = null
  let gitBranch: string | null = null

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
        cwd = pathMatch[1]
      }
    }

    if (cwd) break

    // Don't scan more than 20 lines back
    if (lines.length - 1 - i > 20) break
  }

  return { cwd, gitBranch }
}
