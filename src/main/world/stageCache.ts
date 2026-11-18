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
  /** OpenTelemetry service names declared in the file, when any. */
  names?: string[]
}

export interface StageCache {
  /** Repository-relative path to what its last read found. A file that could not be read has no entry. */
  files: Record<string, StageFile>
  /** Hash of the files, their imports and their boundary signatures (lines left out). */
  structureHash: string
  /** The grouping made from that structure, reused while the hash is unchanged. */
  grouping?: Grouping
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
  return isObj(v) && isStr(v.hash) && boundaries(v.boundaries) && strings(v.imports) && (v.names === undefined || strings(v.names))
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

/** Whether `v` has the stage cache's shape. Anything else (an older layout, a hand edit, a torn file) is ignored. */
export function isStageCache(v: unknown): v is StageCache {
  return (
    isObj(v) &&
    isObj(v.files) &&
    Object.values(v.files).every(isStageFile) &&
    isStr(v.structureHash) &&
    (v.grouping === undefined || isGrouping(v.grouping))
  )
}
