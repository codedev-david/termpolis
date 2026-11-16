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
//   world:progress / world:updated           (webContents.send, while a world compiles / after a
//                                             watcher-driven recompile saved)
// `ipc` and `win` are parameters, so this module never imports Electron and tests pass fakes.
import { err, ok } from '../ipcResult'
import type { AskRequest, AskResult } from '../../shared/world/types'
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
  const v = (args as Record<string, unknown>).worldLabelling
  return typeof v === 'boolean' ? { worldLabelling: v } : {}
}

export interface WorldAsker {
  ask(req: AskRequest): Promise<AskResult>
  cancel(askId: string): void
}

const MAX_QUESTION = 4000
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** A checked AskRequest from the renderer's args, or the reason it is not one. */
const askRequestOf = (args: unknown): AskRequest | string => {
  if (!args || typeof args !== 'object') return 'ask request required'
  const a = args as Record<string, unknown>
  if (!nonEmpty(a.askId)) return 'askId required'
  if (!nonEmpty(a.root)) return 'root required'
  if (typeof a.question !== 'string' || a.question.trim() === '' || a.question.length > MAX_QUESTION) return 'question required (up to 4000 characters)'
  if (!strings(a.selection) || !strings(a.cameraRegion)) return 'selection and cameraRegion must be string arrays'
  if (a.summary !== undefined && typeof a.summary !== 'string') return 'summary must be a string'
  return { askId: a.askId, root: a.root, question: a.question, selection: a.selection, cameraRegion: a.cameraRegion, summary: (a.summary as string | undefined) ?? '' }
}

/** Registers the handlers and the push forwarding; returns a function that stops the forwarding. */
export function registerWorldIpc(
  ipc: WorldIpcMain,
  client: WorldIpcClient,
  win: () => WorldIpcWindow | null | undefined,
  settings: WorldSettingsStore,
  asker?: WorldAsker
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
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    })
    ipc.handle('world:ask-cancel', (_event: unknown, args?: unknown) => {
      const askId = args && typeof args === 'object' ? (args as { askId?: unknown }).askId : undefined
      if (!nonEmpty(askId)) return err('askId required')
      asker.cancel(askId)
      return ok(true)
    })
  }

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
