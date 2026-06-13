// OS-keychain-backed storage for the Groq API key. Reuses secureKeyStore
// (Electron safeStorage: DPAPI / Keychain / libsecret), so the key is encrypted
// at rest and tied to this OS user — and it lives in MAIN only. The renderer
// never receives the raw key; it only ever sees a masked hint + connected flag.
import * as fs from 'fs'
import * as path from 'path'
import { writeSecret, readSecret } from './secureKeyStore'

export function groqKeyPath(userDataDir: string): string {
  return path.join(userDataDir, 'groq-api-key')
}

export function setGroqKey(userDataDir: string, key: string): void {
  writeSecret(groqKeyPath(userDataDir), (key ?? '').trim())
}

export function getGroqKey(userDataDir: string): string | null {
  const v = readSecret(groqKeyPath(userDataDir))
  return v && v.trim() ? v.trim() : null
}

export function clearGroqKey(userDataDir: string): void {
  try {
    fs.rmSync(groqKeyPath(userDataDir), { force: true })
  } catch {
    /* already gone */
  }
}

/** A non-secret display hint: first/last 4 chars, middle masked. */
export function maskKey(key: string): string {
  const k = (key ?? '').trim()
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 4)}••••${k.slice(-4)}`
}

export interface GroqKeyStatus {
  connected: boolean
  hint: string
}

/** What the renderer is allowed to know: whether a key is set, and a masked hint. */
export function getGroqKeyStatus(userDataDir: string): GroqKeyStatus {
  const key = getGroqKey(userDataDir)
  if (!key) return { connected: false, hint: '' }
  return { connected: true, hint: maskKey(key) }
}
