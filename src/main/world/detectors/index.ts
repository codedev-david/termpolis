import { stripComments, type Boundary, type Detector } from './common'
import { detectEnv } from './env'
import { detectHttp } from './http'
import { detectIpc } from './ipc'
import { detectMcp } from './mcp'
import { detectProcesses } from './processes'
import { detectWatch } from './watch'

export { stripComments }
export type { Boundary, BoundaryKind, Detector } from './common'

/**
 * Files longer than this are skipped. Kept equal to MAX_GRAPH_FILE_CHARS in
 * src/main/codeGraph.ts (a test pins them together); not imported from there
 * because codeGraph pulls in tree-sitter and this runs in a utility process.
 */
export const MAX_DETECT_FILE_CHARS = 512 * 1024

export const DEFAULT_DETECTORS: Detector[] = [
  detectIpc,
  detectProcesses,
  detectHttp,
  detectEnv,
  detectMcp,
  detectWatch
]

/** Run detectors over comment-stripped text. Over `maxChars` returns []. */
export function detectBoundaries(
  file: string,
  text: string,
  detectors: Detector[] = DEFAULT_DETECTORS,
  maxChars: number = MAX_DETECT_FILE_CHARS
): Boundary[] {
  if (text.length > maxChars) return []
  const clean = stripComments(text)
  return detectors.flatMap((d) => d(file, clean))
}
