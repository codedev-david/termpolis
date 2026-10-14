// Integration test — hits the real filesystem and (on Windows) the real
// icacls binary. Runs without mocks so we can prove the helper actually
// locks down the file, not just that it calls the right APIs.
//
// This suite complements the unit suite (secureFile.test.ts) which mocks
// child_process. The unit tests prove the invocation is correct; this
// suite proves it has the desired effect on a real NTFS volume.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSecureFile } from '../../src/main/secureFile'

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
    const icacls = (p: string): string =>
      execFileSync('icacls', [p], { encoding: 'utf-8', shell: false, windowsHide: true })
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // The security property we actually care about: the file carries no ACE handed down from
    // its folder, the current user holds full control, and non-privileged local users
    // (Everyone, Users, Authenticated Users) cannot read it.
    //
    // NT AUTHORITY\SYSTEM and BUILTIN\Administrators are deliberately NOT asserted absent. A file
    // born in a folder that passes nothing inheritable gets the creating token's default DACL as
    // EXPLICIT ACEs — on GHA's `runneradmin`, and on any elevated session, that is SYSTEM and
    // Administrators beside the user — and the one icacls call (inheritance:r + grant:r) leaves
    // explicit ACEs alone by design. Both principals can read every file on the machine anyway,
    // so removing them would change no one's access, and a Termpolis child stripping them at
    // every boot is a permission change endpoint monitors flag.
    const expectLockedToUser = (out: string): void => {
      const user = process.env.USERNAME || ''
      expect(out).toMatch(new RegExp(`[\\s\\\\]${escape(user)}:\\(F\\)`, 'i'))
      expect(out).not.toContain('(I)')
      // The actual security boundary: no broad-audience read principals.
      expect(out).not.toContain('Everyone')
      expect(out).not.toContain('BUILTIN\\Users')
      expect(out).not.toMatch(/Authenticated Users/i)
      expect(out).toMatch(/Successfully processed 1 files/i)
    }

    it('Windows: icacls output grants current user (F), nothing inherited, no general read groups', () => {
      const p = join(dir, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)
      expectLockedToUser(icacls(p))
    })

    it('Windows: a second writeSecureFile on same path keeps broad-audience ACEs out', () => {
      const p = join(dir, 'secret')
      writeSecureFile(p, 'one')
      const r = writeSecureFile(p, 'two') // re-write
      expect(r.aclApplied).toBe(true)
      expectLockedToUser(icacls(p))
      expect(readFileSync(p, 'utf-8')).toBe('two')
    })

    it('Windows: a file born in a folder that passes nothing inheritable is locked the same way', () => {
      // The CI runner's shape, reproduced on any machine. There the e2e userData folder hands
      // files no inheritable ACE, so mcp-token was born with explicit SYSTEM, Administrators and
      // user ACEs — the case the e2e caught. The folder here gets the app's own two switches:
      // a grant with no (OI)(CI), so nothing it holds is passed to the files made inside it.
      const bare = join(dir, 'no-inherit')
      mkdirSync(bare)
      const user = process.env.USERNAME || ''
      const domain = process.env.USERDOMAIN
      execFileSync('icacls', [bare, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\${user}` : user}:F`], {
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
      })

      const p = join(bare, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)
      expectLockedToUser(icacls(p))
      expect(readFileSync(p, 'utf-8')).toBe('topsecret')
      writeSecureFile(p, 'again')
      expect(readFileSync(p, 'utf-8')).toBe('again')
    })
  }
})
