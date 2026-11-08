// memoryAuditIpc.ts — the two channels behind Settings > Memory & Learning > Activity record.
//
// The record of what memory did (memoryAudit.ts) is on by default and local, and it has no switch; what the user can do about it
// is see how much of it there is and clear it. Both channels work on the app-data folder the app hands this module, never on a
// path the renderer names, so a renderer cannot point them at another folder. Nothing here reads a line of the record.
//
// Decoupled from electron (the channel registry and the folder are injected) so it unit-tests cleanly.

import { err, ok } from './ipcResult'
import { clearMemoryAudit, memoryAuditSize } from './memoryAudit'

export const AUDIT_IPC = {
  size: 'memory:audit-size',
  clear: 'memory:audit-clear',
} as const

export interface AuditIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

export interface AuditIpcDeps {
  /** The app-data folder the record is kept in (app.getPath('userData')). */
  dir: () => string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function registerMemoryAuditIpc(ipc: AuditIpcLike, d: AuditIpcDeps): void {
  ipc.handle(AUDIT_IPC.size, () => {
    try { return ok(memoryAuditSize(d.dir())) } catch (e) { return err(message(e)) }
  })
  ipc.handle(AUDIT_IPC.clear, () => {
    try { return ok(clearMemoryAudit(d.dir())) } catch (e) { return err(message(e)) }
  })
}
