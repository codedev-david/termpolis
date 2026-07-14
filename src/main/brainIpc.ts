// brainIpc.ts — testable orchestration behind the brain:export / brain:import handlers. The
// file-read and restore-if-absent closures live here (not inline in the Electron entrypoint) so
// they're unit-tested, and index.ts's handlers stay thin (dialog + call these).

import { join } from 'path'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { buildBrainZip, importBrainZip, type ImportResult } from './brainExport'
// v1.26: the memory store lives in a utilityProcess. These MUST come from memoryClient, not
// swarmMemory — the in-main swarmMemory singleton is never initialised any more, so importing them
// direct would export an EMPTY brain (and import into a store nothing reads). Silent, and the user
// would only find out when they restored it on the other machine.
// ...and so must the GRAPH, for exactly the same reason. v1.26.0 repointed the store and left these
// two importing the in-main memoryGraph, whose adjacency Map is only ever filled by initSwarmMemory
// — which runs in the memory process. So the export wrote a brain with ZERO edges and the import fed
// a restored machine's edges into a graph nothing reads: precisely the silent failure the paragraph
// above predicts, found on the other machine, one release later.
import { exportMemorySnapshot, importMemorySnapshot, exportGraphEdges, importGraphEdges } from './memoryClient'

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

/** Assemble the brain .zip from the live stores + the device-local files under userData.
 *  buildBrainZip takes a SYNC `memorySnapshot: () => string`, so the snapshot is fetched first and
 *  handed over as a closure over the resolved value — passing the async proxy itself would make it
 *  serialize a Promise, i.e. export the string "[object Promise]" as the user's brain. */
export async function buildBrainArchive(userDataDir: string, appVersion: string, now: number, fs: BrainFs): Promise<Buffer> {
  // Both resolved BEFORE zipping, then handed over as closures over the values: passing the async
  // proxies themselves would zip the string "[object Promise]" as the user's brain.
  const [memory, graph] = await Promise.all([exportMemorySnapshot(), exportGraphEdges()])
  return buildBrainZip({
    memorySnapshot: () => memory,
    graphSnapshot: () => graph,
    readFile: (name) => fs.read(join(userDataDir, name)),
    appVersion,
    now,
  })
}

/** Integrity-verify + MERGE a brain .zip into this machine. Restores the device-local learning
 *  files only when they're absent/empty (a fresh machine), never clobbering an existing brain. */
export async function mergeBrainArchive(userDataDir: string, zip: Buffer, fs: BrainFs): Promise<ImportResult> {
  return await importBrainZip(zip, {
    importMemory: importMemorySnapshot, // async — importBrainZip awaits it
    importGraph: importGraphEdges,      // ...and so is this now: the graph lives with the store
    restoreFile: (name, data) => {
      const p = join(userDataDir, name)
      if (fs.sizeOrZero(p) <= 0) fs.write(p, data)
    },
  })
}
