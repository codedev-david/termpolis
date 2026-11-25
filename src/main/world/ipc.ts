// Lumopolis IPC (main process): the renderer's three world requests and the two pushes back to it.
//   world:get      { root } → ok(WorldDoc | null)
//   world:compile  { root } → ok(WorldDoc)
//   world:relayout { root } → ok(WorldDoc)   (a compile that ignores the stored positions)
//   world:annotate { key, itemId, text } → ok(WorldDoc)   (a person confirms a claim: stored as a verified claim with
//                                      person evidence, merged into the world; the pane shows the returned doc)
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
//   world:map-project { root }       → ok(WorldEntry)          (the active terminal's project: a folder that looks like one)
//   world:open-folder                → ok(WorldEntry | null)   (native folder dialog; null on cancel)
//   world:pick-folder                → ok(WorldFolderPick | null)  (the dialog only: registers nothing)
//   world:clone { url, ref?, access? } → ok(WorldEntry | CloneNeedsLogin)  (shallow clone into userData, then registered
//                                      with how it was opened, never a token; a sign-in failure answers needsLogin)
//   world:clone-cancel { url, ref? } → ok(boolean)
//   world:remove-source { key }      → ok(true)
//   world:touch-source { key }       → ok(WorldEntry | null)   (a recent world was opened: its lastOpened is now)
//   world:update-source { key, access? } → ok({ changed } | { skipped: true } | CloneNeedsLogin)  (brings a cloned
//                                      repository up to date; a missing key, a world that is not a cloned
//                                      repository, and a token entry asked without its token are all skipped)
//   world:design-get { key }         → ok(WorldDoc)
//   world:build-it { key, root, agent, confirmNonEmpty? } → ok(BuildItResult)  (links the design to the folder; the
//                                      renderer then opens the agent terminal there with the first prompt)
//   world:progress / world:updated           (webContents.send, while a world compiles / after a
//                                             watcher-driven recompile saved)
// Export (exportIpc.ts, registered beside these; the renderer names a world, main loads and titles it):
//   world:export-info   { root? | designKey? }                        → ok(WorldExportInfo)
//   world:export        { exportId, root? | designKey?, smart, proposalId? } → ok({ path, bytes } | { cancelled: true })
//   world:export-cancel { exportId }                                  → ok(boolean)
//   world:document      { root? | designKey?, title, picturePng? }    → ok({ path, bytes } | { cancelled: true })
//   world:show-file / world:open-file { path }  → ok(true)  (only a file this session exported or documented)
//   world:export-progress { exportId, step, done, total }  (webContents.send, while an export runs)
// `ipc` and `win` are parameters, so this module never imports Electron and tests pass fakes.
import { win32 } from 'path'
import { err, ok } from '../ipcResult'
import { NO_PART } from './annotations'
import { WORLD_SAVED_BY_NEWER } from './worldStore'
import { isExecAgent } from '../headlessExec'
import { isSafeModelId } from '../modelCatalog'
import type { AskRequest, AskResult, BuildItResult, Claim, DesignDraftResult, DesignRefineResult, WorldDoc } from '../../shared/world/types'
import { BAD_REF_MESSAGE, BAD_URL_MESSAGE, validateGitUrl, validGitRef } from '../../shared/world/gitUrl'
import { TOKEN_REJECTED_MESSAGE, type CloneNeedsLogin, type NeedsLogin, type RepoAccess, type RepoLogin } from '../../shared/world/repoAccess'
import { AUTH_MESSAGE, NOT_FOUND_MESSAGE, REPO_GONE_MESSAGE, STILL_NOT_FOUND_MESSAGE, STILL_NOT_FOUND_TOKEN_MESSAGE } from './gitSource'
import { DESIGN_KEY_RE, DESIGN_NOT_FOUND, DesignFailure } from './designer'
import { folderKey, forbiddenFolderReal, isProjectFolder } from './folderSafety'
import type { SourceRegistry } from './sources'
import type { WorldClient } from './worldClient'
import { MAX_QUESTION_CHARS, cleanQuestion, questionFits } from '../../shared/world/askLimits'
import { isShownAsIs, windowMessage } from './windowError'
import type { WorldSettings, WorldSettingsStore } from './worldSettings'

export interface WorldIpcMain {
  handle(channel: string, listener: (event: unknown, args?: unknown) => unknown): void
}

export interface WorldIpcWindow {
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** PENDING SIGN-OFF (#65): why a confirmation or the service names were not saved, in place of the raw error. The pane
 *  shows its own sentence for the action instead (M3), so this never reaches a person there; it keeps internals off the
 *  wire. */
export const ANNOTATE_FAILED = "Lumopolis couldn't save it just now. Try again."

/** PENDING SIGN-OFF (#65): what a settings change that failed answers; the reason goes to the log. */
export const SETTINGS_FAILED = "Lumopolis couldn't change that setting. Try again."
/** PENDING SIGN-OFF (M4): what a settings read that failed answers; the reason goes to the log. */
export const SETTINGS_LOAD_FAILED = "Lumopolis couldn't load its settings. Try again."

/** The host's coded refusals of annotate the window is told by name, because a Try again would not help. */
const ANNOTATE_REFUSALS: Record<string, string> = { WORLD_SAVED_BY_NEWER }

/** The words for a failure of annotate that is a host refusal (the host marked it and gave a known code), else null. */
const refusalOf = (e: unknown): string | null => {
  const code = isShownAsIs(e) ? (e as { code?: unknown }).code : undefined
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ANNOTATE_REFUSALS, code) ? ANNOTATE_REFUSALS[code] : null
}

/** A settings failure: logged, answered with the fixed words for a read or a change. */
const settingsFailed = (e: unknown, words: string): ReturnType<typeof err> => {
  console.warn('[world] the Lumopolis settings failed:', e)
  return err(words)
}

export type WorldIpcClient = Pick<WorldClient, 'get' | 'compile' | 'relayout' | 'applySettings' | 'annotate' | 'onProgress' | 'onUpdated'> &
  Partial<Pick<WorldClient, 'cancelLabelling'>>

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
  if (typeof a.worldCiResults === 'boolean') patch.worldCiResults = a.worldCiResults
  if (isExecAgent(a.worldAgent)) patch.worldAgent = a.worldAgent
  if (typeof a.worldOpened === 'boolean') patch.worldOpened = a.worldOpened
  if (typeof a.worldHintDismissed === 'boolean') patch.worldHintDismissed = a.worldHintDismissed
  return patch
}

export interface WorldAsker {
  ask(req: AskRequest): Promise<AskResult>
  cancel(askId: string): void
  /** WPA: a world was opened, so an ask may follow: get ready (the memory primer) without being waited on. */
  warm?(root: string): void
  /** Readies what the world keeps for this root before it is read (WPA fix M2: annotations under an older key). Never fails an
   *  open. Resolves with the older keys of the root its saved data was adopted from (WP5 fix I5: the pane's saved views follow). */
  prepare?(root: string): Promise<string[] | void>
}

export const ASK_FAILED = "Lumopolis couldn't answer that question. Try again."
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
/** `{ model }` for a model id safe to put on a command line, else nothing: an unsafe id is dropped, never passed on. */
const modelField = (v: unknown): { model?: string } => (isSafeModelId(v) ? { model: v } : {})
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** `{ proposalId }` for a short non-empty string, else nothing: anything else is dropped. */
const proposalField = (v: unknown): { proposalId?: string } => (typeof v === 'string' && v !== '' && v.length <= 128 ? { proposalId: v } : {})

/** A checked AskRequest from the renderer's args, or the reason it is not one. */
const askRequestOf = (args: unknown): AskRequest | string => {
  if (!args || typeof args !== 'object') return 'ask request required'
  const a = args as Record<string, unknown>
  if (!nonEmpty(a.askId)) return 'askId required'
  // win32.isAbsolute accepts C:\x, C:/x and /x alike, so the check is the same on every OS.
  if (!nonEmpty(a.root) || !win32.isAbsolute(a.root)) return 'root required'
  // Cleaned before it is checked (U9): the limit counts what reaches the agent, the same limit the field holds to.
  const question = typeof a.question === 'string' ? cleanQuestion(a.question) : ''
  if (!questionFits(question)) return `question required (up to ${MAX_QUESTION_CHARS} characters)`
  if (!strings(a.selection) || !strings(a.cameraRegion)) return 'selection and cameraRegion must be string arrays'
  if (a.summary !== undefined && typeof a.summary !== 'string') return 'summary must be a string'
  return { askId: a.askId, root: a.root, question, selection: a.selection, cameraRegion: a.cameraRegion, summary: (a.summary as string | undefined) ?? '', ...modelField(a.model), ...proposalField(a.proposalId) }
}

export interface WorldDesigner {
  draft(description: string, cancelKey?: string, model?: string): Promise<DesignDraftResult>
  refine(key: string, message: string, summary: string, model?: string): Promise<DesignRefineResult>
  cancel(key: string): boolean
}

const DRAFT_KEY_RE = /^draft:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

const MAX_DESIGN_TEXT = 4000
export const DESIGN_FAILED = "Lumopolis couldn't work on that design. Try again."
const textOf = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_DESIGN_TEXT

/** A checked refine request from the renderer's args, or the reason it is not one. */
const refineRequestOf = (args: unknown): { key: string; message: string; summary: string; model?: string } | string => {
  if (!args || typeof args !== 'object') return 'design request required'
  const a = args as Record<string, unknown>
  if (typeof a.key !== 'string' || !DESIGN_KEY_RE.test(a.key)) return 'design key required'
  // A design change is typed in the ask field, so it is cleaned and limited as a question is (U9).
  const message = typeof a.message === 'string' ? cleanQuestion(a.message) : ''
  if (!questionFits(message)) return `message required (up to ${MAX_QUESTION_CHARS} characters)`
  if (a.summary !== undefined && typeof a.summary !== 'string') return 'summary must be a string'
  return { key: a.key, message, summary: (a.summary as string | undefined) ?? '', ...modelField(a.model) }
}

/** The designer's own friendly failure as it is; anything else that escapes it is never shown raw. */
const designErr = (e: unknown) => err(e instanceof DesignFailure ? e.message : DESIGN_FAILED)

/** What the source handlers need; main passes the real registry, store, dialog and world host. */
export interface WorldSourcesDeps {
  registry: Pick<SourceRegistry, 'list' | 'upsert' | 'remove' | 'touch' | 'get' | 'setLogin'>
  designs: { load(key: string): Promise<WorldDoc | null> }
  /** The native folder dialog: the chosen folder, or null when the user cancels. */
  pickFolder(): Promise<string | null>
  isEmpty(root: string): Promise<boolean>
  /** Clones with the sign-in the person chose; a token is only this call's argument. */
  clone(url: string, ref?: string, access?: RepoAccess): Promise<{ ok: true; root: string } | { ok: false; error: string; needsLogin?: NeedsLogin }>
  /** Updates a cloned repository: `login` is how it was opened, `access` a sign-in given now. */
  updateSource(
    url: string,
    ref: string | undefined,
    login: RepoLogin | undefined,
    access?: RepoAccess
  ): Promise<{ ok: true; changed: boolean } | { ok: false; error: string; needsLogin?: NeedsLogin }>
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
  /** A folder's real path (default fs.promises.realpath), so a link never disguises a refused folder. */
  realpath?(p: string): Promise<string>
  /** Whether a folder looks like a project (default: a project marker among its first entries). */
  isProject?(root: string): Promise<boolean>
}

export const SOURCES_FAILED = "Lumopolis couldn't update its list of worlds. Try again."
export const FOLDER_FAILED = "Lumopolis couldn't open that folder."
export const CLONE_FAILED = "Lumopolis couldn't clone that repository. Try again."
export const UPDATE_FAILED = "Lumopolis couldn't update that repository. Try again."
export const BAD_ACCESS = 'Choose how to sign in: the login this computer uses for git, or a token.'
export const NOT_EMPTY = "That folder isn't empty."
export const NOT_PICKED = 'Choose the folder with the Choose folder button first.'
export const NOT_A_PROJECT = "That folder doesn't look like a project. Use Open folder instead."
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

/**
 * The sign-in a request carries: absent, exactly `{ mode: 'machine' }`, or exactly `{ mode: 'token', value }`
 * with text. Any other shape is refused (`null`), and a fresh object is returned so no unknown field travels on.
 */
const accessOf = (args: unknown): { access?: RepoAccess } | null => {
  const a = field(args, 'access')
  if (a === undefined) return {}
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  const o = a as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  if (keys === 'mode' && o.mode === 'machine') return { access: { mode: 'machine' } }
  if (keys === 'mode,value' && o.mode === 'token' && typeof o.value === 'string') return { access: { mode: 'token', value: o.value } }
  return null
}

/** What a host that still said "not found" means, by the access used (R1): a token's reach, or the account's. */
const stillNotFound = (access: RepoAccess | undefined): string => (access?.mode === 'token' ? STILL_NOT_FOUND_TOKEN_MESSAGE : STILL_NOT_FOUND_MESSAGE)

/** A sign-in failure as the renderer's data: the host, whether git has a helper, and the words to show. A not-found,
 *  first or still after a sign-in (M2), shows the sign-in choices as the second choice: the address comes first. */
const needsLoginOf = (n: NeedsLogin, access: RepoAccess | undefined): CloneNeedsLogin =>
  n.notFound || n.stillNotFound
    ? { needsLogin: { host: n.host, helper: n.helper, notFound: true, message: n.stillNotFound ? stillNotFound(access) : NOT_FOUND_MESSAGE } }
    : { needsLogin: { host: n.host, helper: n.helper, message: access?.mode === 'token' ? TOKEN_REJECTED_MESSAGE : AUTH_MESSAGE } }

/** Registers the handlers and the push forwarding; returns a function that stops the forwarding. */
export function registerWorldIpc(
  ipc: WorldIpcMain,
  client: WorldIpcClient,
  win: () => WorldIpcWindow | null | undefined,
  settings: Pick<WorldSettingsStore, 'get' | 'set'> & Partial<Pick<WorldSettingsStore, 'ready'>>,
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
        // WP3 round 3: a failure main met itself before the host call (headOf, snapshotOf) is logged, never shown as it is.
        return err(windowMessage(e))
      }
    }

  // The pane's get: it may draw the first map from the listing while the first world is compiled (WP4a).
  ipc.handle('world:get', handler(async (root) => {
    try { asker?.warm?.(root) } catch { /* readying the asker never fails an open */ }
    let aliasKeys: string[] | void = undefined
    try { aliasKeys = await asker?.prepare?.(root) } catch { /* nor does readying its annotations */ }
    const doc = await client.get(root, { provisional: true })
    // WP5 fix I5: the root's older keys go with the world (never saved), so the pane copies its saved views from them.
    return doc && Array.isArray(aliasKeys) && aliasKeys.length > 0 ? { ...doc, aliasKeys } : doc
  }))
  ipc.handle('world:compile', handler((root) => client.compile(root)))
  ipc.handle('world:relayout', handler((root) => client.relayout(root)))

  // A person's confirmation: the only writer of person evidence. The claim is built here, never taken from the pane.
  ipc.handle('world:annotate', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    const itemId = field(args, 'itemId')
    const text = field(args, 'text')
    if (!nonEmpty(key) || typeof itemId !== 'string' || typeof text !== 'string' || text.trim() === '') return err('key, itemId and text required')
    try {
      const claim: Claim = { text: text.trim(), state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] }
      return ok(await client.annotate(key, itemId, claim))
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      const refusal = refusalOf(e)
      if (refusal !== null) return err(refusal)
      return err(m === NO_PART || m === 'No world with that key.' ? m : ANNOTATE_FAILED)
    }
  })

  // The Settings toggle "Describe parts with AI" (worldLabelling).
  ipc.handle('world:settings-get', async () => {
    try {
      // Answer what the file says, never the defaults a get before the load would see (the sidebar's New badge).
      await settings.ready?.()
      return ok(settings.get())
    } catch (e) {
      return settingsFailed(e, SETTINGS_LOAD_FAILED)
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
      return settingsFailed(e, SETTINGS_FAILED)
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
        return ok(await designer.draft(description, cancelKey, modelField(field(args, 'model')).model))
      } catch (e) {
        return designErr(e)
      }
    })
    ipc.handle('world:design-refine', async (_event: unknown, args?: unknown) => {
      const req = refineRequestOf(args)
      if (typeof req === 'string') return err(req)
      try {
        return ok(await designer.refine(req.key, req.message, req.summary, req.model))
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

  if (sources) registerSourceHandlers(ipc, sources, client)

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
function registerSourceHandlers(ipc: WorldIpcMain, deps: WorldSourcesDeps, client: WorldIpcClient): void {
  const { registry } = deps
  const home = deps.homeDir
  const forbidden = (root: string): Promise<string | null> => forbiddenFolderReal(root, { home, userData: deps.userDataDir }, deps.realpath)
  const isProject = deps.isProject ?? ((root: string) => isProjectFolder(root))
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
      // The renderer names this folder, so it must look like a project (or already be in the home), and
      // never be a refused one under any of its names.
      // Intended: a clone under userData (world/repos/<hash>) is refused too; it stays a git source, never a project.
      const refused = await forbidden(root)
      if (refused) return err(refused)
      if (!(await knownFolder(root)) && !(await isProject(root))) return err(NOT_A_PROJECT)
      return ok(await registry.upsert({ kind: 'project', root }))
    } catch {
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:open-folder', async () => {
    try {
      const root = await deps.pickFolder()
      if (root === null) return ok(null)
      const refused = await forbidden(root)
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
      const refused = await forbidden(root)
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
    const asked = accessOf(args)
    if (!asked) return err(BAD_ACCESS)
    const { access } = asked
    let res: Awaited<ReturnType<WorldSourcesDeps['clone']>>
    try {
      res = access ? await deps.clone(target.url, target.ref, access) : await deps.clone(target.url, target.ref)
    } catch {
      return err(CLONE_FAILED)
    }
    if (!res.ok) return res.needsLogin ? ok(needsLoginOf(res.needsLogin, access)) : err(res.error)
    try {
      return ok(
        await registry.upsert({
          kind: 'git',
          url: target.url,
          ...(target.ref === undefined ? {} : { ref: target.ref }),
          root: res.root,
          // how it was opened, so a background update knows; the token itself is never kept
          ...(access ? { login: access.mode } : {})
        })
      )
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
      // Its labelling calls still waiting for a slot never start a CLI (the registry key is the world's project key).
      client.cancelLabelling?.(key)
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
    } catch (e) {
      // Logged so a failed touch can be told apart later (an EPERM from a file held open, a full disk): the code
      // only, since the message names the user's folder. The renderer still updates the repository it shows.
      const code = (e as { code?: unknown } | null)?.code
      console.warn('[world] marking a world opened failed:', typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'unknown')
      return err(SOURCES_FAILED)
    }
  })

  ipc.handle('world:update-source', async (_event: unknown, args?: unknown) => {
    const key = field(args, 'key')
    if (!nonEmpty(key) || key.length > MAX_KEY) return err('key required')
    const asked = accessOf(args)
    if (!asked) return err(BAD_ACCESS)
    const { access } = asked
    let entry: Awaited<ReturnType<WorldSourcesDeps['registry']['get']>>
    try {
      entry = await registry.get(key)
    } catch {
      return err(SOURCES_FAILED)
    }
    const src = entry?.source
    // Only a cloned repository updates; one opened with a token waits until the person gives it again.
    if (!src || src.kind !== 'git' || (src.login === 'token' && access?.mode !== 'token')) return ok({ skipped: true as const })
    let res: Awaited<ReturnType<WorldSourcesDeps['updateSource']>>
    try {
      res = access ? await deps.updateSource(src.url, src.ref, src.login, access) : await deps.updateSource(src.url, src.ref, src.login)
    } catch {
      return err(UPDATE_FAILED)
    }
    // F-R8: "not found" from the server is no reason to ask for a sign-in over a saved copy: the address may be gone.
    // R4: the same answer to this computer's login, in the background, says the repository may have moved or gone; a
    // sign-in stays offered, as the second choice, since the account may have lost access.
    if (!res.ok && res.needsLogin?.stillNotFound && !access) {
      return ok({ needsLogin: { host: res.needsLogin.host, helper: res.needsLogin.helper, notFound: true as const, message: REPO_GONE_MESSAGE } })
    }
    if (!res.ok) return res.needsLogin && !res.needsLogin.notFound ? ok(needsLoginOf(res.needsLogin, access)) : err(res.error)
    if (access) {
      try {
        await registry.setLogin(key, access.mode)
      } catch {
        // the update worked; how it was opened is remembered next time
      }
    }
    return ok({ changed: res.changed })
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
    const refused = await forbidden(root)
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
