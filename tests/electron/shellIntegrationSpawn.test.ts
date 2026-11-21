// zsh and fish with Termpolis's integration, for real: the generated files on disk, the shell started on a REAL
// node-pty exactly as terminalManager starts it (its args and env from shellIntegration.ts), a scratch HOME whose own
// start-up files record that they ran. Asserts the OSC 7 after `cd /tmp`, the lumopolis sequence, its refusals and
// its usage line, that the person's own prompt hook still runs, and that zsh leaves ZDOTDIR as it found it.
//
// Runs where the shell is on PATH. On the macOS and Linux CI runners the workflow installs both, and a missing shell
// (or a node-pty that will not load) FAILS there rather than skipping: no silent false green. Every skip logs why.
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import {
  detectShellKind,
  integrationArgs,
  integrationEnv,
  integrationFile,
  integrationFileSet,
  LUMOPOLIS_USAGE,
} from '../../src/main/shellIntegration'
import { LUMOPOLIS_NONCE_ENV } from '../../src/shared/world/lumopolisCommand'

interface Pty { onData(cb: (d: string) => void): void; write(s: string): void; kill(): void }
const require = createRequire(import.meta.url)
let pty: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty } | null = null
let ptyError = ''
try {
  pty = require('node-pty')
} catch (e) {
  ptyError = `node-pty did not load: ${(e as Error).message}`
}

const NONCE = '0123456789abcdef0123456789abcdef'
const CI_POSIX = !!process.env.CI && process.platform !== 'win32'
const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** The shell's path, found by looking in each PATH folder (no process is started to ask). */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

function skipReason(shell: string, path: string | null): string | null {
  if (process.platform === 'win32') return 'zsh and fish are tested on macOS and Linux (Termpolis offers them there)'
  if (!pty) return ptyError
  if (!path) return `${shell} is not on PATH`
  return null
}

/** A shell on a real pty, with what it printed so far; answers fish's terminal query so it never waits on one. */
function start(file: string, args: string[], env: Record<string, string>, cwd: string): { out: () => string; write: (s: string) => void; kill: () => void } {
  const p = pty!.spawn(file, args, { name: 'xterm-256color', cols: 200, rows: 50, cwd, env })
  let out = ''
  p.onData((d) => {
    out += d
    if (d.includes('\x1b[c') || d.includes('\x1b[0c')) p.write('\x1b[?62;22c')
  })
  return { out: () => out, write: (s) => p.write(s), kill: () => { try { p.kill() } catch { /* already gone */ } } }
}

async function waitFor(get: () => string, re: RegExp, what: string, ms = 20_000): Promise<string> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const m = get().match(re)
    if (m) return m[0]
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${what} within ${ms} ms; the terminal showed:\n${JSON.stringify(get().slice(-3000))}`)
}

/** Termpolis's files for this shell, written where terminalSpawnPrep writes them (here: a scratch data folder). */
function writeIntegration(root: string, shell: 'zsh' | 'fish'): string {
  const file = integrationFile(detectShellKind(shell))!
  const main = join(root, 'data', file.name)
  mkdirSync(join(main, '..'), { recursive: true })
  for (const f of integrationFileSet(file, main)) writeFileSync(f.path, f.content, 'utf8')
  return main
}

const OSC7_TMP = /\x1b\]7;file:\/\/[^\x07/]*\/(private\/)?tmp\x07/
const LUMO_TMP = new RegExp(`\\x1b\\]7377;lumopolis;${NONCE};/(private/)?tmp/\\.\\x07`)

/** Types each command and checks what came back after it, the same for both shells. */
async function exercise(sh: ReturnType<typeof start>, belDir: string | null): Promise<void> {
  const after = (cmd: string): (() => string) => { const at = sh.out().length; sh.write(`${cmd}\r`); return () => sh.out().slice(at) }

  const cd = after('cd /tmp')
  await waitFor(cd, OSC7_TMP, 'OSC 7 for /tmp after cd')

  const here = after('lumopolis')
  await waitFor(here, LUMO_TMP, 'the lumopolis sequence for /tmp')

  const nope = after('lumopolis no_such_folder_zz')
  await waitFor(nope, /lumopolis: no such folder: no_such_folder_zz/, 'the no-such-folder line')
  expect(nope()).not.toContain('\x1b]7377')

  const help = after('lumopolis -h')
  await waitFor(help, new RegExp(LUMOPOLIS_USAGE.replace(/[[\]]/g, '\\$&')), 'the usage line')
  expect(help()).not.toContain('\x1b]7377')

  if (belDir) {
    // A real folder whose name holds a BEL: refused, because the BEL would end the sequence early.
    const bel = after('lumopolis "$TP_BEL_DIR"')
    await waitFor(bel, /lumopolis: no such folder: [^\r\n]*a\x07b/, 'the refusal of a folder with a BEL in its name')
    expect(bel()).not.toContain('\x1b]7377')
  }
}

function belFolder(root: string): string | null {
  const d = join(root, 'a\x07b')
  try { mkdirSync(d); return d } catch (e) {
    console.log(`[shellIntegrationSpawn] this file system refuses a BEL in a folder name (${(e as Error).message}); that one check is skipped`)
    return null
  }
}

function baseEnv(home: string, belDir: string | null): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    [LUMOPOLIS_NONCE_ENV]: NONCE,
    ...(belDir ? { TP_BEL_DIR: belDir } : {}),
  }
}

const zshPath = process.platform === 'win32' ? null : onPath('zsh')
const zshSkip = skipReason('zsh', zshPath)
if (zshSkip) console.log(`[shellIntegrationSpawn] zsh skipped: ${zshSkip}`)

describe('zsh, started for real with the integration', () => {
  if (CI_POSIX) {
    it('zsh and node-pty are on this CI runner (a missing one fails here, never skips)', () => {
      expect(pty, ptyError).toBeTruthy()
      expect(zshPath, 'the workflow installs zsh on the macOS and Linux runners').toBeTruthy()
      // For the log: the runner's own fpath folders that compinit calls insecure (see the person's .zshenv below).
      const audit = execFileSync(zshPath!, ['-fc', 'autoload -Uz compaudit; compaudit 2>&1; true'], { encoding: 'utf8' })
      console.log(`[shellIntegrationSpawn] compaudit on this runner: ${audit.trim() || 'nothing insecure'}`)
    })
  }

  for (const withOwnZdotdir of [false, true]) {
    it.skipIf(!!zshSkip)(`runs the person's four files in order, then OSC 7 and lumopolis (${withOwnZdotdir ? 'their own ZDOTDIR' : 'no ZDOTDIR'})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'tp-zsh-'))
      roots.push(root)
      const home = join(root, 'home')
      const userDir = withOwnZdotdir ? join(home, 'zd') : home
      mkdirSync(userDir, { recursive: true })
      const log = join(home, 'order.log')
      for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
        writeFileSync(join(userDir, f), `print -r -- "${f.slice(1)}:\${ZDOTDIR-none}" >> "$HOME/order.log"\n`)
      }
      // Ubuntu's /etc/zsh/zshrc runs compinit, which stops at a y/n question when a folder in the runner's fpath is
      // group or world writable (the GitHub Ubuntu image has one). That is the machine, not Termpolis: a plain zsh with
      // no Termpolis files asks the same, and compaudit checks only fpath, never ZDOTDIR or HOME. Ubuntu's documented
      // opt-out, set in the person's own .zshenv, keeps the run unattended; it does not skip anything Termpolis does.
      writeFileSync(join(userDir, '.zshenv'), 'skip_global_compinit=1\n', { flag: 'a' })
      // The person's own precmd, which Termpolis's hook must sit beside, not replace.
      writeFileSync(join(userDir, '.zshrc'), "precmd() { builtin printf 'USERPRECMD' }\n", { flag: 'a' })
      const belDir = belFolder(root)
      const script = writeIntegration(root, 'zsh')
      const env0 = { ...baseEnv(home, belDir), ...(withOwnZdotdir ? { ZDOTDIR: userDir } : {}) }
      const env = { ...env0, ...integrationEnv('zsh', env0, script) }
      // As terminalManager: --login (getShellArgs, for a path ending in zsh), then the integration's own args (none).
      const sh = start(zshPath!, ['--login', ...integrationArgs('zsh', script)], env, root)
      try {
        await waitFor(sh.out, /\x1b\]7;file:\/\//, 'the first prompt (its OSC 7)')
        const seen = withOwnZdotdir ? userDir : 'none'
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`zshenv:${seen}`, `zprofile:${seen}`, `zshrc:${seen}`, `zlogin:${seen}`])

        const cd = sh.out().length
        await exercise(sh, belDir)
        expect(sh.out().slice(cd)).toContain('USERPRECMD')

        const at = sh.out().length
        sh.write('print -r -- "ZD=[${ZDOTDIR-unset}] V=[${__termpolis_zdotdir-gone}] U=[${TERMPOLIS_USER_ZDOTDIR-gone}]"\r')
        await waitFor(() => sh.out().slice(at), new RegExp(`ZD=\\[${withOwnZdotdir ? userDir.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&') : 'unset'}\\] V=\\[gone\\] U=\\[gone\\]`), "ZDOTDIR as the person had it, and nothing of Termpolis's left set")

        // History stays the person's (macOS's /etc/zshrc sets HISTFILE from ZDOTDIR while it is still Termpolis's).
        const h = sh.out().length
        sh.write('print -r -- "H=[${HISTFILE-}]"\r')
        const hist = await waitFor(() => sh.out().slice(h), /H=\[[^$\]\r\n]*\]/, 'the HISTFILE line')
        expect(hist).not.toContain('termpolis-zsh')
      } finally { sh.kill() }
    }, 60_000)
  }
})

const fishPath = process.platform === 'win32' ? null : onPath('fish')
const fishSkip = skipReason('fish', fishPath)
if (fishSkip) console.log(`[shellIntegrationSpawn] fish skipped: ${fishSkip}`)

describe('fish, started for real with the integration', () => {
  if (CI_POSIX) {
    it('fish and node-pty are on this CI runner (a missing one fails here, never skips)', () => {
      expect(pty, ptyError).toBeTruthy()
      expect(fishPath, 'the workflow installs fish on the macOS and Linux runners').toBeTruthy()
    })
  }

  it.skipIf(!!fishSkip)("runs the person's config.fish first, then OSC 7 and lumopolis beside their own prompt handler", async () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-fish-'))
    roots.push(root)
    const home = join(root, 'home')
    const conf = join(home, '.config', 'fish')
    mkdirSync(conf, { recursive: true })
    writeFileSync(join(conf, 'config.fish'), [
      'set -g fish_greeting',
      'echo config >> $HOME/order.log',
      // Defined by the person: Termpolis's must not replace it, and must still define its own beside it.
      'function user_prompt_hook --on-event fish_prompt',
      "    printf 'USERPROMPT'",
      'end',
      '',
    ].join('\n'))
    const belDir = belFolder(root)
    const script = writeIntegration(root, 'fish')
    const env0 = { ...baseEnv(home, belDir), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') }
    const env = { ...env0, ...integrationEnv('fish', env0, script) }
    const args = integrationArgs('fish', script)
    expect(args[0]).toBe('--init-command')
    const sh = start(fishPath!, args, env, root)
    try {
      await waitFor(sh.out, /\x1b\]7;file:\/\//, 'the first prompt (its OSC 7)')
      expect(readFileSync(join(home, 'order.log'), 'utf8').trim()).toBe('config')
      const cd = sh.out().length
      await exercise(sh, belDir)
      expect(sh.out().slice(cd)).toContain('USERPROMPT')
    } finally { sh.kill() }
  }, 60_000)
})
