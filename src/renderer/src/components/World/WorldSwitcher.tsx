// The Lumopolis toolbar's world switcher: Home, then the recent worlds (a missing one is left out:
// it can only be removed, from the home).
import type { WorldEntry } from '../../../../shared/world/types'
import { targetOf, whereOf } from './worldTargets'
import type { OpenTarget } from './worldTargets'

export interface WorldSwitcherProps {
  entries: WorldEntry[]
  onOpen: (target: OpenTarget) => void
  onHome: () => void
}

const HOME = '__home'

export function WorldSwitcher({ entries, onOpen, onHome }: WorldSwitcherProps): JSX.Element {
  const open = entries.filter((e) => !e.missing)
  // M10: a macOS select shows no option titles, so a name two offered worlds share carries where each is in its text.
  const uses = new Map<string, number>()
  for (const e of open) uses.set(e.title, (uses.get(e.title) ?? 0) + 1)
  const label = (e: WorldEntry): string => {
    const where = whereOf(e)
    return (uses.get(e.title) as number) > 1 && where !== '' ? `${e.title} \u2014 ${where}` : e.title
  }
  return (
    <select
      aria-label="Worlds"
      data-testid="world-switcher"
      value=""
      onChange={(e) => {
        const v = e.target.value
        if (v === HOME) { onHome(); return }
        const entry = open.find((x) => x.key === v)
        if (entry) onOpen(targetOf(entry))
      }}
      className="text-xs px-1.5 py-1 rounded border border-[#3c3c3c] bg-[#1e1e1e] text-[#cccccc] max-w-[12rem]"
    >
      <option value="">Switch world…</option>
      <option value={HOME}>Home</option>
      {/* Where each one is, as its hover title, and in its text when two share a name (F-R12, M10). */}
      {open.map((e) => <option key={e.key} value={e.key} title={whereOf(e) || undefined}>{label(e)}</option>)}
    </select>
  )
}
