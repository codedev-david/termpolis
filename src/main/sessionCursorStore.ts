// sessionCursorStore.ts
//
// Durable "how far into this transcript have I already learned?" marker for solo-session
// reflection.
//
// Through v1.46 this was a bare in-memory `Map<terminalId, SessionCursor>` in index.ts. Two
// things fell out of that, and the second is the worse one:
//
//   1. Quitting inside the reflector's idle window dropped the pending delta. Recoverable —
//      the transcript is still on disk.
//   2. `terminalId` is minted fresh on every launch, so the POSITION went with it. The next
//      run had no cursor for a transcript it had already read end to end, and re-derived the
//      whole thing. Content-hash dedup kept the store clean, but every relaunch paid for a
//      full re-reflection of every open session.
//
// The durable identity is the transcript's own — the (cwd, agent) pair `readSessionTranscript`
// resolves — not the terminal that happened to be showing it. Keying on that also stops two
// panes open on the same repo with the same agent from reflecting the same turns twice.

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionCursor {
  count: number
  hash: string
}

const FILE = 'session-cursors.json'
/** One entry is ~80 bytes, so this caps the file around 40 KB. A user with more than 500
 *  distinct (repo, agent) transcripts is not being served by keeping the coldest ones. */
const MAX_ENTRIES = 500

let dir: string | null = null
let cursors = new Map<string, SessionCursor>()
let dirty = false

/** Stable key for a transcript: the same repo reached by `C:\repos\Termpolis\` and
 *  `C:/repos/termpolis` is one transcript, not two. */
export function sessionCursorKey(cwd: string, agent: string): string {
  const norm = (cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  return `${norm}|${(agent || '').toLowerCase()}`
}

/** Point the store at userData and load what the last run knew. A corrupt or missing file
 *  starts clean: refusing to learn because a cache file is unreadable would be the worse
 *  failure, and the only cost of starting clean is one redundant reflection pass. */
export function initSessionCursors(userDataDir: string): void {
  dir = userDataDir
  cursors = new Map()
  dirty = false
  try {
    const raw = JSON.parse(readFileSync(join(userDataDir, FILE), 'utf8')) as Record<string, SessionCursor>
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.count === 'number' && typeof v.hash === 'string') cursors.set(k, v)
    }
  } catch { /* first run, or a file we can't read — start clean */ }
}

export function getSessionCursor(key: string): SessionCursor | undefined {
  return cursors.get(key)
}

export function setSessionCursor(key: string, cursor: SessionCursor): void {
  // Re-insert so Map iteration order is least-recently-written first, which is the order
  // eviction wants.
  cursors.delete(key)
  cursors.set(key, cursor)
  dirty = true
}

/** Write the map out. Called on the same idle tick that already does memory housekeeping and
 *  once at quit — never on the reflection hot path. */
export function flushSessionCursors(): void {
  if (!dir || !dirty) return
  try {
    while (cursors.size > MAX_ENTRIES) {
      const oldest = cursors.keys().next()
      if (oldest.done) break
      cursors.delete(oldest.value)
    }
    // Write-then-rename: a quit landing mid-write leaves the previous good file, not a
    // truncated one that the next boot would throw away entirely.
    const tmp = join(dir, `${FILE}.tmp`)
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cursors)), 'utf8')
    renameSync(tmp, join(dir, FILE))
    dirty = false
  } catch { /* best effort — a cursor that fails to persist costs one redundant pass */ }
}

/** Test seam, and the reset an import/clear of the brain needs. */
export function resetSessionCursors(): void {
  dir = null
  cursors = new Map()
  dirty = false
}
