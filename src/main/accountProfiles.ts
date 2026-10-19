// Making a profile folder for a new Claude Code or Codex account (Settings ▸ Accounts ▸ Add).
//
// A new folder is built in `~/.claude-<slug>.partial-<6 hex>` and renamed into place only once
// every step worked; the registry entry is written last, after the rename. On any failure
// Termpolis removes only what it made, one item at a time: each link it recorded (after checking
// it IS a link: a junction on Windows is removed with rmdir, which never follows it), each file
// it copied, by name, then the folder if it is empty. Never a recursive delete, which through a
// junction would wipe the folder the junction points at.
//
// A new folder shares some subfolders with the main profile by a link (`projects` is what makes
// a Claude Code conversation resumable on another account, `sessions` the same for Codex), and
// can start from a COPY of the main profile's settings that leaves out everything that can hold
// a key or a token. A sign-in is never copied, linked or read: refresh tokens rotate on use, so a
// copied one dies as soon as another holder refreshes. Each account signs in by itself.
import { randomBytes } from 'crypto'
import { join } from 'path'
import { ACCOUNT_AGENT_LABEL, DEFAULT_PROFILE_FOLDER, SHAREABLE_FOLDERS } from '../shared/agentAccounts'
import type { AccountLink, ProfileAgent } from '../shared/agentAccounts'
import { accountFs } from './accountFs'
import type { AccountFs } from './accountFs'
import { defaultProfileDir, isReachable, launchString } from './agentAccounts'
import { formatJsonLike } from './agentConfigIO'
import { stripTermpolisEntries } from './agentMcpRegistry'
import { stripCodexSecrets } from './codexConfigEdit'

/** The settings.json keys a copy keeps: none of them can hold a secret. Everything else, `env`
 *  above all (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN …), `apiKeyHelper`,
 *  `awsAuthRefresh`, `awsCredentialExport` and `otelHeadersHelper`, is left out and named. */
export const SETTINGS_COPY_KEYS: readonly string[] = [
  'model', 'effortLevel', 'alwaysThinkingEnabled', 'permissions', 'hooks', 'statusLine', 'outputStyle', 'theme',
  'enabledPlugins', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'spinnerTipsEnabled',
  'skipDangerousModePermissionPrompt', 'autoUpdates',
]

export interface CopyResult {
  text: string
  /** Settings left out, by name only. */
  leftOut: string[]
}

/** A Claude Code settings.json for a new profile: the allow-listed keys, with Termpolis's own
 *  entries taken out (connecting puts them back through the normal, consented path). */
export function strippedClaudeSettings(text: string): CopyResult | { error: string } {
  const body = text.replace(/^\uFEFF/, '')
  let root: unknown
  try {
    root = body.trim() ? JSON.parse(body) : {}
  } catch {
    return { error: 'the main profile\'s settings.json is not valid JSON' }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { error: 'the main profile\'s settings.json is not a JSON object' }
  const kept: Record<string, unknown> = {}
  const leftOut: string[] = []
  for (const [k, v] of Object.entries(root)) {
    if (SETTINGS_COPY_KEYS.includes(k)) kept[k] = v
    else leftOut.push(k)
  }
  const strip = stripTermpolisEntries(kept)
  if (typeof strip === 'object') return { error: `the main profile's settings.json can't be copied: ${strip.skipped}` }
  return { text: formatJsonLike(kept, text), leftOut: leftOut.sort() }
}

/** A Codex config.toml for a new home, without what can carry a credential (stripCodexSecrets). */
export function strippedCodexConfig(text: string): CopyResult | { error: string } {
  const r = stripCodexSecrets(text)
  return 'error' in r ? { error: `the main profile's config.toml can't be copied: ${r.error}` } : r
}

export interface CreateProfileOptions {
  agent: ProfileAgent
  home: string
  /** The folder-name part: `[a-z0-9-]{1,32}` (slugOf). */
  slug: string
  /** Subfolders to link to the main profile's (names from SHAREABLE_FOLDERS). */
  share: readonly string[]
  /** Start from a stripped copy of the main profile's settings. */
  copy: boolean
  /** Write the registry entry, after the rename: returns why it couldn't, or null. A failure
   *  undoes the folder like any other step. */
  commit: (dir: string, links: AccountLink[]) => string | null
}

export type CreateProfileResult =
  | { ok: true; dir: string; links: AccountLink[]; copied: string[]; leftOut: string[]; notes: string[] }
  | { ok: false; error: string; leftAt?: string }

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/** Create `~/.claude-<slug>` (or `~/.codex-<slug>`): see the header. Never throws. */
export function createProfile(opts: CreateProfileOptions, fsx: AccountFs = accountFs): CreateProfileResult {
  const { agent, home } = opts
  if (!/^[a-z0-9-]{1,32}$/.test(opts.slug)) return { ok: false, error: 'the name gives no folder name: use letters or digits' }
  const dir = launchString(join(home, `${DEFAULT_PROFILE_FOLDER[agent]}-${opts.slug}`))
  if (!isReachable(dir)) return { ok: false, error: 'the folder would be outside the test home' }
  if (fsx.lstat(dir)) return { ok: false, error: `${dir} already exists: choose it as an existing folder instead` }
  const staging = `${dir}.partial-${randomBytes(3).toString('hex')}`
  const links: AccountLink[] = []
  const files: string[] = []
  const copied: string[] = []
  const leftOut: string[] = []
  const notes: string[] = []
  const main = defaultProfileDir(agent, home)
  let made = false
  let base = staging
  try {
    fsx.mkdir(staging, 0o700)
    made = true
    const mainExists = fsx.exists(main)
    const shareable = SHAREABLE_FOLDERS[agent]
    for (const { name } of shareable.filter((f) => opts.share.includes(f.name))) {
      const target = join(main, name)
      if (!mainExists) {
        notes.push(`${name} isn't shared: ${ACCOUNT_AGENT_LABEL[agent]}'s main profile doesn't exist yet`)
        continue
      }
      if (!fsx.exists(target)) {
        // A link's target must exist. The conversations folder is made for it; anything else the
        // main profile lacks is simply not shared.
        if (name !== 'projects' && name !== 'sessions') {
          notes.push(`${name} isn't shared: the main profile has no ${name} folder`)
          continue
        }
        fsx.mkdir(target, 0o700)
      }
      fsx.link(target, join(staging, name))
      links.push({ name, target })
    }
    if (opts.copy) {
      const sources = agent === 'claude'
        ? [{ name: 'settings.json', strip: strippedClaudeSettings }, { name: 'CLAUDE.md', strip: null }]
        : [{ name: 'config.toml', strip: strippedCodexConfig }]
      for (const src of sources) {
        const text = fsx.readText(join(main, src.name))
        if (text === null) continue
        let out = text
        if (src.strip) {
          const r = src.strip(text)
          if ('error' in r) throw new Error(r.error)
          out = r.text
          leftOut.push(...r.leftOut)
        }
        fsx.writePrivate(join(staging, src.name), out)
        files.push(src.name)
        copied.push(src.name)
      }
    }
    fsx.rename(staging, dir)
    base = dir
    const commitError = opts.commit(dir, links.map((l) => ({ ...l })))
    if (commitError) throw new Error(commitError)
    return { ok: true, dir, links, copied, leftOut, notes }
  } catch (e) {
    const error = errorText(e)
    if (!made) return { ok: false, error }
    const left = rollback(base, links, files, fsx)
    return left ? { ok: false, error, leftAt: left } : { ok: false, error }
  }
}

/** Undo a half-made profile: each link (checked to be one), each copied file by name, then the
 *  folder if nothing else is in it. Returns the folder when it had to stay. */
function rollback(base: string, links: readonly AccountLink[], files: readonly string[], fsx: AccountFs): string | null {
  // An item that can't be removed stays, and so then does the folder: rmdir refuses a folder
  // that isn't empty, which is the point.
  for (const l of [...links].reverse()) {
    try { fsx.unlinkLink(join(base, l.name)) } catch { /* left in place */ }
  }
  for (const f of files) {
    try { fsx.removeFile(join(base, f)) } catch { /* left in place */ }
  }
  try {
    fsx.removeEmptyDir(base)
    return null
  } catch {
    return base
  }
}
