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
// Note on the home directory: Claude deliberately does NOT persist trust when a user
// accepts the dialog while sitting in ~ ("home trust is session-only"), which is why a
// terminal opened in the home folder re-prompted on every single launch. Its trust
// *lookup* has no such carve-out, so a key we write there is honored.

import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

export interface TrustResult {
  changed: boolean
  /** Which keys are now marked trusted (whether or not this call wrote them). */
  keys: string[]
  skipped?: 'corrupt' | 'already-trusted' | 'write-failed' | 'no-cwd' | 'too-large'
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

function readConfig(path: string): { ok: true; value: any } | { ok: false; reason: 'corrupt' | 'too-large'; error?: string } {
  // A missing file is NOT a failure here: Claude creates ~/.claude.json on first run,
  // and a config that only carries `projects` is a shape it merges over its defaults.
  // Refusing to seed until the user has run Claude once would leave exactly the
  // first-launch case — the one that prompts — unfixed.
  if (!existsSync(path)) return { ok: true, value: {} }
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) {
      return { ok: false, reason: 'too-large', error: 'config exceeds ' + MAX_CONFIG_BYTES + ' bytes' }
    }
    const raw = readFileSync(path, 'utf-8')
    if (!raw.trim()) return { ok: true, value: {} }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'corrupt', error: 'root is not an object' }
    }
    return { ok: true, value: parsed }
  } catch (e: any) {
    // Never overwrite a config we failed to parse — that file holds the user's
    // whole Claude Code state. Skip and let the dialog handler take over.
    return { ok: false, reason: 'corrupt', error: e?.message || String(e) }
  }
}

/**
 * Mark `cwd` (and any `alsoTrust` paths, e.g. the enclosing git root) as trusted.
 *
 * Idempotent by design: after the first launch in a folder nothing is written at all,
 * which keeps the read-modify-write window against a concurrently running Claude
 * session down to one write per new folder.
 */
export function trustClaudeWorkspace(
  cwd: string,
  opts: { alsoTrust?: string[]; configPath?: string } = {},
): TrustResult {
  if (!cwd || !cwd.trim()) return { changed: false, keys: [], skipped: 'no-cwd' }
  const path = opts.configPath ?? claudeConfigPath()
  const keys = Array.from(new Set(
    [cwd, ...(opts.alsoTrust ?? [])].filter((p) => !!p && !!p.trim()).map(claudeProjectKey),
  ))

  // Nothing to do if this run already confirmed every key against this config.
  if (keys.every((k) => seeded.has(path + '\0' + k))) {
    return { changed: false, keys, skipped: 'already-trusted' }
  }

  const read = readConfig(path)
  if (!read.ok) return { changed: false, keys, skipped: read.reason, error: read.error }

  const config = read.value
  if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
    config.projects = {}
  }

  let changed = false
  for (const key of keys) {
    const entry = config.projects[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      config.projects[key] = { hasTrustDialogAccepted: true }
      changed = true
    } else if (entry.hasTrustDialogAccepted !== true) {
      entry.hasTrustDialogAccepted = true
      changed = true
    }
  }

  const remember = (): void => { for (const key of keys) seeded.add(path + '\0' + key) }

  if (!changed) {
    remember()
    return { changed: false, keys, skipped: 'already-trusted' }
  }

  try {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    renameSync(tmp, path)
    remember()
    return { changed: true, keys }
  } catch (e: any) {
    return { changed: false, keys, skipped: 'write-failed', error: e?.message || String(e) }
  }
}
