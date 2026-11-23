// Lumopolis reads (world host, Node only): how many files a first map reads at once, and which files it reads when
// a repository lists more than it can read.
//
// Every listed file is still a part of the world (grouping needs only paths). Reading a file is what finds its lines
// (imports) and details (boundaries), and on a big repository each open costs far more than parsing the text. So:
//
// - reads run READ_CONCURRENCY at a time (eachLimit), never one by one and never all at once;
// - a listing of more than MAP_FILE_CAP files has only MAP_FILE_CAP of them read (cappedReads): source files first,
//   then tests, then type declarations, and inside each of those the folders take turns, so every district gets its
//   first files read before any district gets more.
import { MAP_FILE_CAP } from '../repoFileList'

/**
 * Files read at once. Measured on the huge fixtures (Windows, Defender on; first map / full world, folder then
 * repository): 16 at a time 2.6 s / 29.5 s and 3.6 s / 34.0 s; 32 at a time 1.6 s / 36.1 s and 3.2 s / 27.8 s; 64 at a
 * time 2.1 s / 34.8 s and 3.4 s / 27.3 s, with 1.6 s and 2.0 s gaps in the progress. 32 gave the soonest first map and
 * a steady progress; past the thread pool's four workers more at once only lengthens the queue.
 */
export const READ_CONCURRENCY = 32

/** Runs `fn` over `items`, at most `limit` at a time, in order of start. A rejection rejects the whole run. */
export async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(Math.max(1, Math.floor(limit)), items.length); w++) workers.push(worker())
  await Promise.all(workers)
}

const TEST_NAME = /(?:\.(?:test|spec)\.[a-z]+|_test\.go|_test\.py|Tests?\.cs|Tests?\.java|_spec\.rb)$/
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?|spec|e2e)\//

/** The read priority of a file: 0 source, 1 test, 2 type declaration. */
export function readTier(file: string): number {
  if (/\.d\.[cm]?ts$/.test(file)) return 2
  const base = file.slice(file.lastIndexOf('/') + 1)
  return TEST_NAME.test(file) || /^test_.*\.py$/.test(base) || TEST_DIR.test(file) ? 1 : 0
}

const folderOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

/**
 * `files` in read order: by tier; inside a tier, each folder's first file, then each folder's second, and so on
 * (folders and names in code-point order), so a cut anywhere leaves every folder some files.
 */
export function readOrder(files: readonly string[]): string[] {
  const rank = new Map<string, number>()
  const seen = new Map<string, number>()
  // The default sort is code-point (UTF-16 unit) order.
  const sorted = [...new Set(files)].sort()
  for (const f of sorted) {
    const at = `${readTier(f)}\n${folderOf(f)}`
    const n = seen.get(at) ?? 0
    seen.set(at, n + 1)
    rank.set(f, n)
  }
  const key = (f: string): [number, number, string] => [readTier(f), rank.get(f) as number, folderOf(f)]
  // Two files of one tier and rank are never in one folder (a folder ranks its files 0, 1, 2...), so the folder decides.
  return sorted.sort((a, b) => {
    const x = key(a)
    const y = key(b)
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : 1)
  })
}

/** The files a compile reads when `files` holds more than `cap`: the first `cap` in read order. Null when all are read. */
export function cappedReads(files: readonly string[], cap: number = MAP_FILE_CAP): Set<string> | null {
  if (new Set(files).size <= cap) return null
  return new Set(readOrder(files).slice(0, cap))
}
