// A scripted terminal for the account switch's tests (accountSwitch.ts, agySwitch.ts): a shell and
// the agent running in it, each drawn as it draws itself. The agent's screen is a ConPTY-style
// frame (the screen cleared, each row at its place); the shell's output is lines added to it, with
// the prompt report each Termpolis shell writes (OSC 7 from bash, OSC 9;9 from PowerShell and cmd),
// or none, as David's Git Bash. It answers what the switch types the way each program would, and
// keeps what reached whom: what the shell ran, what went to the agent as a prompt, and whether a
// Ctrl+D closed the shell.
import type { SwitchIO } from '../../src/main/accountSwitch'
import { MAX_TERMINAL_BUFFER_CHARS } from '../../src/main/terminalOutputBuffer'
import { screenOf } from '../../src/shared/terminalScreen'

const E = '\x1b'
export const RULE = '─'.repeat(80)
export const ID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
export const ID2 = '01a1664b-6312-7121-97f6-88c7f6793c64'

export type Family = 'posix' | 'powershell' | 'cmd'
export type Agent = 'claude' | 'codex' | 'agy'

/** How the agent stands on screen when the switch starts. */
export type Start = 'idle' | 'busy' | 'menu' | 'waiting' | 'typed' | 'question' | 'gone-hint' | 'gone-quiet' | 'blank'

/** What the shell's run of the relaunch line shows. */
export type Relaunch = 'box' | 'not-found' | 'sign-in' | 'asks' | 'nothing' | 'loading-then-not-found' | 'box-then-not-found' | 'flicker-then-not-found' | 'sandbox-menu' | 'resume-size'

export interface TermScript {
  agent: Agent
  family: Family
  /** The shell reports its prompts. Default true. */
  reports?: boolean
  start: Start
  /** What the agent does with its exit command: exits with its hint, exits with none, ignores it,
   *  or never shows what is typed into its box. */
  exit?: 'hint' | 'no-hint' | 'ignore' | 'no-echo'
  /** Codex's hint as two rows ("…run:" then the command) or one. */
  codexHint?: 'two-rows' | 'one-row' | 'session-only'
  /** The session its hint names. */
  id?: string
  /** Claude Code's hint in a worktree. */
  worktree?: string
  /** The flags Claude Code 2.1.317 prints between `claude` and `--resume` in its hint: the ones the session was started with
   *  (`--effort max` from David's wrapper, `--model sonnet`, `--dangerously-skip-permissions`; SW3-1). */
  hintFlags?: string
  /** What each relaunch shows, in turn; the last one repeats. */
  relaunch?: Relaunch[]
  /** Codex 0.164 draws a status line between its composer's blank row and its hint row, as the real one
   *  does once it has settled (SWITCH-R1 C1); 0.153 and the default draw the hint row alone. */
  codexStatus?: boolean
  /** With the relaunch 'loading-then-not-found' (Codex draws its composer under "Resuming session…") or
   *  'box-then-not-found' (its composer alone): the CLI prints that the session isn't there only this
   *  long after the Enter (the real 0.164 took 2.3 s, 0.3 s after its composer showed). Default 2300. */
  resumeErrorMs?: number
  /** Claude Code draws its "No conversation found" line with a cursor-forward for every space, as the real
   *  2.1.316 does (SWITCH-R1 N1), and so no space is in the bytes; 'absolute': each word at its column
   *  (a cursor-horizontal-absolute), which only the rendered screen reads as words. */
  cursorForward?: boolean | 'absolute'
  /** Rows of the resumed conversation, drawn above the agent's box after a relaunch: the history a real
   *  CLI shows, which can hold the CLI's own error words (SWITCH-R1 H). */
  history?: string[]
  /** The row under Claude Code's or agy's box, instead of its usual footer (Claude Code 2.1.316 draws
   *  "Not logged in · Run /login" there in a profile that is signed out). */
  footer?: string
  /** A prompt entered in the agent's box starts a turn (its spinner shows), as it does for the real CLIs. */
  busyAfterPrompt?: boolean
  /** The shell starts reading keys only this long after the agent's process is gone (a prompt that is drawn late). */
  shellLateMs?: number
  /** The pane's size. Default 80 x 24. */
  cols?: number
  rows?: number
  /** A busy turn stops on Esc. */
  escStops?: boolean
  /** A menu or a wait closes on Esc. Default true. */
  escCloses?: boolean
  /** The box's text stays after Ctrl+U (a hint the agent keeps). */
  clearFails?: boolean
  /** The shell never echoes what is typed at it (the process is gone). */
  shellDead?: boolean
  /** A shell of another family reports at the exit (one started inside it). */
  nestedReport?: Family
  /** The shell's prompt writes only this family's report and never its own (oh-my-posh's pwd=osc99 in
   *  Git Bash writes only OSC 9;9): no shell of another kind is nested. */
  reportsOnly?: Family
  /** The shell's own prompt also writes the other family's report (oh-my-posh's pwd=osc99 in Git Bash, a
   *  PowerShell prompt that writes OSC 7), beside its own: no shell of another kind is nested. */
  alsoReports?: Family
  /** The shell stops echoing after this many relaunches. */
  deadAfterRelaunches?: number
  /** The agent's last answer quotes its own exit hint, above its box. */
  quoteHint?: boolean
  /** agy: what /logout shows: its sign-in screen (the default), or its box again. */
  logout?: 'screen' | 'box'
  /** agy: the Google account its header shows. */
  email?: string
  /** agy, started bare: draws neither its box nor its sign-in (it hangs). */
  agyHangs?: boolean
  /** macOS and Linux: the PTY's foreground process can be read (isShellInForeground), and is the
   *  shell once the agent exited. Otherwise the switch has no such read, as on Windows. */
  foreground?: boolean
  /** What the agent printed as it exited reaches the output this long after it is gone. */
  exitOutputLateMs?: number
  /** The line that started the agent, when not the one a launch types: a swarm worker's, as
   *  run_command typed it. */
  launch?: string
  /** The agent's process outlives its goodbye by this long (Claude Code took 4 to 11 s to hand the
   *  terminal back on a machine with SessionEnd hooks): its exit hint shows at once, its shell's
   *  prompt only when the process is gone, and keys typed to the terminal meanwhile are lost, the
   *  shell not reading yet. An agent gone at the start (gone-*) is still going this long. */
  teardownMs?: number
  /** With `teardownMs`, the hint is printed only when the process is gone (after the hooks). */
  hintAfterTeardown?: boolean
  /** What the OS says about the terminal (shellAlone.ts): `tells` (true once only the shell is
   *  left), `blind` (it cannot tell), `flaky` (cannot tell once in a while). Absent: the switch has
   *  no such read. */
  os?: 'tells' | 'blind' | 'flaky'
  /** The shell reads what is typed this slowly, a character at a time, and draws what it has read
   *  only once its input is empty: Git Bash on a ConPTY took 39 ms a character on David's laptop
   *  when it was idle and over 100 ms when it was busy (measured with a real one), so a
   *  140-character account line shows after 5.5 s and more. PowerShell took 5 ms a character, cmd
   *  none. */
  shellCharMs?: number
  /** With `shellCharMs`: the shell stops reading after this many characters, and draws nothing of
   *  what it read since. */
  shellStallsAfter?: number
  /** How the switch reads the terminal. Default: the whole output, as a test's. 'window': only the last 32 KB
   *  main retains per terminal (terminalOutputBuffer.ts); 'kept': that window and the screen main keeps live
   *  for a terminal an agent runs in, which is what index.ts hands the switch (F-R2-2). */
  main?: 'window' | 'kept'
  /** The agent has worked this many characters before the switch starts. Claude Code 2.1.316 paints its
   *  box once, on its first frame, and every redraw after it changes only the rows that differ, so a replay
   *  of the last 32 KB holds no box after a minute of work. */
  worked?: number
}

/** The conversation id a later exit of agy names: a new, empty one, never the first. */
export const THROWAWAY = '7d7d7d7d-0000-4000-8000-000000000000'

const BOX_FOOTER: Record<Agent, string> = {
  claude: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  codex: '  gpt-5.6-sol medium · ~/repo',
  agy: '? for shortcuts                                          Gemini 4 Argon · medium',
}

export class FakeTerminal {
  out = ''
  clock = 0
  writes: string[] = []
  /** What the agent's box took as a prompt: anything entered in it but its exit command. */
  sentPrompts: string[] = []
  /** What the shell ran. */
  ran: string[] = []
  /** A Ctrl+D reached an empty bash line: the terminal would have closed. */
  closed = false
  mode: 'agent' | 'shell'
  /** The agent's screen now: 'idle' with the box, or one of the states that hold it. */
  agentState: Start | 'sign-in' | 'asks' | 'loading' | 'sandbox' | 'resume-size'
  box = ''
  line = ''
  relaunches = 0
  /** agy: signed out, by /logout, until the user signs in (completeSignIn). */
  signedOut = false
  /** How many times the agent exited. */
  exits = 0
  /** When the agent's process is gone (the clock), and how often the OS was asked. */
  goneAt = 0
  osAsked = 0
  /** The clock at each write, in step with writes. */
  writeClocks: number[] = []
  /** Output on its way (exitOutputLateMs): it reaches `out` once the clock passes `at`. */
  late: { at: number; text: string; mode?: 'agent' | 'shell' } | null = null
  /** Redraws of the agent's screen on their way (the 'flicker' relaunch): at `at`, it shows `state`. */
  redraws: Array<{ at: number; state: 'idle' | 'loading' }> = []
  /** shellCharMs: what the shell has read of the typed line and not drawn yet, and when it will
   *  have read it all. */
  slowEcho: { at: number; text: string } | null = null
  shellFreeAt = 0
  /** How many characters the slow shell has been given. */
  read = 0
  /** The account agy's header shows. */
  email: string
  /** The rows last drawn once the agent paints in place ('worked'): a redraw sends the ones that changed. */
  private drawnRows: string[] | null = null
  constructor(public s: TermScript) {
    this.email = s.email ?? 'home.user@example.test'
    this.mode = s.start === 'gone-hint' || s.start === 'gone-quiet' ? 'shell' : 'agent'
    this.agentState = s.start
    this.out = this.prompt() + this.launchLine() + '\r\n'
    this.launchedAt = this.prompt().length
    if (this.mode === 'shell') this.goneAt = s.teardownMs ?? 0
    if (s.start === 'gone-hint' || s.start === 'gone-quiet') {
      this.out += this.frame()
      this.agentState = 'idle'
      this.out += s.start === 'gone-hint' ? this.hint() : '\r\n'
      this.out += this.prompt()
    } else if (s.start !== 'blank') {
      this.out += this.frame()
      if (s.worked) {
        this.drawnRows = this.rows()
        this.out += this.work(s.worked)
      }
    } else this.out += 'loading…'
  }

  /** At least `chars` characters of a turn at work, in place: a spinner row updated, and cleared at the end. */
  private work(chars: number): string {
    let out = ''
    for (let n = 1; out.length < chars; n++) out += `${E}[2;1H${E}[38;2;255;107;128m✻${E}[1CThinking…${E}[1C(${n}s${E}[1C·${E}[1Ctokens${E}[1C${n * 37})${E}[K`
    return out + `${E}[2;1H${E}[K`
  }

  /** Where the launch line was typed, and the line: what main records as the agent's start. */
  launchedAt: number

  launchLine(): string {
    return this.s.launch ?? { claude: `claude --model opus --session-id ${ID}`, codex: 'codex -m gpt-5.6-sol', agy: 'agy' }[this.s.agent]
  }

  prompt(asked?: Family): string {
    // A shell started inside the terminal's own answers every prompt after the agent's exit, not only the first.
    const family = asked ?? (this.s.nestedReport && this.mode === 'shell' ? this.s.nestedReport : this.s.family)
    const only = this.s.reportsOnly && !asked && family === this.s.family ? this.s.reportsOnly : undefined
    const reports = this.s.reports !== false && !only
    // A prompt that also writes the other family's report: Windows Terminal's cwd marker from a bash prompt, OSC 7 from PowerShell's.
    const alsoFamily = only ?? (reports && this.s.alsoReports && !asked && family === this.s.family ? this.s.alsoReports : undefined)
    const also = alsoFamily ? (alsoFamily === 'posix' ? `${E}]7;file://host/c/repo\x07` : `${E}]9;9;C:\\repo\x07`) : ''
    if (family === 'posix') return `${reports ? `${E}]7;file://host/c/repo\x07` : ''}${also}me@host MINGW64 /c/repo\r\n$ `
    if (family === 'powershell') return `${reports ? `${E}]9;9;C:\\repo\x07` : ''}${also}PS C:\\repo> `
    return `${reports ? `${E}]9;9;C:\\repo\x07` : ''}${also}C:\\repo>`
  }

  private rows(): string[] {
    const a = this.s.agent
    const st = this.agentState
    if (st === 'sign-in') return a === 'codex' ? ['  Sign in with ChatGPT to use Codex', '', '› 1. Sign in with ChatGPT', '  2. Provide your own API key', '', '  Press enter to continue'] : ['  Select login method:', '', '  ❯ 1. Claude account with subscription', '    2. Anthropic Console account', '', '  Enter to confirm · Esc to cancel']
    if (st === 'sign-in' && a === 'agy') return ['Welcome back! You are currently not signed in.', '', 'Select login method:', '', '> Continue with Google', '  Other sign-in options', '', '↑/↓ Navigate · enter Confirm']
    // Claude Code 2.1.316's dialog for a resumed session that is old and large ("Resume from summary (recommended)"), as it draws it.
    if (st === 'resume-size') return ['  This session is 12 days old and 91.2k tokens.', '', '  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.', '', '  ❯ 1. Resume from summary (recommended)', '    2. Resume full session as-is', "    3. Don't ask me again", '', '  Enter to confirm · Esc to cancel']
    if (st === 'asks') return ['  WARNING: Claude Code running in Bypass Permissions mode', '', '  ❯ 1. No, exit', '    2. Yes, I accept', '', '  Enter to confirm · Esc to cancel']
    // Claude Code's permission dialog and its rate-limit menu, laid out as the real captures show
    // them (tests/fixtures/agentScreensInput.json rateLimitMenu): under a rule, the box gone.
    if (st === 'question') return ['● I will edit the file.', '', RULE, ' Edit file', ' app.ts', ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No, and tell Claude what to do differently (esc)', '']
    if (st === 'menu') {
      if (a === 'codex') return ['  Approaching rate limits', '  Switch to gpt-5.6-luna for lower credit usage?', '', '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.', '  2. Keep current model', '', '  Press enter to confirm or esc to go back']
      return ['❯ hi', '  ⎿ \u00a0You\'ve hit your session limit · resets 3pm (America/New_York)', '', '❯ /rate-limit-options', '', RULE, '  What do you want to do?', '', '  ❯ 1. Stop and wait for limit to reset', '    2. Add funds to continue with usage credits', '', '  Enter to confirm · Esc to cancel']
    }
    // Codex's Windows set-up question on a home it never ran in, as the real 0.164 drew it before its keys row.
    if (st === 'sandbox') return ['  >_ OpenAI Codex (v0.164.0)', '     ~\\repo', '  Set up the Codex agent sandbox to protect your files and control network access. Learn more', '  <https://developers.openai.com/codex/windows>', '› 1. Set up default sandbox (requires Administrator permissions)', '  2. Use non-admin sandbox (higher risk if prompt injected)', '  3. Quit', '', '  enter select · esc back']
    if (st === 'loading') return ['  >_ OpenAI Codex (v0.164.0)', '     ~\\repo', '  Resuming session…', '› Ask Codex to do anything']
    // What a resumed conversation drew above its box (its history, which can end at the CLI's own error).
    const history = this.relaunches > 0 && this.s.history ? [...this.s.history, ''] : null
    const above = st === 'busy'
      ? [...(history ?? []), ...(a === 'codex' ? ['• Working (12s • esc to interrupt)', ''] : a === 'agy' ? ['⡿ Generating... (esc to cancel)', ''] : ['✻ Thinking… (2s · esc to interrupt)', ''])]
      : st === 'waiting' ? ['✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', '']
      : history ?? (this.s.quoteHint ? ['● When it exits it prints:', '', 'Resume this session with:', `claude --resume ${this.s.id ?? ID}`, ''] : ['● Done.', ''])
    if (a === 'codex') {
      const composer = `› ${this.box || 'Ask Codex to do anything'}`
      const popup = this.box.startsWith('/') ? ['  /quit   exit Codex'] : []
      // 0.164 settled: the status line, then the hint row with a warning on its right. Before: the hint row alone.
      const footer = this.s.codexStatus ? [BOX_FOOTER.codex, `  ? for shortcuts${' '.repeat(38)}⚠ 1 warning · f2 to view`] : [BOX_FOOTER.codex]
      return ['• Ready.', '', ...above, composer, ...popup, '', ...footer]
    }
    const glyph = a === 'claude' ? '❯' : '>'
    const header = a === 'agy' ? ['      ▄▀▀▄        Antigravity CLI 1.4.3', `     ▀▀▀▀▀▀       ${this.email} (Google AI Pro)`, ''] : []
    // A rule is as wide as the pane (a narrow one would wrap an 80-column rule into rows of its own).
    const rule = this.s.cols ? '─'.repeat(this.s.cols) : RULE
    return [...header, ...above, rule, `${glyph} ${this.box}`, rule, this.s.footer ?? BOX_FOOTER[a]]
  }

  /** Claude Code's "No conversation found" line, drawn as the script says. */
  private notFoundLine(id: string): string {
    const words = ['No', 'conversation', 'found', 'with', 'session', 'ID:', id]
    if (this.s.cursorForward === 'absolute') {
      let col = 1
      return words.map((w) => { const at = col; col += w.length + 1; return `${E}[${at}G${w}` }).join('')
    }
    return this.s.cursorForward ? words.join(`${E}[1C`) : words.join(' ')
  }

  /** The agent's screen, as ConPTY paints it: cleared, then each row at its place. */
  frame(): string {
    return `${E}[H${E}[2J` + this.rows().map((r, i) => `${E}[${i + 1};1H${r}`).join('')
  }

  hint(): string {
    const id = this.exits > 1 ? THROWAWAY : this.s.id ?? ID
    if (this.s.agent === 'claude') {
      const flags = this.s.hintFlags ? ` ${this.s.hintFlags}` : ''
      const cmd = this.s.worktree ? `claude --worktree "${this.s.worktree}"${flags} --resume ${id}` : `claude${flags} --resume ${id}`
      return `\r\n${E}[2m\r\nResume this session with:\r\n${cmd}\r\n${E}[22m`
    }
    if (this.s.agent === 'codex') {
      if (this.s.codexHint === 'session-only') return `\r\n› Shutting down...\r\nSession ID: ${id}\r\n`
      if (this.s.codexHint === 'one-row') return `\r\nTo continue this session, run codex resume ${id}\r\n`
      return `\r\nTo continue this session, run:\r\ncodex resume ${id}\r\n`
    }
    return `\r\nResume with -c (or command below):\r\nagy --conversation=${id}\r\n`
  }

  private redraw(): void {
    if (!this.drawnRows) {
      this.out += this.frame()
      return
    }
    // Painted in place: only the rows that differ are sent, each at its place.
    const rows = this.rows()
    for (let i = 0; i < Math.max(rows.length, this.drawnRows.length); i++) {
      if (rows[i] !== this.drawnRows[i]) this.out += `${E}[${i + 1};1H${E}[2K${rows[i] ?? ''}`
    }
    // The cursor is parked after the last row, where a whole frame leaves it: what the agent prints as it
    // exits goes under its box.
    this.out += `${E}[${rows.length};${rows[rows.length - 1].length + 1}H`
    this.drawnRows = rows
  }

  private exitAgent(): void {
    this.exits++
    this.mode = 'shell'
    // The next agent paints a whole frame of its own.
    this.drawnRows = null
    const hint = this.s.exit === 'no-hint' ? '\r\n' : this.hint()
    const prompt = this.prompt()
    if (this.s.teardownMs) {
      this.goneAt = this.clock + this.s.teardownMs
      if (this.s.hintAfterTeardown) this.late = { at: this.goneAt, text: hint + prompt }
      else {
        this.out += hint
        this.late = { at: this.goneAt, text: prompt }
      }
      return
    }
    const said = hint + prompt
    if (this.s.exitOutputLateMs) this.late = { at: this.clock + this.s.exitOutputLateMs, text: said }
    else this.out += said
  }

  private runLine(line: string): void {
    this.ran.push(line)
    if (!line.trim()) {
      this.out += this.prompt()
      return
    }
    if (!/\b(claude|codex|agy)\b/.test(line)) {
      this.out += `bash: ${line.split(' ')[0]}: command not found\r\n${this.prompt()}`
      return
    }
    if (line === 'agy') {
      // A new agy, as the guided switch starts one to sign out: its sign-in screen when signed out.
      if (this.s.agyHangs) return
      this.mode = 'agent'
      this.box = ''
      this.agentState = this.signedOut ? 'sign-in' : 'idle'
      this.redraw()
      return
    }
    const list = this.s.relaunch ?? ['box']
    const what = list[Math.min(this.relaunches, list.length - 1)]
    this.relaunches++
    if (this.s.deadAfterRelaunches !== undefined && this.relaunches >= this.s.deadAfterRelaunches) this.s.shellDead = true
    const id = this.s.id ?? ID
    if (what === 'nothing') return
    if (what === 'loading-then-not-found' || what === 'box-then-not-found' || what === 'flicker-then-not-found') {
      // The composer is up at once (under "Resuming session…", or alone); the CLI finds the session isn't there later.
      this.mode = 'agent'
      this.box = ''
      this.agentState = what === 'loading-then-not-found' ? 'loading' : 'idle'
      this.redraw()
      // 'flicker': the loading row comes and goes while it looks (1 s in, gone again at 3 s).
      if (what === 'flicker-then-not-found') this.redraws = [{ at: this.clock + 1000, state: 'loading' }, { at: this.clock + 3000, state: 'idle' }]
      this.late = { at: this.clock + (this.s.resumeErrorMs ?? 2300), mode: 'shell', text: `\r\nERROR: No saved session found with ID ${id}. Run \`codex resume\` without an ID to choose from existing sessions.\r\n${this.prompt()}` }
      return
    }
    if (what === 'not-found') {
      if (this.s.agent === 'claude') this.out += `${this.notFoundLine(id)}\r\n${this.prompt()}`
      else if (this.s.agent === 'codex') this.out += `ERROR: No saved session found with ID ${id}. Run \`codex resume\` without an ID to choose from existing sessions.\r\n${this.prompt()}`
      else {
        this.out += `Conversation ${id} not found, ignoring --conversation flag\r\n`
        this.mode = 'agent'
        this.agentState = 'idle'
        this.box = ''
        this.redraw()
      }
      return
    }
    this.mode = 'agent'
    this.box = ''
    this.agentState = what === 'sign-in' ? 'sign-in' : what === 'asks' ? 'asks' : what === 'resume-size' ? 'resume-size' : what === 'sandbox-menu' ? 'sandbox' : 'idle'
    this.redraw()
  }

  /** What the switch typed, as each program takes it. */
  type(data: string): void {
    this.writes.push(data)
    this.writeClocks.push(this.clock)
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      if (this.mode === 'shell') {
        // The shell isn't reading while the agent's process is still going: the keys are lost.
        if (this.s.shellDead || this.clock < this.goneAt + (this.s.shellLateMs ?? 0)) continue
        if (c === '\r') {
          this.flushSlowEcho()
          const line = this.line
          this.line = ''
          this.out += '\r\n'
          this.runLine(line)
        } else if (c === '\u0015' || c === E) {
          // The slow shell reads the Ctrl+U after what came before it: nothing of that was drawn.
          this.slowEcho = null
          this.line = ''
          this.out += `\r${E}[K${this.prompt().split('\r\n').pop()}`
        } else if (c === '\u0004') {
          if (this.s.family === 'posix' && this.line === '') this.closed = true
        } else if (c >= ' ') {
          this.line += c
          if (this.s.shellCharMs) {
            this.read++
            // A stalled shell reads on and draws none of it.
            if (this.s.shellStallsAfter === undefined || this.read <= this.s.shellStallsAfter) {
              this.shellFreeAt = Math.max(this.shellFreeAt, this.clock) + this.s.shellCharMs
              this.slowEcho = { at: this.shellFreeAt, text: (this.slowEcho?.text ?? '') + c }
            }
          } else this.out += c
        }
        continue
      }
      // The agent's TUI.
      if (c === E) {
        if (this.agentState === 'menu' || this.agentState === 'waiting') {
          if (this.s.escCloses !== false) this.agentState = 'idle'
        } else if (this.agentState === 'busy' && this.s.escStops) this.agentState = 'idle'
        this.redraw()
      } else if (c === '\u0015') {
        if (!this.s.clearFails) this.box = ''
        this.redraw()
      } else if (c === '\r') {
        const exitCmd = this.s.agent === 'codex' ? '/quit' : '/exit'
        if (this.box === exitCmd && this.s.exit !== 'ignore') this.exitAgent()
        else if (this.s.agent === 'agy' && (this.box === '/logout' || this.box === '/login')) {
          // agy's own commands: /logout signs this computer's agy out (and shows its sign-in, or its
          // box again); /login shows its sign-in.
          const cmd = this.box
          this.box = ''
          if (cmd === '/logout') this.signedOut = true
          this.agentState = cmd === '/logout' && this.s.logout === 'box' ? 'idle' : 'sign-in'
          this.redraw()
        } else {
          if (this.box) this.sentPrompts.push(this.box)
          if (this.box && this.s.busyAfterPrompt) this.agentState = 'busy'
          this.box = ''
          this.redraw()
        }
      } else if (c === '\u0003' || c === '\u0004') {
        // Recorded in writes; the switch never sends either.
      } else if (c >= ' ' && this.s.exit !== 'no-echo' && this.agentState !== 'menu' && this.agentState !== 'question') {
        this.box += c
        this.redraw()
      }
    }
  }

  /** The slow shell has read the typed line: it draws it. */
  private flushSlowEcho(): void {
    if (this.slowEcho) this.out += this.slowEcho.text
    this.slowEcho = null
  }

  /** The user signs in, in agy's sign-in screen: agy says so and shows its box, under the account. */
  completeSignIn(email = this.email): void {
    this.signedOut = false
    this.email = email
    this.out += '\r\nAuthentication successful!\r\n'
    this.agentState = 'idle'
    this.redraw()
  }

  /** What the OS says: only the shell is left in the terminal, once the agent's process is gone. */
  private alone(): boolean | null {
    this.osAsked++
    if (this.s.os === 'blind') return null
    if (this.s.os === 'flaky' && this.osAsked % 2 === 0) return null
    return this.mode === 'shell' && this.clock >= this.goneAt
  }

  io(): SwitchIO {
    const retained = (): string => (this.s.main ? this.out.slice(-MAX_TERMINAL_BUFFER_CHARS) : this.out)
    const size = (): { cols: number; rows: number } => ({ cols: this.s.cols ?? 80, rows: this.s.rows ?? 24 })
    return {
      output: () => (this.out ? { raw: retained(), end: this.out.length } : null),
      outputFrom: (_id, from) => (this.s.main ? this.out.slice(Math.max(from, this.out.length - MAX_TERMINAL_BUFFER_CHARS)) : this.out.slice(from)),
      end: () => this.out.length,
      size,
      ...(this.s.main === 'kept' ? { screen: () => { const screen = screenOf(this.out, size()); return { lines: screen.lines(), title: screen.title } } } : {}),
      write: (_id, data) => this.type(data),
      sleep: async (ms) => {
        this.clock += ms
        for (const r of this.redraws.filter((x) => x.at <= this.clock)) {
          this.agentState = r.state
          this.redraw()
        }
        this.redraws = this.redraws.filter((x) => x.at > this.clock)
        if (this.late && this.late.at <= this.clock) {
          this.out += this.late.text
          if (this.late.mode) this.mode = this.late.mode
          this.late = null
        }
        if (this.slowEcho && this.slowEcho.at <= this.clock) this.flushSlowEcho()
      },
      now: () => this.clock,
      ...(this.s.foreground ? { atShell: () => this.mode === 'shell' } : {}),
      ...(this.s.os ? { shellAlone: async () => this.alone() } : {}),
    }
  }
}

/** Every key the switch sent, as one string. */
export const keys = (t: FakeTerminal): string => t.writes.join('')
