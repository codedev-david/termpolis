import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatHandoffPrompt, captureHandoffContext } from '../../src/renderer/src/lib/contextCapture'
import type { HandoffContext } from '../../src/renderer/src/lib/contextCapture'

function makeCtx(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    task: '',
    recentCommands: [],
    recentOutput: '',
    gitDiff: '',
    gitBranch: '',
    cwd: '/home/user/project',
    filesModified: [],
    previousAgent: 'Claude',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatHandoffPrompt — pure, no mocks needed
// ---------------------------------------------------------------------------

describe('formatHandoffPrompt', () => {
  it('includes the previousAgent name in the opening line', () => {
    const prompt = formatHandoffPrompt(makeCtx({ previousAgent: 'Codex' }))
    expect(prompt).toContain('Codex')
  })

  it('shows "## Task" with task text when task is non-empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ task: 'Fix the login bug' }))
    expect(prompt).toContain('## Task')
    expect(prompt).toContain('Fix the login bug')
  })

  it('shows "Continuing previous work session" when task is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ task: '' }))
    expect(prompt).toContain('Continuing previous work session')
  })

  it('always includes "## Working Directory" with cwd', () => {
    const prompt = formatHandoffPrompt(makeCtx({ cwd: '/srv/app' }))
    expect(prompt).toContain('## Working Directory')
    expect(prompt).toContain('/srv/app')
  })

  it('includes "## Git Branch" when gitBranch is non-empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ gitBranch: 'main' }))
    expect(prompt).toContain('## Git Branch')
    expect(prompt).toContain('main')
  })

  it('omits "## Git Branch" when gitBranch is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ gitBranch: '' }))
    expect(prompt).not.toContain('## Git Branch')
  })

  it('includes "## Recent Commands" with "$ " prefix on each command', () => {
    const prompt = formatHandoffPrompt(makeCtx({ recentCommands: ['npm test', 'git status'] }))
    expect(prompt).toContain('## Recent Commands')
    expect(prompt).toContain('$ npm test')
    expect(prompt).toContain('$ git status')
  })

  it('omits "## Recent Commands" when recentCommands is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ recentCommands: [] }))
    expect(prompt).not.toContain('## Recent Commands')
  })

  it('includes "## Files Modified" when filesModified is non-empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ filesModified: ['src/auth.ts'] }))
    expect(prompt).toContain('## Files Modified')
    expect(prompt).toContain('src/auth.ts')
  })

  it('omits "## Files Modified" when filesModified is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ filesModified: [] }))
    expect(prompt).not.toContain('## Files Modified')
  })

  it('includes "## Recent Changes" section when gitDiff is non-empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ gitDiff: 'diff --git a/foo.ts b/foo.ts' }))
    expect(prompt).toContain('## Recent Changes')
    expect(prompt).toContain('diff --git')
  })

  it('omits "## Recent Changes" when gitDiff is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ gitDiff: '' }))
    expect(prompt).not.toContain('## Recent Changes')
  })

  it('includes "## Last Terminal Output" when recentOutput is non-empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ recentOutput: 'build succeeded' }))
    expect(prompt).toContain('## Last Terminal Output')
    expect(prompt).toContain('build succeeded')
  })

  it('omits "## Last Terminal Output" when recentOutput is empty', () => {
    const prompt = formatHandoffPrompt(makeCtx({ recentOutput: '' }))
    expect(prompt).not.toContain('## Last Terminal Output')
  })

  it('always ends with the "Please review" continuation message', () => {
    const prompt = formatHandoffPrompt(makeCtx())
    expect(prompt).toContain('Please review the context above')
  })

  it('truncates to 3000 chars and appends "[Context truncated for brevity]" when over limit', () => {
    const ctx = makeCtx({
      recentOutput: 'x'.repeat(5000),
      gitDiff: 'y'.repeat(5000),
    })
    const prompt = formatHandoffPrompt(ctx)
    expect(prompt.length).toBeLessThanOrEqual(3100)
    expect(prompt).toContain('[Context truncated for brevity]')
  })
})

// ---------------------------------------------------------------------------
// captureHandoffContext — requires window.termpolis mock
// ---------------------------------------------------------------------------

describe('captureHandoffContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).termpolis = {
      getGitInfo: vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'M src/foo.ts\nA src/bar.ts\n' },
      }),
      getGitDiff: vi.fn().mockResolvedValue({
        success: true,
        data: 'diff --git a/src/foo.ts b/src/foo.ts',
      }),
      getTerminalStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { gitBranch: 'feature/test' },
      }),
    }
  })

  it('calls getGitInfo with the correct cwd', async () => {
    await captureHandoffContext('/proj', 'Claude', '')
    expect((window as any).termpolis.getGitInfo).toHaveBeenCalledWith('/proj')
  })

  it('calls getGitDiff with the correct cwd', async () => {
    await captureHandoffContext('/proj', 'Claude', '')
    expect((window as any).termpolis.getGitDiff).toHaveBeenCalledWith('/proj')
  })

  it('calls getTerminalStatus with the correct cwd', async () => {
    await captureHandoffContext('/proj', 'Claude', '')
    expect((window as any).termpolis.getTerminalStatus).toHaveBeenCalledWith('', '/proj')
  })

  it('populates filesModified from getGitInfo status split/trimmed by newline', async () => {
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.filesModified).toEqual(['M src/foo.ts', 'A src/bar.ts'])
  })

  it('populates gitDiff from getGitDiff data', async () => {
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.gitDiff).toBe('diff --git a/src/foo.ts b/src/foo.ts')
  })

  it('populates gitBranch from getTerminalStatus data.gitBranch', async () => {
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.gitBranch).toBe('feature/test')
  })

  it('handles getGitInfo throwing without crashing', async () => {
    ;(window as any).termpolis.getGitInfo = vi.fn().mockRejectedValue(new Error('git error'))
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.filesModified).toEqual([])
  })

  it('handles getGitDiff throwing without crashing', async () => {
    ;(window as any).termpolis.getGitDiff = vi.fn().mockRejectedValue(new Error('diff error'))
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.gitDiff).toBe('')
  })

  it('handles getTerminalStatus throwing without crashing', async () => {
    ;(window as any).termpolis.getTerminalStatus = vi.fn().mockRejectedValue(new Error('status error'))
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(ctx.gitBranch).toBe('')
  })

  it('extracts commands from "$ cmd" prompt patterns in recentOutput', async () => {
    const output = '$ npm install\n$ npm test\n'
    const ctx = await captureHandoffContext('/proj', 'Claude', output)
    expect(ctx.recentCommands).toContain('npm install')
    expect(ctx.recentCommands).toContain('npm test')
  })

  it('extracts commands from lines where $ is preceded by whitespace', async () => {
    // The prompt regex requires $ to be at start or preceded by whitespace.
    // "user@host ~ $ cmd" satisfies this (space before $).
    const output = 'user@host ~ $ git status\nuser@host ~ $ git diff\n'
    const ctx = await captureHandoffContext('/proj', 'Claude', output)
    expect(ctx.recentCommands).toContain('git status')
    expect(ctx.recentCommands).toContain('git diff')
  })

  it('returns at most 10 recent commands', async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `$ cmd${i}`).join('\n')
    const ctx = await captureHandoffContext('/proj', 'Claude', lines)
    expect(ctx.recentCommands.length).toBeLessThanOrEqual(10)
  })

  it('infers task from "commit: fix bug" pattern in output', async () => {
    const output = 'commit abc123: fix bug in auth flow'
    const ctx = await captureHandoffContext('/proj', 'Claude', output)
    expect(ctx.task).toBe('fix bug in auth flow')
  })

  it('infers task from "feat: add feature" conventional commit pattern', async () => {
    const output = 'feat: add dark mode support to settings'
    const ctx = await captureHandoffContext('/proj', 'Claude', output)
    expect(ctx.task).toContain('feat')
    expect(ctx.task).toContain('add dark mode support to settings')
  })

  it('returns empty task when no pattern matches', async () => {
    const output = 'some random terminal output with no recognizable pattern'
    const ctx = await captureHandoffContext('/proj', 'Claude', output)
    expect(ctx.task).toBe('')
  })

  it('truncates recentOutput to 2048 chars in the returned context', async () => {
    const longOutput = 'a'.repeat(4096)
    const ctx = await captureHandoffContext('/proj', 'Claude', longOutput)
    expect(ctx.recentOutput.length).toBe(2048)
  })

  it('sets cwd from argument', async () => {
    const ctx = await captureHandoffContext('/my/project', 'Claude', '')
    expect(ctx.cwd).toBe('/my/project')
  })

  it('sets previousAgent from argument', async () => {
    const ctx = await captureHandoffContext('/proj', 'Codex', '')
    expect(ctx.previousAgent).toBe('Codex')
  })

  it('timestamp is an ISO string', async () => {
    const ctx = await captureHandoffContext('/proj', 'Claude', '')
    expect(() => new Date(ctx.timestamp)).not.toThrow()
    expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp)
  })
})
