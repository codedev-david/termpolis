// The IPC behind Settings > Memory > "Claude Code's saved notes": the two switches, what was imported, and
// "Remove imported notes". Kept out of index.ts (which registers it with one call) so it can be tested without
// the 3,700-line main entry. Every answer is the app's usual envelope (ipcResult.ts).

import { err, ok } from './ipcResult'
import type { NotesStatus, RemoveResult } from './claudeNotesIngest'

export const NOTES_IPC = {
  get: 'memory:get-notes-settings',
  set: 'memory:set-notes-settings',
  remove: 'memory:remove-imported-notes',
} as const

export interface NotesIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

export interface NotesSettingsView {
  indexClaudeNotes: boolean
  shareNotesAcrossProjects: boolean
  /** The user has said yes to connecting their agents (an older install nobody has asked yet does not count). Until then, no note is read, whatever the first switch says. */
  connected: boolean
  /** Memory is locked (its key cannot be opened): the import and every removal wait until it opens. */
  locked: boolean
  status: NotesStatus
}

export interface NotesIpcDeps {
  index: { get(): boolean; set(on: boolean): unknown }
  share: { get(): boolean; set(on: boolean): unknown }
  connected(): boolean
  /** Whether memory is locked. A store that cannot even answer is not reported as locked. */
  locked(): Promise<boolean>
  status(): NotesStatus
  remove(): Promise<RemoveResult>
  /** Run a pass now. Called when the first switch has just been turned on, so the user does not wait for the next tick. */
  passSoon(): void
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function registerClaudeNotesIpc(ipc: NotesIpcLike, d: NotesIpcDeps): void {
  const view = async (): Promise<NotesSettingsView> => ({
    indexClaudeNotes: d.index.get(),
    shareNotesAcrossProjects: d.share.get(),
    connected: d.connected(),
    locked: await d.locked().catch(() => false),
    status: d.status(),
  })

  ipc.handle(NOTES_IPC.get, async () => {
    try { return ok(await view()) } catch (e) { return err(message(e)) }
  })

  // Either switch, or both. Only a real boolean counts: anything else is ignored, never read as a "yes".
  ipc.handle(NOTES_IPC.set, async (_event, input) => {
    try {
      const req = isRec(input) ? input : {}
      const wasOn = d.index.get()
      if (typeof req.indexClaudeNotes === 'boolean') d.index.set(req.indexClaudeNotes)
      if (typeof req.shareNotesAcrossProjects === 'boolean') d.share.set(req.shareNotesAcrossProjects)
      if (!wasOn && d.index.get()) d.passSoon()
      return ok(await view())
    } catch (e) {
      return err(message(e))
    }
  })

  // The switch goes off FIRST, or a pass could bring the notes straight back; and it stays off, so the
  // removal is not undone at the next tick. Turning it on again re-imports from scratch.
  ipc.handle(NOTES_IPC.remove, async () => {
    try {
      // When the switch cannot be turned off and kept off, nothing is touched: say so, or the error reads as a removal that went
      // part of the way.
      try { d.index.set(false) } catch (e) { throw new Error(`${message(e).replace(/[.\s]+$/, '')}. Nothing was removed.`) }
      const result = await d.remove()
      return ok({ ...result, settings: await view() })
    } catch (e) {
      return err(message(e))
    }
  })
}
