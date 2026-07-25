// sessionProjects.ts — which project directories the trigger supervisor arms
// at boot.
//
// The sidebar registers a project when you look at it, which is far too late
// for a cron (or a gitCommit hook) saved in a project you never click into this
// launch. So at boot we arm every directory the LAST session had open, plus the
// home store — the fallback project the sidebar shows before any terminal
// exists.
//
// Kept pure and separate from index.ts so the fan-out is unit-testable: a
// silently-empty list here means every automatic trigger in the app quietly
// stops working, and nothing else would notice.

type TerminalLike = { cwd?: unknown }
export type SessionLike = {
  terminals?: TerminalLike[]
  workspaces?: { terminals?: TerminalLike[] }[]
} | null | undefined

/**
 * Home first, then every distinct terminal cwd from the restored session
 * (loose terminals before workspace terminals), in first-seen order.
 *
 * Tolerant by design: the session file is user-writable JSON that has changed
 * shape across versions, and a malformed one must not cost us the home store.
 */
export function sessionProjectCwds(session: SessionLike, home: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (c: unknown): void => {
    if (typeof c !== 'string') return
    const t = c.trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }
  add(home)
  const terminals = Array.isArray(session?.terminals) ? session!.terminals! : []
  for (const t of terminals) add(t?.cwd)
  const workspaces = Array.isArray(session?.workspaces) ? session!.workspaces! : []
  for (const w of workspaces) {
    const wt = Array.isArray(w?.terminals) ? w!.terminals! : []
    for (const t of wt) add(t?.cwd)
  }
  return out
}
