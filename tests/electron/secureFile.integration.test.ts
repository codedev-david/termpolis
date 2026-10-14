// Integration test — hits the real filesystem and (on Windows) the real
// icacls binary. Runs without mocks so we can prove the helper actually
// locks down the file, not just that it calls the right APIs.
//
// This suite complements the unit suite (secureFile.test.ts) which mocks
// child_process. The unit tests prove the invocation is correct; this
// suite proves it has the desired effect on a real NTFS volume.
//
// Every icacls call here uses only the switches the app itself runs (/inheritance:r, /grant:r),
// plus /save, which only reads an ACL out — all on files under a temp folder.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, openSync, closeSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSecureFile, writeSecureFile } from '../../src/main/secureFile'
import { daclAces, daclSddl, fullControlPattern, lockdownProblems } from '../windowsAcl'

describe('writeSecureFile — real filesystem integration', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-secfile-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes content readable by current user', () => {
    const p = join(dir, 'secret')
    const r = writeSecureFile(p, 'topsecret')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('topsecret')
    expect(r.path).toBe(p)
  })

  it("the listing check survives icacls's OEM code page mangling a non-ASCII name", () => {
    // Piped, "José" comes back as "Jos" plus a replacement mark (or "?"), never as "José".
    expect(fullControlPattern('José').test('PC\\Jos�:(F)')).toBe(true)
    expect(fullControlPattern('José').test('PC\\Jos?:(F)')).toBe(true)
    expect(fullControlPattern('José').test('PC\\Jose:(R)')).toBe(false)
    expect(fullControlPattern('David Engelhart').test(' AzureAD\\David Engelhart:(F)')).toBe(true)
  })

  if (process.platform !== 'win32') {
    it('POSIX: file has mode 0o600 on disk', () => {
      const p = join(dir, 'secret')
      writeSecureFile(p, 'topsecret')
      const st = statSync(p)
      // Mask off the file-type bits — just compare permission bits
      expect(st.mode & 0o777).toBe(0o600)
    })
  }

  if (process.platform === 'win32') {
    const user = process.env.USERNAME || ''
    const domain = process.env.USERDOMAIN
    const principal = domain ? `${domain}\\${user}` : user
    const icacls = (target: string, ...args: string[]): void => {
      execFileSync('icacls', [target, ...args], { stdio: 'pipe', shell: false, windowsHide: true })
    }
    // What an ordinary reader gets. cmd's `type` opens the file without backup semantics, so a
    // DACL that shuts the user out shuts it out whatever privileges the session holds — unlike
    // Node: libuv opens every file with backup semantics, so a session holding the backup and
    // restore privileges (an elevated one can) reads and writes straight through any DACL.
    const typeFile = (p: string): { ok: boolean; text: string } => {
      const r = spawnSync('cmd', ['/d', '/c', 'type', p], { encoding: 'utf-8', windowsHide: true })
      return { ok: r.status === 0, text: r.stdout }
    }
    const nodeOpensForWrite = (p: string): boolean => {
      try { closeSync(openSync(p, 'r+')); return true } catch { return false }
    }
    // A folder shaped like an installed userData: it hands the user's full control down to every
    // file made in it, and nothing else. A CI runner's TEMP passes nothing inheritable, so a file
    // born there carries explicit ACEs for the user that /inheritance:r never removes, and no
    // lockout can be built from it; built in here, one shuts the user out on any machine.
    const userDataLike = (): string => {
      const d = join(dir, 'userData')
      mkdirSync(d)
      icacls(d, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`)
      return d
    }

    // The security property: the lockdown ran, nothing is inherited, no broad audience, and the
    // user holds full control. NT AUTHORITY\SYSTEM and BUILTIN\Administrators are deliberately NOT
    // asserted absent — see lockdownProblems in tests/windowsAcl.ts for why they may remain.
    it('Windows: the lockdown ran, nothing inherited, no broad audience, current user (F)', () => {
      const p = join(dir, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)
      expect(lockdownProblems(p, user)).toEqual([])
    })

    it('Windows: a second writeSecureFile on same path keeps broad-audience ACEs out', () => {
      const p = join(dir, 'secret')
      writeSecureFile(p, 'one')
      const r = writeSecureFile(p, 'two') // re-write
      expect(r.aclApplied).toBe(true)
      expect(lockdownProblems(p, user)).toEqual([])
      expect(readFileSync(p, 'utf-8')).toBe('two')
    })

    it('Windows: a file born in a folder that passes nothing inheritable is locked the same way', () => {
      // The CI runner's shape, reproduced on any machine. There the e2e userData folder hands
      // files no inheritable ACE, so mcp-token was born with explicit SYSTEM, Administrators and
      // user ACEs — the case the e2e caught. The folder here gets the app's own two switches:
      // a grant with no (OI)(CI), so nothing it holds is passed to the files made inside it.
      const bare = join(dir, 'no-inherit')
      mkdirSync(bare)
      icacls(bare, '/inheritance:r', '/grant:r', `${principal}:F`)

      const p = join(bare, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)
      // Born this way, the file already passes every check but one; the protected flag is what
      // proves the lockdown ran on it.
      expect(lockdownProblems(p, user)).toEqual([])
      expect(readFileSync(p, 'utf-8')).toBe('topsecret')
      writeSecureFile(p, 'again')
      expect(readFileSync(p, 'utf-8')).toBe('again')
    })

    it('Windows: born in that folder with NO lockdown, a file is still caught, by the protected flag alone', () => {
      // The user holds (F), nothing is inherited and no broad group is listed, so every other check
      // passes: the e2e's mcp-token on a CI runner would look locked even if the app never ran icacls.
      const bare = join(dir, 'no-inherit')
      mkdirSync(bare)
      icacls(bare, '/inheritance:r', '/grant:r', `${principal}:F`)
      const p = join(bare, 'never-locked')
      writeFileSync(p, 'x')

      expect(lockdownProblems(p, user)).toEqual([expect.stringContaining('the lockdown never ran')])
    })

    // Files an older Termpolis locked. Its two-call sequence (/inheritance:r, then /grant:r of the
    // bare, stripped USERNAME) could leave a file with no ACE at all, or with full control for a
    // same-named local account instead of the user. Each case first proves the user really is shut
    // out — to an ordinary reader, cmd's `type` — and ends with that reader getting the new content.
    describe('Windows: a file an older Termpolis locked', () => {
      it('an empty DACL: the token is written and the user can read it again', () => {
        const f = join(userDataLike(), 'f')
        writeFileSync(f, 'old')
        icacls(f, '/inheritance:r') // what the old first call left when its grant then failed
        expect(typeFile(f).ok, 'premise: the user is shut out').toBe(false)

        const r = writeSecureFile(f, 'new', { replaceIfLocked: true })
        expect(r.aclApplied).toBe(true)
        expect(typeFile(f)).toEqual({ ok: true, text: 'new' })
        expect(lockdownProblems(f, user)).toEqual([])
      })

      it("another account's grant does not survive the repair", () => {
        // LOCAL SERVICE (alias LS) stands in for the local account that captured the bare name.
        // Granting the user into this DACL would leave LS there, reading every token after it.
        const f = join(userDataLike(), 'f')
        writeFileSync(f, 'old')
        icacls(f, '/inheritance:r', '/grant:r', '*S-1-5-19:F')
        expect(daclAces(daclSddl(f)).map((a) => a.trustee)).toEqual(['LS'])
        expect(typeFile(f).ok, 'premise: the user is shut out').toBe(false)
        // A session that writes through any DACL would write in place and never meet the lockout;
        // the read-only attribute refuses the write to every session, so the repair runs there too.
        if (nodeOpensForWrite(f)) chmodSync(f, 0o444)

        const r = writeSecureFile(f, 'new', { replaceIfLocked: true })
        expect(r.aclApplied).toBe(true)
        expect(typeFile(f)).toEqual({ ok: true, text: 'new' })
        expect(daclAces(daclSddl(f)).map((a) => a.trustee)).not.toContain('LS')
        expect(lockdownProblems(f, user)).toEqual([])
      })

      it('a read-only one is replaced too: the delete ignores the attribute', () => {
        const f = join(dir, 'f')
        writeFileSync(f, 'old')
        chmodSync(f, 0o444)

        const r = writeSecureFile(f, 'new', { replaceIfLocked: true })
        expect(r.aclApplied).toBe(true)
        expect(r.writeRetries).toBeGreaterThanOrEqual(4)
        expect(readFileSync(f, 'utf-8')).toBe('new')
        expect(statSync(f).mode & 0o200, 'a new, writable file took its place').not.toBe(0)
      })

      it('a store that cannot be written keeps what it holds: nothing is deleted or reopened', () => {
        // Without replaceIfLocked: this process may never have read what the store holds.
        const f = join(dir, 'store.json')
        writeFileSync(f, 'on disk')
        chmodSync(f, 0o444)

        expect(() => writeSecureFile(f, 'only what is in memory')).toThrow()
        expect(readFileSync(f, 'utf-8')).toBe('on disk')
      })

      it('readSecureFile reads a store another account was granted, and leaves only the user in', () => {
        const f = join(userDataLike(), 'store.json')
        writeFileSync(f, '{"paths":[]}')
        icacls(f, '/inheritance:r', '/grant:r', '*S-1-5-19:F')
        expect(typeFile(f).ok, 'premise: the user is shut out').toBe(false)
        // Nothing forces a READ refusal on a session that reads through any DACL, so the repair is
        // checked only where a plain read is refused — as it is for a user who is not elevated.
        let plainReadRefused = false
        try { readFileSync(f, 'utf-8') } catch { plainReadRefused = true }

        expect(readSecureFile(f)).toBe('{"paths":[]}')
        if (plainReadRefused) {
          expect(typeFile(f)).toEqual({ ok: true, text: '{"paths":[]}' })
          expect(daclAces(daclSddl(f)).map((a) => a.trustee)).not.toContain('LS')
          expect(lockdownProblems(f, user)).toEqual([])
        }
      })
    })
  }
})
