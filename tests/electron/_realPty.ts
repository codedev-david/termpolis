// A real shell on a real pseudo-terminal (node-pty), read and typed into the way Termpolis's main
// process reads and types into one: the switch engine's SwitchIO over its raw output. The test
// files that use it (accountsChooserE2eMock, accountsRealCli) skip when node-pty can't load or a
// shell isn't on the machine, and give every process they start a temp home, so none can reach a
// real profile.
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { delimiter } from 'path'
import type { SwitchIO } from '../../src/main/accountSwitch'
import { drawn } from '../../src/main/mcpServer'
import { killProcessTree } from '../../src/main/processTree'
import type { ShellFamily } from '../../src/shared/agentAccounts'

const nodeRequire = createRequire(import.meta.url)

interface PtyProcess {
  pid: number
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  kill(): void
}

export interface PtyModule {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): PtyProcess
}

/** node-pty, or null where it can't load (the stale node_modules of a laptop, an unsupported OS). */
export function loadPty(): PtyModule | null {
  try { return nodeRequire('node-pty') as PtyModule } catch { return null }
}

export interface ShellSpec {
  /** The name Termpolis gives this shell's terminal type (familyOf reads it). */
  shellType: 'gitbash' | 'bash' | 'powershell' | 'cmd'
  family: ShellFamily
  file: string
  args: string[]
}

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']

/** The shells this machine has, of the kinds Termpolis types an account line into. */
export function shellsHere(): ShellSpec[] {
  const out: ShellSpec[] = []
  if (process.platform === 'win32') {
    const bash = GIT_BASH.find((p) => existsSync(p))
    if (bash) out.push({ shellType: 'gitbash', family: 'posix', file: bash, args: ['--noprofile', '--norc', '-i'] })
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    if (existsSync(ps)) out.push({ shellType: 'powershell', family: 'powershell', file: ps, args: ['-NoLogo', '-NoProfile'] })
    const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    if (existsSync(cmd)) out.push({ shellType: 'cmd', family: 'cmd', file: cmd, args: [] })
    return out
  }
  for (const file of ['/bin/bash', '/usr/bin/bash']) {
    if (existsSync(file)) {
      out.push({ shellType: 'bash', family: 'posix', file, args: ['--noprofile', '--norc', '-i'] })
      break
    }
  }
  return out
}

/** `env` without anything that would point an agent at a real profile or sign-in. */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|AGY|TERMPOLIS_LIMIT)/i.test(k)) env[k] = v
  }
  // macOS's bash 3.2 says the default shell is zsh now, before its first prompt, unless told not to
  // (the app sets this for its own terminals too).
  return { ...env, BASH_SILENCE_DEPRECATION_WARNING: '1', ...extra }
}

export function prependPath(dir: string, env: Record<string, string>): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  return { ...env, [key]: `${dir}${delimiter}${env[key] ?? ''}` }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How many times longer than on an idle machine a wait on a real shell is given, from how late a 10 ms timer fires: on a
 *  laptop other processes keep busy, Git Bash took about a second a character to echo (MODELS-R2-6), and every wait of this
 *  harness would give up first. One for an idle machine, four at most. */
export const loadScale = (lagMs: number): number => Math.min(4, Math.max(1, 1 + lagMs / 10))

let measured: Promise<number> | null = null
/** The scale for this machine now, measured once per process: the average lateness of twenty 10 ms timers. */
export function machineScale(): Promise<number> {
  measured ??= (async () => {
    let late = 0
    for (let i = 0; i < 20; i++) {
      const at = Date.now()
      await sleep(10)
      late += Math.max(0, Date.now() - at - 10)
    }
    return loadScale(late / 20)
  })()
  return measured
}

const KEEP = 400_000

/** The line bash runs before each prompt in Termpolis's own terminals (shellIntegration.ts), reporting the folder as OSC 7. */
export const POSIX_PROMPT_REPORT = `printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-}" "$PWD"`

export class RealTerminal {
  /** The tail of what the terminal drew, and the absolute offset of its end. */
  raw = ''
  total = 0
  exitCode: number | null = null
  readonly cols: number
  readonly rows: number
  /** Every write and every chunk of output, with the time since the start: for a failed test. */
  trace: string[] = []
  private t0 = Date.now()
  private proc: PtyProcess
  private dead = false

  constructor(pty: PtyModule, readonly shell: ShellSpec, opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }) {
    this.cols = opts.cols ?? 110
    this.rows = opts.rows ?? 30
    // A bash terminal of Termpolis's own reports each prompt (shellIntegration.ts: OSC 7 from PROMPT_COMMAND), and the switch waits for
    // that report where its terminal's shell sends one, instead of reading a quiet spell as "the prompt is back". The harness's bash,
    // started with --noprofile --norc, sent none, so a loaded machine's slow shell read as a stalled one (MODELS-R3-6). The host's own
    // PROMPT_COMMAND (David's rc has one) is replaced, not chained: a test's shell is the same on every machine.
    const env = shell.family === 'posix' ? { ...opts.env, PROMPT_COMMAND: POSIX_PROMPT_REPORT } : opts.env
    this.proc = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: opts.cwd, env })
    this.proc.onData((d) => {
      this.trace.push(`+${Date.now() - this.t0} r ${JSON.stringify(d.slice(0, 80))}`)
      this.raw += d
      this.total += d.length
      if (this.raw.length > KEEP) this.raw = this.raw.slice(-KEEP)
    })
    this.proc.onExit((e) => { this.exitCode = e.exitCode })
  }

  /** The shell's process id: what the OS is asked about (shellAlone.ts). */
  get pid(): number {
    return this.proc.pid
  }

  write(data: string): void {
    this.trace.push(`+${Date.now() - this.t0} W ${JSON.stringify(data.slice(0, 80))}`)
    if (!this.dead) this.proc.write(data)
  }

  /** The screen as Termpolis's screen model draws it, one string. */
  screen(): string {
    return drawn(this.raw, { cols: this.cols, rows: this.rows }).lines.join('\n')
  }

  /** The switch engine's view of this terminal. `writes` collects every write, for assertions. */
  io(writes: string[] = []): SwitchIO {
    return {
      output: () => ({ raw: this.raw, end: this.total }),
      outputFrom: (_id, from) => this.raw.slice(Math.max(0, this.raw.length - (this.total - from))),
      end: () => this.total,
      size: () => ({ cols: this.cols, rows: this.rows }),
      write: (_id, data) => { writes.push(data); this.write(data) },
      sleep,
      now: () => Date.now(),
    }
  }

  async until(test: () => boolean, ms: number, what: string): Promise<void> {
    // The same wait as before on an idle machine, longer on a busy one (machineScale): a wait that gave up on a slow
    // shell said nothing of the engine under test.
    ms = Math.round(ms * await machineScale())
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await sleep(100)
    }
    throw new Error(`gave up waiting for ${what} after ${ms} ms; the screen:\n${this.screen()}`)
  }

  kill(): void {
    if (this.dead) return
    this.dead = true
    // A shell that exited needs nothing: node-pty's own kill() asks Windows for its console's
    // process list and prints a stack trace when the console is gone.
    if (this.exitCode !== null) return
    let killed = false
    try { killed = killProcessTree(this.proc.pid) } catch { /* gone already */ }
    if (!killed) {
      try { this.proc.kill() } catch { /* gone already */ }
    }
  }
}
