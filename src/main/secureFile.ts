// writeSecureFile — writes a file that should only be readable by the
// current user. On POSIX this is a plain writeFileSync with mode 0o600.
// On Windows the mode flag is a no-op (NTFS uses ACLs, not POSIX perms),
// so we invoke icacls to strip inherited ACEs and grant access only to
// the current user. Without this, other local users on a shared machine
// could read the MCP auth token.

import { writeFileSync } from 'fs'
import { execFileSync } from 'child_process'

export interface SecureFileResult {
  path: string
  aclApplied: boolean
  aclError?: string
}

export function writeSecureFile(path: string, content: string): SecureFileResult {
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 })

  if (process.platform !== 'win32') {
    return { path, aclApplied: true }
  }

  // Skip the icacls dance when the caller opts out — spawning two child
  // processes per write busts vitest's default 5s timeout when a test writes
  // the same store several times. Tests that specifically verify the ACL
  // behavior (secureFile.test.ts) mock execFileSync instead and must NOT
  // set this flag. The e2e suite still covers the real Windows ACL path.
  if (process.env.TERMPOLIS_SKIP_ACL) {
    return { path, aclApplied: false, aclError: 'skipped (TERMPOLIS_SKIP_ACL)' }
  }

  // Windows: use icacls to lock the file down to the current user.
  // USERNAME is sanitized to [A-Za-z0-9._-] to keep it argv-safe even
  // though execFileSync runs without a shell.
  const rawUser = process.env.USERNAME || process.env.USER || ''
  const user = rawUser.replace(/[^A-Za-z0-9._\\-]/g, '')
  if (!user) {
    return { path, aclApplied: false, aclError: 'No USERNAME env var' }
  }

  try {
    // /inheritance:r drops all inherited ACEs so parent-folder grants
    // don't leak access. /grant:r replaces any existing ACE for this user.
    execFileSync('icacls', [path, '/inheritance:r'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: 5000,
    })
    execFileSync('icacls', [path, '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: 5000,
    })
    return { path, aclApplied: true }
  } catch (e: any) {
    // Don't fail the write — file is already on disk with default ACL.
    // Caller can log the warning and continue. Worst case on a shared
    // Windows box is other local users could read the token; on a
    // single-user laptop (the common case) this changes nothing.
    return { path, aclApplied: false, aclError: e?.message || String(e) }
  }
}
