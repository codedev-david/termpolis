/**
 * Parse terminal prompt output to extract cwd and git branch.
 * Works by matching common prompt patterns from the terminal's output buffer.
 */

// Git Bash prompt: "user@host MINGW64 ~/repos/project (branch)"
// or: "user@host MINGW64 /c/Users/name/repos (branch)"
const GIT_BASH_PROMPT = /MINGW\d*\s+([^\s(]+(?:\s[^\s(]+)*)\s*(?:\(([^)]+)\))?/

// PowerShell prompt: "PS C:\Users\name\repos\project>" — anchored to the line
// start so prompts QUOTED inside other output (AI answers, pasted context)
// are not mistaken for the live prompt.
const PS_PROMPT = /^PS\s+([A-Za-z]:\\[^>]+)>/

// Generic path detection: lines ending with $ or > preceded by a path
const GENERIC_PROMPT = /([~\/][^\s$>]+|\b[A-Za-z]:\\[^\s$>]+)\s*[$>]\s*$/

// Git branch in parentheses: "(branch-name)" — common across many prompt
// configs. The content must look like a git ref (no spaces, ref charset);
// otherwise TUI hints like "(esc to interrupt)" become the "branch".
const BRANCH_IN_PARENS = /\(([A-Za-z0-9][\w./-]*)\)\s*[$>]?\s*$/

export interface PromptInfo {
  cwd: string | null
  gitBranch: string | null
}

// Detect "cd <path>" commands to track directory changes
const CD_COMMAND = /[$>]\s*cd\s+(.+?)\s*$/

// zsh. Every pattern above terminates on `$` or `>`, and zsh's default prompt
// ends in `%` (`#` when root) — so a zsh terminal matches NONE of them and
// loses the path, the branch and the `cd` fallback together. That matters more
// than it looks: zsh is the DEFAULT shell on macOS, and under MSYS zsh on
// Windows the pid probe is unavailable, which leaves the prompt as the only
// cwd reporter there at all.
//
// The path stays `~`/`/`-anchored, exactly like GENERIC_PROMPT, and that anchor
// is load-bearing rather than cosmetic. macOS's stock prompt (`%n@%m %1~ %#`)
// abbreviates the directory to its BASENAME — "dave@mac repo %" — and a bare
// "repo" must match NOTHING here: normalizeShellPath rejects a relative POSIX
// path, TerminalPane falls back to the raw string, and git would then resolve
// "repo" against the app's own working directory and report some OTHER
// repository's changes as this terminal's. Matching nothing leaves the pid
// probe in charge, which is the honest answer.
const ZSH_PROMPT = /([~/][^\s%#]+)\s*[%#]\s*$/
const ZSH_BRANCH_IN_PARENS = /\(([A-Za-z0-9][\w./-]*)\)\s*[%#]?\s*$/
// `#` is deliberately NOT a prompt marker here: "# cd /somewhere" is an
// ordinary shell comment in printed docs and READMEs, and honouring it would
// invent a directory change that never happened.
const ZSH_CD_COMMAND = /%\s*cd\s+(.+?)\s*$/

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

    // zsh, tried before the generic patterns and deliberately NOT breaking out:
    // a zsh user whose custom prompt ends in `$` or `>` still falls through to
    // the generic ones below, which remain their best match.
    if (shellType === 'zsh') {
      if (!gitBranch) {
        const zshBranch = line.match(ZSH_BRANCH_IN_PARENS)
        if (zshBranch) {
          gitBranch = zshBranch[1]
        }
      }
      if (!cwd) {
        const zshMatch = line.match(ZSH_PROMPT)
        if (zshMatch) {
          if (!lastCdTarget) {
            cwd = zshMatch[1]
          } else {
            lastKnownPath = zshMatch[1]
          }
        }
      }
      if (!cwd && !lastCdTarget) {
        const zshCd = line.match(ZSH_CD_COMMAND)
        if (zshCd) {
          lastCdTarget = zshCd[1].trim()
        }
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
