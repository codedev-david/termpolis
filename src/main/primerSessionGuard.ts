// One memory primer per session. A Claude session can be primed three ways: the SessionStart hook
// (memory-primer-hook.cjs), the launch instruction telling the agent to call memory_primer, and (from 1.55)
// the first-prompt primer. Without a guard each one loads the same notes again, and every copy is re-read
// on every later turn. The guard remembers which memory ids a session was handed, by a key that names the
// session's folder and Claude profile, so a later primer hands over only what is new.
//
// In memory only, never written: a restart forgets it, and the next primer is then a full one, which is
// the safe direction (a note shown twice costs tokens; a note never shown costs the answer).

import { resolve } from 'path'

export const PRIMER_GUARD_TTL_MS = 6 * 60 * 60 * 1000
/** Memories one primer shows: the SessionStart hook and the memory_primer tool read the same constant. */
export const PRIMER_LIMIT = 12
const MAX_KEYS = 200

interface Served { ids: Set<string>; at: number }
const served = new Map<string, Served>()

/** The guard's key for a session: its folder (case folded on Windows and macOS, where paths are) plus the Claude
 *  config dir it runs under, so the same folder under two accounts is two sessions. */
export function primerGuardKey(cwd: string | undefined, configDir?: string): string {
  const norm = (p: string | undefined): string => {
    if (!p || !p.trim()) return ''
    const r = resolve(p.trim()).replace(/[\/]+$/, '')
    return process.platform === 'linux' ? r : r.toLowerCase()
  }
  return `${norm(cwd)}|${norm(configDir)}`
}

/** Record ids a primer showed this session. Adds to what the session already holds within the TTL. */
export function markServed(key: string, ids: readonly string[], now: number): void {
  const cur = served.get(key)
  const set = cur && now - cur.at < PRIMER_GUARD_TTL_MS ? cur.ids : new Set<string>()
  for (const id of ids) if (typeof id === 'string' && id) set.add(id)
  served.delete(key) // re-insert: the newest key goes to the back, the oldest is the one cut
  served.set(key, { ids: set, at: now })
  if (served.size > MAX_KEYS) served.delete(served.keys().next().value as string)
}

/** A session start: whatever an earlier session in this folder was shown no longer counts. */
export function resetServed(key: string): void { served.delete(key) }

/** The ids this session was already shown, or an empty set once the TTL has passed. */
export function servedIds(key: string, now: number): ReadonlySet<string> {
  const cur = served.get(key)
  if (!cur) return new Set()
  if (now - cur.at >= PRIMER_GUARD_TTL_MS) { served.delete(key); return new Set() }
  return new Set(cur.ids) // a copy: the caller reads it after recording the next primer
}

// ── The first-prompt primer (v1.55.0) ────────────────────────────────────────────────────────
// The UserPromptSubmit hook asks once per Claude session, by its session id, with the prompt as the
// query. Only a session's first real prompt gets notes; one session in ten (by a hash of its id, so
// a session never changes arm) gets none, so the receipt can compare sessions with and without.

/** Notes the first-prompt primer shows, at most. */
export const PROMPT_PRIMER_LIMIT = 6
export const PROMPT_HOLDOUT_PERCENT = 10
const PROMPTED_TTL_MS = 24 * 60 * 60 * 1000

export type PrimerArm = 'focused' | 'holdout'
interface Prompted { at: number; arm: PrimerArm }
const prompted = new Map<string, Prompted>()

/** The arm a session is in: 'holdout' for PROMPT_HOLDOUT_PERCENT of session ids, else 'focused'. */
export function armOf(sessionId: string): PrimerArm {
  let h = 0x811c9dc5 // FNV-1a, 32-bit
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100 < PROMPT_HOLDOUT_PERCENT ? 'holdout' : 'focused'
}

/** True the first time a session id comes with a prompt (within a day); false after, and for no id. */
export function claimFirstPrompt(sessionId: string, now: number): boolean {
  if (!sessionId) return false
  const cur = prompted.get(sessionId)
  if (cur && now - cur.at < PROMPTED_TTL_MS) return false
  prompted.delete(sessionId)
  prompted.set(sessionId, { at: now, arm: armOf(sessionId) })
  if (prompted.size > MAX_KEYS) prompted.delete(prompted.keys().next().value as string)
  return true
}

/** The arm a session was tagged with at its first prompt, or null when it has had none here. */
export function sessionArm(sessionId: string): PrimerArm | null {
  return prompted.get(sessionId)?.arm ?? null
}

/** `terminalId`: the Termpolis pane the session runs in, when the hook could tell (TERMPOLIS_TERMINAL_ID). */
export type FirstPromptListener = (sessionId: string, prompt: string, cwd: string | undefined, terminalId?: string) => void
const firstPromptListeners = new Set<FirstPromptListener>()

/** Called with each session's first real prompt (the redacted text the hook sent). Returns an unsubscribe. */
export function onFirstPrompt(fn: FirstPromptListener): () => void {
  firstPromptListeners.add(fn)
  return () => { firstPromptListeners.delete(fn) }
}

export function emitFirstPrompt(sessionId: string, prompt: string, cwd: string | undefined, terminalId?: string): void {
  for (const fn of firstPromptListeners) {
    try { fn(sessionId, prompt, cwd, terminalId) } catch { /* a listener never stops the primer */ }
  }
}

/** For tests. */
export function resetPrimerGuard(): void {
  served.clear()
  prompted.clear()
  firstPromptListeners.clear()
}

/** The line a repeat primer starts with, in place of the notes the session already holds. */
export function alreadyLoadedLine(count: number): string {
  return `Memory already loaded at session start (${count} notes). Use memory_search for more.`
}

