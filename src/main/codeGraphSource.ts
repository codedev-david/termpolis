// The listing and the reader of every code-graph sweep of a project, and of the code memory's ingest of it (index.ts
// graphSourceFor): memory:ingest-code's, buildGraphFor's and the file watcher's re-index with its full re-sweep fallback.
// A Lumopolis clone is someone else's content: both are confined to the clone's folder, found from the root's spelling
// and its real path (folderSafety.ts cloneConfinement), so a committed symlink never leads discovery or a read out of it,
// whichever spelling of the clone the sweep was asked for with (Opus R3-m3, R3-n2; Codex r4 M1).
import { promises as fsp } from 'fs'
import { discoverRepoFiles } from './codeIngest'
import { cloneConfinement, confinedTextReader } from './world/folderSafety'

export interface SweepSource {
  /** The root as asked for: builds of one project coalesce only when they name the same root (codeGraph.ts buildCodeGraph). */
  root: string
  listFiles: () => Promise<string[]>
  readFile: (file: string) => Promise<string>
}

const plainRead = (f: string): Promise<string> => fsp.readFile(f, 'utf8')

/** The source of a sweep of `root`, confined when it is a clone under `<userData>/world/repos`. The clone check runs
 *  once, on first use, and never rejects. */
export function sweepSourceFor(root: string, userData: string): SweepSource {
  let within: Promise<string | null> | undefined
  const clone = (): Promise<string | null> => (within ??= cloneConfinement(userData, root))
  let reader: Promise<(f: string) => Promise<string>> | undefined
  const read = (): Promise<(f: string) => Promise<string>> =>
    (reader ??= clone().then((w) => (w === null ? plainRead : confinedTextReader(w))))
  return {
    root,
    listFiles: async () => discoverRepoFiles(root, { confineTo: await clone() }),
    readFile: async (f) => (await read())(f),
  }
}
