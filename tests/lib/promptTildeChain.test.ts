/**
 * The reported bug, over the two modules that actually produce it: a Git Bash prompt abbreviates
 * the directory to `~`, and the renderer had no home directory to expand it against. So
 * normalizeShellPath left `~/repos/x` verbatim, `git -C '~/repos/x'` could not chdir to it,
 * git:change-counts answered null, and the mark read a dirty repository as "not a repository".
 *
 * These assert the JOIN between the two modules — parsePromptFromOutput's output fed straight into
 * normalizeShellPath — because that join is where the bug lived. Each module's own unit tests pass
 * with the bug present; only the composition shows it.
 *
 * `platform: 'win32'` is passed explicitly rather than inherited from the host, so the expectations
 * are the same on a developer's Windows box and on the Linux CI runner.
 *
 * The prompt strings are the real thing, taken from a Git Bash session under the app, not invented:
 * a two-line PS1 renders the path and the `$` on separate lines, which is why the path line carries
 * no prompt terminator and GIT_BASH_PROMPT has to match on the `MINGW` token alone.
 */
import { describe, it, expect } from 'vitest'
import { parsePromptFromOutput } from '../../src/renderer/src/lib/promptParser'
import { normalizeShellPath } from '../../src/shared/cwdPath'

const HOME = 'C:\\Users\\dev'
const EXPANDED = 'C:\\Users\\dev\\project'

/** The composition under test, exactly as TerminalPane performs it. */
const chain = (output: string, homedir: string): string | null => {
  const info = parsePromptFromOutput(output, 'gitbash')
  if (!info.cwd) return null
  // The `?? info.cwd` fallback is TerminalPane's, and is deliberate there: a path with no native
  // form fails git cleanly, which blanks the mark, rather than stranding it on a stale directory.
  return normalizeShellPath(info.cwd, { homedir, platform: 'win32' }) ?? info.cwd
}

describe('a `~`-abbreviated Git Bash prompt reaches git as a real path', () => {
  const TILDE_PROMPT = ['MINGW64 ~/project', '$ '].join('\n')
  const TILDE_PROMPT_BRANCH = ['MINGW64 ~/project (main)', '$ '].join('\n')

  it('expands the tilde the shell printed into the home directory git can open', () => {
    expect(chain(TILDE_PROMPT, HOME)).toBe(EXPANDED)
  })

  it('still expands it when the prompt also carries a branch', () => {
    expect(chain(TILDE_PROMPT_BRANCH, HOME)).toBe(EXPANDED)
    expect(parsePromptFromOutput(TILDE_PROMPT_BRANCH, 'gitbash').gitBranch).toBe('main')
  })

  /**
   * The negative control, and the reason these tests are worth having: with no home directory to
   * expand against — the state the renderer was in before the fix, having no `process` — the tilde
   * survives into the value handed to git. If the fix regresses, THIS is the assertion that changes
   * from "unusable" to "unusable", so the two above are what fail. Asserted rather than implied so
   * the bug's actual shape is on the record.
   */
  it('without a home directory the tilde survives, which is precisely what broke git', () => {
    const unexpanded = chain(TILDE_PROMPT, '')
    expect(unexpanded).not.toBe(EXPANDED)
    expect(unexpanded?.startsWith('~')).toBe(true)
  })

  /**
   * Two shapes this machine's own prompts produce, pinned so a future parser change cannot quietly
   * turn either into a wrong answer. The basename case matters most: a bare `project` must match
   * NOTHING, because git would resolve it against the app's working directory and report some other
   * repository's changes as this terminal's.
   */
  it('reports no directory for a prompt that prints only the basename', () => {
    const info = parsePromptFromOutput(['project (main) $ '].join('\n'), 'gitbash')
    expect(info.cwd).toBeNull()
    expect(info.gitBranch).toBe('main')
  })

  it('leaves an MSYS path with no Windows equivalent as the shell wrote it', () => {
    // /tmp has no drive to map to, so normalizeShellPath answers null and the raw text is kept.
    expect(chain(['/tmp/scratch $ '].join('\n'), HOME)).toBe('/tmp/scratch')
  })
})
