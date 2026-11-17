// Lumopolis IPC (main process): the renderer's three world requests and the two pushes back to it.
//   world:get      { root } → ok(WorldDoc | null)
//   world:compile  { root } → ok(WorldDoc)
//   world:relayout { root } → ok(WorldDoc)   (a compile that ignores the stored positions)
//   world:settings-get       → ok(WorldSettings)
//   world:settings-set patch → ok(WorldSettings)  (only the known fields of the patch apply; a running
//                              world host is told at once, so turning labelling off needs no restart)
//   world:ask      AskRequest → ok(AskResult)   (one question about the world, answered by the user's agent;
//                  registered only when an asker is passed)
//   world:ask-cancel { askId } → ok(true)
//   world:design-draft  { description }          → ok(DesignDraftResult)   (a new design world, keyed design:<id>,
//                                                    sketched by the user's agent; registered only when a designer is passed)
//   world:design-refine { key, message, summary } → ok(DesignRefineResult)  (one conversational change to a design)
//   world:design-cancel { key }                   → ok(boolean)  (stops a running draft (draft:<token>) or refine)
// Sources (the Lumopolis home; registered only when sources are passed):
//   world:sources-list               → ok(WorldEntry[])        (recent worlds, newest first, `missing` marked)
//   world:map-project { root }       → ok(WorldEntry)          (the active terminal's project)
//   world:open-folder                → ok(WorldEntry | null)   (native folder dialog; null on cancel)
//   world:pick-folder                → ok(WorldFolderPick | null)  (the dialog only: registers nothing)
//   world:clone { url, ref? }        → ok(WorldEntry)          (shallow clone into userData, then registered)
//   world:clone-cancel { url, ref? } → ok(boolean)
//   world:remove-source { key }      → ok(true)
//   world:touch-source { key }       → ok(WorldEntry | null)   (a recent world was opened: its lastOpened is now)
//   world:design-get { key }         → ok(WorldDoc)
//   world:build-it { key, root, agent, confirmNonEmpty? } → ok(BuildItResult)  (links the design to the folder; the
//                                      renderer then opens the agent terminal there with the first prompt)
//   world:progress / world:updated           (webContents.send, while a world compiles / after a
//                                             watcher-driven recompile saved)
// `ipc` and `win` are parameters, so this module never imports Electron and tests pass fakes.
import { win32 } from 'path'
import { err, ok } from '../ipcResult'
import type { AskRequest, AskResult, BuildItResult, DesignDraftResult, DesignRefineResult, WorldDoc } from '../../shared/world/types'
import { BAD_REF_MESSAGE, BAD_URL_MESSAGE, validateGitUrl, validGitRef } from '../../shared/world/gitUrl'
import { DESIGN_KEY_RE, DESIGN_NOT_FOUND, DesignFailure } from './designer'
import { folderKey, forbiddenFolder } from './folderSafety'
import type { SourceRegistry } from './sources'
import type { WorldClient } from './worldClient'
import type { WorldSettings, WorldSettingsStore } from './worldSettings'

export interface WorldIpcMain {
  handle(channel: string, listener: (event: unknown, args?: unknown) => unknown): void
}

export interface WorldIpcWindow {
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export type WorldIpcClient = Pick<WorldClient, 'get' | 'compile' | 'relayout' | 'applySettings' | 'onProgress' | 'onUpdated'>

const rootOf = (args: unknown): string | null => {
  const root = args && typeof args === 'object' ? (args as { root?: unknown }).root : undefined
  return typeof root === 'string' && root.trim() !== '' ? root : null
}

/** The allowlisted fields of a settings patch from the renderer; null when it is not an object. */
const settingsPatchOf = (args: unknown): Partial<WorldSettings> | null => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const a = args as Record<string, unknown>
  const patch: Partial<WorldSettings> = {}
  if (typeof a.worldLabelling === 'boolean') patch.worldLabelling = a.worldLabelling
  if (typeof a.worldSpeakAnswers === 'boolean') patch.worldSpeakAnswers = a.worldSpeakAnswers
  return patch
}

export interface WorldAsker {
  ask(req: AskRequest): Promise<AskResult>
  cancel(askId: string): void
}

const MAX_QUESTION = 4000
export const ASK_FAILED = "Lumopolis couldn't answer that question. Try again."
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** A checked AskRequest from the renderer's args, or the reason it is not one. */
const askRequestOf = (args: unknown): AskRequest | string => {
  if (!args || typeof args !== 'object') return 'ask request required'
  const a = args as Record<string, unknown>
  if (!nonEmpty(a.askId)) return 'askId required'
  // win32.isAbsolute accepts C:\x, C:/x and /x alike, so the check is the same on every OS.
  if (!nonEmpty(a.root) || !win32.isAbsolute(a.root)) return 'root required'
  if (typeof a.question !== 'string' || a.question.trim() === '' || a.question.length > MAX_QUESTION) return 'question required (up to 4000 characters)'
  if (!strings(a.selection) || !strings(a.cameraRegion)) return 'selection and cameraRegion must be string arrays'
  if (a.summary !== undefined && typeof a.summary !== 'string') return 'summary must be a string'
  return { askId: a.askId, root: a.root, question: a.question, selection: a.selection, cameraRegion: a.cameraRegion, summary: (a.summary as string | undefined) ?? '' }
}

export interface WorldDesigner {
  draft(description: string, cancelKey?: string): Promise<DesignDraftResult>
  refine(key: string, message: string, summary: string): Promise<DesignRefineResult>
  cancel(key: string): boolean
}

const DRAFT_KEY_RE = /^draft:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

const MAX_DESIGN_TEXT = 4000
export const DESIGN_FAILED = "Lumopolis couldn't work on that design. Try again."
const textOf = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_DESIGN_TEXT

/** A checked refine request from the renderer's args, or the reason it is not one. */
const refineRequestOf = (args: unknown): { key: string; message: string; summary: string } | string => {
  if (!args || typeof args !== 'object') return 'design request required'
  const a = args as Record<string, unknown>
  if (typeof a.key !== 'string' || !DESIGN_KEY_RE.test(a.key)) return 'design key required'
  if (!textOf(a.message)) return 'message required (up to 4000 characters)'
  if (a.summary !== undefined && typeof a.summary !== 'string') return 'summary must be a string'
  return { key: a.key, message: a.message, summary: (a.summary as string | undefined) ?? '' }
}

/** The designer's own friendly failure as it is; anything else that escapes it is never shown raw. */
const designErr = (e: unknown) => err(e instanceof DesignFailure ? e.message : DESIGN_FAILED)

/** What the source handlers need; main passes the real registry, store, dialog and world host. */
export interface WorldSourcesDeps {
  registry: Pick<SourceRegistry, 'list' | 'upsert' | 'remove' | 'touch' | 'get'>
  designs: { load(key: string): Promise<WorldDoc | null> }
  /** The native folder dialog: the chosen folder, or null when the user cancels. */
  pickFolder(): Promise<string | null>
  isEmpty(root: string): Promise<boolean>
  clone(url: string, ref?: string): Promise<{ ok: true; root: string } | { ok: false; error: string }>
  cancelClone(url: string, ref?: string): Promise<boolean>
  /** Watches a Build it folder, so its world follows the agent's writes (a folder outside git has no other
   *  watch). True when this started a new watch, false when the folder was already watched. */
  watch?(root: string): boolean
  /** Stops a watch that Build it started, when its world is removed from the home. */
  unwatch?(root: string): void
  /** The home folder (os.homedir() in the app): it, and every folder above it, is never a Build it target. */
  homeDir: string
  /** Termpolis's data folder: nothing inside it is ever a Build it or open-folder target. */
  userDataDir?: string
}

export const SOURCES_FAILED = "Lumopolis couldn't update its list of worlds. Try again."
export const FOLDER_FAILED = "Lumopolis couldn't open that folder."
export const CLONE_FAILED = "Lumopolis couldn't clone that repository. Try again."
export const NOT_EMPTY = "That folder isn't empty."
export const NOT_PICKED = 'Choose the folder with the Choose folder button first.'
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/
const MAX_KEY = 200
/** The design title's share of the first prompt; the whole prompt stays under the launcher's 500 characters. */
const MAX_PROMPT_TITLE = 80

/** A title as plain words: no character the launcher's shell-safety pass (taskPromptArg) would drop or change. */
const promptTitle = (title: string): string =>
  title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/["`$%\\!()\u201c-\u201f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROMPT_TITLE)
    .trim() || 'untitled'

/**
 * The first prompt of the Build it agent terminal. It reaches the agent through taskPromptArg, which
 * drops quotes, parentheses and the like, so it uses none of them and arrives exactly as written. It names
 * the gateway call in the form gateway_call takes: tool "server/tool" with an arguments object.
 */
export const BUILD_PROMPT = (title: string, key: string): string =>
  `Read the Lumopolis design first: call gateway_call with tool lumopolis/world_read and arguments {designKey: ${key}}. Then build the app it describes in this folder. Design title: ${promptTitle(title)}.`

const field = (args: unknown, name: string): unknown => (args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined)
const absolute = (v: unknown): v is string => nonEmpty(v) && win32.isAbsolute(v)

/** A checked clone target, or the friendly reason it is not one. */
const cloneTargetOf = (args: unknown): { url: string; ref?: string } | string => {
  const url = field(args, 'url')
  if (typeof url !== 'string') return BAD_URL_MESSAGE
  const checked = validateGitUrl(url)
  if (!checked.ok) return checked.reason
  const ref = field(args, 'ref')
  if (ref !== undefined && !validGitRef(ref)) return BAD_REF_MESSAGE
  return ref === undefined ? { url } : { url, ref }
}

/** Registers the handlers and the push forwarding; returns a function that stops the forwarding. */
export function registerWorldIpc(
  ipc: WorldIpcMain,
  client: WorldIpcClient,
  win: () => WorldIpcWindow | null | undefined,
  settings: WorldSettingsStore,
  asker?: WorldAsker,
  designer?: WorldDesigner,
  sources?: WorldSourcesDeps
): () => void {
  const handler =
    (run: (root: string) => Promise<unknown>) =>
    async (_event: unknown, args?: unknown) => {
      const root = rootOf(args)
      if (!root) return err('root required')
      try {
        return ok(await run(root))
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }

  ipc.handle('world:get', handler((root) => client.get(root)))
  ipc.handle('world:compile', handler((root) => client.compile(root)))
  ipc.handle('world:relayout', handler((root) => client.relayout(root)))

  // The Settings toggle "Describe parts with AI" (worldLabelling).
  ipc.handle('world:settings-get', () => {
    try {
      return ok(settings.get())
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })
  ipc.handle('world:settings-set', (_event: unknown, args?: unknown) => {
    const patch = settingsPatchOf(args)
    if (!patch) return err('settings patch required')
    try {
      const next = settings.set(patch)
      // A running world host honours the change from its next compile, not from the next restart.
      client.applySettings()
      return ok(next)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  if (asker) {
    ipc.handle('world:ask', async (_event: unknown, args?: unknown) => {
      const req = askRequestOf(args)
      if (typeof req === 'string') return err(req)
      try {
        return ok(await asker.ask(req))
      } catch {
        // The runner frames its own failures; anything that still escapes it is never shown raw.
        return err(ASK_FAILED)
      }
    })
    ipc.handle('world:ask-cancel', (_event: unknown, args?: unknown) => {
      const askId = args && typeof args === 'object' ? (args as { askId?: unknown }).askId : undefined
      if (!nonEmpty(askId)) return err('askId required')
      asker.cancel(askId)
      return ok(true)
    })
  }

  if (designer) {
    ipc.handle('world:design-draft', async (_event: unknown, args?: unknown) => {
      const description = field(args, 'description')
      if (!textOf(description)) return err('description required (up to 4000 characters)')
      const cancelKey = field(args, 'cancelKey')
      if (cancelKey !== undefined && (typeof cancelKey !== 'string' || !DRAFT_KEY_RE.test(cancelKey))) return err('cancelKey must be draft:<id>')
      try {
        return ok(await (cancelKey === undefined ? designer.draft(description) : designer.draft(description, cancelKey)))
      } catch (e) {
        return designErr(e)
      }
    })
    ipc.handle('world:design-refine', async (_event: unknown, args?: unknown) => {
      const req = refineRequestOf(args)
      if (typeof req === 'string') return err(req)
      try {
        return ok(await designer.refine(req.key, req.message, req.summary))
      } catch (e) {
        return designErr(e)
      }
    })
    ipc.handle('world:design-cancel', (_event: unknown, args?: unknown) => {
      const key = field(args, 'key')
      if (typeof key !== 'string' || !(DESIGN_KEY_RE.test(key) || DRAFT_KEY_RE.test(key))) return err('design key required')
      return ok(designer.cancel(key))
    })
  }

  if (sources) registerSourceHandlers(ipc, sources)

  // A closed or reloading window must never break the host's event stream.
  const offProgress = client.onProgress((e) => {
    try {
      win()?.webContents.send('world:progress', e)
    } catch {
      // window gone
    }
  })
  const offUpdated = client.onUpdated((e) => {
    try {
      win()?.webContents.send('world:updated', e)
    } catch {
      // window gone
    }
  })
  return () => {
    offProgress()
    offUpdated()
  }
}

/** The Lumopolis home's handlers. Every failure is a fixed friendly string; nothing raw reaches the renderer. */
function registerSourceHandlers(ipc: WorldIpcMain, deps: WorldSourcesDeps): void {
  const { registry } = deps
  const home = deps.homeDir
  const forbidden = (root: string): string | null => forbiddenFolder(root, { home, userData: deps.userDataDir })
  /** Folders the native dialog returned this session: the only new folders Build it may write into. */
  const picked = new Set<string>()
  /** Build it folders whose watch Build it started, by registry key, so removing the world stops it. */
  const watched = new Map<string, string>()

  /** Whether Build it may use `root`: a folder the dialog returned, or the folder of a world already in the home. */
  const knownFolder = async (root: string): Promise<boolean> => {
    const key = folderKey(root)
    if (picked.has(key)) return true
    return (await registry.list()).some((e) => e.source.kind !== 'design' && folderKey(e.source.root) === key)
  }

  ipc.handle('world:sources-list', async () => {
    try {
      return ok(await registry.list())
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:map-project', async (_event: unknown, args?: unknown) => {
    const root = field(args, 'root')
    if (!absolute(root)) return err('root required')
    try {
      return ok(await registry.upsert({ kind: 'project', root }))
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:open-folder', async () => {
    try {
      const root = await deps.pickFolder()
      if (root === null) return ok(null)
      const refused = forbidden(root)
      if (refused) return err(refused)
      return ok(await registry.upsert({ kind: 'folder', root }))
    } catch {
      return err(FOLDER_FAILED)
    }
  })

  ipc.handle('world:pick-folder', async () => {
    try {
      const root = await deps.pickFolder()
      if (root === null) return ok(null)
      const refused = forbidden(root)
      if (refused) return err(refused)
      picked.add(folderKey(root))
      return ok({ root, empty: await deps.isEmpty(root) })
    } catch {
      return err(FOLDER_FAILED)
    }
  })

  ipc.handle('world:clone', async (_event: unknown, args?: unknown) => {
    const target = cloneTargetOf(args)
    if (typeof target === 'string') return err(target)
    let res: Awaited<ReturnType<WorldSourcesDeps['clone']>>
    try {
      res = await deps.clone(target.url, target.ref)
    } catch {
      return err(CLONE_FAILED)
    }
    if (!res.ok) return err(res.error)
    try {
      return ok(await registry.upsert({ kind: 'git', url: target.url, ...(target.ref === undefined ? {} : { ref: target.ref }), root: res.root }))
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:clone-cancel', async (_event: unknown, args?: unknown) => {
    const target = cloneTargetOf(args)
    if (typeof target === 'string') return err(target)
    try {
      return ok(await deps.cancelClone(target.url, target.ref))
    } catch {
      return ok(false)
    }
  })

  ipc.handle('world:remove-source', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    if (!nonEmpty(key) || key.length > MAX_KEY) return err('key required')
    try {
      await registry.remove(key)
      const root = watched.get(key)
      if (root !== undefined) {
        watched.delete(key)
        try {
          deps.unwatch?.(root)
        } catch {
          // the watch ends at quit instead
        }
      }
      return ok(true)
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:touch-source', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    if (!nonEmpty(key) || key.length > MAX_KEY) return err('key required')
    try {
      return ok(await registry.touch(key))
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:design-get', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    if (typeof key !== 'string' || !DESIGN_KEY_RE.test(key)) return err(DESIGN_NOT_FOUND)
    try {
      const doc = await deps.designs.load(key)
      return doc ? ok(doc) : err(DESIGN_NOT_FOUND)
    } catch {
      return err(DESIGN_NOT_FOUND)
    }
  })

  ipc.handle('world:build-it', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    const root = field(args, 'root')
    const agent = field(args, 'agent')
    const confirm = field(args, 'confirmNonEmpty')
    if (typeof key !== 'string' || key.length > MAX_KEY || !DESIGN_KEY_RE.test(key)) return err(DESIGN_NOT_FOUND)
    if (!absolute(root)) return err('root required')
    if (typeof agent !== 'string' || !AGENT_RE.test(agent)) return err('agent required')
    if (confirm !== undefined && typeof confirm !== 'boolean') return err('confirmNonEmpty must be a boolean')
    const refused = forbidden(root)
    if (refused) return err(refused)
    let title: string
    try {
      // Only a folder the user chose in the dialog (or one already in the home): never one the renderer names.
      if (!(await knownFolder(root))) return err(NOT_PICKED)
      const entry = await registry.get(key)
      if (!entry || entry.source.kind !== 'design') return err(DESIGN_NOT_FOUND)
      title = entry.title
    } catch {
      return err(SOURCES_FAILED)
    }
    try {
      if (!(await deps.isEmpty(root)) && confirm !== true) return err(NOT_EMPTY)
    } catch {
      return err(FOLDER_FAILED)
    }
    let folderEntryKey: string
    try {
      folderEntryKey = (await registry.upsert({ kind: 'folder', root, linkedDesign: key })).key
    } catch {
      return err(SOURCES_FAILED)
    }
    try {
      if (deps.watch?.(root) === true) watched.set(folderEntryKey, root)
    } catch {
      // the world still opens; it refreshes on the next open instead of live
    }
    const res: BuildItResult = { root, key, title, prompt: BUILD_PROMPT(title, key) }
    return ok(res)
  })
}
