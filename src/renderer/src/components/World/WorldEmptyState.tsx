// What the Lumopolis pane shows while a world is not drawn yet: opening, mapping (with the
// compile's progress, and Stop mapping), or a failure the user can retry. With no world open the pane shows the home.
// A folder with nothing to map (WP4b F-R9) says why in its own words and offers Choose another folder and Back to
// Home; Try again only where it can help, a folder that could not be read.

import { useUiZoom } from './worldPane'
import { UI_FAILED } from './worldTargets'
import { noFilesReasonOf } from '../../../../shared/world/types'

export type WorldEmptyMode = 'loading' | 'mapping' | 'error'

export interface WorldEmptyStateProps {
  mode: WorldEmptyMode
  /** The latest compile progress, while mapping. */
  progress?: { stage: string; pct: number } | null
  /** The failure message, in error mode. */
  error?: string | null
  /** Try again, in error mode. */
  onRetry?: () => void
  /** Stop mapping, in mapping mode (WP4b F-R6): absent, the mapping cannot be stopped from here. */
  onCancel?: () => void
  /** Choose another folder and Back to Home, for a folder with nothing to map (WP4b F-R9). */
  onChooseFolder?: () => void
  onHome?: () => void
}

const quietBtn = 'text-xs px-3 py-1.5 rounded bg-[#3c3c3c] hover:bg-[#4a4a4a] text-[#cccccc]'
const mainBtn = 'text-xs px-3 py-1.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white'

export function WorldEmptyState({ mode, progress, error, onRetry, onCancel, onChooseFolder, onHome }: WorldEmptyStateProps): JSX.Element {
  const zoom = useUiZoom()
  const noFiles = mode === 'error' ? noFilesReasonOf(error) : null
  // Mapping an empty folder or one of other languages again finds the same; a folder that could not be read may be back.
  const retry = mode === 'error' && onRetry && noFiles !== 'empty' && noFiles !== 'unsupported' ? onRetry : undefined
  return (
    <div className="flex items-center justify-center p-6" style={{ position: 'absolute', inset: 0 }} data-testid="world-empty">
      <div className="max-w-md text-center flex flex-col items-center gap-3 text-[#cccccc]" style={zoom}>
        <i className="fa-solid fa-earth-americas text-3xl text-[#4fc1ff]" aria-hidden="true" />
        {mode === 'loading' && <p className="text-sm" data-testid="world-loading">Opening Lumopolis&hellip;</p>}
        {mode === 'mapping' && <MappingProgress progress={progress ?? null} />}
        {mode === 'mapping' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            data-testid="world-mapping-cancel"
            className={quietBtn}
          >Stop mapping</button>
        )}
        {/* A failure is read out as it shows, the way an error in a dialog is (A11Y Y5). */}
        {mode === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-3" data-testid="world-failure">
            {noFiles === null && <p className="text-sm">Lumopolis could not map this project.</p>}
            {/* M3: the fixed words for a call that threw would only say "couldn't" twice. */}
            {noFiles === null && error !== UI_FAILED && <p className="text-xs text-[#f48771] break-words" data-testid="world-error">{error}</p>}
            {/* The folder's own words say it all; "could not map" over them would only say it twice. */}
            {noFiles !== null && <p className="text-sm break-words" data-testid="world-error">{error}</p>}
          </div>
        )}
        {(retry || noFiles !== null) && (
          <div className="flex flex-wrap justify-center gap-2">
            {retry && <button type="button" onClick={retry} data-testid="world-retry" className={mainBtn}>Try again</button>}
            {noFiles !== null && onChooseFolder && (
              <button type="button" onClick={onChooseFolder} data-testid="world-choose-folder" className={retry ? quietBtn : mainBtn}>Choose another folder</button>
            )}
            {noFiles !== null && onHome && <button type="button" onClick={onHome} data-testid="world-back-home" className={quietBtn}>Back to Home</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function MappingProgress({ progress }: { progress: { stage: string; pct: number } | null }): JSX.Element {
  // The bar takes the exact value (reads report twentieths of a point), the text and the reader a whole percent.
  const exact = progress ? Math.max(0, Math.min(100, progress.pct)) : 0
  const pct = Math.round(exact)
  return (
    <div className="w-72 max-w-full flex flex-col gap-2" data-testid="world-mapping">
      <p className="text-sm">Mapping your project&hellip;</p>
      <div
        role="progressbar"
        aria-label="Mapping progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-full rounded bg-[#3c3c3c] overflow-hidden"
      >
        <div className="h-full bg-[#4fc1ff] transition-[width] duration-300" style={{ width: `${exact}%` }} />
      </div>
      <p className="text-xs text-[#9ca3af]" data-testid="world-progress-text">
        {progress ? `${pct}% · ${progress.stage}` : 'Starting…'}
      </p>
      {/* A screen reader hears each stage once as it starts, not every percent (the bar has the number) (A11Y Y5).
          PENDING SIGN-OFF: the wording. */}
      <p role="status" className="sr-only" data-testid="world-progress-stage">{progress ? `Mapping: ${progress.stage}` : 'Mapping started'}</p>
    </div>
  )
}
