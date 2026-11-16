import { baseKey, collect, type Boundary } from './common'

// First argument: `new URL('x', ...)`, `path.join(a, 'b', 'x')` (the LAST literal
// before the closing paren, and only if it is the last argument), or a bare string.
const LIT = String.raw`['"\`]([^'"\`]+)['"\`]`
const ARG = String.raw`\(\s*(?:new URL\(\s*${LIT}\s*[,)]|[\w.]+\((?:[^()]*,)?\s*${LIT}\s*\)|${LIT}\s*[,)])`
const target = (m: RegExpExecArray): string => baseKey(m[1] ?? m[2] ?? m[3])
const FORK = new RegExp(String.raw`\butilityProcess\.fork` + ARG)
const WORKER = new RegExp(String.raw`\bnew Worker` + ARG)
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"`]([^'"`]+)['"`]/
// A module-relative URL of a sibling script: `new URL('./memoryHost.js', import.meta.url)`. A bundled
// main process names a sibling entry this way only to start it, usually through a variable or a
// parameter (`fork(hostPath)`) that the literal patterns above cannot follow. In a file that creates
// a Worker it is a worker target, else a forked process.
const ENTRY_URL = /\bnew URL\(\s*['"`]\.\/([^'"`]+\.[cm]?js)['"`]\s*,\s*import\.meta\.url\s*\)/
const CREATES_WORKER = /\bnew Worker\b/

// fork/worker key = target file basename without extension; spawn key = the command as written.
// The spawning file is the consumer of the target process.
export function detectProcesses(file: string, text: string): Boundary[] {
  const found = [
    ...collect(file, text, FORK, (m) => ({ kind: 'fork', key: target(m), side: 'consume' })),
    ...collect(file, text, WORKER, (m) => ({ kind: 'worker', key: target(m), side: 'consume' })),
    ...collect(file, text, SPAWN, (m) => ({ kind: 'spawn', key: m[1], side: 'consume' }))
  ]
  const entryKind = CREATES_WORKER.test(text) ? 'worker' : 'fork'
  // A target a literal fork/Worker call already names (`fork(new URL('./x.js', ...))`) is not repeated.
  const direct = new Set(found.filter((b) => b.kind !== 'spawn').map((b) => b.key))
  for (const b of collect(file, text, ENTRY_URL, (m) => ({ kind: entryKind, key: baseKey(m[1]), side: 'consume' }))) {
    if (!direct.has(b.key)) {
      direct.add(b.key)
      found.push(b)
    }
  }
  return found
}
