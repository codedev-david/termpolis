// v1.25.6 — the bugs the coverage sweep uncovered, each pinned so it cannot come back.
//
// These were all found by writing tests against code nobody had tested. That is the whole argument
// for coverage as a practice: not the number, but the fact that you cannot write an honest test for
// a branch without reading what it actually does — and several of these had never been read.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { matchSensitiveFile } from '../../src/main/sensitiveFileWatcher'

describe('BUG: the gpg-private rule could never fire (SECURITY)', () => {
  // `secring.gpg` — your PRIVATE GnuPG keyring — had been grouped into the rule's EXCLUSION list
  // alongside the PUBLIC keyrings, so the exclusion returned false before the match could return
  // true. An agent reading your private keyring was never flagged, and the failure mode was total
  // silence: the watcher reported nothing, which reads exactly like "nothing happened".
  it('flags a read of the PRIVATE keyring (~/.gnupg/secring.gpg)', () => {
    const m = matchSensitiveFile('/home/u/.gnupg/secring.gpg')
    expect(m).not.toBeNull()
    expect(m!.rule).toBe('gpg-private')
  })

  it('flags it on Windows-style paths too', () => {
    const m = matchSensitiveFile('C:\\Users\\u\\.gnupg\\secring.gpg')
    expect(m).not.toBeNull()
    expect(m!.rule).toBe('gpg-private')
  })

  it('still flags private key material in .gnupg (by whichever rule gets there first)', () => {
    // `.key` files are caught by `private-key-pem` before the gpg rule sees them. That is fine —
    // what matters is that the read IS flagged, not which rule takes credit.
    expect(matchSensitiveFile('/home/u/.gnupg/private-keys-v1.d/ABCDEF.key')).not.toBeNull()
  })

  it('does NOT flag the PUBLIC keyrings — those are not secrets, and crying wolf costs trust', () => {
    expect(matchSensitiveFile('/home/u/.gnupg/pubring.gpg')).toBeNull()
    expect(matchSensitiveFile('/home/u/.gnupg/pubring.kbx')).toBeNull()
  })

  it('does not flag a secring.gpg that is not in a .gnupg directory', () => {
    // The rule is scoped to the keyring directory on purpose; a stray file of that name in a repo
    // (a fixture, a doc) must not trip the watcher.
    expect(matchSensitiveFile('/home/u/project/secring.gpg')).toBeNull()
  })
})

describe('BUG: a literal NUL byte made a source file invisible to code search', () => {
  // src/main/mnemeSession.ts contained a raw U+0000 inside a string literal (an FNV-1a separator).
  // ripgrep classifies ANY file containing a NUL as binary and silently skips it — so
  // `grep -rn reflectSoloSession src/` found nothing, and the file could not be found by anyone
  // searching the codebase. Harmless at runtime; corrosive to every future reader.
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.cjs')) files.push(p)
    }
  }
  walk(resolve(__dirname, '../../src'))

  it('scanned a meaningful number of source files (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no source file contains a raw NUL byte', () => {
    // Built with fromCharCode, NOT a literal: embedding a raw NUL here would make THIS file binary,
    // and ripgrep would skip the very guard that exists to prevent that.
    const NUL = String.fromCharCode(0)
    const binary = files
      .filter((f) => readFileSync(f, 'utf8').includes(NUL))
      .map((f) => f.split(/[\\/]src[\\/]/)[1] ?? f)
    // A NUL belongs in source as a unicode ESCAPE: identical bytes at runtime, still a text file.
    expect(binary).toEqual([])
  })
})
