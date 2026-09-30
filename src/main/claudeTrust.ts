// Pre-approve a workspace in Claude Code's OWN config so its trust dialog never renders.
//
// WHY this exists instead of answering the dialog in the terminal:
// Termpolis used to "auto-trust" by typing a bare Enter a few seconds after the launch
// command, on the assumption that the highlighted option was "Yes". Claude Code 2.1.x
// builds that dialog with `cancelFirst: true, focus: "cancel"` — the options array is
// [cancel, confirm] and the cursor starts on cancel — so a bare Enter now answers
// **"No, exit"**. Claude quits the instant it starts, the user is dropped back at a
// shell prompt, and the launch looks like the injected command was cut off.
//
// Guessing which keystroke means yes is what broke. Trust is a config value, so write
// the config value. Claude keeps it in ~/.claude.json (NOT ~/.claude/settings.json):
//
//   { "projects": { "C:/Users/you/repo": { "hasTrustDialogAccepted": true } } }
//
// Keys are absolute paths with forward slashes on every platform. Claude's own resolver
// checks the exact key first and then walks the cwd's ancestors, so seeding the resolved
// cwd is sufficient; the repo root is seeded too when the caller knows it, which is the
// key Claude itself would have written.
//
// That ancestor walk is also why some folders are never seeded: the home folder, anything
// above it, a drive root, `/` and a UNC share root. Trusting one of them trusts every
// project beneath it, which is a decision for the user and not for a terminal they happened
// to open there. Claude itself refuses to persist trust for the home folder ("home trust is
// session-only"), so a terminal in ~ keeps getting the dialog, and that is intended.
//
// Only agentIntegrationManager calls this, and only once the user agreed to connect the
// agents; it records the keys a call newly set (`newlySet`) so a disconnect can put them back.

import { readFileSync, realpathSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { atomicWriteText, errorText, formatJsonLike } from './agentConfigIO'
import { isUnsafeTrustRoot } from '../shared/agentIntegration'

export interface TrustResult {
  changed: boolean
  /** Which keys are now marked trusted (whether or not this call wrote them). */
  keys: string[]
  /** The keys this call switched to trusted: the ones a disconnect must switch back. */
  newlySet: string[]
  skipped?: 'corrupt' | 'already-trusted' | 'write-failed' | 'no-cwd' | 'too-large' | 'unsafe-root'
  error?: string
}

export interface TrustRevertResult {
  changed: boolean
  /** Keys whose trust this call withdrew. */
  reverted: string[]
  error?: string
}

/**
 * Ceiling on the config we are willing to parse. This runs on the MAIN process,
 * where a synchronous parse of a pathological file would freeze the whole app —
 * the exact failure class this project has been bitten by before. A real
 * ~/.claude.json is well under a megabyte; anything past this is not worth an
 * unbounded stall, so we skip and let the dialog handler cover that session.
 */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024

/**
 * Keys already confirmed trusted in this app run, as `<configPath>\0<key>`.
 * Trust is seeded on EVERY terminal creation, so without this the main process
 * would re-read and re-parse the config for every tab opened in a folder it has
 * already handled. Purely a cost optimisation — correctness never depends on it.
 */
const seeded = new Set<string>()

/** Test hook: forget which keys this run has already confirmed. */
export function __resetTrustCache(): void {
  seeded.clear()
}

/**
 * Where Claude Code keeps `projects[...].hasTrustDialogAccepted`. Honors
 * CLAUDE_CONFIG_DIR (how a second Claude profile is run) so seeding lands in the
 * same file the launched CLI will read.
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = (env.CLAUDE_CONFIG_DIR || '').trim()
  return join(dir || home, '.claude.json')
}

/**
 * Normalize a directory the way Claude Code does when it builds a project key:
 * real path (resolving symlinks and Windows short names) where the folder exists,
 * absolute, forward slashes, no trailing separator — except a bare drive root,
 * which keeps its slash so "C:/" never collapses to "C:".
 */
export function claudeProjectKey(cwd: string): string {
  let abs = resolve(cwd)
  try { abs = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs) } catch { /* not on disk yet — use the resolved form */ }
  const fwd = abs.replace(/\\/g, '/')
  if (/^[A-Za-z]:\/$/.test(fwd)) return fwd
  return fwd.replace(/\/+$/, '') || '/'
}

/** Home as given and as a key, so a short-name or symlinked home is still recognised. */
function homeForms(home: string): string[] {
  return home.trim() ? Array.from(new Set([home, claudeProjectKey(home)])) : ['']
}

function isUnsafe(path: string, key: string, homes: string[]): boolean {
  return homes.some((h) => isUnsafeTrustRoot(path, h) || isUnsafeTrustRoot(key, h))
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

type ConfigRead =
  | { ok: true; value: any; text: string | null }
  | { ok: false; reason: 'corrupt' | 'too-large'; error?: string }

function readConfig(path: string): ConfigRead {
  // A missing file is NOT a failure here: Claude creates ~/.claude.json on first run,
  // and a config that only carries `projects` is a shape it merges over its defaults.
  // Refusing to seed until the user has run Claude once would leave exactly the
  // first-launch case — the one that prompts — unfixed.
  if (!existsSync(path)) return { ok: true, value: {}, text: null }
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) {
      return { ok: false, reason: 'too-large', error: 'config exceeds ' + MAX_CONFIG_BYTES + ' bytes' }
    }
    const raw = readFileSync(path, 'utf-8')
    const body = raw.replace(/^\uFEFF/, '')
    if (!body.trim()) return { ok: true, value: {}, text: raw }
    const parsed = JSON.parse(body)
    if (!isObj(parsed)) {
      return { ok: false, reason: 'corrupt', error: 'root is not an object' }
    }
    return { ok: true, value: parsed, text: raw }
  } catch (e) {
    // Never overwrite a config we failed to parse — that file holds the user's
    // whole Claude Code state. Skip and let the dialog handler take over.
    return { ok: false, reason: 'corrupt', error: errorText(e) }
  }
}

/**
 * Mark `cwd` (and any `alsoTrust` paths, e.g. the enclosing git root) as trusted.
 * A `cwd` that is the home folder or a filesystem root is refused outright; such an
 * `alsoTrust` path is dropped and the rest still seeded.
 *
 * Idempotent by design: after the first launch in a folder nothing is written at all,
 * which keeps the read-modify-write window against a concurrently running Claude
 * session down to one write per new folder.
 */
export function trustClaudeWorkspace(
  cwd: string,
  opts: { alsoTrust?: string[]; configPath?: string; home?: string } = {},
): TrustResult {
  if (!cwd || !cwd.trim()) return { changed: false, keys: [], newlySet: [], skipped: 'no-cwd' }
  const path = opts.configPath ?? claudeConfigPath()
  const homes = homeForms(opts.home ?? homedir())
  const cwdKey = claudeProjectKey(cwd)
  if (isUnsafe(cwd, cwdKey, homes)) return { changed: false, keys: [], newlySet: [], skipped: 'unsafe-root' }
  const extra = (opts.alsoTrust ?? [])
    .filter((p) => !!p && !!p.trim())
    .map((p) => ({ p, key: claudeProjectKey(p) }))
    .filter(({ p, key }) => !isUnsafe(p, key, homes))
    .map(({ key }) => key)
  const keys = Array.from(new Set([cwdKey, ...extra]))

  // Nothing to do if this run already confirmed every key against this config.
  if (keys.every((k) => seeded.has(path + '\0' + k))) {
    return { changed: false, keys, newlySet: [], skipped: 'already-trusted' }
  }

  const read = readConfig(path)
  if (!read.ok) return { changed: false, keys, newlySet: [], skipped: read.reason, error: read.error }

  const config = read.value
  if (!isObj(config.projects)) config.projects = {}

  const newlySet: string[] = []
  for (const key of keys) {
    const entry = config.projects[key]
    if (!isObj(entry)) {
      config.projects[key] = { hasTrustDialogAccepted: true }
      newlySet.push(key)
    } else if (entry.hasTrustDialogAccepted !== true) {
      entry.hasTrustDialogAccepted = true
      newlySet.push(key)
    }
  }

  const remember = (): void => { for (const key of keys) seeded.add(path + '\0' + key) }

  if (!newlySet.length) {
    remember()
    return { changed: false, keys, newlySet, skipped: 'already-trusted' }
  }

  try {
    atomicWriteText(path, formatJsonLike(config, read.text))
    remember()
    return { changed: true, keys, newlySet }
  } catch (e) {
    return { changed: false, keys, newlySet: [], skipped: 'write-failed', error: errorText(e) }
  }
}

/**
 * Withdraw trust from the folders `pick` selects. An entry holding nothing but the flag was
 * created by Termpolis and goes; otherwise the flag goes back to false, which is what Claude
 * Code writes before a folder is accepted. Nothing is written when nothing matched.
 */
function withdrawTrust(path: string, pick: (key: string) => boolean): TrustRevertResult {
  const read = readConfig(path)
  if (!read.ok) return { changed: false, reverted: [], error: read.error }
  const projects = read.value.projects
  if (!isObj(projects)) return { changed: false, reverted: [] }
  const reverted: string[] = []
  for (const [key, entry] of Object.entries(projects)) {
    if (!pick(key) || !isObj(entry) || entry.hasTrustDialogAccepted !== true) continue
    if (Object.keys(entry).length === 1) delete projects[key]
    else entry.hasTrustDialogAccepted = false
    reverted.push(key)
  }
  if (!reverted.length) return { changed: false, reverted }
  try {
    atomicWriteText(path, formatJsonLike(read.value, read.text))
  } catch (e) {
    return { changed: false, reverted: [], error: errorText(e) }
  }
  seeded.clear()
  return { changed: true, reverted }
}

/** Undo trustClaudeWorkspace: withdraw trust from the keys it reported in `newlySet`. */
export function revertClaudeTrust(keys: readonly string[], opts: { configPath?: string } = {}): TrustRevertResult {
  if (!keys.length) return { changed: false, reverted: [] }
  return withdrawTrust(opts.configPath ?? claudeConfigPath(), (key) => keys.includes(key))
}

/**
 * Withdraw trust from the home folder, the folders above it and the filesystem roots.
 * Claude never persists trust for home itself, so such a key was written by an earlier
 * Termpolis, which seeded every folder a terminal opened in.
 */
export function untrustUnsafeClaudeRoots(opts: { configPath?: string; home?: string } = {}): TrustRevertResult {
  const homes = homeForms(opts.home ?? homedir())
  return withdrawTrust(opts.configPath ?? claudeConfigPath(), (key) => isUnsafe(key, key, homes))
}
