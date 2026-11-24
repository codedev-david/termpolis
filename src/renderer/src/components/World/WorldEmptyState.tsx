// What the Lumopolis pane shows while a world is not drawn yet: opening, mapping (with the
// compile's progress), or a failure the user can retry. With no world open the pane shows the home.

import { useUiZoom } from './worldPane'

export type WorldEmptyMode = 'loading' | 'mapping' | 'error'

export interface WorldEmptyStateProps {
  mode: WorldEmptyMode
  /** The latest compile progress, while mapping. */
  progress?: { stage: string; pct: number } | null
  /** The failure message, in error mode. */
  error?: string | null
  /** Try again, in error mode. */
  onRetry?: () => void
}

export function WorldEmptyState({ mode, progress, error, onRetry }: WorldEmptyStateProps): JSX.Element {
  const zoom = useUiZoom()
  return (
    <div className="flex items-center justify-center p-6" style={{ position: 'absolute', inset: 0 }} data-testid="world-empty">
      <div className="max-w-md text-center flex flex-col items-center gap-3 text-[#cccccc]" style={zoom}>
        <i className="fa-solid fa-earth-americas text-3xl text-[#4fc1ff]" aria-hidden="true" />
        {mode === 'loading' && <p className="text-sm" data-testid="world-loading">Opening Lumopolis&hellip;</p>}
        {mode === 'mapping' && <MappingProgress progress={progress ?? null} />}
        {mode === 'error' && (
          <>
            <p className="text-sm">Lumopolis could not map this project.</p>
            <p className="text-xs text-[#f48771] break-words" data-testid="world-error">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                data-testid="world-retry"
                className="text-xs px-3 py-1.5 rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
              >Try again</button>
            )}
          </>
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
    </div>
  )
}
