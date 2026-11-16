// Lumopolis IPC (main process): the renderer's three world requests and the two pushes back to it.
//   world:get      { root } → ok(WorldDoc | null)
//   world:compile  { root } → ok(WorldDoc)
//   world:relayout { root } → ok(WorldDoc)   (a compile that ignores the stored positions)
//   world:settings-get       → ok(WorldSettings)
//   world:settings-set patch → ok(WorldSettings)  (only the known fields of the patch apply)
//   world:progress / world:updated           (webContents.send, while a world compiles / after a
//                                             watcher-driven recompile saved)
// `ipc` and `win` are parameters, so this module never imports Electron and tests pass fakes.
import { err, ok } from '../ipcResult'
import type { WorldClient } from './worldClient'
import type { WorldSettings, WorldSettingsStore } from './worldSettings'

export interface WorldIpcMain {
  handle(channel: string, listener: (event: unknown, args?: unknown) => unknown): void
}

export interface WorldIpcWindow {
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export type WorldIpcClient = Pick<WorldClient, 'get' | 'compile' | 'relayout' | 'onProgress' | 'onUpdated'>

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

/** Registers the handlers and the push forwarding; returns a function that stops the forwarding. */
export function registerWorldIpc(
  ipc: WorldIpcMain,
  client: WorldIpcClient,
  win: () => WorldIpcWindow | null | undefined,
  settings: WorldSettingsStore
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
      return ok(settings.set(patch))
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

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
