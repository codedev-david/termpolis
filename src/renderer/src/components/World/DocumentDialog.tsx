// Lumopolis documentation: save the world's documentation as one page. The person sets the title (the
// project's name to start with) and whether the city picture goes in; Save… asks main to write the file
// where the person chooses (world:document). A saved file goes to onSaved: the pane shows its toast. Cancel (or
// closing the pane) while saving stops the save in main (world:document-cancel), and its answer then shows nothing;
// a cancel that loses the race (the file already in place) still reports the file, as an export does.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { WorldSavedFile } from '../../../../shared/world/types'
import { btnCls, dialogCls, fieldCls, primaryCls, UI_FAILED } from './worldTargets'
import { useUiZoom } from './worldPane'
import { usePaneDialog } from './usePaneDialog'

/** Stops the save running now, if any; it is no longer this dialog's from here on. */
function stopSave(run: MutableRefObject<string | null>): void {
  const id = run.current
  if (id === null) return
  run.current = null
  window.termpolis.worldDocumentCancel(id).catch(() => undefined)
}

export interface DocumentDialogProps {
  root?: string
  designKey?: string
  projectName: string
  /** The city as it is on screen, as a PNG data URL; null when there is no 3D map to take it from. */
  picture: () => string | null
  onSaved: (file: WorldSavedFile) => void
  onClose: () => void
}

/** The longest title main takes (world:document); the field stops there. */
const MAX_TITLE = 200

export function DocumentDialog({ root, designKey, projectName, picture, onSaved, onClose }: DocumentDialogProps): JSX.Element {
  const zoom = useUiZoom()
  // Taken once, when the dialog opens: the view the person asked from.
  const [png] = useState(picture)
  const box = useRef<HTMLDivElement>(null)
  usePaneDialog(box)
  const [title, setTitle] = useState(() => projectName.slice(0, MAX_TITLE))
  const [withPicture, setWithPicture] = useState(png !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The id of the save running now; null: none, or it was cancelled. */
  const runRef = useRef<string | null>(null)

  useEffect(() => () => stopSave(runRef), [])

  const cancel = (): void => {
    stopSave(runRef)
    onClose()
  }

  // Bound only to the Save button, which is disabled while saving or with a blank title.
  const save = (): void => {
    const id = crypto.randomUUID()
    runRef.current = id
    setSaving(true)
    setError(null)
    const picturePng = withPicture ? png as string : undefined
    window.termpolis.worldDocument({ documentId: id, root, designKey, title: title.trim(), picturePng }).then(
      (res) => {
        const mine = runRef.current === id
        if (res.success && 'path' in res.data) {
          onSaved(res.data)
          if (mine) { runRef.current = null; onClose() }
          return
        }
        if (!mine) return
        runRef.current = null
        setSaving(false)
        if (!res.success) setError(res.error)
        // Otherwise the save dialog was closed: back to the choices.
      },
      () => {
        if (runRef.current !== id) return
        runRef.current = null
        setSaving(false)
        setError(UI_FAILED)
      },
    )
  }

  return (
    <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Generate Lumopolis documentation" data-testid="world-document-dialog" className={`${dialogCls} focus:outline-none`} style={zoom}>
      <h2 className="text-base font-semibold text-white">Generate Lumopolis documentation</h2>
      <p className="text-xs text-[#9ca3af]">One page that explains the project: its parts, how they connect, and its tours.</p>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Title
        <input type="text" value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} disabled={saving} className={fieldCls} />
      </label>
      <div className="flex flex-col gap-1">
        <label className="inline-flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={withPicture} disabled={saving || png === null} onChange={(e) => setWithPicture(e.target.checked)} />
          Include the city picture
        </label>
        {png === null && (
          <p data-testid="world-document-no-picture" className="text-xs text-[#9ca3af] pl-5">The city picture needs the 3D map on screen.</p>
        )}
      </div>
      {error !== null && <p role="alert" className="text-xs text-[#f48771]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnCls} onClick={cancel}>Cancel</button>
        <button type="button" className={primaryCls} disabled={saving || title.trim() === ''} onClick={save}>{saving ? 'Saving…' : 'Save…'}</button>
      </div>
    </div>
  )
}
