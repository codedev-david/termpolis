// Saved views of a world: a name, where the camera stood and what was open. Kept per project in
// localStorage; a missing, corrupt or blocked store is an empty list, never an error.
import type { CameraState } from './createWorldViewer'

export const MAX_BOOKMARKS = 20

export interface Bookmark { name: string; camera: CameraState; selection: string[] }

const keyOf = (projectKey: string): string => `termpolis.world.bookmarks.${projectKey}`

function store(projectKey: string, list: Bookmark[]): Bookmark[] {
  try { localStorage.setItem(keyOf(projectKey), JSON.stringify(list)) } catch { /* storage blocked: the list lives for this session only */ }
  return list
}

const vec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

function valid(x: unknown): x is Bookmark {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  const cam = b.camera as Record<string, unknown> | null | undefined
  return typeof b.name === 'string' && b.name !== ''
    && typeof cam === 'object' && cam !== null && vec3(cam.pos) && vec3(cam.target)
    && Array.isArray(b.selection) && b.selection.every((s) => typeof s === 'string')
}

function read(projectKey: string): Bookmark[] {
  try {
    const raw = localStorage.getItem(keyOf(projectKey))
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(valid).slice(0, MAX_BOOKMARKS)
  } catch {
    return []
  }
}

function absent(projectKey: string): boolean {
  try { return localStorage.getItem(keyOf(projectKey)) === null } catch { return false }
}

/** The saved views of a project, newest first; malformed entries are dropped. Never throws.
 *  WP5 fix I5: a project with no list of its own yet takes a copy of the lists saved under its older keys (`aliasKeys`, in
 *  order, a name kept once), so its saved views survive the key change. The older lists stay where they are. */
export function loadBookmarks(projectKey: string, aliasKeys: readonly string[] = []): Bookmark[] {
  const others = aliasKeys.filter((k) => k !== projectKey)
  if (others.length === 0 || !absent(projectKey)) return read(projectKey)
  const list: Bookmark[] = []
  for (const k of others) {
    for (const b of read(k)) if (!list.some((x) => x.name === b.name)) list.push(b)
  }
  return list.length === 0 ? [] : store(projectKey, list.slice(0, MAX_BOOKMARKS))
}


/** Saves a view as the newest, replacing one with the same name, and keeps the newest 20. */
export function saveBookmark(projectKey: string, b: Bookmark): Bookmark[] {
  const list = [b, ...loadBookmarks(projectKey).filter((x) => x.name !== b.name)].slice(0, MAX_BOOKMARKS)
  return store(projectKey, list)
}

export function removeBookmark(projectKey: string, name: string): Bookmark[] {
  return store(projectKey, loadBookmarks(projectKey).filter((x) => x.name !== name))
}
