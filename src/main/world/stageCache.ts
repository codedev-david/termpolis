// Lumopolis stage cache: what a world compile learned about each source file (its content hash, the
// boundaries and relative imports found in it, its service names) plus the grouping those produced
// and a hash of everything the grouping depends on. A recompile re-reads only the files that changed
// and regroups only when that structure hash moves (compile.ts, compileWorldStaged). The store keeps it
// beside the world as `<world file>.stages.json`. Pure: types and a shape check, no imports with code,
// so main can load the store without pulling the compiler in.
import type { Boundary } from './detectors/common'
import type { Grouping } from './group'

export interface StageFile {
  /** Content hash of the text the scan saw (length plus two FNV-1a seeds). */
  hash: string
  boundaries: Boundary[]
  /** Relative import specifiers found in the text. */
  imports: string[]
  /** The packages the text imports (bare specifiers, no subpath), for the technology chips; absent when none. */
  packages?: string[]
  /** OpenTelemetry service names declared in the file, when any. */
  names?: string[]
  /** Python, Go, Rust, Java and Kotlin imports, tagged and not yet resolved (langImports.ts); absent when none. */
  refs?: string[]
  /** The package a Java or Kotlin file declares, when it declares one. */
  pkg?: string
  /** A Kotlin file's top-level declarations, when it has any. */
  decls?: string[]
}

/**
 * The stage cache layout and the meaning of what it holds. BUMP THIS whenever a boundary detector, the
 * import reader, the package reader, the service-name reader or the grouping rules (group.ts) change: a cache written by an
 * older version is then ignored and the next compile reads and groups every file afresh, so a detector
 * fix reaches worlds that already exist.
 */
export const STAGE_CACHE_VERSION = 8

export interface StageCache {
  /** STAGE_CACHE_VERSION of the compiler that wrote it; any other value is no cache. */
  version: number
  /** Repository-relative path to what its last read found. A file that could not be read has no entry. */
  files: Record<string, StageFile>
  /** Hash of the files, their imports and their boundary signatures (lines left out). */
  structureHash: string
  /** The grouping made from that structure, reused while the hash is unchanged. */
  grouping?: Grouping
  /** Hash of the test links and results. While it and the grouping are unchanged, an untouched building keeps its status. */
  tests?: string
}

const KINDS = new Set(['ipc', 'port', 'fork', 'worker', 'spawn', 'http-out', 'http-listen', 'env', 'mcp', 'watch'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

function isBoundary(v: unknown): v is Boundary {
  return (
    isObj(v) &&
    KINDS.has(v.kind as string) &&
    isStr(v.key) &&
    (v.side === 'provide' || v.side === 'consume') &&
    isStr(v.file) &&
    typeof v.line === 'number' &&
    Number.isFinite(v.line)
  )
}

const boundaries = (v: unknown): v is Boundary[] => Array.isArray(v) && v.every(isBoundary)

function isStageFile(v: unknown): v is StageFile {
  return (
    isObj(v) &&
    isStr(v.hash) &&
    boundaries(v.boundaries) &&
    strings(v.imports) &&
    (v.packages === undefined || strings(v.packages)) &&
    (v.names === undefined || strings(v.names)) &&
    (v.refs === undefined || strings(v.refs)) &&
    (v.pkg === undefined || isStr(v.pkg)) &&
    (v.decls === undefined || strings(v.decls))
  )
}

function isGrouping(v: unknown): v is Grouping {
  if (!isObj(v) || !Array.isArray(v.districts) || !Array.isArray(v.buildings) || !Array.isArray(v.edges)) return false
  return (
    v.districts.every((d) => isObj(d) && isStr(d.id) && isStr(d.name) && strings(d.members)) &&
    v.buildings.every(
      (b) => isObj(b) && isStr(b.id) && isStr(b.districtId) && isStr(b.name) && strings(b.members) && isStr(b.process) && boundaries(b.boundaries)
    ) &&
    v.edges.every((e) => isObj(e) && isStr(e.from) && isStr(e.to) && boundaries(e.via))
  )
}

/** Whether `v` has the stage cache's shape and version. Anything else (an older layout or compiler, a hand edit, a torn file) is ignored. */
export function isStageCache(v: unknown): v is StageCache {
  return (
    isObj(v) &&
    v.version === STAGE_CACHE_VERSION &&
    isObj(v.files) &&
    Object.values(v.files).every(isStageFile) &&
    isStr(v.structureHash) &&
    (v.grouping === undefined || isGrouping(v.grouping)) &&
    (v.tests === undefined || isStr(v.tests))
  )
}
