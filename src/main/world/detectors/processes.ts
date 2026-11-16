import { baseKey, collect, type Boundary } from './common'

// First argument: a string, `new URL('x', ...)`, or `path.join(a, 'x')`.
const ARG = String.raw`\(\s*(?:new URL\(\s*|[\w.]+\(\s*(?:[\w.]+\s*,\s*)*)?['"\`]([^'"\`]+)['"\`]`
const FORK = new RegExp(String.raw`\butilityProcess\.fork` + ARG)
const WORKER = new RegExp(String.raw`\bnew Worker` + ARG)
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"`]([^'"`]+)['"`]/

// fork/worker key = target file basename without extension; spawn key = the command as written.
// The spawning file is the consumer of the target process.
export function detectProcesses(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, FORK, (m) => ({ kind: 'fork', key: baseKey(m[1]), side: 'consume' })),
    ...collect(file, text, WORKER, (m) => ({ kind: 'worker', key: baseKey(m[1]), side: 'consume' })),
    ...collect(file, text, SPAWN, (m) => ({ kind: 'spawn', key: m[1], side: 'consume' }))
  ]
}
