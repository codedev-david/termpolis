import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildPrimerPointer } from '../../src/renderer/src/hooks/useAutoPrimer'
import { psQuote } from '../../src/shared/shellQuote'

// The launch pointer is one line of text. Typed with its Enter at a SHELL's prompt, which is where
// an agent that died at startup leaves the terminal, it is a command line, and the folder's name
// in it is data somebody else chose. Whether a shell finds a name inert is the shell's to say, and
// no string assertion can prove it, so this types the pointer, as one line, into the real shells
// on this machine and looks for a file that a payload hidden in the folder's name would create.
//
// Every shell also gets the pointer as v1.54.4 built it, with the folder between double quotes.
// That must RUN the payload: it is what proves the check below can see a payload run at all.

const win = process.platform === 'win32'
const system = process.env.SystemRoot || 'C:\\Windows'
const firstThatExists = (...paths: string[]): string | undefined => paths.find((p) => existsSync(p))

interface Shell {
  exe: string | undefined
  /** Starts the shell reading its commands from stdin, one line at a time as they are typed. */
  args: string[]
  eol: string
  /** Typed after the pointer, to end a shell that would otherwise wait for more. */
  tail: string
  /** A folder name that closes the double quotes of the old pointer and runs `echo x > pwned`.
   *  The space before `>` matters: PowerShell reads `x>` as an argument, not a redirection. */
  breakout: string
  /** A folder name with a command separator and no quote at all. */
  bare: string
  /** Whether text in single quotes is inert here. cmd.exe has no single quotes: to it they are
   *  ordinary characters, so a separator between them still separates. */
  singleQuotesProtect: boolean
}

const SHELLS: Record<string, Shell> = {
  bash: {
    exe: win ? firstThatExists('C:\\Program Files\\Git\\bin\\bash.exe') : firstThatExists('/bin/bash', '/usr/bin/bash'),
    args: ['--norc', '--noprofile'],
    eol: '\n',
    tail: 'exit\n',
    breakout: '/tmp/x"; echo x > pwned; #',
    bare: '/tmp/x; echo x > pwned; #',
    singleQuotesProtect: true,
  },
  powershell: {
    exe: win ? firstThatExists(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) : undefined,
    args: ['-NoProfile', '-NonInteractive', '-Command', '-'],
    eol: '\r\n',
    tail: '',
    breakout: 'C:\\x"; echo x > pwned; #',
    bare: 'C:\\x; echo x > pwned; #',
    singleQuotesProtect: true,
  },
  cmd: {
    exe: win ? firstThatExists(join(system, 'System32', 'cmd.exe')) : undefined,
    args: ['/Q', '/D'],
    eol: '\r\n',
    tail: 'exit\r\n',
    // cmd.exe chains commands on &, and a double quote flips whether it sees one.
    breakout: 'C:\\x" & echo x > pwned & rem "',
    bare: 'C:\\x & echo x > pwned & rem ',
    singleQuotesProtect: false,
  },
}

/** Types one line into a fresh shell in an empty folder; true when `pwned` was created there. */
function payloadRan(shell: Shell, line: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'tp-pointer-shell-'))
  try {
    spawnSync(shell.exe as string, shell.args, {
      cwd: dir,
      input: line + shell.eol + shell.tail,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    })
    return existsSync(join(dir, 'pwned'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The pointer as v1.54.4 built it: the same words, the folder between double quotes. */
const oldPointer = (folder: string): string => buildPrimerPointer('X').replace("'X'", () => `"${folder}"`)

for (const [name, shell] of Object.entries(SHELLS)) {
  describe.runIf(shell.exe !== undefined)(`the pointer typed into a real ${name}`, () => {
    it('the pointer as v1.54.4 built it runs a payload in the folder name (the check can see a payload run)', () => {
      expect(payloadRan(shell, oldPointer(shell.breakout))).toBe(true)
    }, 60_000)

    it('runs nothing from a folder name that breaks out of double quotes', () => {
      expect(payloadRan(shell, buildPrimerPointer(shell.breakout))).toBe(false)
      expect(buildPrimerPointer(shell.breakout)).toBe(buildPrimerPointer('')) // the name is left out
    }, 60_000)

    if (!shell.singleQuotesProtect) {
      it('a name in single quotes alone is NOT inert here, which is why such names are left out', () => {
        const quoted = buildPrimerPointer('X').replace("'X'", () => psQuote(shell.bare))
        expect(payloadRan(shell, quoted)).toBe(true)
      }, 60_000)
    }

    it('runs nothing from a folder name with a command separator in it', () => {
      expect(payloadRan(shell, buildPrimerPointer(shell.bare))).toBe(false)
      expect(buildPrimerPointer(shell.bare)).toBe(buildPrimerPointer(''))
    }, 60_000)

    it('runs nothing from a pointer that names no folder, or an ordinary one', () => {
      expect(payloadRan(shell, buildPrimerPointer(''))).toBe(false)
      expect(payloadRan(shell, buildPrimerPointer(win ? 'C:\\Program Files (x86)\\My App [dev]' : '/srv/my app (x86)/[dev]'))).toBe(false)
    }, 60_000)
  })
}
