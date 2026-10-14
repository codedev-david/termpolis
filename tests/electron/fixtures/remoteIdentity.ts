import { resolveRemoteIdentity, type RemoteIdentity } from '../../../src/main/remoteIdentityStore'

/** The identity a test's userData holds, minted the way the host mints it. Throws for a locked one:
 *  every caller sets up a working keychain first, so a lock here is the bug under test. */
export function identityOf(dir: string): RemoteIdentity {
  const resolved = resolveRemoteIdentity(dir)
  if (resolved.kind !== 'ok') throw new Error(`the identity is locked (${resolved.reason})`)
  return resolved.identity
}
