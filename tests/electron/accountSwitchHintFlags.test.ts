// @vitest-environment node
//
// SW3-1: Claude Code 2.1.317 prints the flags a session was started with between `claude` and `--resume` in its exit hint. The rows
// below are the real ones, captured from the installed CLI in a signed-out temp profile (round 3's probe-out/r3-hintflags-*.json):
// in PowerShell 5.1 under Termpolis's own wrapper, and in Git Bash with David's rc, whose `claude()` adds `--effort max` to every
// interactive launch. A reader that took only `claude --resume <id>` read no id from any flagged launch, and the switch fell back on
// the launch's own id, which a /clear or a /resume makes stale, or on a fresh session.
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetSwitchLocksForTest, hintAtFoot, runAccountSwitch } from '../../src/main/accountSwitch'
import type { Look, SwitchContext } from '../../src/main/accountSwitch'
import { exitHintOf } from '../../src/shared/accountSwitch'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { AgentAccount } from '../../src/shared/agentAccounts'
import { FakeTerminal, ID, ID2 } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'
import { resumeIdFromOutput } from '../../src/renderer/src/lib/agentResume'

const HINT_ID = '8c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const B: AgentAccount = { id: 'acc_b', agent: 'claude', label: 'codedev', profile: 'C:\\Users\\me\\.claude-b', autoOffer: true, order: 1, connect: true, origin: 'created', links: [] }

/** The command rows Claude Code 2.1.317 printed, as captured (the id is the probe's). */
const REAL_ROWS: string[] = [
  `claude --resume ${HINT_ID}`,
  `claude --effort max --resume ${HINT_ID}`,
  `claude --model sonnet --resume ${HINT_ID}`,
  `claude --dangerously-skip-permissions --resume ${HINT_ID}`,
  `claude --permission-mode plan --resume ${HINT_ID}`,
  `claude --effort max --model sonnet --dangerously-skip-permissions --resume ${HINT_ID}`,
  `claude --effort max --dangerously-skip-permissions --resume ${HINT_ID}`,
  `claude --effort max --model sonnet --resume ${HINT_ID}`,
]

describe('exitHintOf reads the flags Claude Code prints in its hint (SW3-1)', () => {
  it.each(REAL_ROWS)('reads the id of: %s', (command) => {
    expect(exitHintOf(['Resume this session with:', command], 'claude')).toEqual({ id: HINT_ID, row: 0 })
  })

  it('reads it with the blank rows and indent a real screen has around the hint', () => {
    const rows = ['', '  Resume this session with:', '', `  ${REAL_ROWS[5]}`, '', '$ ']
    expect(exitHintOf(rows, 'claude')).toEqual({ id: HINT_ID, row: 1 })
  })

  it.each([
    ['before the flags', `claude --worktree "feat-x" --effort max --resume ${HINT_ID}`],
    ['among them', `claude --effort max --worktree "feat-x" --model sonnet --resume ${HINT_ID}`],
    ['as -w', `claude -w "feat-x" --dangerously-skip-permissions --resume ${HINT_ID}`],
    ['with nothing else', `claude --worktree "feat-x" --resume ${HINT_ID}`],
  ])('reads the worktree %s', (_where, command) => {
    expect(exitHintOf(['Resume this session with:', command], 'claude')).toEqual({ id: HINT_ID, worktree: 'feat-x', row: 0 })
  })

  it('reads -r as well, and a flag with its value joined by =', () => {
    expect(exitHintOf(['Resume this session with:', `claude --effort=max -r ${HINT_ID}`], 'claude')).toEqual({ id: HINT_ID, row: 0 })
  })

  it('reads a quoted value that holds spaces and brackets, which is not a flag of its own', () => {
    const command = `claude --allowedTools "Bash(git:*) Read" --effort max --resume ${HINT_ID}`
    expect(exitHintOf(['Resume this session with:', command], 'claude')).toEqual({ id: HINT_ID, row: 0 })
  })

  it('names no id for a worktree it could not type back, as before', () => {
    expect(exitHintOf(['Resume this session with:', `claude --worktree "a b;c" --effort max --resume ${HINT_ID}`], 'claude')).toEqual({ id: null, row: 0 })
  })

  it('names no id for a worktree flag with no name in quotes: resuming from the main folder would not find the conversation', () => {
    for (const flags of ['--worktree feat-x', '-w feat-x', '--worktree=feat-x', '--worktree', '--effort max --worktree']) {
      expect(exitHintOf(['Resume this session with:', `claude ${flags} --resume ${HINT_ID}`], 'claude'), flags).toEqual({ id: null, row: 0 })
    }
  })

  it('does not take a flag that only contains the worktree flag for it', () => {
    expect(exitHintOf(['Resume this session with:', `claude --worktrees-off --resume ${HINT_ID}`], 'claude')).toEqual({ id: HINT_ID, row: 0 })
    expect(exitHintOf(['Resume this session with:', `claude --add-dir ./a-w ./b --resume ${HINT_ID}`], 'claude')).toEqual({ id: HINT_ID, row: 0 })
  })

  it.each([
    ['a command substitution', `claude $(whoami) --resume ${HINT_ID}`],
    ['a variable', `claude --effort $LEVEL --resume ${HINT_ID}`],
    ['an opening parenthesis', `claude --effort (max --resume ${HINT_ID}`],
    ['a closing parenthesis', `claude --effort max) --resume ${HINT_ID}`],
    ['a redirect in a word', `claude --effort max<x --resume ${HINT_ID}`],
    ['a redirect out of a word', `claude --effort max>x --resume ${HINT_ID}`],
    ['a backtick', `claude \`id\` --resume ${HINT_ID}`],
    ['a semicolon', `claude --effort max; rm -rf x --resume ${HINT_ID}`],
    ['an ampersand', `claude --effort max & echo hi --resume ${HINT_ID}`],
    ['a pipe', `claude --effort max | tee x --resume ${HINT_ID}`],
    ['a redirect', `claude --effort max > x --resume ${HINT_ID}`],
    ['another program', `notclaude --effort max --resume ${HINT_ID}`],
    ['text before claude', `run claude --effort max --resume ${HINT_ID}`],
    ['no resume', 'claude --effort max'],
    ['something after the id', `claude --effort max --resume ${HINT_ID} and more`],
  ])('is no hint for %s', (_what, command) => {
    expect(exitHintOf(['Resume this session with:', command], 'claude')).toBeNull()
  })

  it('names no id when what follows --resume is not a UUID', () => {
    expect(exitHintOf(['Resume this session with:', 'claude --effort max --resume not-an-id'], 'claude')).toEqual({ id: null, row: 0 })
    expect(exitHintOf(['Resume this session with:', 'claude --effort max --resume'], 'claude')).toEqual({ id: null, row: 0 })
  })

  it('reads the hint at the screen foot, and one that wraps in a narrow pane', () => {
    const l: Look = { lines: ['', 'Resume this session with:', REAL_ROWS[5]], title: '', raw: '', end: 0, box: -1 }
    expect(hintAtFoot(l, 'claude')).toMatchObject({ id: HINT_ID })
    const cols = 40
    const wrapped = REAL_ROWS[5].match(new RegExp(`.{1,${cols}}`, 'g')) as string[]
    expect(wrapped.length).toBeGreaterThan(2)
    expect(hintAtFoot({ lines: ['Resume this session with:', ...wrapped], title: '', raw: '', end: 0, box: -1, cols }, 'claude')).toMatchObject({ id: HINT_ID })
  })
})

describe('the switch resumes the conversation the flagged hint names (SW3-1)', () => {
  beforeEach(() => _resetSwitchLocksForTest())

  async function run(script: TermScript, over: Partial<SwitchContext> = {}): Promise<{ t: FakeTerminal; outcome: SwitchOutcome }> {
    const t = new FakeTerminal(script)
    const outcome = await runAccountSwitch(
      { terminalId: 't1', targetId: B.id, shellType: 'gitbash' },
      { io: t.io(), target: B, agent: 'claude', start: { at: t.launchedAt, commands: [t.launchLine()] }, newSessionId: () => ID2, record: () => {}, ...over },
    )
    return { t, outcome }
  }
  const claude = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'claude', family: 'posix', start: 'idle', exit: 'hint', ...over })

  it.each(['--effort max', '--model sonnet', '--dangerously-skip-permissions', '--effort max --model sonnet --dangerously-skip-permissions'])(
    'with %s printed: the current conversation, not the stale launch id (a /clear or /resume since)',
    async (hintFlags) => {
      const { t, outcome } = await run(claude({ id: HINT_ID, hintFlags }), { sessionId: ID, hasTranscript: () => true })
      expect(outcome).toMatchObject({ kind: 'switched', resumed: true, sessionId: HINT_ID })
      expect(t.ran.join('\n')).toContain(`--resume ${HINT_ID}`)
      expect(t.ran.join('\n')).not.toContain(ID)
    },
  )

  it('and with no launch id on record (a swarm worker): the conversation, not a fresh session', async () => {
    const { t, outcome } = await run(claude({ id: HINT_ID, hintFlags: '--effort max' }))
    expect(outcome).toMatchObject({ kind: 'switched', resumed: true, sessionId: HINT_ID })
    expect(t.ran.join('\n')).toContain(`--resume ${HINT_ID}`)
  })

  it('a worktree among the flags goes back into the same worktree', async () => {
    const { t, outcome } = await run(claude({ id: HINT_ID, worktree: 'feat-x', hintFlags: '--effort max' }))
    expect(outcome).toMatchObject({ kind: 'switched', resumed: true, sessionId: HINT_ID })
    expect(t.ran.join('\n')).toContain('--worktree "feat-x"')
  })
})

describe('the model switcher reads the same hint (agentResume.ts, SW3-1)', () => {
  it.each(REAL_ROWS)('reads the id of: %s', (command) => {
    expect(resumeIdFromOutput('claude', `\r\nResume this session with:\r\n${command}\r\n`)).toBe(HINT_ID)
  })

  it('takes the last hint of a screen that repeats an older one', () => {
    const text = `Resume this session with:\nclaude --effort max --resume ${ID}\nResume this session with:\nclaude --effort max --resume ${HINT_ID}\n`
    expect(resumeIdFromOutput('claude', text)).toBe(HINT_ID)
  })

  it('does not join a launch line to a resume on the lines after it', () => {
    expect(resumeIdFromOutput('claude', `claude --effort max\nnothing --resume ${HINT_ID}\n`)).toBeNull()
    expect(resumeIdFromOutput('claude', `claude\n--resume ${HINT_ID}\n`)).toBeNull()
  })

  it('does not read a command that only ends in claude', () => {
    expect(resumeIdFromOutput('claude', `notclaude --effort max --resume ${HINT_ID}\n`)).toBeNull()
  })

  it('leaves the other agents as they were', () => {
    expect(resumeIdFromOutput('codex', `To continue this session, run codex resume ${HINT_ID}\n`)).toBe(HINT_ID)
    expect(resumeIdFromOutput('gemini', `agy --conversation=${HINT_ID}\n`)).toBe(HINT_ID)
  })
})

