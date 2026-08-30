// memoryCorrectionStore.ts
//
// Persistence for the correction overlay. The log is the on-disk truth and the in-memory
// overlay is always a replay of it (`overlayFromLog`), which is what makes a correction
// survive a restart, a resync, and a rebuild of the index it corrects.
//
// JSONL, matching the memory store it shadows: corrections have to survive the same
// cross-machine sync as the memories they annotate, and an append-only line format is
// the only shape that merges without a conflict resolver.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import {
  applyCorrection,
  revokeCorrection,
  overlayFromLog,
  emptyOverlay,
  correctionStats,
  correctionFor,
  applyOverlayToRecall,
  type Correction,
  type CorrectionOverlay,
  type CorrectionInput,
  type RecallCandidate,
} from './memoryCorrection'

let dir: string | null = null
let overlay: CorrectionOverlay = emptyOverlay()

function logPath(): string {
  return join(dir as string, 'memory-corrections.jsonl')
}

export function initMemoryCorrections(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('initMemoryCorrections: userDataPath required')
  dir = userDataPath
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* degrade to in-memory */
  }
  overlay = emptyOverlay()
  try {
    if (!existsSync(logPath())) return
    const log: Correction[] = []
    for (const line of readFileSync(logPath(), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        log.push(JSON.parse(trimmed) as Correction)
      } catch {
        // One corrupt line must not discard every correction after it — a truncated
        // final write during a crash is the common case and costs exactly one entry.
        continue
      }
    }
    overlay = overlayFromLog(log)
  } catch {
    overlay = emptyOverlay()
  }
}

function append(correction: Correction): void {
  if (!dir) return
  try {
    appendFileSync(logPath(), `${JSON.stringify(correction)}\n`, 'utf8')
  } catch {
    /* best effort; the in-memory overlay still applies this session */
  }
}

export function correctMemory(input: CorrectionInput): { ok: boolean; error?: string; correction?: Correction } {
  const result = applyCorrection(overlay, input)
  if (result.ok && result.correction) append(result.correction)
  return result
}

export function revokeMemoryCorrection(id: string): { ok: boolean; error?: string } {
  const result = revokeCorrection(overlay, id)
  if (result.ok && result.correction) append(result.correction)
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
}

/** Filter/annotate a ranked recall list. Called on the read path so a corrected memory
 *  stops reaching agents immediately, without waiting for a re-index. */
export function applyCorrections<T extends RecallCandidate>(candidates: T[]): ReturnType<typeof applyOverlayToRecall<T>> {
  return applyOverlayToRecall(overlay, candidates)
}

export function correctionForMemory(id: string): Correction | null {
  return correctionFor(overlay, id)
}

export function memoryCorrectionStats(): ReturnType<typeof correctionStats> {
  return correctionStats(overlay)
}

/** Tests only. */
export function resetMemoryCorrections(): void {
  dir = null
  overlay = emptyOverlay()
}
