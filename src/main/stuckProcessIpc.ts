/**
 * IPC for Settings ▸ Processes. Two request/response channels:
 *   processes:scan-stuck — what looks stuck right now (stuckProcesses.ts says what that means)
 *   processes:kill-stuck — end the given { pid, created } targets; `stuckOnly: true` (the
 *                          "Kill all stuck" button) also skips any target no longer stuck
 *
 * The renderer never names a pid on its own authority: a kill re-scans and refuses every
 * target that is no longer on the list. Overlapping scans share one run, because a scan is a
 * PowerShell process plus netstat and a double-clicked Refresh should not start two.
 */
import { ok, err } from './ipcResult'
import {
  scanStuckProcesses,
  killStuckProcesses,
  type StuckScan,
  type StuckKillResult,
  type StuckKillOptions,
} from './stuckProcesses'

export interface StuckProcessIpcLike {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void
}

export interface StuckProcessIpcDeps {
  scan?: () => Promise<StuckScan>
  kill?: (targets: unknown, opts: StuckKillOptions) => Promise<StuckKillResult>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function registerStuckProcessIpc(ipc: StuckProcessIpcLike, deps: StuckProcessIpcDeps = {}): void {
  const scan = deps.scan ?? (() => scanStuckProcesses())
  const kill = deps.kill ?? ((targets: unknown, opts: StuckKillOptions) => killStuckProcesses(targets, {}, opts))
  let inFlight: Promise<StuckScan> | null = null

  ipc.handle('processes:scan-stuck', async () => {
    try {
      inFlight ??= scan().finally(() => {
        inFlight = null
      })
      return ok(await inFlight)
    } catch (e) {
      return err(message(e))
    }
  })

  ipc.handle('processes:kill-stuck', async (_event, input) => {
    if (!isRecord(input) || !Array.isArray(input.targets)) return err('A list of processes to end is required')
    try {
      return ok(await kill(input.targets, { stuckOnly: input.stuckOnly === true }))
    } catch (e) {
      return err(message(e))
    }
  })
}
