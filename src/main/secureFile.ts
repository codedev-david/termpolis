// writeSecureFile — writes a file that should only be readable by the
// current user. On POSIX this is a plain writeFileSync with mode 0o600.
// On Windows the mode flag is a no-op (NTFS uses ACLs, not POSIX perms),
// so one icacls call drops the ACEs the parent folder hands down and grants
// the current user full control. Without it, other local users on a shared
// machine could read the MCP auth token through those inherited grants.
//
// What that call deliberately leaves alone: explicit ACEs the file was BORN
// with. When the parent folder passes nothing inheritable (an fs.mkdtemp
// directory, say), Windows stamps the creating token's default DACL onto the
// new file instead — SYSTEM and Administrators beside the user. Both can read
// every file on the machine anyway, so removing them would change no one's
// access, while a Termpolis child process stripping SYSTEM/Administrators at
// every boot is exactly the permission change an endpoint monitor flags. So
// the switches stay the two every boot has always run, now in a single call.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
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
// What Windows reports when a file's ACL shuts us out. Both are transient codes
// above too, so a file only counts as locked out once every retry has failed.
const ACCESS_DENIED = new Set(['EPERM', 'EACCES'])
const MAX_WRITE_ATTEMPTS = 4
const BACKOFF_MS = [50, 120, 250]
const WRITE_OPTIONS = { encoding: 'utf-8', mode: 0o600 } as const

// icacls's exit status when a name maps to no account (ERROR_NONE_MAPPED). It
// fails before touching the file, so the single call is all or nothing.
const NONE_MAPPED = 1332

// A bare account name, or DOMAIN\account — some MSYS shells hand USER over that way.
const ACCOUNT_SHAPE = /^(?:([^\\]+)\\)?([^\\]+)$/
// Characters Windows forbids in account and domain names, plus the controls.
// Several are icacls syntax — ':' separates the rights, a leading '*' means a
// SID, '/' starts a switch — so a name carrying one is refused, never edited.
// Editing is what the old strip-to-ASCII did, and it turned "José" into "Jos":
// a different name, which can belong to a different account.
const NOT_A_NAME = /[\u0000-\u001f\u007f"/\\[\]:;|=,+*?<>]/

function sleepSync(ms: number) {
  // Deliberately block — writeSecureFile is sync by contract (main-process
  // boot path). A 50-250ms stall during a file-lock race is acceptable;
  // going async would ripple through every caller.
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin */ }
}

export function writeSecureFile(path: string, content: string): SecureFileResult {
  let attempts: number
  try {
    attempts = writeWithRetries(path, content)
  } catch (e) {
    if (!lockedOut(e, path)) throw e
    attempts = MAX_WRITE_ATTEMPTS + reopenAndWrite(path, content, e)
  }

  const writeRetries = attempts - 1

  if (process.platform !== 'win32') {
    return { path, aclApplied: true, writeRetries }
  }
  return { path, ...lockToCurrentUser(path), writeRetries }
}

/**
 * readFileSync(path, 'utf-8') for a file writeSecureFile manages, which also reopens one an
 * older Termpolis locked its owner out of (see reopenAndWrite). Without the repair a locked
 * trust store reads as empty on every boot, and the next save replaces the user's real list.
 */
export function readSecureFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch (e) {
    if (!lockedOut(e, path)) throw e
    lockToCurrentUser(path)
    return readFileSync(path, 'utf-8')
  }
}

function writeWithRetries(path: string, content: string): number {
  for (let i = 0; ; i++) {
    try {
      writeFileSync(path, content, WRITE_OPTIONS)
      return i + 1
    } catch (e) {
      if (!RETRYABLE_ERRNO.has(errnoCode(e)) || i === MAX_WRITE_ATTEMPTS - 1) throw e
      sleepSync(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)])
    }
  }
}

/** A Windows access-denied on a file that is already there: its ACL, not a passing lock. */
function lockedOut(e: unknown, path: string): boolean {
  return process.platform === 'win32' && ACCESS_DENIED.has(errnoCode(e)) && existsSync(path)
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/**
 * Get back into a file the older two-call icacls sequence locked. It stripped inheritance in
 * one call and granted in a second, and when the grant named no account — its sanitizer made
 * "David Engelhart" into "DavidEngelhart" — the file was left with an EMPTY DACL, which every
 * later write and read hit as EPERM. The owner keeps WRITE_DAC whatever the DACL says, so the
 * grant alone reopens it; failing that, the folder's delete-child right lets it be replaced
 * outright, which loses nothing because every caller writes the whole file. Returns the
 * extra attempts it took, or throws `cause` when neither worked.
 */
function reopenAndWrite(path: string, content: string, cause: unknown): number {
  lockToCurrentUser(path)
  try {
    writeFileSync(path, content, WRITE_OPTIONS)
    return 1
  } catch { /* still shut out: replace the file */ }
  try {
    unlinkSync(path)
    writeFileSync(path, content, WRITE_OPTIONS)
    return 2
  } catch {
    throw cause
  }
}

interface AclPrincipal {
  /** DOMAIN\user when the domain is known, so a same-named local account can't take the grant. */
  principal: string
  /** The bare account, tried once if the qualified name maps to no account. */
  bare?: string
}

function resolveAclPrincipal(env: NodeJS.ProcessEnv): AclPrincipal | { error: string } {
  const raw = (env.USERNAME || env.USER || '').trim()
  if (!raw) return { error: 'No USERNAME env var' }
  const [, named, account] = ACCOUNT_SHAPE.exec(raw) ?? []
  if (!account || NOT_A_NAME.test(account) || (named !== undefined && NOT_A_NAME.test(named))) {
    return { error: `USERNAME ${JSON.stringify(raw)} is not an account name icacls can be given` }
  }
  // LocalSystem's USERNAME is the computer account, COMPUTER$. On a domain-joined machine that
  // name resolves — to an AD account this process never runs as — so it must not get the grant.
  if (account.endsWith('$')) {
    return { error: `USERNAME ${JSON.stringify(raw)} is a machine account, not a user to lock the file to` }
  }
  const domain = (named ?? env.USERDOMAIN ?? '').trim()
  if (!domain || NOT_A_NAME.test(domain)) return { principal: account }
  return { principal: `${domain}\\${account}`, bare: account }
}

/** The one icacls call: drop the inherited ACEs, grant this user full control. Returns its failure. */
function grantOnlyUser(path: string, principal: string): { status?: number; message: string } | null {
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${principal}:F`], {
      // Piped rather than ignored: on failure Node appends icacls's stderr to the message,
      // the only place its reason ("No mapping between account names...") is printed.
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
      timeout: 5000,
    })
    return null
  } catch (e) {
    const failed = e as { status?: number; message?: string } | null
    return { status: failed?.status, message: failed?.message || String(e) }
  }
}

/**
 * Lock `path` to the current user, or say why not. A failure leaves the file with the ACL it
 * already had, never a half-applied one, so the caller can log the reason and carry on: the
 * worst case on a shared Windows box is that other local users could read the file; on a
 * single-user laptop (the common case) it changes nothing.
 */
function lockToCurrentUser(path: string): { aclApplied: boolean; aclError?: string } {
  // Skip the icacls spawn when the caller opts out — spawning a child process per write busts
  // vitest's default 5s timeout when a test writes the same store several times. Tests that
  // specifically verify the ACL behavior (secureFile.test.ts) mock execFileSync instead and
  // must NOT set this flag. The e2e suite still covers the real Windows ACL path.
  if (process.env.TERMPOLIS_SKIP_ACL) {
    return { aclApplied: false, aclError: 'skipped (TERMPOLIS_SKIP_ACL)' }
  }
  const who = resolveAclPrincipal(process.env)
  if ('error' in who) return { aclApplied: false, aclError: who.error }
  let failure = grantOnlyUser(path, who.principal)
  // The domain did not resolve (offline, or a stale USERDOMAIN): once more with the bare name.
  if (failure?.status === NONE_MAPPED && who.bare) failure = grantOnlyUser(path, who.bare)
  return failure ? { aclApplied: false, aclError: failure.message } : { aclApplied: true }
}
