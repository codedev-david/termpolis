// brainIpc.ts — testable orchestration behind the brain:export / brain:import handlers. The
// file-read and restore-if-absent closures live here (not inline in the Electron entrypoint) so
// they're unit-tested, and index.ts's handlers stay thin (dialog + call these).

import { join } from 'path'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { buildBrainZip, importBrainZip, type ImportResult } from './brainExport'
import { exportMemorySnapshot, importMemorySnapshot } from './swarmMemory'
import { exportGraphEdges, importGraphEdges } from './memoryGraph'

/** Injected filesystem surface — real fs in the app, fakes in tests. */
export interface BrainFs {
  /** Read a file, or null if it doesn't exist / can't be read. */
  read: (path: string) => Buffer | null
  /** File size, or 0 if absent — used to restore only when the target is empty/missing. */
  sizeOrZero: (path: string) => number
  write: (path: string, data: Buffer) => void
}

/** The real fs-backed BrainFs used by the app (kept here so the closures are unit-tested). */
export function realBrainFs(): BrainFs {
  return {
    read: (p) => { try { return readFileSync(p) } catch { return null } },
    sizeOrZero: (p) => { try { return statSync(p).size } catch { return 0 } },
    write: (p, d) => writeFileSync(p, d),
  }
}

/** Assemble the brain .zip from the live stores + the device-local files under userData. */
export function buildBrainArchive(userDataDir: string, appVersion: string, now: number, fs: BrainFs): Buffer {
  return buildBrainZip({
    memorySnapshot: exportMemorySnapshot,
    graphSnapshot: exportGraphEdges,
    readFile: (name) => fs.read(join(userDataDir, name)),
    appVersion,
    now,
  })
}

/** Integrity-verify + MERGE a brain .zip into this machine. Restores the device-local learning
 *  files only when they're absent/empty (a fresh machine), never clobbering an existing brain. */
export function mergeBrainArchive(userDataDir: string, zip: Buffer, fs: BrainFs): ImportResult {
  return importBrainZip(zip, {
    importMemory: importMemorySnapshot,
    importGraph: importGraphEdges,
    restoreFile: (name, data) => {
      const p = join(userDataDir, name)
      if (fs.sizeOrZero(p) <= 0) fs.write(p, data)
    },
  })
}
