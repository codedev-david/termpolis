// A scripted terminal for the account switch's tests (accountSwitch.ts, agySwitch.ts): a shell and
// the agent running in it, each drawn as it draws itself. The agent's screen is a ConPTY-style
// frame (the screen cleared, each row at its place); the shell's output is lines added to it, with
// the prompt report each Termpolis shell writes (OSC 7 from bash, OSC 9;9 from PowerShell and cmd),
// or none, as David's Git Bash. It answers what the switch types the way each program would, and
// keeps what reached whom: what the shell ran, what went to the agent as a prompt, and whether a
// Ctrl+D closed the shell.
import type { SwitchIO } from '../../src/main/accountSwitch'

const E = '\x1b'
export const RULE = '─'.repeat(80)
export const ID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
export const ID2 = '01a1664b-6312-7121-97f6-88c7f6793c64'

export type Family = 'posix' | 'powershell' | 'cmd'
export type Agent = 'claude' | 'codex' | 'agy'

/** How the agent stands on screen when the switch starts. */
export type Start = 'idle' | 'busy' | 'menu' | 'waiting' | 'typed' | 'question' | 'gone-hint' | 'gone-quiet' | 'blank'

/** What the shell's run of the relaunch line shows. */
export type Relaunch = 'box' | 'not-found' | 'sign-in' | 'asks' | 'nothing'

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
  /** What each relaunch shows, in turn; the last one repeats. */
  relaunch?: Relaunch[]
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
  agentState: Start | 'sign-in' | 'asks'
  box = ''
  line = ''
  relaunches = 0
  /** agy: signed out, by /logout, until the user signs in (completeSignIn). */
  signedOut = false
  /** How many times the agent exited. */
  exits = 0
  /** The account agy's header shows. */
  email: string
  constructor(public s: TermScript) {
    this.email = s.email ?? 'home.user@example.test'
    this.mode = s.start === 'gone-hint' || s.start === 'gone-quiet' ? 'shell' : 'agent'
    this.agentState = s.start
    this.out = this.prompt() + this.launchLine() + '\r\n'
    this.launchedAt = this.prompt().length
    if (s.start === 'gone-hint' || s.start === 'gone-quiet') {
      this.out += this.frame()
      this.agentState = 'idle'
      this.out += s.start === 'gone-hint' ? this.hint() : '\r\n'
      this.out += this.prompt()
    } else if (s.start !== 'blank') this.out += this.frame()
    else this.out += 'loading…'
  }

  /** Where the launch line was typed, and the line: what main records as the agent's start. */
  launchedAt: number

  launchLine(): string {
    return { claude: `claude --model opus --session-id ${ID}`, codex: 'codex -m gpt-5.6-sol', agy: 'agy' }[this.s.agent]
  }

  prompt(family: Family = this.s.family): string {
    const reports = this.s.reports !== false
    if (family === 'posix') return `${reports ? `${E}]7;file://host/c/repo\x07` : ''}me@host MINGW64 /c/repo\r\n$ `
    if (family === 'powershell') return `${reports ? `${E}]9;9;C:\\repo\x07` : ''}PS C:\\repo> `
    return `${reports ? `${E}]9;9;C:\\repo\x07` : ''}C:\\repo>`
  }

  private rows(): string[] {
    const a = this.s.agent
    const st = this.agentState
    if (st === 'sign-in') return a === 'codex' ? ['  Sign in with ChatGPT to use Codex', '', '› 1. Sign in with ChatGPT', '  2. Provide your own API key', '', '  Press enter to continue'] : ['  Select login method:', '', '  ❯ 1. Claude account with subscription', '    2. Anthropic Console account', '', '  Enter to confirm · Esc to cancel']
    if (st === 'sign-in' && a === 'agy') return ['Welcome back! You are currently not signed in.', '', 'Select login method:', '', '> Continue with Google', '  Other sign-in options', '', '↑/↓ Navigate · enter Confirm']
    if (st === 'asks') return ['  WARNING: Claude Code running in Bypass Permissions mode', '', '  ❯ 1. No, exit', '    2. Yes, I accept', '', '  Enter to confirm · Esc to cancel']
    // Claude Code's permission dialog and its rate-limit menu, laid out as the real captures show
    // them (tests/fixtures/agentScreensInput.json rateLimitMenu): under a rule, the box gone.
    if (st === 'question') return ['● I will edit the file.', '', RULE, ' Edit file', ' app.ts', ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No, and tell Claude what to do differently (esc)', '']
    if (st === 'menu') {
      if (a === 'codex') return ['  Approaching rate limits', '  Switch to gpt-5.6-luna for lower credit usage?', '', '› 1. Switch to gpt-5.6-luna   Uses fewer credits for upcoming turns.', '  2. Keep current model', '', '  Press enter to confirm or esc to go back']
      return ['❯ hi', '  ⎿ \u00a0You\'ve hit your session limit · resets 3pm (America/New_York)', '', '❯ /rate-limit-options', '', RULE, '  What do you want to do?', '', '  ❯ 1. Stop and wait for limit to reset', '    2. Add funds to continue with usage credits', '', '  Enter to confirm · Esc to cancel']
    }
    const above = st === 'busy'
      ? (a === 'codex' ? ['• Working (12s • esc to interrupt)', ''] : a === 'agy' ? ['⡿ Generating... (esc to cancel)', ''] : ['✻ Thinking… (2s · esc to interrupt)', ''])
      : st === 'waiting' ? ['✻ Usage limit reached · continuing automatically at 3pm · esc to cancel', '']
      : this.s.quoteHint ? ['● When it exits it prints:', '', 'Resume this session with:', `claude --resume ${this.s.id ?? ID}`, ''] : ['● Done.', '']
    if (a === 'codex') {
      const composer = `› ${this.box || 'Ask Codex to do anything'}`
      const popup = this.box.startsWith('/') ? ['  /quit   exit Codex'] : []
      return ['• Ready.', '', ...above, composer, ...popup, '', BOX_FOOTER.codex]
    }
    const glyph = a === 'claude' ? '❯' : '>'
    const header = a === 'agy' ? ['      ▄▀▀▄        Antigravity CLI 1.4.3', `     ▀▀▀▀▀▀       ${this.email} (Google AI Pro)`, ''] : []
    return [...header, ...above, RULE, `${glyph} ${this.box}`, RULE, BOX_FOOTER[a]]
  }

  /** The agent's screen, as ConPTY paints it: cleared, then each row at its place. */
  frame(): string {
    return `${E}[H${E}[2J` + this.rows().map((r, i) => `${E}[${i + 1};1H${r}`).join('')
  }

  hint(): string {
    const id = this.exits > 1 ? THROWAWAY : this.s.id ?? ID
    if (this.s.agent === 'claude') {
      const cmd = this.s.worktree ? `claude --worktree "${this.s.worktree}" --resume ${id}` : `claude --resume ${id}`
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
    this.out += this.frame()
  }

  private exitAgent(): void {
    this.exits++
    this.mode = 'shell'
    this.out += this.s.exit === 'no-hint' ? '\r\n' : this.hint()
    if (this.s.nestedReport) this.out += this.prompt(this.s.nestedReport)
    else this.out += this.prompt()
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
    if (what === 'not-found') {
      if (this.s.agent === 'claude') this.out += `No conversation found with session ID: ${id}\r\n${this.prompt()}`
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
    this.agentState = what === 'sign-in' ? 'sign-in' : what === 'asks' ? 'asks' : 'idle'
    this.redraw()
  }

  /** What the switch typed, as each program takes it. */
  type(data: string): void {
    this.writes.push(data)
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      if (this.mode === 'shell') {
        if (this.s.shellDead) continue
        if (c === '\r') {
          const line = this.line
          this.line = ''
          this.out += '\r\n'
          this.runLine(line)
        } else if (c === '\u0015' || c === E) {
          this.line = ''
          this.out += `\r${E}[K${this.prompt().split('\r\n').pop()}`
        } else if (c === '\u0004') {
          if (this.s.family === 'posix' && this.line === '') this.closed = true
        } else if (c >= ' ') {
          this.line += c
          this.out += c
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

  /** The user signs in, in agy's sign-in screen: agy says so and shows its box, under the account. */
  completeSignIn(email = this.email): void {
    this.signedOut = false
    this.email = email
    this.out += '\r\nAuthentication successful!\r\n'
    this.agentState = 'idle'
    this.redraw()
  }

  io(): SwitchIO {
    return {
      output: () => (this.out ? { raw: this.out, end: this.out.length } : null),
      outputFrom: (_id, from) => this.out.slice(from),
      end: () => this.out.length,
      size: () => ({ cols: 80, rows: 24 }),
      write: (_id, data) => this.type(data),
      sleep: async (ms) => { this.clock += ms },
      now: () => this.clock,
    }
  }
}

/** Every key the switch sent, as one string. */
export const keys = (t: FakeTerminal): string => t.writes.join('')
