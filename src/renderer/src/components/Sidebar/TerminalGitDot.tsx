// The small git mark on a terminal's sidebar row.
//
// Grey and still when that terminal's repo has nothing outstanding; amber and pulsing
// when it does. "Outstanding" deliberately means staged OR modified OR untracked OR
// conflicted OR unpushed — the last one matters because committed-but-not-pushed work
// is invisible in every other part of the UI and is exactly the state people lose work
// from. Being BEHIND the remote is not counted: that is someone else's work arriving,
// not yours waiting, and on a busy shared repo it would leave the dot pulsing forever,
// which trains people to ignore it.
//
// The mark is present on EVERY terminal — plain shells, AI terminals, PowerShell, zsh,
// Git Bash alike — because a control that only sometimes exists is a control nobody
// learns to look at. Outside a repo it is a dim, inert glyph with no click target: it
// says "this is where git status would appear", without offering to open a panel that
// would have nothing in it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribe, unsubscribe } from '../../lib/pollingService'
import type { GitChangeCounts } from '../../types'

/** One status spawn per terminal per tick — slow enough to stay off the PTY thread. */
const POLL_MS = 5000

export function isDirty(c: GitChangeCounts): boolean {
  return c.staged + c.unstaged + c.untracked + c.conflicted + c.ahead > 0
}

export function summarize(c: GitChangeCounts): string {
  const parts: string[] = []
  if (c.staged > 0) parts.push(`${c.staged} staged`)
  if (c.unstaged > 0) parts.push(`${c.unstaged} modified`)
  if (c.untracked > 0) parts.push(`${c.untracked} untracked`)
  if (c.conflicted > 0) parts.push(`${c.conflicted} conflicted`)
  if (c.ahead > 0) parts.push(`${c.ahead} to push`)
  // Shown, never pulsed: worth knowing, but not work of yours that is waiting.
  if (c.behind > 0) parts.push(`${c.behind} to pull`)
  if (parts.length === 0) return 'Nothing to commit or push'
  return parts.join(', ')
}

interface Props {
  terminalId: string
  cwd: string
}

export function TerminalGitDot({ terminalId, cwd }: Props) {
  const [counts, setCounts] = useState<GitChangeCounts | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    const get = window.termpolis?.gitChangeCounts
    // Checked synchronously: starting a promise we cannot use would land a setState
    // after unmount in any host that has no bridge (tests, the pre-preload first paint).
    if (!cwd || typeof get !== 'function') return
    get(cwd)
      .then(res => {
        if (!alive.current) return
        setCounts(res?.success ? res.data ?? null : null)
      })
      .catch(() => {
        if (alive.current) setCounts(null)
      })
  }, [cwd])

  useEffect(() => {
    alive.current = true
    refresh()
    // Keyed by terminal id, not by cwd: pollingService ids are global and a duplicate
    // silently replaces the previous subscriber, so two terminals in the same repo
    // would leave one of them permanently un-updated.
    const id = `git-dot-${terminalId}`
    subscribe(id, refresh, POLL_MS)
    return () => {
      alive.current = false
      unsubscribe(id)
    }
  }, [refresh, terminalId])

  // No repo here (or no answer yet). Render the glyph anyway, dimmed and inert, so the
  // sidebar's shape does not change the instant someone cd's into a repo — the mark
  // lights up in place instead of appearing from nowhere.
  if (!counts) {
    return (
      <span
        data-testid={`git-dot-${terminalId}`}
        data-repo="false"
        data-dirty="false"
        role="img"
        aria-label="Not a git repository"
        title="Not a git repository"
        className="text-[10px] px-1 leading-none text-[#3a3f4a]"
      >
        <i className="fa-solid fa-code-branch"></i>
      </span>
    )
  }

  const dirty = isDirty(counts)
  const branch = counts.branch || 'detached HEAD'

  return (
    <button
      data-repo="true"
      onClick={e => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent('termpolis:openChanges', { detail: { terminalId } }))
      }}
      data-testid={`git-dot-${terminalId}`}
      data-dirty={dirty ? 'true' : 'false'}
      aria-label={`Git changes on ${branch} — ${summarize(counts)}`}
      title={`${branch} — ${summarize(counts)}`}
      className={`text-[10px] px-1 leading-none ${
        dirty
          ? 'text-[#e5c07b] animate-pulse-git'
          : 'text-[#5a5f6a] hover:text-[#9ca3af]'
      }`}
    >
      <i className="fa-solid fa-code-branch"></i>
    </button>
  )
}
