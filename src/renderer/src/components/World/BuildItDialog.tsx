// Lumopolis Build it: the one write action. The user picks a folder (the native dialog), is warned
// when it already holds files (and must agree to build there anyway), chooses the agent, and
// confirms. Main links the design to the folder; the pane then opens the agent's terminal there with
// the first prompt and switches to the folder's world with the plan overlay on.
import { useRef, useState } from 'react'
import type { BuildItResult, WorldFolderPick } from '../../../../shared/world/types'
import { btnCls, dialogCls, fieldCls, primaryCls, UI_FAILED } from './worldTargets'
import { useUiZoom } from './worldPane'
import { usePaneDialog } from './usePaneDialog'

export interface BuildAgent { id: string; name: string }

export interface BuildItDialogProps {
  designKey: string
  title: string
  /** The agents Build it can start: Claude Code's profiles, the one agent that takes a first prompt on launch. */
  agents: BuildAgent[]
  /** The user's default among them (defaultBuildAgent), preselected. */
  defaultAgent?: string
  onBuilt: (res: BuildItResult, agentId: string) => void
  onClose: () => void
}

export function BuildItDialog({ designKey, title, agents, defaultAgent, onBuilt, onClose }: BuildItDialogProps): JSX.Element {
  const zoom = useUiZoom()
  const [folder, setFolder] = useState<WorldFolderPick | null>(null)
  const [anyway, setAnyway] = useState(false)
  const [agent, setAgent] = useState(() => (agents.some((a) => a.id === defaultAgent) ? defaultAgent as string : agents[0]?.id ?? ''))
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  usePaneDialog(box)

  const pick = (): void => {
    setError(null)
    window.termpolis.worldPickFolder().then(
      (res) => {
        if (!res.success) { setError(res.error); return }
        if (res.data === null) return // cancelled: the folder chosen before (if any) stays
        setFolder(res.data)
        setAnyway(false)
      },
      () => setError(UI_FAILED),
    )
  }

  const ready = folder !== null && (folder.empty || anyway) && agent !== '' && !building
  // Bound only to the Build it button, which is disabled until `ready`.
  const build = (): void => {
    const f = folder as WorldFolderPick
    setBuilding(true)
    setError(null)
    const req = { key: designKey, root: f.root, agent, ...(f.empty ? {} : { confirmNonEmpty: true }) }
    window.termpolis.worldBuildIt(req).then(
      (res) => {
        setBuilding(false)
        if (res.success) onBuilt(res.data, agent)
        else setError(res.error)
      },
      () => { setBuilding(false); setError(UI_FAILED) },
    )
  }

  return (
    <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Build it" data-testid="world-build-it" className={`${dialogCls} focus:outline-none`} style={zoom}>
      <h2 className="text-base font-semibold text-white">Build “{title}”</h2>
      <p className="text-xs text-[#9ca3af]">
        Choose the folder the app goes in. Lumopolis links the design to it and opens your agent there with the design as its brief.
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={btnCls} onClick={pick} disabled={building}>
          {folder ? 'Choose another folder…' : 'Choose folder…'}
        </button>
        {folder && <span data-testid="world-build-folder" className="text-xs truncate text-[#d4d4d4]" title={folder.root}>{folder.root}</span>}
      </div>
      {folder && !folder.empty && (
        <div role="alert" className="rounded border border-[#f0b429]/50 bg-[#f0b429]/10 p-2 text-xs text-[#f0d58a] flex flex-col gap-1.5">
          <span>This folder isn&apos;t empty. The agent will work alongside the files already in it.</span>
          <label className="inline-flex items-center gap-1.5 text-[#d4d4d4]">
            <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
            Build here anyway
          </label>
        </div>
      )}
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Agent
        <select value={agent} onChange={(e) => setAgent(e.target.value)} className={fieldCls} disabled={building || agents.length === 0}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <p data-testid="world-build-claude-only" className="text-xs text-[#9ca3af]">
        Build it starts Claude Code: it is the one agent that takes the design as its first prompt when it opens.
      </p>
      {agents.length === 0 && <p className="text-xs text-[#f0b429]">Build it needs Claude Code: add a Claude Code profile in the sidebar first.</p>}
      {error !== null && <p role="alert" className="text-xs text-[#f48771]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryCls} disabled={!ready} onClick={build}>{building ? 'Building…' : 'Build it'}</button>
      </div>
    </div>
  )
}
