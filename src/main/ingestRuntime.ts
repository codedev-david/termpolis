// ingestRuntime.ts
//
// What the app adds to every conversation-ingest pass, set ONCE at start-up so the three call sites in
// index.ts (the manual "index everything" IPC, the full pass, the fast pass) stay exactly as they were:
//   - the persisted per-file watermark (ingestWatermark): an unchanged transcript is not opened
//   - a byte budget per background pass (8 MiB) and time slices of 25 ms of synchronous parse work, with the
//     event loop served between slices (a pass is cut into pieces the keyboard can interleave with)
//   - the typing gate (typingQuiet): nothing starts within 500 ms of a keystroke
//   - 1 MiB read pieces and a head-only verdict on a subagent's parent session (ingestFiles)
//   - the "Learn from conversations" pause switch, asked at every file and every slice
//   - one counter record per pass (passCounters), so a support bundle can show what a pass did
//
// Kill switch: TERMPOLIS_INGEST_FAST=off|0|false|no keeps the pause switch and the counters (marked
// "legacy") and nothing else: every pass is then the whole-file, whole-corpus pass of 1.54.4.
//
// This module imports no value from conversationIngest (that module imports this one), so a test or a
// harness that mocks conversationIngest does not break it.

import { join } from 'path'
import type { IngestMemory, IngestStats, PassMetrics } from './conversationIngest'
import { fileHead, filePieces, fileStamp } from './ingestFiles'
import {
  fileWatermarkIO,
  ingestFastEnabled,
  INGEST_FORMAT_VERSION,
  openWatermark,
  WATERMARK_FILE,
  type FileStamp,
  type IngestWatermark,
} from './ingestWatermark'
import { recordPass } from './passCounters'
import { whenTypingQuiet } from './typingQuiet'
import { whenNotShed } from './loopGovernor'

/** Most bytes one background pass reads before it stops and leaves the rest to the next. */
export const INGEST_PASS_BYTES = 8 * 1024 * 1024
/** Longest synchronous stretch of parsing, chunking and hashing, in milliseconds. */
export const INGEST_SLICE_MS = 25

const MIB = 1024 * 1024

export interface IngestRuntime {
  /** True under the kill switch: only the pause switch and the counters are active. */
  readonly legacy: boolean
  /** The "Learn from conversations" switch is OFF. */
  readonly paused: () => boolean
  readonly passBytes: number
  readonly sliceMs: number
  readonly openWatermark?: () => Promise<IngestWatermark>
  readonly statFile?: (filePath: string) => Promise<FileStamp | null>
  readonly readText?: (filePath: string) => AsyncIterable<string>
  readonly readHead?: (filePath: string, maxBytes: number) => Promise<{ text: string; eof: boolean }>
  readonly quiet?: () => Promise<unknown>
  readonly canMark?: () => Promise<boolean>
  readonly record: (metrics: PassMetrics) => void
  /** The files the current drain episode has read (MEM-F1): a pass that is not a drain pass starts a new one. */
  readonly drainEpisode?: { files: Set<string> }
}

export interface IngestRuntimeConfig {
  /** Where the watermark file lives. */
  userData: string
  /** Part of the watermark's stamp: another app version re-checks every transcript once. */
  appVersion: string
  /** True while the memory store refuses writes (locked): no mark may be kept for a pass that ran into that. */
  isLocked: () => Promise<boolean>
  /** True while "Learn from conversations" is OFF. Read at every file and every slice; one that throws counts as ON. */
  paused?: () => boolean
  env?: NodeJS.ProcessEnv
}

let runtime: IngestRuntime | null = null

export function getIngestRuntime(): IngestRuntime | null {
  return runtime
}

/** Test seam, and what a restart looks like. */
export function resetIngestRuntime(): void {
  runtime = null
}

const round = (n: number, places: number): number => {
  const k = 10 ** places
  return Math.round(n * k) / k
}

/** Configure the runtime once, at start-up. Never throws. */
export function configureConversationIngest(cfg: IngestRuntimeConfig): void {
  const legacy = !ingestFastEnabled(cfg.env ?? process.env)
  const paused = cfg.paused ?? ((): boolean => false)
  // Exactly 12 numbers, the most a pass record keeps (passCounters.PASS_LIMITS.maxFields).
  const record = (m: PassMetrics): void =>
    recordPass('ingest', {
      files: m.files,
      skipped: m.unchanged,
      mb: round(m.bytes / MIB, 2),
      parseMsSum: round(m.parseMsSum, 1),
      parseMsMax: round(m.parseMsMax, 1),
      hashed: m.hashed,
      known: m.known,
      written: m.written,
      truncated: m.truncated ? 1 : 0,
      drain: m.drainPass,
      ms: Math.round(m.ms),
      legacy: legacy ? 1 : 0,
    })

  if (legacy) {
    runtime = { legacy: true, paused, passBytes: Number.POSITIVE_INFINITY, sliceMs: 0, record }
    return
  }

  let opened: Promise<IngestWatermark> | null = null
  const stamp = `${INGEST_FORMAT_VERSION}|${cfg.appVersion}`
  runtime = {
    legacy: false,
    paused,
    passBytes: INGEST_PASS_BYTES,
    drainEpisode: { files: new Set() },
    sliceMs: INGEST_SLICE_MS,
    // Opened (read from disk) once, on the first pass; every pass shares the one object.
    openWatermark: () => (opened ??= openWatermark(fileWatermarkIO(join(cfg.userData, WATERMARK_FILE)), stamp)),
    statFile: fileStamp,
    readText: (filePath) => filePieces(filePath),
    readHead: fileHead,
    // Asked before each file and at every slice boundary: the user typing holds the pass back (bounded), and so does the
    // event-loop governor's SHED (until it ends, at most SHED_WAIT_CAP_MS a boundary; never with TERMPOLIS_NO_GOVERNOR=1).
    quiet: async () => {
      await whenTypingQuiet()
      await whenNotShed()
    },
    canMark: async () => !(await cfg.isLocked()),
    record,
  }
}

/** What the scheduler is told about a pass: chunks written, whether more is queued, and a short note for the log. */
export function passResult(stats: IngestStats): { written: number; more: boolean; note?: string } {
  const busy = stats.filesScanned > 0 || stats.chunksWritten > 0
  let note: string | undefined
  // Only a pass that kept watermark counters has anything to add to the log line: under the kill switch the
  // line is exactly what it was.
  if (busy && stats.unchanged !== undefined) {
    note = `files ${stats.filesScanned} skipped ${stats.unchanged}`
    if (stats.bytesRead !== undefined) note += ` ${round(stats.bytesRead / MIB, 1).toFixed(1)} MB`
    if (stats.episodeSkipped) note += ` held ${stats.episodeSkipped}`
    if (stats.stop === 'bytes') note += ' (byte budget)'
    else if (stats.stop === 'chunks') note += ' (chunk cap)'
  }
  // A pass that was stopped (the app is quitting, or the switch went OFF) asks for no follow-up. One that
  // stopped at its BYTE budget asks for one only if it got somewhere (it wrote chunks, or vouched for files so
  // the next pass will not read them again): spent on files it could neither store nor vouch for (the memory
  // host is down, say), the next pass would spend the same 8 MiB on the same files, and the follow-up would
  // repeat every few seconds for as long as the host stays down. (The old loop did not do that: it had no budget.)
  const gotSomewhere = stats.chunksWritten > 0 || (stats.marked ?? 0) > 0
  const more = stats.truncated && stats.stop !== 'stopped' && (stats.stop !== 'bytes' || gotSomewhere)
  return { written: stats.chunksWritten, more, note }
}

export interface DrainHooks {
  /** The store deps every ingest pass uses (index.ts ingestMemoryDeps). */
  memory: () => IngestMemory
  isLocked: () => Promise<boolean>
  /** Persist the ANN index (a no-op when none is built). */
  persist: () => Promise<void>
  stopped: () => boolean
  ingest: (memory: IngestMemory, opts: { maxChunks: number; stopped: () => boolean; drainPass: number }) => Promise<IngestStats>
}

/**
 * The follow-up of a pass that hit its cap: the incremental tier only. It ingests what is left (the
 * watermark makes a file that is done cost one stat) and nothing else: no linked-history recheck, no lesson
 * recheck, no consolidation, summarization or Weave, and the ANN index is persisted only once the backlog is
 * done. Before this, every follow-up (every 3 s while a backlog lasted) was a whole full pass.
 */
export function makeDrainRun(hooks: DrainHooks): (info: { drainPass: number }) => Promise<{ written: number; more?: boolean; note?: string }> {
  return async ({ drainPass }) => {
    // LOCKED: nothing is written, nothing is marked; the first pass after an unlock picks it all up.
    if (await hooks.isLocked()) return { written: 0 }
    const stats = await hooks.ingest(hooks.memory(), { maxChunks: 250, stopped: hooks.stopped, drainPass })
    if (!stats.truncated) {
      try { await hooks.persist() } catch { /* best effort: the next full pass persists it */ }
    }
    return passResult(stats)
  }
}
