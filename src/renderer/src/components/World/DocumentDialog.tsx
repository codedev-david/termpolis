// Lumopolis documentation: save the world's documentation as one page. The person sets the title (the
// project's name to start with) and whether the city picture goes in; Save… asks main to write the file
// where the person chooses (world:document). A saved file goes to onSaved: the pane shows its toast.
import { useState } from 'react'
import type { WorldSavedFile } from '../../../../shared/world/types'
import { btnCls, dialogCls, fieldCls, primaryCls, UI_FAILED } from './worldTargets'

export interface DocumentDialogProps {
  root?: string
  designKey?: string
  projectName: string
  /** The city as it is on screen, as a PNG data URL; null when there is no 3D map to take it from. */
  picture: () => string | null
  onSaved: (file: WorldSavedFile) => void
  onClose: () => void
}

export function DocumentDialog({ root, designKey, projectName, picture, onSaved, onClose }: DocumentDialogProps): JSX.Element {
  // Taken once, when the dialog opens: the view the person asked from.
  const [png] = useState(picture)
  const [title, setTitle] = useState(projectName)
  const [withPicture, setWithPicture] = useState(png !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bound only to the Save button, which is disabled while saving or with a blank title.
  const save = (): void => {
    setSaving(true)
    setError(null)
    const picturePng = withPicture ? png as string : undefined
    window.termpolis.worldDocument({ root, designKey, title: title.trim(), picturePng }).then(
      (res) => {
        setSaving(false)
        if (!res.success) { setError(res.error); return }
        if (!('path' in res.data)) return // the save dialog was closed: back to the choices
        onSaved(res.data)
        onClose()
      },
      () => { setSaving(false); setError(UI_FAILED) },
    )
  }

  return (
    <div role="dialog" aria-label="Generate Lumopolis documentation" data-testid="world-document-dialog" className={dialogCls}>
      <h2 className="text-base font-semibold text-white">Generate Lumopolis documentation</h2>
      <p className="text-xs text-[#9ca3af]">One page that explains the project: its parts, how they connect, and its tours.</p>
      <label className="flex flex-col gap-1 text-xs text-[#9ca3af]">
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} className={fieldCls} />
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
      {error !== null && <p role="alert" className="text-xs text-[#f14c4c]">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnCls} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryCls} disabled={saving || title.trim() === ''} onClick={save}>{saving ? 'Saving…' : 'Save…'}</button>
      </div>
    </div>
  )
}
