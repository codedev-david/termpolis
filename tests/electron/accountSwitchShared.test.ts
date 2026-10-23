// @vitest-environment node
//
// The in-place account switch's pure parts (src/shared/accountSwitch.ts): each CLI's exit hint as
// it draws it (Claude Code 2.1.309's printResumeHint and its command builder, Codex 0.153.4's
// shutdown lines from its probe and program file, agy 1.4.3's from its program file), the commands
// that exit and resume each agent, the screens a relaunch can land on, and the typed lines that
// change a terminal's account by hand.
import { describe, it, expect } from 'vitest'
import {
  AGY_SIGNED_IN, ASKS_USER, CLEAR_BOX_KEYS, EXIT_COMMAND, HINT_FROM_FOOT_ROWS, LINE_CLEAR, RESUME_NOT_FOUND,
  SIGN_IN_SCREEN, changesAccountByHand, exitHintOf, isSafeModelName, isSessionId, otherShellReported, relaunchCommand,
} from '../../src/shared/accountSwitch'

const ID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
const ID2 = '01a1664b-6312-7121-97f6-88c7f6793c64'

describe('ids and names that go on a command line', () => {
  it('takes a UUID, in either case, and nothing else', () => {
    expect(isSessionId(ID)).toBe(true)
    expect(isSessionId(ID.toUpperCase())).toBe(true)
    expect(isSessionId(ID2)).toBe(true)
    for (const v of [`${ID} `, `${ID};rm`, 'abc', '', null, 42, `${ID}x`]) expect(isSessionId(v)).toBe(false)
  })

  it('takes a plain model name only', () => {
    for (const v of ['opus', 'gpt-5.6-sol', 'claude-opus-5-5', 'a_b']) expect(isSafeModelName(v)).toBe(true)
    for (const v of ['', 'op us', 'opus;x', '$(x)', 'a'.repeat(65), null]) expect(isSafeModelName(v)).toBe(false)
  })
})

describe('the keys and commands', () => {
  it('exits each agent with its own command, never a key', () => {
    expect(EXIT_COMMAND).toEqual({ claude: '/exit', codex: '/quit', agy: '/exit' })
  })

  it('clears a box with twenty Ctrl+U, and a shell line with the family key', () => {
    expect(CLEAR_BOX_KEYS).toBe('\u0015'.repeat(20))
    expect(LINE_CLEAR).toEqual({ posix: '\u0015', powershell: '\u001b', cmd: '\u001b' })
  })
})

describe('exitHintOf: Claude Code', () => {
  const prompt = ['', 'user@host MINGW64 ~/repo (main)', '$ ']

  it('reads the id from "Resume this session with:" and the command under it', () => {
    const rows = ['● done', '', 'Resume this session with:', `claude --resume ${ID}`, ...prompt]
    expect(exitHintOf(rows, 'claude')).toEqual({ id: ID, row: 2 })
  })

  it('keeps a worktree, in its long and short forms', () => {
    expect(exitHintOf(['Resume this session with:', `claude --worktree "feat-x" --resume ${ID}`], 'claude')).toEqual({ id: ID, worktree: 'feat-x', row: 0 })
    expect(exitHintOf(['Resume this session with:', '', `  claude -w "w.2_b" -r ${ID}`], 'claude')).toEqual({ id: ID, worktree: 'w.2_b', row: 0 })
  })

  it('gives no id for `claude --resume` alone, an id that is no UUID, or a worktree name it would not type', () => {
    expect(exitHintOf(['Resume this session with:', 'claude --resume'], 'claude')).toEqual({ id: null, row: 0 })
    expect(exitHintOf(['Resume this session with:', 'claude --resume my-title'], 'claude')).toEqual({ id: null, row: 0 })
    expect(exitHintOf(['Resume this session with:', `claude --worktree "a b;rm" --resume ${ID}`], 'claude')).toEqual({ id: null, row: 0 })
  })

  it('reads none from a head with no command under it, or one too far up', () => {
    expect(exitHintOf(['Resume this session with:'], 'claude')).toBeNull()
    expect(exitHintOf(['Resume this session with:', 'something else'], 'claude')).toBeNull()
    // The head on the screen's HINT_FROM_FOOT_ROWS-th row from the foot is the farthest up that counts.
    const far = ['Resume this session with:', `claude --resume ${ID}`, ...Array.from({ length: HINT_FROM_FOOT_ROWS - 1 }, () => '$ ')]
    expect(exitHintOf(far, 'claude')).toBeNull()
    expect(exitHintOf(far.slice(0, -1), 'claude')).toEqual({ id: ID, row: 0 })
  })

  it('takes the last of two hints, and not another agent\'s', () => {
    const rows = ['Resume this session with:', `claude --resume ${ID2}`, '$ claude', 'Resume this session with:', `claude --resume ${ID}`, '$ ']
    expect(exitHintOf(rows, 'claude')).toEqual({ id: ID, row: 3 })
    expect(exitHintOf(rows, 'codex')).toBeNull()
    expect(exitHintOf(rows, 'agy')).toBeNull()
  })
})

describe('exitHintOf: Codex', () => {
  it('reads the command on the head\'s row or the next', () => {
    expect(exitHintOf(['Token usage: 1', `To continue this session, run codex resume ${ID2}`, '$ '], 'codex')).toEqual({ id: ID2, row: 1 })
    expect(exitHintOf(['To continue this session, run:', `codex resume ${ID2}`, `Session ID: ${ID2}`], 'codex')).toEqual({ id: ID2, row: 0 })
  })

  it('takes its shutdown line alone as an exit with nothing to resume', () => {
    expect(exitHintOf(['› Shutting down...', `Session ID: ${ID2}`, 'PS C:\\w> '], 'codex')).toEqual({ id: null, row: 1 })
    expect(exitHintOf(['To continue this session, run:', 'garbled', `Session ID: ${ID2}`], 'codex')).toEqual({ id: null, row: 2 })
  })

  it('gives no id for one that is no UUID, and reads none from other screens', () => {
    expect(exitHintOf(['To continue this session, run:', 'codex resume last'], 'codex')).toEqual({ id: null, row: 0 })
    expect(exitHintOf(['To continue this session, run:'], 'codex')).toBeNull()
    expect(exitHintOf(['› hi', 'Ask Codex to do anything'], 'codex')).toBeNull()
  })
})

describe('exitHintOf: agy', () => {
  it('reads agy --conversation=<id>', () => {
    expect(exitHintOf(['Resume with -c (or command below):', `agy --conversation=${ID}`, '$ '], 'agy')).toEqual({ id: ID, row: 0 })
  })

  it('gives no id for one that is no UUID, and reads none without the command', () => {
    expect(exitHintOf(['Resume with -c (or command below):', 'agy --conversation=x'], 'agy')).toEqual({ id: null, row: 0 })
    expect(exitHintOf(['Resume with -c (or command below):', 'agy -c'], 'agy')).toBeNull()
    expect(exitHintOf([], 'agy')).toBeNull()
  })
})

describe('relaunchCommand (R8: never --continue or resume --last)', () => {
  it('Claude Code: resumes by id with the terminal\'s flags, in a worktree too', () => {
    expect(relaunchCommand({ agent: 'claude', id: ID })).toBe(`claude --resume ${ID}`)
    expect(relaunchCommand({ agent: 'claude', id: ID, model: 'opus', skipPermissions: true })).toBe(`claude --model opus --dangerously-skip-permissions --resume ${ID}`)
    expect(relaunchCommand({ agent: 'claude', id: ID, worktree: 'feat-x', model: 'sonnet' })).toBe(`claude --worktree "feat-x" --model sonnet --resume ${ID}`)
  })

  it('Claude Code: starts a new session with the id it is given, or bare', () => {
    expect(relaunchCommand({ agent: 'claude', id: null, sessionId: ID2 })).toBe(`claude --session-id ${ID2}`)
    expect(relaunchCommand({ agent: 'claude', id: null })).toBe('claude')
  })

  it('Codex: global options before resume', () => {
    expect(relaunchCommand({ agent: 'codex', id: ID2, model: 'gpt-5.6-sol', instructions: 'Use the memory tools.' }))
      .toBe(`codex -m gpt-5.6-sol -c "developer_instructions='Use the memory tools.'" resume ${ID2}`)
    expect(relaunchCommand({ agent: 'codex', id: null })).toBe('codex')
  })

  it('agy: --conversation=<id>, or a new conversation', () => {
    expect(relaunchCommand({ agent: 'agy', id: ID })).toBe(`agy --conversation=${ID}`)
    expect(relaunchCommand({ agent: 'agy', id: null })).toBe('agy')
  })

  it('throws on anything unchecked', () => {
    expect(() => relaunchCommand({ agent: 'claude', id: 'x; rm -rf ~' })).toThrow('not a session id')
    expect(() => relaunchCommand({ agent: 'codex', id: null, model: 'a b' })).toThrow('not a model name')
    expect(() => relaunchCommand({ agent: 'claude', id: ID, worktree: 'a"b' })).toThrow('not a worktree name')
    expect(() => relaunchCommand({ agent: 'claude', id: null, sessionId: 'nope' })).toThrow('not a session id')
    expect(() => relaunchCommand({ agent: 'codex', id: null, instructions: "it's" })).toThrow('not a shell-safe instruction')
  })
})

describe('what a relaunch can land on', () => {
  it('reads each CLI\'s own "no such session" words', () => {
    expect(RESUME_NOT_FOUND.claude.test(`No conversation found with session ID: ${ID}`)).toBe(true)
    expect(RESUME_NOT_FOUND.codex.test(`ERROR: No saved session found with ID ${ID2}. Run \`codex resume\` without an ID`)).toBe(true)
    expect(RESUME_NOT_FOUND.agy.test(`Conversation ${ID} not found, ignoring --conversation flag`)).toBe(true)
    expect(RESUME_NOT_FOUND.claude.test('Resume this session with:')).toBe(false)
  })

  it('reads each CLI\'s sign-in screen', () => {
    expect(SIGN_IN_SCREEN.claude.test(' Select login method:')).toBe(true)
    expect(SIGN_IN_SCREEN.claude.test('Paste code here if prompted > ')).toBe(true)
    expect(SIGN_IN_SCREEN.codex.test('  1. Sign in with ChatGPT')).toBe(true)
    expect(SIGN_IN_SCREEN.agy.test('Welcome back! You are currently not signed in.')).toBe(true)
    expect(SIGN_IN_SCREEN.agy.test('Paste the authorization code below:')).toBe(true)
    expect(SIGN_IN_SCREEN.claude.test('❯ hello')).toBe(false)
  })

  it('reads agy\'s words for a finished sign-in', () => {
    expect(AGY_SIGNED_IN.test('Authentication successful!')).toBe(true)
    expect(AGY_SIGNED_IN.test('Successfully authenticated.')).toBe(true)
    expect(AGY_SIGNED_IN.test('Signing in...')).toBe(false)
  })

  it('reads the questions only the user answers', () => {
    expect(ASKS_USER.test('WARNING: Claude Code running in Bypass Permissions mode')).toBe(true)
    expect(ASKS_USER.test('New MCP server found in .mcp.json: x')).toBe(true)
    expect(ASKS_USER.test('Do you trust the files in this folder?')).toBe(true)
    expect(ASKS_USER.test('Do you trust the contents of this directory?')).toBe(true)
    expect(ASKS_USER.test('❯ ready')).toBe(false)
  })
})

describe('changesAccountByHand (§6.1)', () => {
  it('sees an assignment or unset of a profile variable in every shell\'s syntax, and switch-now', () => {
    for (const typed of [
      "export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-b' && claude",
      'CLAUDE_CONFIG_DIR=/tmp/x claude',
      'unset CLAUDE_CONFIG_DIR && claude',
      'unset -v FOO CODEX_HOME',
      'env -u CLAUDE_CONFIG_DIR claude',
      "& { $env:CODEX_HOME = 'C:\\x'; codex }",
      '$ENV:claude_config_dir="x"',
      'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue',
      'Remove-Item -Path Env:\\GEMINI_CLI_HOME',
      'set "CLAUDE_CONFIG_DIR=C:\\x" && call claude',
      'set CODEX_HOME=C:\\y',
      'switch-now codedev',
      'cd x; switch-now',
    ]) expect(changesAccountByHand(typed), typed).toBe(true)
  })

  it('sees nothing in lines that only mention one', () => {
    for (const typed of [
      'claude --resume ' + ID,
      'echo $CLAUDE_CONFIG_DIR',
      'cd ~/.claude-codedev',
      'cat MY_CLAUDE_CONFIG_DIR_NOTES.md',
      'git commit -m "switch-nowhere"',
      'node switch-now.js',
    ]) expect(changesAccountByHand(typed), typed).toBe(false)
  })
})

describe('otherShellReported (R1: a positive mismatch only)', () => {
  it('refuses a PowerShell or cmd report in a posix terminal, and a bash one in theirs', () => {
    expect(otherShellReported('x\x1b]9;9;C:\\w\x07y', 'posix')).toBe(true)
    expect(otherShellReported('x\x1b]7;file://h/w\x07', 'powershell')).toBe(true)
    expect(otherShellReported('x\x1b]7;file://h/w\x07', 'cmd')).toBe(true)
  })

  it('passes its own family\'s reports, and no report at all', () => {
    expect(otherShellReported('\x1b]7;file://h/w\x07', 'posix')).toBe(false)
    expect(otherShellReported('\x1b]9;9;C:\\w\x07', 'powershell')).toBe(false)
    expect(otherShellReported('plain text', 'posix')).toBe(false)
    expect(otherShellReported('plain text', 'cmd')).toBe(false)
  })
})
