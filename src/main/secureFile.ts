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
  writeRetries?: number
}

// Transient Windows errors we retry on: OneDrive sync holding the file,
// AV scanner briefly locking it, cloud backup agents, indexer, etc.
const RETRYABLE_ERRNO = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])
const MAX_WRITE_ATTEMPTS = 4
const BACKOFF_MS = [50, 120, 250]

function sleepSync(ms: number) {
  // Deliberately block — writeSecureFile is sync by contract (main-process
  // boot path). A 50-250ms stall during a file-lock race is acceptable;
  // going async would ripple through every caller.
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin */ }
}

export function writeSecureFile(path: string, content: string): SecureFileResult {
  let lastErr: any
  let attempts = 0
  for (let i = 0; i < MAX_WRITE_ATTEMPTS; i++) {
    attempts = i + 1
    try {
      writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 })
      lastErr = null
      break
    } catch (e: any) {
      lastErr = e
      if (!RETRYABLE_ERRNO.has(e?.code) || i === MAX_WRITE_ATTEMPTS - 1) throw e
      sleepSync(BACKOFF_MS[i] ?? 250)
    }
  }
  if (lastErr) throw lastErr

  const writeRetries = attempts - 1

  if (process.platform !== 'win32') {
    return { path, aclApplied: true, writeRetries }
  }

  // Skip the icacls dance when the caller opts out — spawning two child
  // processes per write busts vitest's default 5s timeout when a test writes
  // the same store several times. Tests that specifically verify the ACL
  // behavior (secureFile.test.ts) mock execFileSync instead and must NOT
  // set this flag. The e2e suite still covers the real Windows ACL path.
  if (process.env.TERMPOLIS_SKIP_ACL) {
    return { path, aclApplied: false, aclError: 'skipped (TERMPOLIS_SKIP_ACL)', writeRetries }
  }

  // Windows: use icacls to lock the file down to the current user.
  // USERNAME is sanitized to [A-Za-z0-9._\\-] to keep it argv-safe even
  // though execFileSync runs without a shell. The backslash allows
  // DOMAIN\user; unicode/spaces fall through to icacls-error (harmless —
  // file remains on disk with default inherited ACL).
  const rawUser = process.env.USERNAME || process.env.USER || ''
  const user = rawUser.replace(/[^A-Za-z0-9._\\-]/g, '')
  if (!user) {
    return { path, aclApplied: false, aclError: 'No USERNAME env var', writeRetries }
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
    return { path, aclApplied: true, writeRetries }
  } catch (e: any) {
    // Don't fail the write — file is already on disk with default ACL.
    // Caller can log the warning and continue. Worst case on a shared
    // Windows box is other local users could read the token; on a
    // single-user laptop (the common case) this changes nothing.
    return { path, aclApplied: false, aclError: e?.message || String(e), writeRetries }
  }
}
