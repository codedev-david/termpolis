// @vitest-environment node
//
// The in-place account switch's pure parts (src/shared/accountSwitch.ts): each CLI's exit hint as
// it draws it (Claude Code 2.1.309's printResumeHint and its command builder, Codex 0.153.4's
// shutdown lines from its probe and program file, agy 1.4.3's from its program file), the commands
// that exit and resume each agent, the screens a relaunch can land on, and the typed lines that
// change a terminal's account by hand.
import { describe, it, expect } from 'vitest'
import {
  AGY_SIGNED_IN, ASKS_USER, CLEAR_BOX_KEYS, EXIT_COMMAND, HINT_FROM_FOOT_ROWS, LINE_CLEAR, RELAUNCH_HELD, RESUME_NOT_FOUND,
  SIGN_IN_SCREEN, carryForSwitch, changesAccountByHand, completesSwitchAccount, exitHintOf, isSafeModelName, isSessionId, nestedShellReported, otherShellReported,
  relaunchCommand,
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
    for (const v of ['opus', 'gpt-5.6-sol', 'claude-opus-5-5', 'a_b', 'opus[1m]']) expect(isSafeModelName(v)).toBe(true)
    for (const v of ['', 'op us', 'opus;x', '$(x)', 'a'.repeat(65), null]) expect(isSafeModelName(v)).toBe(false)
  })
})

describe('the keys and commands', () => {
  it('exits each agent with its own command, never a key', () => {
    expect(EXIT_COMMAND).toEqual({ claude: '/exit', codex: '/quit', agy: '/exit' })
  })

  it('clears a box with twenty Ctrl+U, and a shell line with the family key', () => {
    expect(CLEAR_BOX_KEYS).toBe('\u0015'.repeat(20))
    // bash, zsh and fish: the end of the line first, since Ctrl+U kills only what is left of the cursor (SW2-8).
    expect(LINE_CLEAR).toEqual({ posix: '\u0005\u0015', powershell: '\u001b', cmd: '\u001b' })
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
    expect(relaunchCommand({ agent: 'claude', id: ID, model: 'opus', extra: ['--dangerously-skip-permissions'] })).toBe(`claude --model opus --dangerously-skip-permissions --resume ${ID}`)
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
    // Claude Code 2.1.316's footer in a profile that is onboarded but signed out, as two terminals draw its dot.
    expect(SIGN_IN_SCREEN.claude.test('? for shortcuts      Not logged in · Run /login')).toBe(true)
    expect(SIGN_IN_SCREEN.claude.test('? for shortcuts      Not logged in \ufffd Run /login')).toBe(true)
    expect(SIGN_IN_SCREEN.claude.test('She was not logged in, so run /login')).toBe(false)
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
    // The one-time offer a profile never used before opens on (real Claude Code 2.1.316).
    expect(ASKS_USER.test('Try the new fullscreen renderer?  Enter to confirm / Esc to cancel')).toBe(true)
    // Claude Code 2.1.316 asks how to resume a session that is old and large (SW2-2): both of its choices, and the sentence under it.
    expect(ASKS_USER.test('❯ 1. Resume from summary (recommended)')).toBe(true)
    expect(ASKS_USER.test('  2. Resume full session as-is')).toBe(true)
    expect(ASKS_USER.test('We recommend resuming from a summary.')).toBe(false)
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

  // David's own ways of moving a terminal to another account (~/.claude/skills/switch-account.sh,
  // switch-now.sh, and the `claude-switch` alias of ~/.bashrc): the restart they do passes through no
  // line Termpolis types, so the typed line is the only sign (SW2-1).
  it('sees David\'s /switch-account, claude-switch and switch-now.sh, whoever starts them and however they are named', () => {
    for (const typed of [
      '/switch-account work',
      '/switch-account personal',
      '/switch-account codedev',
      '/switch-account status',
      '  /switch-account   work ',
      '/SWITCH-ACCOUNT work',
      '/switch-account',
      'claude-switch work',
      'claude-switch',
      'cd repo && claude-switch codedev',
      'bash ~/.claude/switch-now.sh work',
      'bash C:\\Users\\me\\.claude\\switch-now.sh codedev',
      'sh /c/Users/me/.claude/switch-now.sh',
      '~/.local/bin/switch-now work',
      'switch-now.cmd work',
      'switch-now.sh',
      '(switch-now personal)',
    ]) expect(changesAccountByHand(typed), typed).toBe(true)
  })

  // SAFETY-R3-7: the other ways an environment is changed by hand, in PowerShell, fish, csh and the rest. A profile variable named
  // as a bare word, with no sigil that says it is only read, is a change as far as the chip is concerned.
  it('sees a profile variable named as a bare word: the other ways to change an environment', () => {
    for (const typed of [
      "Set-Item Env:CLAUDE_CONFIG_DIR 'C:\\x'",
      "New-Item -Path Env:\\CODEX_HOME -Value 'C:\\x'",
      'Set-Item -Path Env:\\CLAUDE_CONFIG_DIR -Value x',
      "${env:CLAUDE_CONFIG_DIR} = 'C:\\x'",
      "${ENV:codex_home}='C:\\x'",
      "[Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'C:\\x', 'Process')",
      "[System.Environment]::SetEnvironmentVariable(\"CODEX_HOME\",\"C:\\x\")",
      'set -gx CLAUDE_CONFIG_DIR /x',
      'set -e CODEX_HOME',
      'set --erase CLAUDE_CONFIG_DIR',
      'setenv CLAUDE_CONFIG_DIR /x',
      'unsetenv GEMINI_CLI_HOME',
      'export -n CLAUDE_CONFIG_DIR',
      'declare -x CODEX_HOME=/x',
      'typeset -x CLAUDE_CONFIG_DIR=/x',
      'direnv exec . env CLAUDE_CONFIG_DIR=/x claude',
      'echo CLAUDE_CONFIG_DIR',
    ]) expect(changesAccountByHand(typed), typed).toBe(true)
  })

  it('and still not one that is only read, whatever the shell\'s syntax', () => {
    for (const typed of [
      'echo $CLAUDE_CONFIG_DIR',
      'echo "${CLAUDE_CONFIG_DIR}"',
      'echo ${CLAUDE_CONFIG_DIR:-none}',
      'echo %CLAUDE_CONFIG_DIR%',
      'echo $env:CLAUDE_CONFIG_DIR',
      'echo ${env:CODEX_HOME}',
      'cd "$CODEX_HOME/sessions"',
      'ls $GEMINI_CLI_HOME',
      'cat MY_CODEX_HOME_NOTES.md',
      'echo CODEX_HOME_X',
    ]) expect(changesAccountByHand(typed), typed).toBe(false)
  })

  it('sees a /switch-account that completion cut short (SW3-3), and no other command', () => {
    for (const typed of ['/sw', '/swi work', '/switch', '/switch-acc work', '/switch-account', '  /SWITCH-ACC  ']) expect(completesSwitchAccount(typed), typed).toBe(true)
    for (const typed of ['/s', '/st', '/status', '/model', '/switcher', '/switch-accounts', 'switch', '', 'claude /sw']) expect(completesSwitchAccount(typed), typed).toBe(false)
  })

  it('sees nothing in lines that only look like them', () => {
    for (const typed of [
      '/switch-accounts',
      '/switch-account-notes',
      'cat /docs/switch-account.md',
      'cat claude-switch.md',
      'ls claude-switches',
      'cat my-switch-now.txt',
      'node switch-now.js',
      'echo claude-switching',
      'switch-nowhere',
    ]) expect(changesAccountByHand(typed), typed).toBe(false)
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

describe('nestedShellReported: another family heard from, and the own one silent', () => {
  it('is a shell of another kind when only its family reported', () => {
    expect(nestedShellReported('x\x1b]9;9;C:\\w\x07y', 'posix')).toBe(true)
    expect(nestedShellReported('x\x1b]7;file://h/w\x07', 'powershell')).toBe(true)
    expect(nestedShellReported('x\x1b]7;file://h/w\x07', 'cmd')).toBe(true)
  })

  it('is none when the own family reported too: a prompt that writes both (oh-my-posh in Git Bash, OSC 7 from PowerShell)', () => {
    expect(nestedShellReported('\x1b]7;file://h/w\x07\x1b]9;9;C:\\w\x07', 'posix')).toBe(false)
    expect(nestedShellReported('\x1b]9;9;C:\\w\x07\x1b]7;file://h/w\x07', 'powershell')).toBe(false)
    expect(nestedShellReported('\x1b]9;9;C:\\w\x07\x1b]7;file://h/w\x07', 'cmd')).toBe(false)
  })

  it('reads a family that was heard before and has gone silent as nested, and one never heard as no sign of it (SWITCH-R1 F2)', () => {
    const own = '\x1b]7;file://h/w\x07'
    const other = '\x1b]9;9;C:\\w\x07'
    // A shell that wrote its own family's report before, and now only the other's: another shell took its place.
    expect(nestedShellReported(other, 'posix', `${own}me@host $ claude`)).toBe(true)
    // One that never wrote its own (oh-my-posh in Git Bash writes only OSC 9;9) is not shown nested by writing the other's.
    expect(nestedShellReported(other, 'posix', `${other}me@host $ claude`)).toBe(false)
    expect(nestedShellReported(other, 'posix', '')).toBe(false)
    // With no earlier output given, as before: the clear case refuses.
    expect(nestedShellReported(other, 'posix')).toBe(true)
    // Or the fact itself, kept by main after the report left its window (SW2-10): the own family did, or never did.
    expect(nestedShellReported(other, 'posix', true)).toBe(true)
    expect(nestedShellReported(other, 'posix', false)).toBe(false)
    expect(nestedShellReported('\x1b]7;file://h/w\x07', 'powershell', true)).toBe(true)
    expect(nestedShellReported(own, 'posix', true)).toBe(false)
    // The own family heard now settles it, whatever came before.
    expect(nestedShellReported(`${own}${other}`, 'posix', own)).toBe(false)
  })

  it('is none when nothing reported, or only the own family did', () => {
    expect(nestedShellReported('plain text', 'posix')).toBe(false)
    expect(nestedShellReported('\x1b]7;file://h/w\x07', 'posix')).toBe(false)
    expect(nestedShellReported('\x1b]9;9;C:\\w\x07', 'powershell')).toBe(false)
  })
})

describe('relaunchCommand: the flags a relaunch keeps', () => {
  it("puts a Codex worker's other flags after its model, and agy's model before its conversation", () => {
    expect(relaunchCommand({ agent: 'codex', id: ID2, model: 'gpt-5.6-sol', extra: ['-a', 'never', '-s', 'workspace-write'] }))
      .toBe(`codex -m gpt-5.6-sol -a never -s workspace-write resume ${ID2}`)
    expect(relaunchCommand({ agent: 'agy', id: ID, model: 'gemini-4-argon', extra: ['--mode', 'plan'] })).toBe(`agy --model gemini-4-argon --mode plan --conversation=${ID}`)
    expect(relaunchCommand({ agent: 'codex', id: null, extra: ['-c', 'check_for_update_on_startup=false'], instructions: 'Use the memory tools.' }))
      .toBe(`codex -c check_for_update_on_startup=false -c "developer_instructions='Use the memory tools.'"`)
  })

  it('types only words it can repeat faithfully', () => {
    for (const extra of [['a b'], ['x;y'], ['$(x)'], ['"q"'], ['a|b'], ['{']]) {
      expect(() => relaunchCommand({ agent: 'claude', id: null, extra }), extra.join()).toThrow('not a flag a relaunch can repeat')
    }
    expect(relaunchCommand({ agent: 'claude', id: null, model: 'opus[1m]', extra: ['--add-dir', '../lib'] })).toBe('claude --model opus[1m] --add-dir ../lib')
  })
})


describe('carryForSwitch never carries another agent\'s model or flags (MODELS-R1-5)', () => {
  it('a Claude Code line for a Codex or agy switch, and a Codex line for a Claude Code one, carries nothing', () => {
    expect(carryForSwitch('codex', 'claude --model opus --dangerously-skip-permissions')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'codex -m gpt-5.6-sol -s read-only')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('agy', 'claude --model opus')).toEqual({ ok: true, extra: [] })
  })

  it('control: the same agent still carries its model and flags', () => {
    expect(carryForSwitch('claude', 'claude --model opus --dangerously-skip-permissions')).toEqual({ ok: true, model: 'opus', extra: ['--dangerously-skip-permissions'] })
  })
})

describe('carryForSwitch: an agent typed with its path or its extension (MODELS-R1-1, SWITCH-R1 G3)', () => {
  // The chip and the switch work for a terminal whose agent was started as claude.exe or by its path, so
  // what that line carried must come back, the restrictions included.
  it.each([
    ['claude.exe --dangerously-skip-permissions --model opus --session-id 6b0f3c2a-9d14-4e27-8a31-2f5c7d9e1b44', { ok: true, model: 'opus', extra: ['--dangerously-skip-permissions'] }, 'claude'],
    ['C:\\tools\\claude.exe --disallowedTools Bash', { ok: true, extra: ['--disallowedTools', 'Bash'] }, 'claude'],
    ['/usr/local/bin/claude --permission-mode plan', { ok: true, extra: ['--permission-mode', 'plan'] }, 'claude'],
    ['claude.cmd --verbose', { ok: true, extra: ['--verbose'] }, 'claude'],
    ['codex.exe -m gpt-5.6-sol -s read-only', { ok: true, model: 'gpt-5.6-sol', extra: ['-s', 'read-only'] }, 'codex'],
    ['cd proj && C:\\tools\\codex.CMD -a never', { ok: true, extra: ['-a', 'never'] }, 'codex'],
    ["export CLAUDE_CONFIG_DIR='/h/.claude-b' && /opt/claude/bin/claude --verbose", { ok: true, extra: ['--verbose'] }, 'claude'],
  ] as const)('%s', (line, expected, agent) => {
    expect(carryForSwitch(agent, line)).toEqual(expected)
  })

  it('keeps the restrictions of a Codex started by path, and refuses what it cannot repeat there too', () => {
    expect(carryForSwitch('codex', '/usr/bin/codex -s read-only -a never').ok).toBe(true)
    expect(carryForSwitch('claude', 'C:\\tools\\claude.exe "do the thing"').ok).toBe(false)
  })

  it('reads a word that only ends like an agent as none', () => {
    expect(carryForSwitch('claude', 'myclaude --verbose')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'claude-code --verbose')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'echo /usr/bin/claude-notes')).toEqual({ ok: true, extra: [] })
  })
})
describe('carryForSwitch: what a switch repeats of the line the agent was started with', () => {
  it("carries Claude Code's model in any spelling, and its other flags word for word", () => {
    expect(carryForSwitch('claude', 'claude --model opus --dangerously-skip-permissions')).toEqual({ ok: true, model: 'opus', extra: ['--dangerously-skip-permissions'] })
    expect(carryForSwitch('claude', 'claude --model=opus[1m] --permission-mode plan --effort max')).toEqual({ ok: true, model: 'opus[1m]', extra: ['--permission-mode', 'plan', '--effort', 'max'] })
    expect(carryForSwitch('claude', "claude --model 'sonnet'")).toEqual({ ok: true, model: 'sonnet', extra: [] })
    expect(carryForSwitch('claude', 'claude --disallowedTools Bash --add-dir ../lib')).toEqual({ ok: true, extra: ['--disallowedTools', 'Bash', '--add-dir', '../lib'] })
  })

  it('leaves out the conversation, which the switch names itself, and what Termpolis added to the line', () => {
    expect(carryForSwitch('claude', `claude --session-id ${ID}`)).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', `claude --resume ${ID} --model opus`)).toEqual({ ok: true, model: 'opus', extra: [] })
    expect(carryForSwitch('claude', 'claude --model opus --append-system-prompt-file "C:/p.txt" --dangerously-skip-permissions'))
      .toEqual({ ok: true, model: 'opus', extra: ['--dangerously-skip-permissions'] })
    expect(carryForSwitch('claude', "claude --append-system-prompt-file='/p x.txt' --verbose")).toEqual({ ok: true, extra: ['--verbose'] })
    expect(carryForSwitch('codex', `codex -a never -c "developer_instructions='Use the memory tools.'"`)).toEqual({ ok: true, extra: ['-a', 'never'] })
    expect(carryForSwitch('codex', "codex -c 'developer_instructions=Use it' --full-auto")).toEqual({ ok: true, extra: ['--full-auto'] })
  })

  it("reads the agent's command out of the account line Termpolis typed, in every shell", () => {
    const cmd = 'claude --dangerously-skip-permissions --resume ' + ID
    const expected = { ok: true, extra: ['--dangerously-skip-permissions'] }
    expect(carryForSwitch('claude', `export CLAUDE_CONFIG_DIR='/h/.claude-b' && unset ANTHROPIC_BASE_URL && ${cmd}`)).toEqual(expected)
    expect(carryForSwitch('claude', `& { $env:CLAUDE_CONFIG_DIR = 'C:\\h\\.claude-b'; ${cmd} }`)).toEqual(expected)
    expect(carryForSwitch('claude', `set "CLAUDE_CONFIG_DIR=C:\\h\\.claude-b" && call ${cmd}`)).toEqual(expected)
    expect(carryForSwitch('claude', `cd repo && ${cmd}`)).toEqual(expected)
  })

  it("carries Codex's model, approval, sandbox and update check in their short and long forms", () => {
    expect(carryForSwitch('codex', 'codex -m gpt-5.6-sol -a never -s workspace-write')).toEqual({ ok: true, model: 'gpt-5.6-sol', extra: ['-a', 'never', '-s', 'workspace-write'] })
    expect(carryForSwitch('codex', 'codex --model x1 --ask-for-approval on-request --sandbox read-only')).toEqual({ ok: true, model: 'x1', extra: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'] })
    expect(carryForSwitch('codex', 'codex -a never -s workspace-write -c check_for_update_on_startup=false'))
      .toEqual({ ok: true, extra: ['-a', 'never', '-s', 'workspace-write', '-c', 'check_for_update_on_startup=false'] })
    expect(carryForSwitch('codex', 'codex -mgpt-5.6-sol --search -c model_reasoning_effort=high')).toEqual({ ok: true, model: 'gpt-5.6-sol', extra: ['--search', '-c', 'model_reasoning_effort=high'] })
    expect(carryForSwitch('codex', `codex resume ${ID2} --last`)).toEqual({ ok: true, extra: [] })
  })

  it("carries agy's model and other options", () => {
    expect(carryForSwitch('agy', 'agy --model gemini-4-argon')).toEqual({ ok: true, model: 'gemini-4-argon', extra: [] })
    expect(carryForSwitch('agy', 'agy --model gemini-4-argon --dangerously-skip-permissions --add-dir ../x')).toEqual({ ok: true, model: 'gemini-4-argon', extra: ['--dangerously-skip-permissions', '--add-dir', '../x'] })
    expect(carryForSwitch('agy', `agy --conversation=${ID}`)).toEqual({ ok: true, extra: [] })
  })

  it('leaves out a worktree, which the exit hint names, and says which it left out (MODELS-R2-3)', () => {
    expect(carryForSwitch('claude', 'claude --worktree feat-x --verbose')).toEqual({ ok: true, extra: ['--verbose'], worktree: 'feat-x' })
    // `-w` with no name asks Claude Code for a generated one: there is none to name.
    expect(carryForSwitch('claude', 'claude -w --verbose')).toEqual({ ok: true, extra: ['--verbose'] })
    expect(carryForSwitch('claude', 'claude --worktree=feat-x --verbose')).toEqual({ ok: true, extra: ['--verbose'], worktree: 'feat-x' })
    expect(carryForSwitch('claude', 'claude -w feat-y --model opus')).toEqual({ ok: true, model: 'opus', extra: [], worktree: 'feat-y' })
    // A name it could not type back safely is not offered as one to say, though the line is repeated as it was (a slash is no
    // character of a worktree name Termpolis types; the exit hint's own `--worktree "<name>"` is the one that names it).
    expect(carryForSwitch('claude', 'claude --worktree feat/x --verbose')).toEqual({ ok: true, extra: ['--verbose'] })
    expect(carryForSwitch('claude', 'claude --worktree=feat/x')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'claude --worktree=a;b')).toMatchObject({ ok: false })
  })

  it("has nothing to repeat when nothing was recorded, or the line is another agent's", () => {
    expect(carryForSwitch('claude', undefined)).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', '')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'ls -la')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'codex -a never')).toEqual({ ok: true, extra: [] })
  })

  it('refuses a line it cannot repeat faithfully, before anything is typed: a prompt, a quote, an operator, a flag with several values, an odd model name', () => {
    const refused = (agent: 'claude' | 'codex' | 'agy', line: string): string => {
      const r = carryForSwitch(agent, line)
      expect(r.ok, line).toBe(false)
      return (r as { why: string }).why
    }
    expect(refused('claude', 'claude "fix the bug"'))
      .toBe('Claude Code was started with options it cannot repeat (a prompt, a quote, an operator, or a flag with several values), which switching in place would not repeat faithfully, so it would come back without it')
    expect(refused('claude', 'claude --dangerously-skip-permissions /review')).toMatch(/^Claude Code was started with options/)
    expect(refused('claude', 'claude --disallowedTools Bash Edit')).toMatch(/^Claude Code was started with options/)
    expect(refused('claude', 'claude --add-dir "my dir"')).toMatch(/options/)
    expect(refused('claude', 'claude --verbose; rm x')).toMatch(/options/)
    expect(refused('codex', 'codex -m "a b" -a NEVER -s')).toMatch(/^Codex was started with/)
    expect(refused('agy', 'agy -- prompt')).toMatch(/^agy was started with/)
    expect(refused('claude', 'claude --model "op;us"')).toMatch(/a model name Termpolis cannot repeat/)
    expect(refused('claude', 'claude --model a' + 'b'.repeat(70))).toMatch(/a model name Termpolis cannot repeat/)
  })

  it('has no model for a flag with no value, and refuses a command it cannot take apart', () => {
    expect(carryForSwitch('claude', 'claude --model')).toEqual({ ok: true, extra: [] })
    expect(carryForSwitch('claude', 'claude --model=')).toEqual({ ok: true, extra: [] })
    // An unclosed quote is not repeated, so it is refused.
    expect(carryForSwitch('claude', 'claude --model "opus').ok).toBe(false)
  })
})

describe('RELAUNCH_HELD: what the conductor and the phone are told while a relaunch holds a terminal', () => {
  it('says which relaunch, and to wait for system\'s next message', () => {
    expect(RELAUNCH_HELD).toEqual({
      account: 'Termpolis is switching this agent\'s account; try again in a few seconds',
      model: 'Termpolis is changing this agent\'s model; try again in a few seconds',
      worker: 'Termpolis is restarting this worker; wait for system\'s next message',
    })
  })
})
