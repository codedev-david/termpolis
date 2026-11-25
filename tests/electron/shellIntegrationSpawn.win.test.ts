// #73. Windows PowerShell and cmd with Termpolis's integration, for real, from a data folder with a space in its path
// (C:\Users\First Last\AppData\Roaming\Termpolis is what a person with a two-word name gets) and with an apostrophe.
// The generated file is written to disk, and the shell starts on a REAL node-pty (ConPTY) with the args and env
// shellIntegration.ts gives terminalManager. Asserts that the integration loaded: `lumopolis` prints its sequence for
// the shell's folder, and the prompt reports the folder. The string tests cannot show this, because the quoting has to
// survive node-pty's command line and each shell's own parsing of it.
//
// -NoProfile: the person's $PROFILE is not what is under test, and a developer's profile can be slow or print anything.
// Each shell is asked to exit, so no console process list is ever taken to kill it (kill is only the fallback).
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { integrationArgs, integrationEnv, integrationFile } from '../../src/main/shellIntegration'
import { LUMOPOLIS_NONCE_ENV } from '../../src/shared/world/lumopolisCommand'
import { powershellPath } from '../../src/main/secondOpinion'

interface Pty { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; write(s: string): void; kill(): void }
const require = createRequire(import.meta.url)
const pty = require('node-pty') as { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty }

const NONCE = 'fedcba9876543210fedcba9876543210'
const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

async function waitFor(get: () => string, re: RegExp, what: string, ms = 30_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (re.test(get())) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${what} within ${ms} ms; the terminal showed:\n${JSON.stringify(get().slice(-3000))}`)
}

function start(file: string, args: string[], env: Record<string, string>, cwd: string) {
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 200, rows: 50, cwd, env })
  let out = ''
  let exited = false
  p.onData((d) => { out += d })
  p.onExit(() => { exited = true })
  return {
    out: () => out,
    write: (s: string) => p.write(s),
    /** Asks the shell to exit and waits for it; kills it only if it will not go. */
    async end(): Promise<void> {
      if (!exited) p.write('exit\r')
      for (const t0 = Date.now(); !exited && Date.now() - t0 < 10_000;) await new Promise((r) => setTimeout(r, 50))
      if (!exited) { try { p.kill() } catch { /* already gone */ } }
    },
  }
}

/** The environment terminalManager would give the shell: the parent's, the integration's, and this run's nonce. */
function envFor(kind: 'powershell' | 'cmd', script: string): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  delete base.PROMPT // the developer's own cmd prompt is not under test
  return { ...base, ...integrationEnv(kind, base, script), [LUMOPOLIS_NONCE_ENV]: NONCE }
}

const DATA_DIRS = ['First Last\\AppData\\Roaming\\Termpolis', "Ann O'Neil é\\Termpolis"]

describe.runIf(process.platform === 'win32')('Windows shells started for real with the integration in a folder with a space', () => {
  for (const dataDir of DATA_DIRS) {
    it(`Windows PowerShell dot-sources the integration from "${dataDir}"`, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-win-'))) // the long form: the shells report it, not 8.3
      roots.push(root)
      const file = integrationFile('powershell')!
      const dir = join(root, dataDir)
      mkdirSync(dir, { recursive: true })
      const script = join(dir, file.name)
      writeFileSync(script, file.content, 'utf8')
      const work = join(root, 'work')
      mkdirSync(work)
      const sh = start(powershellPath(), ['-NoProfile', ...integrationArgs('powershell', script)], envFor('powershell', script), work)
      try {
        // The prompt wrapper reports the folder (OSC 9;9) only once the integration has loaded.
        await waitFor(sh.out, new RegExp(`\\x1b\\]9;9;"?${escapeRe(work)}`), "the first prompt's folder report")
        const at = sh.out().length
        sh.write('lumopolis\r')
        await waitFor(() => sh.out().slice(at), new RegExp(`\\x1b\\]7377;lumopolis;${NONCE};${escapeRe(work)}\\x07`), 'the lumopolis sequence')
        expect(sh.out()).not.toMatch(/is not recognized|CommandNotFoundException|cannot be loaded/)
      } finally { await sh.end() }
    }, 60_000)

    it(`cmd loads the lumopolis macro from "${dataDir}"`, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-win-'))) // the long form: the shells report it, not 8.3
      roots.push(root)
      const file = integrationFile('cmd')!
      const dir = join(root, dataDir)
      mkdirSync(dir, { recursive: true })
      const script = join(dir, file.name)
      writeFileSync(script, file.content, 'utf8')
      const work = join(root, 'work')
      mkdirSync(work)
      const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      const sh = start(cmd, integrationArgs('cmd', script), envFor('cmd', script), work)
      try {
        await waitFor(sh.out, new RegExp(`\\x1b\\]9;9;${escapeRe(work)}`), "the first prompt's folder report")
        const at = sh.out().length
        sh.write('lumopolis\r')
        await waitFor(() => sh.out().slice(at), new RegExp(`\\x1b\\]7377;lumopolis;${NONCE};${escapeRe(work)}\\x07`), 'the lumopolis sequence')
        expect(sh.out()).not.toMatch(/is not recognized|cannot find the file/i)
      } finally { await sh.end() }
    }, 60_000)
  }
})
