// Integration test — hits the real filesystem and (on Windows) the real
// icacls binary. Runs without mocks so we can prove the helper actually
// locks down the file, not just that it calls the right APIs.
//
// This suite complements the unit suite (secureFile.test.ts) which mocks
// child_process. The unit tests prove the invocation is correct; this
// suite proves it has the desired effect on a real NTFS volume.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'fs'
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
    // The security property we actually care about: non-privileged local
    // users (Everyone, Users, Authenticated Users) cannot read this file.
    // We deliberately do NOT assert absence of BUILTIN\Administrators or
    // NT AUTHORITY\SYSTEM — when the owner of the file IS an admin (which
    // is true on GHA's `runneradmin` account, on single-user dev laptops
    // running as admin, and on any managed Windows box where the user has
    // elevation), icacls /inheritance:r cannot strip those ACEs. Those
    // principals already have read access to every file on the system by
    // definition, so their presence does not change the security posture.
    it('Windows: icacls output grants current user (F) and excludes general read groups', () => {
      const p = join(dir, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)

      const out = execFileSync('icacls', [p], {
        encoding: 'utf-8',
        shell: false,
        windowsHide: true,
      })

      const user = (process.env.USERNAME || '').replace(/[^A-Za-z0-9._\\-]/g, '')
      expect(out).toContain(user)
      expect(out).toContain('(F)')
      // The actual security boundary: no broad-audience read principals.
      expect(out).not.toContain('Everyone')
      expect(out).not.toContain('BUILTIN\\Users')
      expect(out).not.toMatch(/Authenticated Users/i)
      expect(out).toMatch(/Successfully processed 1 files/i)
    })

    it('Windows: a second writeSecureFile on same path keeps broad-audience ACEs out', () => {
      const p = join(dir, 'secret')
      writeSecureFile(p, 'one')
      writeSecureFile(p, 'two') // re-write
      const out = execFileSync('icacls', [p], {
        encoding: 'utf-8',
        shell: false,
        windowsHide: true,
      })
      expect(out).not.toContain('Everyone')
      expect(out).not.toContain('BUILTIN\\Users')
      expect(out).not.toMatch(/Authenticated Users/i)
      expect(readFileSync(p, 'utf-8')).toBe('two')
    })
  }
})
