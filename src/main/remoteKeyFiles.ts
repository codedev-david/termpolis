// The files that let this computer's phones and linked computers recognise it: the Remote identity
// key, the links this computer joined (each holding the key minted for it), and the paired-device
// registry beside them.
//
// Two user decisions act on them, and nothing else does: "Encrypt keys now" seals the key files
// still saved in the clear once a keychain is there to do it, and "Start over" sets all three aside
// when the keys can't be opened any more. Both go through secureKeyStore's verbs, so no key is ever
// written over or deleted.
import { inspectSecret, keyStorageMode, retireSecretFile, wrapSecretInPlace } from './secureKeyStore'
import { remoteIdentityPath } from './remoteIdentityStore'
import { linkedStatePath } from './linkedStore'
import { remoteDevicesPath } from './remoteDeviceStore'

/** The two files that hold secrets, identity first. remote-devices.json holds public keys only. */
function keyFiles(userDataDir: string): string[] {
  return [remoteIdentityPath(userDataDir), linkedStatePath(userDataDir)]
}

/** Key files saved in the clear although a keychain could seal them now -- what "Encrypt keys now"
 *  is for. None without a keychain: there is nothing to seal them with. */
export function unencryptedKeyFiles(userDataDir: string): string[] {
  if (keyStorageMode() !== 'keychain') return []
  return keyFiles(userDataDir).filter((p) => inspectSecret(p).state === 'plaintext')
}

/** "Encrypt keys now": seal each key file saved in the clear, one at a time. Each one is either
 *  sealed or exactly as it was, so a throw part-way leaves nothing half done. */
export function encryptKeyFiles(userDataDir: string): void {
  for (const p of keyFiles(userDataDir)) wrapSecretInPlace(p)
}

/** "Start over": rename the identity, the joined links and the device registry aside --
 *  `<name>.retired-<time>`, never deleted, so keys that open again some day can still be put back by
 *  hand. The identity goes first, and when it can't be moved this throws before anything else is
 *  touched: there is no starting over while it is still in the way. */
export function retireRemoteKeyFiles(userDataDir: string): void {
  retireIfThere(remoteIdentityPath(userDataDir))
  for (const p of [linkedStatePath(userDataDir), remoteDevicesPath(userDataDir)]) {
    try {
      retireIfThere(p)
    } catch {
      /* the hosts forget what it held anyway, and their next save writes over it */
    }
  }
}

function retireIfThere(filePath: string): void {
  try {
    retireSecretFile(filePath, 'start-over')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }
}
