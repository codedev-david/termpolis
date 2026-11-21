// Lumopolis export in main: the IPC behind the export dialog and Write documentation (spec 5.2 and 5.4).
//
// The renderer only names a world: a folder (`root`) or a design (`designKey`). Main loads the saved world itself,
// titles it the way the World pane does (shared/world/worldTitle.ts, from the same recent-worlds list), builds the
// sanitiser's context from its own folders, asks where to save (Documents by default), and hands the rest to the
// assembler in export.ts. Nothing the renderer sends is trusted: every field is checked and a bad one is refused
// with err(), never thrown on. Show in folder and Open take only a file this session exported or documented.
// No process is started here and nothing is opened on the web.
//
// Channels:
//   world:export-info   { root? | designKey? }                       -> ok(WorldExportInfo)
//   world:export        { exportId, root? | designKey?, smart, proposalId? } -> ok({ path, bytes }) | ok({ cancelled: true })
//   world:export-cancel { exportId }                                  -> ok(true) when that export was running, else ok(false)
//   world:document      { root? | designKey?, title, picturePng? }    -> ok({ path, bytes }) | ok({ cancelled: true })
//   world:show-file     { path }  shell.showItemInFolder, for an exported file only
//   world:open-file     { path }  shell.openPath, for an exported file only
// and pushes world:export-progress { exportId, step, done, total } while an export runs.
import { join, posix, win32 } from 'node:path'
import { err, ok } from '../ipcResult'
import type { SanitizeContext } from '../../shared/world/exportSanitize'
import type { WorldDoc, WorldEntry } from '../../shared/world/types'
import { worldTitle } from '../../shared/world/worldTitle'
import { DESIGN_KEY_RE, DESIGN_NOT_FOUND } from './designer'
import {
  describedShare, estimateExportBytes, exportWorld, NO_MODEL, NO_RUNTIME, writeDocument,
  type ExportAssets, type ExportFs, type ExportProgress,
} from './export'
import type { WorldIpcMain } from './ipc'

export interface WorldExportDeps {
  /** The saved world for a folder (worldClient.get with no background refresh), or null when none was saved. */
  getWorld(root: string): Promise<WorldDoc | null>
  /** A stored design world by its design:<id> key, or null. */
  loadDesign(designKey: string): Promise<WorldDoc | null>
  /** The recent worlds (the sources registry): the World pane titles a world from this list, and so does main. */
  entries(): Promise<WorldEntry[]>
  /** The save dialog, opened at `defaultPath`: the chosen path, or null when the person closed it. */
  saveDialog(defaultPath: string): Promise<string | null>
  /** The e2e answer for the save dialog (testHooks.testSavePath): undefined means "show the real dialog". */
  testSave?: () => Promise<string | null | undefined>
  documentsDir: string
  homeDir: string
  userDataDir: string
  /** Where the export's files are (export.ts resolveExportAssets). */
  assets(): { assets: ExportAssets } | { missing: 'runtime' } | { missing: 'model'; assets: ExportAssets }
  /** The embedder (localEmbedder's embedBatch). */
  embed(texts: string[]): Promise<(number[] | null)[]>
  fs: ExportFs
  /** Sends to the window; it may be gone, so a throw here is caught and the export goes on. */
  send(channel: string, payload: unknown): void
  showItemInFolder(path: string): void
  /** shell.openPath: '' when the file opened, else the OS's reason. */
  openPath(path: string): Promise<string>
  /** Default process.platform: on win32 an exported path matches in any letter case. */
  platform?: NodeJS.Platform
  /** Default the clock: the page's "exported on" and the documentation's "generated on" day. */
  now?: () => Date
}

export const WORLD_REQUIRED = 'Choose a folder or a design to export.'
export const NO_SAVED_WORLD = "There's no saved map for that folder yet."
export const READ_FAILED = "Lumopolis couldn't read that world. Try again."
export const NOT_EXPORTABLE = "This world didn't pass its checks, so it can't be exported."
export const EXPORT_FAILED = "Lumopolis couldn't export that world. Try again."
export const DOCUMENT_FAILED = "Lumopolis couldn't write that documentation. Try again."
export const ALREADY_RUNNING = 'That export is already running.'
export const WHOLE_DESIGN = 'A design exports whole, so it takes no proposal.'
export const NOT_EXPORTED = 'That file was not exported here.'
export const OPEN_FAILED = "Termpolis couldn't open that file."

const ID_REQUIRED = 'exportId required'
const SMART_REQUIRED = 'smart must be true or false'
const PROPOSAL_REQUIRED = 'proposalId must be a short string'
const TITLE_REQUIRED = 'title must be a string (up to 200 characters)'
const PICTURE_REQUIRED = 'picturePng must be a PNG data URL'
const PATH_REQUIRED = 'path required'

const MAX_ID = 128
const MAX_KEY = 200
const MAX_PATH = 4096
const MAX_TITLE = 200
/** A city picture is a few MB at most; past this the request is refused before anything is read. */
const MAX_PICTURE = 32 * 1024 * 1024
const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/
/** The characters a file name can't hold on Windows (and `/` anywhere). */
const NOT_IN_NAMES = '\\/:*?"<>|'
const MAX_STEM = 120

/**
 * The save dialog's default file name: `<title> - Lumopolis.html` for a world page and `<title> - Lumopolis
 * documentation.html` for its documentation. Characters a file name can't hold, and control characters, become
 * dashes; the stem keeps at most 120 characters, and an empty title is "Lumopolis".
 */
export function defaultSaveName(title: string, kind: 'world' | 'document'): string {
  const safe = Array.from(title, (c) => (c < ' ' || c === '\u007f' || NOT_IN_NAMES.includes(c) ? '-' : c)).join('')
  const stem = safe.trim().slice(0, MAX_STEM).trim() || 'Lumopolis'
  return `${stem} - Lumopolis${kind === 'world' ? '' : ' documentation'}.html`
}

const field = (args: unknown, name: string): unknown => (args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined)
const shortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max
const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A world the renderer named, loaded and titled by main, with the sanitiser's context main built for it. */
interface Resolved { doc: WorldDoc; ctx: SanitizeContext; title: string; design: boolean }

export function registerWorldExportIpc(ipc: WorldIpcMain, deps: WorldExportDeps): void {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? (() => new Date())
  const paths = platform === 'win32' ? win32 : posix
  /** An exported path's key: normalised and absolute, in any letter case on Windows only. */
  const keyOf = (p: string): string => (platform === 'win32' ? win32.resolve(p).toLowerCase() : posix.resolve(p))
  const exported = new Map<string, string>()
  const running = new Map<string, AbortController>()

  const ctxOf = (root: string | null): SanitizeContext => ({ root, home: deps.homeDir, userData: deps.userDataDir })
  const titleOf = async (at: { root: string | null; designKey: string | null }): Promise<string> =>
    worldTitle(await deps.entries().catch((): WorldEntry[] => []), at)

  /** Exactly one of a folder or a design; each must resolve through main's own loaders. A load that throws
   *  propagates, so each handler answers its own fixed sentence. */
  const resolveWorld = async (args: unknown): Promise<Resolved | string> => {
    const root = field(args, 'root')
    const designKey = field(args, 'designKey')
    if ((root === undefined) === (designKey === undefined)) return WORLD_REQUIRED
    if (designKey !== undefined) {
      if (typeof designKey !== 'string' || designKey.length > MAX_KEY || !DESIGN_KEY_RE.test(designKey)) return DESIGN_NOT_FOUND
      const doc = await deps.loadDesign(designKey)
      if (!doc) return DESIGN_NOT_FOUND
      return { doc, ctx: ctxOf(null), title: await titleOf({ root: null, designKey }), design: true }
    }
    if (!shortString(root, MAX_PATH) || !win32.isAbsolute(root)) return WORLD_REQUIRED
    const doc = await deps.getWorld(root)
    if (!doc) return NO_SAVED_WORLD
    return { doc, ctx: ctxOf(root), title: await titleOf({ root, designKey: null }), design: false }
  }

  const pickTarget = async (defaultPath: string): Promise<string | null> => {
    const test = await deps.testSave?.()
    return test !== undefined ? test : deps.saveDialog(defaultPath)
  }

  const progress = (exportId: string, p: ExportProgress): void => {
    try {
      deps.send('world:export-progress', { exportId, ...p })
    } catch {
      // The window is gone: the export still finishes and its file is still written.
    }
  }

  const saved = (path: string, bytes: number) => {
    exported.set(keyOf(path), path)
    return ok({ path, bytes })
  }

  ipc.handle('world:export-info', async (_event: unknown, args?: unknown) => {
    try {
      const world = await resolveWorld(args)
      if (typeof world === 'string') return err(world)
      const found = deps.assets()
      if (!('assets' in found)) return err(NO_RUNTIME)
      const base = { doc: world.doc, ctx: world.ctx, title: world.title }
      const [keywordBytes, smartBytes] = await Promise.all([estimateExportBytes({ ...base, smart: false }), estimateExportBytes({ ...base, smart: true })])
      if (keywordBytes === null || smartBytes === null) return err(NOT_EXPORTABLE)
      const share = describedShare(world.doc)
      const smartAvailable = !('missing' in found)
      return ok({
        title: world.title,
        savedAt: world.doc.generatedAt,
        smartDefault: share.smartDefault && smartAvailable,
        buildings: share.buildings,
        lines: share.lines,
        smartBytes,
        keywordBytes,
        smartAvailable,
        // A design exports whole; a code world can export one of its proposals alone.
        proposals: world.design ? [] : world.doc.layers.plan.map((p) => ({ id: p.id, title: p.title })),
      })
    } catch {
      return err(READ_FAILED)
    }
  })

  ipc.handle('world:export', async (_event: unknown, args?: unknown) => {
    const exportId = field(args, 'exportId')
    const smart = field(args, 'smart')
    const proposalId = field(args, 'proposalId')
    if (!shortString(exportId, MAX_ID)) return err(ID_REQUIRED)
    if (typeof smart !== 'boolean') return err(SMART_REQUIRED)
    if (proposalId !== undefined && !shortString(proposalId, MAX_ID)) return err(PROPOSAL_REQUIRED)
    if (running.has(exportId)) return err(ALREADY_RUNNING)
    // Reserved before the first await, so a cancel sent right after the request finds it.
    const controller = new AbortController()
    running.set(exportId, controller)
    try {
      const world = await resolveWorld(args)
      if (typeof world === 'string') return err(world)
      if (world.design && proposalId !== undefined) return err(WHOLE_DESIGN)
      const found = deps.assets()
      if (!('assets' in found)) return err(NO_RUNTIME)
      if (smart && 'missing' in found) return err(NO_MODEL)
      const target = await pickTarget(join(deps.documentsDir, defaultSaveName(world.title, 'world')))
      if (target === null) return ok({ cancelled: true })
      const result = await exportWorld(
        { doc: world.doc, ctx: world.ctx, title: world.title, smart, ...(proposalId !== undefined ? { proposalId } : {}), target, exportedOn: localDay(now()) },
        { assets: found.assets, embed: deps.embed, fs: deps.fs, signal: controller.signal, progress: (p) => progress(exportId, p) },
      )
      if (result.ok) return saved(result.path, result.bytes)
      return result.cancelled ? ok({ cancelled: true }) : err(result.error)
    } catch {
      return err(EXPORT_FAILED)
    } finally {
      running.delete(exportId)
    }
  })

  ipc.handle('world:export-cancel', (_event: unknown, args?: unknown) => {
    const exportId = field(args, 'exportId')
    if (!shortString(exportId, MAX_ID)) return err(ID_REQUIRED)
    const controller = running.get(exportId)
    controller?.abort()
    return ok(controller !== undefined)
  })

  ipc.handle('world:document', async (_event: unknown, args?: unknown) => {
    const title = field(args, 'title')
    const picturePng = field(args, 'picturePng')
    if (typeof title !== 'string' || title.length > MAX_TITLE) return err(TITLE_REQUIRED)
    if (picturePng !== undefined && !(typeof picturePng === 'string' && picturePng.length <= MAX_PICTURE && PNG_URL.test(picturePng))) {
      return err(PICTURE_REQUIRED)
    }
    try {
      const world = await resolveWorld(args)
      if (typeof world === 'string') return err(world)
      // The person's title, else the world's own; writeDocument sanitises it either way.
      const name = title.trim() || world.title
      const target = await pickTarget(join(deps.documentsDir, defaultSaveName(name, 'document')))
      if (target === null) return ok({ cancelled: true })
      const result = await writeDocument(
        { doc: world.doc, ctx: world.ctx, title: name, ...(typeof picturePng === 'string' ? { picturePng } : {}), target, generatedOn: localDay(now()) },
        deps.fs,
      )
      return result.ok ? saved(result.path, result.bytes) : err(result.error)
    } catch {
      return err(DOCUMENT_FAILED)
    }
  })

  /** The exported file a request names, as it was saved; undefined when this session didn't export it. */
  const exportedFile = (args: unknown): string | undefined | null => {
    const p = field(args, 'path')
    if (!shortString(p, MAX_PATH)) return null
    return paths.isAbsolute(p) ? exported.get(keyOf(p)) : undefined
  }

  ipc.handle('world:show-file', (_event: unknown, args?: unknown) => {
    const file = exportedFile(args)
    if (file === null) return err(PATH_REQUIRED)
    if (file === undefined) return err(NOT_EXPORTED)
    deps.showItemInFolder(file)
    return ok(true)
  })

  ipc.handle('world:open-file', async (_event: unknown, args?: unknown) => {
    const file = exportedFile(args)
    if (file === null) return err(PATH_REQUIRED)
    if (file === undefined) return err(NOT_EXPORTED)
    return (await deps.openPath(file)) === '' ? ok(true) : err(OPEN_FAILED)
  })
}
