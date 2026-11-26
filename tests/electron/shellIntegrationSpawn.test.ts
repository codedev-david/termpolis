// bash, zsh and fish with Termpolis's integration, for real: the generated files on disk, the shell started on a REAL
// node-pty exactly as terminalManager starts it (its args and env from shellIntegration.ts), a scratch HOME whose own
// start-up files record that they ran. Asserts the OSC 7 after `cd /tmp`, the lumopolis sequence, its refusals and
// its usage line, that the person's own prompt hook still runs, and that zsh leaves ZDOTDIR as it found it.
//
// Runs where the shell is on PATH. On the macOS and Linux CI runners the workflow installs zsh and fish, and a missing shell
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
  if (process.platform === 'win32') return `this file runs ${shell} on macOS and Linux only`
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

/**
 * Termpolis's data folder in each run: a plain one, and one with a space and a non-ASCII letter in it, as macOS's
 * userData ("~/Library/Application Support/Termpolis") has a space and a person's own name may be in any script.
 */
const DATA_DIRS = ['data', 'Application Support/Termpolis üß']

/** Termpolis's files for this shell, written where terminalSpawnPrep writes them (here: a scratch data folder). */
function writeIntegration(root: string, shell: 'zsh' | 'fish', dataDir: string): string {
  const file = integrationFile(detectShellKind(shell))!
  const main = join(root, dataDir, file.name)
  mkdirSync(join(main, '..'), { recursive: true })
  for (const f of integrationFileSet(file, main)) writeFileSync(f.path, f.content, 'utf8')
  return main
}

const OSC7_TMP = /\x1b\]7;file:\/\/[^\x07/]*\/(private\/)?tmp\x07/
const LUMO_TMP = new RegExp(`\\x1b\\]7377;lumopolis;${NONCE};/(private/)?tmp/\\.\\x07`)

/** Types each command and checks what came back after it, the same for both shells. */
async function exercise(sh: ReturnType<typeof start>, belDir: string | null, spacedDir: string): Promise<void> {
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

  // A folder with a space and a non-ASCII letter in its name travels whole, as one argument.
  const spaced = after('lumopolis "$TP_SPACED_DIR"')
  await waitFor(spaced, new RegExp(`\\x1b\\]7377;lumopolis;${NONCE};${escapeRe(spacedDir)}\\x07`), 'the lumopolis sequence for a folder with a space')

  if (belDir) {
    // A real folder whose name holds a BEL: refused, because the BEL would end the sequence early.
    const bel = after('lumopolis "$TP_BEL_DIR"')
    await waitFor(bel, /lumopolis: no such folder: [^\r\n]*a\x07b/, 'the refusal of a folder with a BEL in its name')
    expect(bel()).not.toContain('\x1b]7377')
  }
}

const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

/** A real folder with a space and a non-ASCII letter in its name, for `lumopolis "<folder>"`. */
function spacedFolder(root: string): string {
  const d = join(root, 'my folder é')
  mkdirSync(d)
  return d
}

function belFolder(root: string): string | null {
  const d = join(root, 'a\x07b')
  try { mkdirSync(d); return d } catch (e) {
    console.log(`[shellIntegrationSpawn] this file system refuses a BEL in a folder name (${(e as Error).message}); that one check is skipped`)
    return null
  }
}

function baseEnv(home: string, belDir: string | null, spacedDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    [LUMOPOLIS_NONCE_ENV]: NONCE,
    TP_SPACED_DIR: spacedDir,
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

  const cases = [
    { withOwnZdotdir: false, dataDir: DATA_DIRS[0] },
    { withOwnZdotdir: true, dataDir: DATA_DIRS[0] },
    // The ß of this one is UTF-8 C3 9F, a byte zsh 5.9 drops from $ZDOTDIR as it opens .zshenv (see ZSH_ZSHENV).
    { withOwnZdotdir: false, dataDir: DATA_DIRS[1] },
    { withOwnZdotdir: true, dataDir: DATA_DIRS[1] },
    // No UTF-8 locale: .zshenv finds its own folder through prompt expansion (%x), which then prints ß as \M-C\M-^_
    // unless print_eight_bit is on (see ZSH_ZSHENV). The start-up files and what is left set are checked here; the
    // folder-name round trips of exercise() are the UTF-8 cases' job.
    { withOwnZdotdir: true, dataDir: DATA_DIRS[1], lang: 'C' },
  ]
  for (const { withOwnZdotdir, dataDir, lang } of cases) {
    it.skipIf(!!zshSkip)(`runs the person's four files in order, then OSC 7 and lumopolis (${withOwnZdotdir ? 'their own ZDOTDIR' : 'no ZDOTDIR'}; data folder "${dataDir}"${lang ? `; LANG=${lang}` : ''})`, async () => {
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
      // Aliases of the person's own, named like the built-ins lumopolis calls. zsh defines lumopolis after their .zshrc,
      // so these would expand inside it unless each call goes through `builtin`.
      writeFileSync(join(userDir, '.zshrc'), "alias printf='builtin print -rn -- ALIASED;' local='builtin print -rn -- ALIASED;' return='builtin print -rn -- ALIASED;'\n", { flag: 'a' })
      const belDir = belFolder(root)
      const spacedDir = spacedFolder(root)
      const script = writeIntegration(root, 'zsh', dataDir)
      const env0 = { ...baseEnv(home, belDir, spacedDir), ...(withOwnZdotdir ? { ZDOTDIR: userDir } : {}), ...(lang ? { LANG: lang } : {}) }
      const env = { ...env0, ...integrationEnv('zsh', env0, script) }
      // As terminalManager: --login (getShellArgs, for a path ending in zsh), then the integration's own args (none).
      const sh = start(zshPath!, ['--login', ...integrationArgs('zsh', script)], env, root)
      try {
        await waitFor(sh.out, /\x1b\]7;file:\/\//, 'the first prompt (its OSC 7)')
        // #29: Termpolis's .zshrc ran to its end, and says so with the ready mark beside the report.
        await waitFor(sh.out, /\x1b\]7377;ready\x07/, 'the ready mark (#29)')
        const seen = withOwnZdotdir ? userDir : 'none'
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`zshenv:${seen}`, `zprofile:${seen}`, `zshrc:${seen}`, `zlogin:${seen}`])

        if (!lang) {
          const cd = sh.out().length
          await exercise(sh, belDir, spacedDir)
          expect(sh.out().slice(cd)).toContain('USERPRECMD')
        }
        expect(sh.out()).not.toContain('ALIASED')

        const at = sh.out().length
        sh.write('print -r -- "ZD=[${ZDOTDIR-unset}] V=[${__termpolis_zdotdir-gone}] U=[${TERMPOLIS_USER_ZDOTDIR-gone}] D=[${TERMPOLIS_ZSH_DIR-gone}]"\r')
        await waitFor(() => sh.out().slice(at), new RegExp(`ZD=\\[${withOwnZdotdir ? escapeRe(userDir) : 'unset'}\\] V=\\[gone\\] U=\\[gone\\] D=\\[gone\\]`), "ZDOTDIR as the person had it, and nothing of Termpolis's left set")

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

  for (const dataDir of DATA_DIRS) it.skipIf(!!fishSkip)(`runs the person's config.fish first, then OSC 7 and lumopolis beside their own prompt handler (data folder "${dataDir}")`, async () => {
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
      // #45. Functions of theirs named after the builtins the integration calls (fish 3.7 lets these two be shadowed).
      // They pass through, and record only the integration's own calls: a record means a builtin was not called as one.
      'function contains',
      '    if builtin test (count $argv) -ge 4; and builtin test "$argv[3]" = -h; and builtin test "$argv[4]" = --help',
      '        echo contains >> $HOME/shadowed.log',
      '    end',
      '    builtin contains $argv',
      'end',
      'function functions',
      '    if builtin test "$argv[1]" = -q; and builtin test "$argv[2]" = lumopolis',
      '        echo functions >> $HOME/shadowed.log',
      '    end',
      '    builtin functions $argv',
      'end',
      '',
    ].join('\n'))
    const belDir = belFolder(root)
    const spacedDir = spacedFolder(root)
    const script = writeIntegration(root, 'fish', dataDir)
    const env0 = { ...baseEnv(home, belDir, spacedDir), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') }
    const env = { ...env0, ...integrationEnv('fish', env0, script) }
    const args = integrationArgs('fish', script)
    expect(args[0]).toBe('--init-command')
    const sh = start(fishPath!, args, env, root)
    try {
      await waitFor(sh.out, /\x1b\]7;file:\/\//, 'the first prompt (its OSC 7)')
      expect(readFileSync(join(home, 'order.log'), 'utf8').trim()).toBe('config')
      const cd = sh.out().length
      await exercise(sh, belDir, spacedDir)
      expect(sh.out().slice(cd)).toContain('USERPROMPT')
      expect(existsSync(join(home, 'shadowed.log')) ? readFileSync(join(home, 'shadowed.log'), 'utf8') : '').toBe('')
    } finally { sh.kill() }
  }, 60_000)
})

const bashPath = process.platform === 'win32' ? null : onPath('bash')
const bashSkip = skipReason('bash', bashPath)
if (bashSkip) console.log(`[shellIntegrationSpawn] bash skipped: ${bashSkip}`)

// bash's integration travels in its environment alone (PROMPT_COMMAND and the exported lumopolis function), so it has
// no file in the data folder; the space and the non-ASCII letter go in its HOME and working folder instead.
describe('bash, started for real with the integration', () => {
  if (CI_POSIX) {
    it('bash and node-pty are on this CI runner (a missing one fails here, never skips)', () => {
      expect(pty, ptyError).toBeTruthy()
      expect(bashPath).toBeTruthy()
    })
  }

  it.skipIf(!!bashSkip)("runs the person's .bash_profile, then OSC 7 and lumopolis, with a function of theirs named local", async () => {
    const root = mkdtempSync(join(tmpdir(), `tp bash ${'ü'}-`))
    roots.push(root)
    const home = join(root, 'home dir')
    mkdirSync(home)
    writeFileSync(join(home, '.bash_profile'), 'echo profile >> "$HOME/order.log"\n')
    const belDir = belFolder(root)
    const spacedDir = spacedFolder(root)
    const env0 = baseEnv(home, belDir, spacedDir)
    const env = { ...env0, ...integrationEnv('bash', env0, null) }
    // As terminalManager: --login (getShellArgs, for a path ending in bash), then the integration's own args (none).
    expect(integrationFile('bash')).toBeNull()
    const sh = start(bashPath!, ['--login', ...integrationArgs('bash', null)], env, root)
    try {
      await waitFor(sh.out, /\x1b\]7;file:\/\//, 'the first prompt (its OSC 7)')
      expect(readFileSync(join(home, 'order.log'), 'utf8').trim()).toBe('profile')
      await exercise(sh, belDir, spacedDir)
      // A function of the person's own, named like a built-in lumopolis calls: bash looks functions up before
      // built-ins when it runs one, so only `builtin local` keeps it out. It also reaches the system's own prompt
      // hooks (Ubuntu's systemd OSC 3008 script calls local), so only lumopolis's own output is checked, in a file.
      const hijacked = sh.out().length
      sh.write(`local() { builtin printf 'FNHIJACK'; }; lumopolis "$TP_SPACED_DIR" > "$HOME/lp.out" 2>&1; unset -f local; echo LP-$((40+2))\r`)
      await waitFor(() => sh.out().slice(hijacked), /LP-42/, 'lumopolis run with a function named local defined')
      expect(readFileSync(join(home, 'lp.out'), 'utf8')).toBe(`\x1b]7377;lumopolis;${NONCE};${spacedDir}\x07`)

      // An alias or a function of the person's named printf (a .bashrc can have either): the folder report before each
      // prompt still arrives, so the globe, the git dot and the file tree follow the shell. Each one is defined on the line
      // that changes folder; PROMPT_COMMAND is read after that line, with the alias or function in place.
      for (const [hijack, undo, dir] of [
        [`alias printf='builtin echo PFALIAS'`, 'unalias printf', home],
        [`printf() { builtin echo PFHIJACK; }`, 'unset -f printf', spacedDir],
      ] as const) {
        const at = sh.out().length
        sh.write(`${hijack}; cd "${dir}"\r`)
        await waitFor(() => sh.out().slice(at), new RegExp(`\\x1b\\]7;file://[^\\x07]*${escapeRe(dir)}\\x07`), `the folder report with "${hijack}" defined`)
        sh.write(`${undo}\r`)
      }
    } finally { sh.kill() }
  }, 60_000)
})
