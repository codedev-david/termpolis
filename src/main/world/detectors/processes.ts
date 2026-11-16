import { baseKey, collect, type Boundary } from './common'

// First argument: `new URL('x', ...)`, `path.join(a, 'b', 'x')` (the LAST literal
// before the closing paren, and only if it is the last argument), or a bare string.
const LIT = String.raw`['"\`]([^'"\`]+)['"\`]`
const ARG = String.raw`\(\s*(?:new URL\(\s*${LIT}\s*[,)]|[\w.]+\((?:[^()]*,)?\s*${LIT}\s*\)|${LIT}\s*[,)])`
const target = (m: RegExpExecArray): string => baseKey(m[1] ?? m[2] ?? m[3])
const FORK = new RegExp(String.raw`\butilityProcess\.fork` + ARG)
const WORKER = new RegExp(String.raw`\bnew Worker` + ARG)
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"`]([^'"`]+)['"`]/

// fork/worker key = target file basename without extension; spawn key = the command as written.
// The spawning file is the consumer of the target process.
export function detectProcesses(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, FORK, (m) => ({ kind: 'fork', key: target(m), side: 'consume' })),
    ...collect(file, text, WORKER, (m) => ({ kind: 'worker', key: target(m), side: 'consume' })),
    ...collect(file, text, SPAWN, (m) => ({ kind: 'spawn', key: m[1], side: 'consume' }))
  ]
}
