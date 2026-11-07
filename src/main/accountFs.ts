// The one door every file the accounts code touches goes through. It refuses an agent's sign-in
// files outright (a read, a write, a copy, a link, a stat), so no code path added for accounts
// can ever open a credential: Termpolis tells who a profile is signed in to from the email in its
// config, or by asking the agent's own CLI, never from the sign-in itself. A unit test fails if
// any accounts module names those files anywhere but CREDENTIAL_BASENAMES.
//
// Claude Code's `.claude.json` is a second class: Termpolis edits it (its MCP entry, folder trust)
// through agentIntegrationManager's byte-safe edit path, but a Console sign-in's key can live in
// it (`primaryApiKey`), so this seam reads it only for named fields and never hands it out whole.
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'fs'
import type { Dirent, Stats } from 'fs'
import { basename, resolve, sep } from 'path'
import { renameWithRetry } from './agentConfigIO'

/** Files that hold an agent's sign-in, or any other credential. Never opened, in any way. */
export const CREDENTIAL_BASENAMES: readonly string[] = [
  '.credentials.json', 'auth.json', 'oauth_creds.json', 'mcp-oauth-tokens.json', '.git-credentials',
]

/** Folders whose contents are all credentials. */
const CREDENTIAL_FOLDERS: readonly string[] = ['.ssh', '.aws']

/** Read only through readClaudeJsonFields. */
const CLAUDE_JSON = '.claude.json'

/** No config the accounts code reads is anywhere near this. */
export const MAX_READ_BYTES = 4 * 1024 * 1024

function fold(s: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s
}

/** Is `p` a credential file, or inside a credential folder? */
export function isCredentialPath(p: string): boolean {
  const full = resolve(p)
  if (CREDENTIAL_BASENAMES.some((n) => fold(n) === fold(basename(full)))) return true
  return full.split(/[\\/]+/).some((part) => CREDENTIAL_FOLDERS.some((f) => fold(f) === fold(part)))
}

export class CredentialPathError extends Error {
  constructor() {
    super('refused: that is a sign-in file, which Termpolis never opens')
    this.name = 'CredentialPathError'
  }
}

/** Throws for a credential path. Every operation below calls it on every path it is given. */
export function assertNotCredential(p: string): void {
  if (typeof p !== 'string' || !p || isCredentialPath(p)) throw new CredentialPathError()
}

function assertReadable(p: string): void {
  assertNotCredential(p)
  if (fold(basename(resolve(p))) === CLAUDE_JSON) throw new Error('refused: .claude.json is read only for named fields')
}

export interface AccountFs {
  exists(p: string): boolean
  lstat(p: string): Stats | null
  stat(p: string): Stats | null
  readText(p: string, cap?: number): string | null
  readDir(p: string): Dirent[]
  readLink(p: string): string | null
  realpath(p: string): string | null
  mkdir(p: string, mode?: number): void
  link(target: string, at: string): void
  unlinkLink(p: string): void
  removeFile(p: string): void
  removeEmptyDir(p: string): void
  rename(from: string, to: string): void
  writePrivate(p: string, text: string): void
  /** A transcript carried to another profile (accountCarry.ts): a file, never a link, never
   *  `.claude.json`, kept private. */
  copyFile(from: string, to: string): void
}

/** The real filesystem, behind the tripwire. */
export const accountFs: AccountFs = {
  exists(p) {
    assertNotCredential(p)
    return existsSync(p)
  },
  lstat(p) {
    assertNotCredential(p)
    try { return lstatSync(p) } catch { return null }
  },
  stat(p) {
    assertNotCredential(p)
    try { return statSync(p) } catch { return null }
  },
  readText(p, cap = MAX_READ_BYTES) {
    assertReadable(p)
    let size: number
    try { size = statSync(p).size } catch { return null }
    if (size > cap) throw new Error(`larger than ${cap} bytes`)
    return readFileSync(p, 'utf-8')
  },
  readDir(p) {
    assertNotCredential(p)
    return readdirSync(p, { withFileTypes: true })
  },
  readLink(p) {
    assertNotCredential(p)
    try { return readlinkSync(p) } catch { return null }
  },
  realpath(p) {
    assertNotCredential(p)
    try { return realpathSync.native(p) } catch { return null }
  },
  mkdir(p, mode = 0o700) {
    assertNotCredential(p)
    mkdirSync(p, { mode })
  },
  link(target, at) {
    assertNotCredential(target)
    assertNotCredential(at)
    // A junction needs no admin rights and no developer mode on Windows; elsewhere a symlink.
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  },
  unlinkLink(p) {
    assertNotCredential(p)
    const s = lstatSync(p)
    if (!s.isSymbolicLink()) throw new Error(`${p} is not a link`)
    // A junction is removed as the empty folder it looks like; rmdir never follows it.
    if (process.platform === 'win32') rmdirSync(p)
    else unlinkSync(p)
  },
  removeFile(p) {
    assertNotCredential(p)
    const s = lstatSync(p)
    if (!s.isFile()) throw new Error(`${p} is not a file`)
    unlinkSync(p)
  },
  removeEmptyDir(p) {
    assertNotCredential(p)
    rmdirSync(p)
  },
  rename(from, to) {
    assertNotCredential(from)
    assertNotCredential(to)
    renameWithRetry(from, to, renameSync)
  },
  copyFile(from, to) {
    assertReadable(from)
    assertNotCredential(to)
    if (fold(basename(resolve(to))) === CLAUDE_JSON) throw new Error('refused: .claude.json is never copied')
    if (!lstatSync(from).isFile()) throw new Error(`${from} is not a file`)
    copyFileSync(from, to)
    chmodSync(to, 0o600)
  },
  writePrivate(p, text) {
    assertNotCredential(p)
    if (fold(basename(resolve(p))) === CLAUDE_JSON) throw new Error('refused: .claude.json is edited only by agent integration')
    const tmp = `${p}.termpolis-${process.pid}.tmp`
    try {
      writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameWithRetry(tmp, p, renameSync)
    } catch (e) {
      try { chmodSync(tmp, 0o600) } catch { /* never created */ }
      try { unlinkSync(tmp) } catch { /* never created */ }
      throw e
    }
  },
}

/** A field of a parsed JSON object by dotted path, when it is a string, number or boolean. */
function fieldAt(root: unknown, path: string): string | number | boolean | undefined {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' ? node : undefined
}

export type ClaudeJsonFields = { kind: 'ok'; values: Record<string, string | number | boolean | undefined> } | { kind: 'missing' } | { kind: 'unreadable' }

/**
 * Only the named scalar fields of a Claude Code `.claude.json`. The parsed object never leaves
 * this function, so a key kept there (a Console sign-in's `primaryApiKey`) can't reach the
 * renderer, a log line, an error message or a crash report; a parse error is reported as
 * "unreadable", with no content.
 */
export function readClaudeJsonFields(file: string, fields: readonly string[]): ClaudeJsonFields {
  try {
    assertNotCredential(file)
    if (fold(basename(resolve(file))) !== CLAUDE_JSON) return { kind: 'unreadable' }
    if (!existsSync(file)) return { kind: 'missing' }
    if (statSync(file).size > 32 * 1024 * 1024) return { kind: 'unreadable' }
    const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
    const root: unknown = text.trim() ? JSON.parse(text) : {}
    const values: Record<string, string | number | boolean | undefined> = {}
    for (const f of fields) values[f] = fieldAt(root, f)
    return { kind: 'ok', values }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** Is `child` (links resolved by `realpath`) the same folder as `parent` or inside it? */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = fold(child.replace(/[\\/]+$/, ''))
  const p = fold(parent.replace(/[\\/]+$/, ''))
  return c === p || c.startsWith(p + sep) || c.startsWith(p + '/')
}
