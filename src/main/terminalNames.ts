// What the user called each terminal, cached, for callers that need the answer
// often and cheaply.
//
// The session record is the only place a terminal's name exists in main -- the
// renderer owns naming and persists it there -- and reading it is a synchronous
// file read plus a JSON parse. That is fine once per MCP call and not fine on a
// timer, which is what the remote status pump needs it for.

/** The part of a session terminal this cares about. Deliberately narrower than
 *  the record on disk: nothing here should start depending on the rest of it. */
export interface NamedTerminal {
  id: string
  name: string
}

export interface TerminalNameDeps {
  /** Read the current terminal records. May throw; a throw is treated as "no
   *  names on record" rather than propagated, because every caller of the
   *  lookup can carry on without a name and none of them can fix the file. */
  load(): NamedTerminal[]
  now(): number
  ttlMs?: number
}

/** How long a lookup may reuse the last read.
 *
 *  Two seconds is short enough that renaming a tab shows up on a phone before
 *  the user has finished looking at it, and long enough that a per-second caller
 *  costs one file read a second at worst instead of one per terminal. */
export const TERMINAL_NAME_TTL_MS = 2000

/** A `name(terminalId)` that reads the session at most once per TTL.
 *
 *  Returns `''` for a terminal with no name on record, which is the same answer
 *  as for one whose session file will not parse. Callers treat an empty name as
 *  "no name-specific behaviour", never as an error: the agent-status detector,
 *  the only caller so far, simply runs none of its per-agent rules. */
export function createTerminalNameLookup(deps: TerminalNameDeps): (terminalId: string) => string {
  const ttlMs = deps.ttlMs ?? TERMINAL_NAME_TTL_MS
  let cache: Map<string, string> | null = null
  let readAt = 0

  return (terminalId: string): string => {
    const now = deps.now()
    if (cache === null || now - readAt >= ttlMs) {
      const names = new Map<string, string>()
      try {
        for (const t of deps.load()) names.set(t.id, t.name)
      } catch {
        // A session file that will not parse is not a reason to stop answering.
        // The empty map is refreshed on the next expiry like any other.
      }
      cache = names
      readAt = now
    }
    return cache.get(terminalId) ?? ''
  }
}
