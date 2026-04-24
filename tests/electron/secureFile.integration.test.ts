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
    it('Windows: icacls /L shows only current user with (F) grant', () => {
      const p = join(dir, 'secret')
      const r = writeSecureFile(p, 'topsecret')
      expect(r.aclApplied).toBe(true)

      // Query the ACL with icacls. Output looks like:
      //   C:\...\secret SOMEBOX\david:(F)
      //   Successfully processed 1 files; Failed processing 0 files
      const out = execFileSync('icacls', [p], {
        encoding: 'utf-8',
        shell: false,
        windowsHide: true,
      })

      // Every ACE line should reference our user. Because /inheritance:r
      // drops inherited ACEs and we only grant the current user, there
      // should be no Administrators, SYSTEM, or Everyone ACEs.
      const user = (process.env.USERNAME || '').replace(/[^A-Za-z0-9._\\-]/g, '')
      expect(out).toContain(user)
      expect(out).toContain('(F)')
      // These would indicate inheritance wasn't dropped
      expect(out).not.toContain('BUILTIN\\Administrators')
      expect(out).not.toContain('NT AUTHORITY\\SYSTEM')
      expect(out).not.toContain('Everyone')
      expect(out).toMatch(/Successfully processed 1 files/i)
    })

    it('Windows: a second writeSecureFile on same path keeps ACL tight', () => {
      const p = join(dir, 'secret')
      writeSecureFile(p, 'one')
      writeSecureFile(p, 'two') // re-write
      const out = execFileSync('icacls', [p], {
        encoding: 'utf-8',
        shell: false,
        windowsHide: true,
      })
      // Still no inherited ACEs after re-apply
      expect(out).not.toContain('BUILTIN\\Administrators')
      expect(out).not.toContain('Everyone')
      expect(readFileSync(p, 'utf-8')).toBe('two')
    })
  }
})
