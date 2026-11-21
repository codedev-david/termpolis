// The Lumopolis home: shown when no world is open. Four ways in (this project, a folder, a git
// repository, a new design) and the recent worlds below them. A world whose folder or design is gone
// shows "missing" and can only be removed (its files, if any, are left alone).
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { WorldEntry, WorldSource } from '../../../../shared/world/types'
import { CloneDialog } from './CloneDialog'
import { DesignStart } from './DesignStart'
import { targetOf, UI_FAILED } from './worldTargets'
import type { OpenTarget } from './worldTargets'
import { useUiZoom } from './worldPane'

export { targetOf }
export type { OpenTarget }

export interface WorldHomeProps {
  entries: WorldEntry[]
  /** The active terminal's folder; empty when there is none (Map this project is then off). */
  projectCwd: string
  onOpen: (target: OpenTarget) => void
  /** The recent worlds changed (one added or removed): the pane reloads the list. */
  onChanged: () => void
  /** Tests pin the clock. */
  now?: number
}

const ICONS: Record<WorldSource['kind'], { icon: string; label: string }> = {
  project: { icon: 'fa-diagram-project', label: 'Project' },
  folder: { icon: 'fa-folder', label: 'Folder' },
  git: { icon: 'fa-code-branch', label: 'Git repository' },
  design: { icon: 'fa-pen-ruler', label: 'Design' },
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** The choices' grid: as many 15rem columns as fit (two at most in the home's 48rem), one when the pane is narrower. */
const CHOICE_GRID: CSSProperties = { gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))' }
const choiceCls = 'flex flex-col items-start gap-1 rounded-lg border border-[#3c3c3c] bg-[#1b2236] hover:bg-[#222b44] hover:border-[#4fc1ff]/60 px-4 py-3 text-left disabled:opacity-50 disabled:hover:bg-[#1b2236] disabled:hover:border-[#3c3c3c]'

export function WorldHome({ entries, projectCwd, onOpen, onChanged, now }: WorldHomeProps): JSX.Element {
  const zoom = useUiZoom()
  const [dialog, setDialog] = useState<'clone' | 'design' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const at = now ?? Date.now()

  /** Runs one home action: a failure shows main's friendly reason, a throw a fixed one. */
  const run = (fn: () => Promise<string | null>): void => {
    setError(null)
    fn().then((message) => { if (message !== null) setError(message) }, () => setError(UI_FAILED))
  }

  const mapProject = (): void => run(async () => {
    const api = window.termpolis
    const found = await api.gitFindRoot(projectCwd)
    const root = found.success && found.data ? found.data : projectCwd
    const res = await api.worldMapProject(root)
    if (!res.success) return res.error
    onChanged()
    onOpen({ kind: 'root', root, follow: true })
    return null
  })

  const openFolder = (): void => run(async () => {
    const res = await window.termpolis.worldOpenFolder()
    if (!res.success) return res.error
    if (res.data === null) return null
    onChanged()
    onOpen(targetOf(res.data))
    return null
  })

  const remove = (key: string): void => run(async () => {
    const res = await window.termpolis.worldRemoveSource(key)
    if (!res.success) return res.error
    onChanged()
    return null
  })

  const choices: { label: string; hint: string; icon: string; onClick: () => void; disabled?: boolean }[] = [
    { label: 'Map this project', hint: projectCwd ? 'The project open in the active terminal' : 'Open a terminal in a project first', icon: 'fa-diagram-project', onClick: mapProject, disabled: !projectCwd },
    { label: 'Open a folder…', hint: 'Any folder on this computer', icon: 'fa-folder-open', onClick: openFolder },
    { label: 'Open a git repository…', hint: 'Cloned into Termpolis, read-only', icon: 'fa-code-branch', onClick: () => { setError(null); setDialog('clone') } },
    { label: 'Design something new', hint: 'Describe an app and see it planned', icon: 'fa-pen-ruler', onClick: () => { setError(null); setDialog('design') } },
  ]

  return (
    <div data-testid="world-home" className="overflow-auto" style={{ position: 'absolute', inset: 0 }}>
      <div className="mx-auto max-w-3xl px-6 py-10 flex flex-col gap-6" style={zoom}>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-3xl font-semibold text-white inline-flex flex-wrap justify-center items-center gap-x-3">
            <i className="fa-solid fa-earth-americas text-[#4fc1ff]" aria-hidden="true" />
            Lumopolis
          </h1>
          <p className="text-sm text-[#9ca3af]">Where AI Worlds Become Human Understanding.</p>
        </div>
        {/* Two columns where the pane has room for them, one in a narrow pane: the pane's width, not the window's. */}
        <div className="grid gap-3" style={CHOICE_GRID}>
          {choices.map((c) => (
            <button key={c.label} type="button" className={choiceCls} onClick={c.onClick} disabled={c.disabled}>
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-white">
                <i className={`fa-solid ${c.icon} text-[#4fc1ff]`} aria-hidden="true" />
                {c.label}
              </span>
              <span className="text-xs text-[#9ca3af]">{c.hint}</span>
            </button>
          ))}
        </div>
        {error !== null && <p role="alert" className="text-xs text-[#f14c4c] text-center">{error}</p>}
        <section className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-[#9ca3af]">Recent worlds</h2>
          {entries.length === 0 ? (
            <p className="text-xs text-[#6b7280]">No worlds yet. Pick one of the choices above to make your first.</p>
          ) : (
            <ul aria-label="Recent worlds" className="flex flex-col gap-1">
              {entries.map((e) => {
                const kind = ICONS[e.source.kind]
                const body = (
                  <>
                    <i className={`fa-solid ${kind.icon} w-4 text-[#9ca3af]`} title={kind.label} aria-hidden="true" />
                    <span className="flex-1 truncate text-sm text-[#d4d4d4]">{e.title}</span>
                    <span className="text-xs text-[#6b7280]">{agoText(e.lastOpened, at)}</span>
                  </>
                )
                return (
                  <li key={e.key} data-testid={`world-recent-${e.key}`}>
                    {e.missing ? (
                      <div className="flex items-center gap-3 rounded px-3 py-2 border border-[#3c3c3c] opacity-80">
                        {body}
                        <span className="text-[11px] uppercase rounded px-1.5 py-0.5 bg-[#5a1d1d] text-[#f48771]">missing</span>
                        <button type="button" aria-label={`Remove ${e.title}`} className="text-xs px-2 py-0.5 rounded border border-[#3c3c3c] hover:bg-[#37373d]" onClick={() => remove(e.key)}>Remove</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Open ${e.title}`}
                        className="w-full flex items-center gap-3 rounded px-3 py-2 border border-transparent hover:border-[#3c3c3c] hover:bg-[#1b2236] text-left"
                        onClick={() => onOpen(targetOf(e))}
                      >{body}</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
      {dialog === 'clone' && (
        <CloneDialog
          onClose={() => setDialog(null)}
          onCloned={(entry) => { setDialog(null); onChanged(); onOpen(targetOf(entry)) }}
        />
      )}
      {dialog === 'design' && (
        <DesignStart
          onClose={() => setDialog(null)}
          onDrafted={(key) => { setDialog(null); onChanged(); onOpen({ kind: 'design', key }) }}
        />
      )}
    </div>
  )
}
