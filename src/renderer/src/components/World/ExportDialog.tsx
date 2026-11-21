// Lumopolis Export: save the world as one offline page. The dialog asks main what the world holds
// (world:export-info), lets the person choose smart Ask and, when the world has proposals, the whole world or
// one proposal, then runs one export under its own id (world:export). It follows that export's progress, and
// cancels it on Cancel or when it unmounts mid-run (Esc, or the pane closing). A saved file goes to onSaved;
// the pane shows ExportToast in its notice slot.
import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { WorldExportInfo, WorldExportProgressEvent, WorldSavedFile } from '../../../../shared/world/types'
import { NO_MODEL } from '../../../../shared/world/exportMeta'
import { btnCls, dialogCls, fieldCls, primaryCls, UI_FAILED } from './worldTargets'
import { fileNameOf, formatMb, savedAtText } from './exportFormat'

type Step = WorldExportProgressEvent['step']

/** Cancels the export the ref names, if any; a cancel that fails changes nothing the person can act on. */
function stopRun(run: MutableRefObject<string | null>): void {
  const id = run.current
  if (id === null) return
  run.current = null
  window.termpolis.worldExportCancel(id).catch(() => undefined)
}

export interface ExportDialogProps {
  root?: string
  designKey?: string
  /** A compile or labelling run is going: the export uses the map as it was last saved. */
  labelling: boolean
  /** A file was written. Called even after the dialog closed, when a cancel lost the race. */
  onSaved: (file: WorldSavedFile) => void
  onClose: () => void
}

export function ExportDialog({ root, designKey, labelling, onSaved, onClose }: ExportDialogProps): JSX.Element {
  const [info, setInfo] = useState<WorldExportInfo | null>(null)
  const [smart, setSmart] = useState(false)
  const [keywordOnly, setKeywordOnly] = useState<string | null>(null)
  const [scope, setScope] = useState<'whole' | 'proposal'>('whole')
  const [pick, setPick] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** The export running now, with the smart choice it started with; null: none. */
  const [run, setRun] = useState<{ smart: boolean } | null>(null)
  const [prog, setProg] = useState<WorldExportProgressEvent | null>(null)
  const [indexTotal, setIndexTotal] = useState<number | null>(null)
  /** The id of the export running now: progress for any other id is ignored. */
  const runRef = useRef<string | null>(null)

  useEffect(() => {
    window.termpolis.worldExportInfo({ root, designKey }).then(
      (res) => {
        if (!res.success) { setError(res.error); return }
        setInfo(res.data)
        setSmart(res.data.smartDefault && res.data.smartAvailable)
        setPick(res.data.proposals[0]?.id ?? '')
      },
      () => setError(UI_FAILED),
    )
  }, [root, designKey])

  useEffect(() => {
    const off = window.termpolis.onWorldExportProgress((e) => {
      if (e.exportId !== runRef.current) return
      setProg(e)
      if (e.step === 'index' && e.total > 0) setIndexTotal(e.total)
    })
    return () => {
      stopRun(runRef)
      off()
    }
  }, [])

  const cancel = (): void => {
    stopRun(runRef)
    onClose()
  }

  // Bound only to the Export button, which is disabled until the info is in and while a run goes.
  const start = (): void => {
    const id = crypto.randomUUID()
    const useSmart = smart
    runRef.current = id
    setRun({ smart: useSmart })
    setProg(null)
    setIndexTotal(null)
    setError(null)
    const proposalId = scope === 'proposal' ? pick : undefined
    window.termpolis.worldExport({ exportId: id, root, designKey, smart: useSmart, proposalId }).then(
      (res) => {
        const mine = runRef.current === id
        if (res.success && 'path' in res.data) {
          onSaved(res.data)
          if (mine) { runRef.current = null; onClose() }
          return
        }
        if (!mine) return
        runRef.current = null
        setRun(null)
        if (res.success) return // the save dialog was closed: back to the choices
        if (res.keywordOnly) { setKeywordOnly(res.error); setSmart(false); return }
        setError(res.error)
      },
      () => {
        if (runRef.current !== id) return
        runRef.current = null
        setRun(null)
        setError(UI_FAILED)
      },
    )
  }

  const running = run !== null
  const keywordWhy = keywordOnly ?? (info !== null && !info.smartAvailable ? NO_MODEL : null)
  const steps: Step[] = run !== null && run.smart ? ['prepare', 'index', 'write'] : ['prepare', 'write']
  const current = prog === null ? 0 : steps.indexOf(prog.step)
  const pct = prog !== null && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0
  const label = (s: Step): string => {
    if (s === 'prepare') return 'Preparing the map'
    if (s === 'write') return 'Writing the file'
    return indexTotal !== null ? `Indexing ${indexTotal} parts for smart Ask` : 'Indexing parts for smart Ask'
  }

  return (
    <div role="dialog" aria-label="Export Lumopolis world" data-testid="world-export-dialog" className={dialogCls}>
      <h2 className="text-base font-semibold text-white">Export Lumopolis world</h2>
      {info === null && error === null && (
        <p data-testid="world-export-loading" className="text-xs text-[#9ca3af]">Reading the world…</p>
      )}
      {info !== null && (
        <>
          {info.proposals.length > 0 && (
            <div className="flex flex-col gap-1.5 text-xs">
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" name="world-export-scope" checked={scope === 'whole'} disabled={running} onChange={() => setScope('whole')} />
                Whole world
              </label>
              <div className="flex items-center gap-1.5">
                <label className="inline-flex items-center gap-1.5 shrink-0">
                  <input type="radio" name="world-export-scope" checked={scope === 'proposal'} disabled={running} onChange={() => setScope('proposal')} />
                  Proposal:
                </label>
                <select
                  aria-label="Proposal to export"
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  disabled={running || scope !== 'proposal'}
                  className={`${fieldCls} min-w-0`}
                >
                  {info.proposals.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={smart} disabled={running || keywordWhy !== null} onChange={(e) => setSmart(e.target.checked)} />
              Include smart Ask (works offline, adds ~35 MB)
            </label>
            <p className="text-xs text-[#9ca3af] pl-5">Finds the parts that match a question by meaning.</p>
            {keywordWhy !== null && <p data-testid="world-export-keyword" className="text-xs text-[#f0b429] pl-5">{keywordWhy}</p>}
            {keywordWhy === null && !info.smartDefault && (
              <p data-testid="world-export-note" className="text-xs text-[#f0b429] pl-5">
                Most parts aren&apos;t described yet, so smart Ask would mostly match file names. Re-label the world first, or export with keyword Ask.
              </p>
            )}
          </div>
          <p className="text-xs text-[#9ca3af]">Includes cards, tours, layers and themes. Not included: your conversation, and file paths outside the project.</p>
          {labelling && (
            <p data-testid="world-export-saved-at" className="text-xs text-[#9ca3af]">
              Uses the map as it was saved at {savedAtText(info.savedAt)}; labelling is still running.
            </p>
          )}
          <p data-testid="world-export-size" className="text-xs text-[#d4d4d4]">About {formatMb(smart ? info.smartBytes : info.keywordBytes)} MB</p>
        </>
      )}
      {running && (
        <div className="flex flex-col gap-2">
          <ol data-testid="world-export-steps" className="flex flex-col gap-1 text-xs">
            {steps.map((s, i) => {
              const state = i < current ? 'done' : i === current ? 'current' : 'pending'
              return (
                <li key={s} data-state={state} className={`inline-flex items-center gap-2 ${state === 'pending' ? 'text-[#9ca3af]' : 'text-[#d4d4d4]'}`}>
                  <i
                    aria-hidden="true"
                    className={`w-3 text-center ${state === 'done' ? 'fa-solid fa-check text-[#3fb950]' : state === 'current' ? 'fa-solid fa-spinner fa-spin text-[#0078d4]' : 'fa-regular fa-circle'}`}
                  />
                  {label(s)}
                </li>
              )
            })}
          </ol>
          <div className="flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1.5 flex-1 rounded bg-[#3c3c3c] overflow-hidden"
            >
              <div className="h-full bg-[#0078d4] transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {prog !== null && prog.step === 'index' && (
              <span data-testid="world-export-count" className="text-[11px] text-[#9ca3af] tabular-nums">{prog.done} of {prog.total}</span>
            )}
          </div>
        </div>
      )}
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={info === null || running} onClick={start}>{running ? 'Exporting…' : 'Export…'}</button>
      </div>
    </div>
  )
}

export interface ExportToastProps {
  file: WorldSavedFile
  onDismiss: () => void
}

/** The pane's notice after a save: the file's name and size, and buttons to show it in its folder or open it. */
export function ExportToast({ file, onDismiss }: ExportToastProps): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const call = (fn: typeof window.termpolis.worldShowFile): void => {
    setError(null)
    fn(file.path).then(
      (res) => { if (!res.success) setError(res.error) },
      () => setError(UI_FAILED),
    )
  }
  const link = 'text-[#4fc1ff] hover:underline'
  return (
    <span data-testid="world-export-toast" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span><i className="fa-solid fa-circle-check text-[#3fb950] mr-1.5" aria-hidden="true" />Exported {fileNameOf(file.path)} <span className="whitespace-nowrap">({formatMb(file.bytes)} MB)</span></span>
      <button type="button" className={link} onClick={() => call(window.termpolis.worldShowFile)}>Show in folder</button>
      <button type="button" className={link} onClick={() => call(window.termpolis.worldOpenFile)}>Open</button>
      <button type="button" aria-label="Dismiss" className="text-[#999] hover:text-white" onClick={onDismiss}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
      {error !== null && <span role="alert" className="basis-full text-[#f14c4c]">{error}</span>}
    </span>
  )
}
