// Public surface of the Lumopolis engine. vite.world.config.ts bundles this file (with Three.js
// inlined) as dist-world/world-viewer.js for the website and the in-app view.
export { createWorldViewer, hasWebGL } from './createWorldViewer'
export type { CameraState, SelectionKind, WorldDrawn, WorldDrawnVisual, WorldGraphics, WorldSelection, WorldViewer, WorldViewerOptions } from './createWorldViewer'
export { buildingCard, edgeCard, techCard, usesTech, escapeHtml } from './cards'
export { renderFallback } from './fallback2d'
export { loadBookmarks, MAX_BOOKMARKS, removeBookmark, saveBookmark } from './bookmarks'
export type { Bookmark } from './bookmarks'
export { DEFAULT_LAYERS } from './sceneModel'
export type { LayerState } from './sceneModel'
export { THEMES } from './themes'
export type { Theme, ThemeName } from './themes'
export { validateWorld } from '../../../../shared/world/validate'
