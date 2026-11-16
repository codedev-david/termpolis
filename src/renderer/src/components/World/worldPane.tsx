// The frame of the Lumopolis pane: below the app's title bar (so the window controls stay usable),
// over everything else, with an opaque background from its first frame. Inline styles, so the
// frame never depends on which utility classes the CSS build happens to contain.
//
// App shows WorldPaneOpening while the Lumopolis chunk (the engine and Three.js) loads. This module
// imports nothing from the engine, so it stays small enough for App's main chunk.
import type { CSSProperties } from 'react'
import { TITLE_BAR_HEIGHT } from '../TitleBar/constants'

/** The Neon theme's background (themes.ts): the pane always opens in Neon. A test keeps the two equal. */
export const WORLD_OPENING_BACKGROUND = '#03050a'

export function worldPaneStyle(background: string): CSSProperties {
  return {
    position: 'fixed', top: TITLE_BAR_HEIGHT, left: 0, right: 0, bottom: 0, zIndex: 40,
    display: 'flex', flexDirection: 'column', background, color: '#cccccc',
  }
}

export function WorldPaneOpening(): JSX.Element {
  return (
    <div data-testid="world-view-opening" style={worldPaneStyle(WORLD_OPENING_BACKGROUND)}>
      <div role="status" style={{ margin: 'auto', fontSize: 14, color: '#9ca3af' }}>Opening Lumopolis…</div>
    </div>
  )
}
