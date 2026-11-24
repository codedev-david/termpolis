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
//       A cancel that loses the race (the file was already renamed into place) still answers ok(true); the
//       export's own answer, ok({ path }), is the truth, so the renderer trusts that and the file stays.
//   world:document      { documentId?, root? | designKey?, title, picturePng? } -> ok({ path, bytes }) | ok({ cancelled: true })
//   world:document-cancel { documentId }                              -> ok(true) when that save was running, else ok(false)
//       As with an export, a cancel that loses the race (the file already renamed into place) leaves the file and
//       the save's own answer, ok({ path }), stands.
//   world:show-file     { path }  shell.showItemInFolder, for an exported file only
//   world:open-file     { path }  shell.openPath, for an exported file only
// and pushes world:export-progress { exportId, step, done, total } while an export runs. A smart export that can't
// use the model answers err(...) with `keywordOnly: true`: the renderer can offer the same export with keyword Ask.
// A world that fails its checks answers the plain sentence; the validator's text goes to the app log only.
import { join, posix, win32 } from 'node:path'
import { err, ok } from '../ipcResult'
import type { SanitizeContext } from '../../shared/world/exportSanitize'
import type { WorldDoc, WorldEntry } from '../../shared/world/types'
import { worldTitle } from '../../shared/world/worldTitle'
import { DESIGN_KEY_RE, DESIGN_NOT_FOUND } from './designer'
import {
  describedShare, estimateExportBytes, exportWorld, NO_MODEL, NO_RUNTIME, NOT_EXPORTABLE, writeDocument,
  type ExportAssets, type ExportFs, type ExportProgress, type ExportResult,
} from './export'

export { NOT_EXPORTABLE }
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
  /** The Documents folder (app.getPath('documents')), asked at each save: it can throw when the OS can't say
   *  (a redirected or unavailable folder), and then the save dialog opens in the home folder. */
  documentsDir(): string
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
  /** Writes a line to the app log. Default console.warn, which main mirrors into the app log. */
  log?: (message: string) => void
}

export const WORLD_REQUIRED = 'Choose a folder or a design to export.'
export const NO_SAVED_WORLD = "There's no saved map for that folder yet."
export const READ_FAILED = "Lumopolis couldn't read that world. Try again."
export const EXPORT_FAILED = "Lumopolis couldn't export that world. Try again."
export const DOCUMENT_FAILED = "Lumopolis couldn't write that documentation. Try again."
export const ALREADY_RUNNING = 'That export is already running.'
export const DOCUMENT_RUNNING = 'That documentation is already being written.'
export const WHOLE_DESIGN = 'A design exports whole, so it takes no proposal.'
export const NOT_EXPORTED = 'That file was not exported here.'
export const OPEN_FAILED = "Termpolis couldn't open that file."
/** The model is installed but couldn't index this world (its files unreadable, or no embedding came back). */
export const KEYWORD_ONLY = "Smart Ask couldn't index this world, so this export can use keyword Ask only."

const ID_REQUIRED = 'exportId required'
const DOCUMENT_ID_REQUIRED = 'documentId required'
const DOCUMENT_ID_SHORT = 'documentId must be a short string'
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
const PNG_PREFIX = 'data:image/png;base64,'
/** Every PNG file starts with these eight bytes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** A PNG data URL within the size bound whose bytes start with the PNG signature. Only the first 12 base64
 *  characters (9 bytes) are decoded: the regex has already checked the whole payload's alphabet. */
const isPngUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > MAX_PICTURE || !PNG_URL.test(v)) return false
  const head = Buffer.from(v.slice(PNG_PREFIX.length, PNG_PREFIX.length + 12), 'base64')
  return PNG_SIGNATURE.every((b, i) => head[i] === b)
}
/** The characters a file name can't hold on Windows (and `/` anywhere). */
const NOT_IN_NAMES = '\\/:*?"<>|'
/** Text-direction controls (embeddings, overrides and isolates): they could make a name read reversed. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/
const MAX_STEM = 120

/**
 * The save dialog's default file name: `<title> - Lumopolis.html` for a world page and `<title> - Lumopolis
 * documentation.html` for its documentation. Characters a file name can't hold, control characters and
 * text-direction controls become dashes; the stem keeps at most 120 characters (code points, so an emoji is never
 * split), and an empty title is "Lumopolis".
 */
export function defaultSaveName(title: string, kind: 'world' | 'document'): string {
  const safe = Array.from(title, (c) => (c < ' ' || c === '\u007f' || NOT_IN_NAMES.includes(c) || BIDI.test(c) ? '-' : c))
  const stem = Array.from(safe.join('').trim()).slice(0, MAX_STEM).join('').trim() || 'Lumopolis'
  return `${stem} - Lumopolis${kind === 'world' ? '' : ' documentation'}.html`
}

/** How many numbered names (` (2)` to ` (100)`) a save tries before it takes a random one. */

const field = (args: unknown, name: string): unknown => (args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined)
const shortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max
const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A world the renderer named, loaded and titled by main, with the sanitiser's context main built for it. */
interface Resolved { doc: WorldDoc; ctx: SanitizeContext; title: string; design: boolean }

export function registerWorldExportIpc(ipc: WorldIpcMain, deps: WorldExportDeps): void {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((message: string) => console.warn(message))
  const paths = platform === 'win32' ? win32 : posix
  /** An exported path's key: normalised and absolute, in any letter case on Windows only. */
  const keyOf = (p: string): string => (platform === 'win32' ? win32.resolve(p).toLowerCase() : posix.resolve(p))
  const exported = new Map<string, string>()
  const running = new Map<string, AbortController>()
  const documents = new Map<string, AbortController>()

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
    // A first map drawn from the listing is not a saved map: nothing is exported until the complete world is (I1).
    if (!doc || doc.provisional === true) return NO_SAVED_WORLD
    return { doc, ctx: ctxOf(root), title: await titleOf({ root, designKey: null }), design: false }
  }

  /** Documents, asked now (never at startup); the home folder when the OS can't say. */
  const saveFolder = (): string => {
    try {
      return deps.documentsDir()
    } catch {
      return deps.homeDir
    }
  }

  /**
   * The chosen path, ending in .html (in any letter case) so Open always opens a web page. A name ending in .html is
   * the dialog's own, and the dialog asked before replacing it. `.html` added here makes a name the dialog never saw
   * (a Linux dialog adds no extension): `newName` has the write claim a free name then (export.ts claimName), so it
   * never replaces a file.
   */
  const asHtml = (chosen: string): { target: string; newName: boolean } =>
    /\.html$/i.test(chosen) ? { target: chosen, newName: false } : { target: `${chosen}.html`, newName: true }

  /** The save dialog (or the test run's answer), opened at `<Documents>/<name>`: the path ending in .html, or null. */
  const pickTarget = async (name: string): Promise<{ target: string; newName: boolean } | null> => {
    const test = await deps.testSave?.()
    const chosen = test !== undefined ? test : await deps.saveDialog(join(saveFolder(), name))
    return chosen === null ? null : asHtml(chosen)
  }

  /** A smart export that can't use the model: the sentence, and a flag so the renderer can offer keyword Ask. */
  const keywordOnly = (sentence: string) => ({ ...err(sentence), keywordOnly: true as const })

  const progress = (exportId: string, p: ExportProgress): void => {
    try {
      deps.send('world:export-progress', { exportId, ...p })
    } catch {
      // The window is gone: the export still finishes and its file is still written.
    }
  }

  /** A failure's sentence for the renderer; its detail (the validator's text) goes to the app log only. */
  const failed = (what: string, result: Extract<ExportResult, { ok: false }>) => {
    if (result.detail !== undefined) log(`Lumopolis ${what}: the world failed its checks: ${result.detail}`)
    return err(result.error)
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
      if (smart && 'missing' in found) return keywordOnly(NO_MODEL)
      // A cancel while the world loaded never opens the dialog; one while the dialog was open reads and writes nothing.
      if (controller.signal.aborted) return ok({ cancelled: true })
      const picked = await pickTarget(defaultSaveName(world.title, 'world'))
      if (picked === null || controller.signal.aborted) return ok({ cancelled: true })
      const result = await exportWorld(
        { doc: world.doc, ctx: world.ctx, title: world.title, smart, ...(proposalId !== undefined ? { proposalId } : {}), ...picked, exportedOn: localDay(now()) },
        { assets: found.assets, embed: deps.embed, fs: deps.fs, signal: controller.signal, progress: (p) => progress(exportId, p) },
      )
      if (result.ok) return saved(result.path, result.bytes)
      if (result.cancelled) return ok({ cancelled: true })
      // The assets said the model is here, yet it couldn't index this world: never "isn't installed".
      return result.keywordOnly ? keywordOnly(KEYWORD_ONLY) : failed('export', result)
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
    const documentId = field(args, 'documentId')
    const title = field(args, 'title')
    const picturePng = field(args, 'picturePng')
    if (documentId !== undefined && !shortString(documentId, MAX_ID)) return err(DOCUMENT_ID_SHORT)
    if (typeof title !== 'string' || title.length > MAX_TITLE) return err(TITLE_REQUIRED)
    if (picturePng !== undefined && !isPngUrl(picturePng)) return err(PICTURE_REQUIRED)
    if (documentId !== undefined && documents.has(documentId)) return err(DOCUMENT_RUNNING)
    // Reserved before the first await, so a cancel sent right after the request finds it.
    const controller = new AbortController()
    if (documentId !== undefined) documents.set(documentId, controller)
    try {
      const world = await resolveWorld(args)
      if (typeof world === 'string') return err(world)
      if (controller.signal.aborted) return ok({ cancelled: true })
      // The person's title, else the world's own; writeDocument sanitises it either way.
      const name = title.trim() || world.title
      const picked = await pickTarget(defaultSaveName(name, 'document'))
      if (picked === null || controller.signal.aborted) return ok({ cancelled: true })
      const result = await writeDocument(
        { doc: world.doc, ctx: world.ctx, title: name, ...(typeof picturePng === 'string' ? { picturePng } : {}), ...picked, generatedOn: localDay(now()) },
        deps.fs,
        controller.signal,
      )
      if (result.ok) return saved(result.path, result.bytes)
      return result.cancelled ? ok({ cancelled: true }) : failed('documentation', result)
    } catch {
      return err(DOCUMENT_FAILED)
    } finally {
      if (documentId !== undefined) documents.delete(documentId)
    }
  })

  ipc.handle('world:document-cancel', (_event: unknown, args?: unknown) => {
    const documentId = field(args, 'documentId')
    if (!shortString(documentId, MAX_ID)) return err(DOCUMENT_ID_REQUIRED)
    const controller = documents.get(documentId)
    controller?.abort()
    return ok(controller !== undefined)
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
