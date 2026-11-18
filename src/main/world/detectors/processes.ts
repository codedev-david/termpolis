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

// A message port: `const ch = new MessageChannel()` makes the port variable a provider; `somePort.postMessage(`
// sends on one (a name ending in Port or port, so `report.postMessage` is not one). Keyed by the variable name.
const CHANNEL = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*new MessageChannel\(\)/
const POST = /(?<![\w$.])((?:[\w$]*[a-z0-9_$]Port|port)\d?)\.postMessage\(/

// exec/execSync/fork start a process only when they come from child_process: a regex `exec(` or `db.exec(` is not
// one. The file must import it (or call `child_process.x(` directly); names bound from it, renames and a namespace
// alias (`import * as cp`, `const cp = require(...)`) are followed. Keyed by the first literal argument, as written.
const CP = /\bchild_process\b/
const CP_NAMED = /(?:import\s*\{([^}]*)\}\s*from|const\s*\{([^}]*)\}\s*=\s*require\(\s*)\s*['"`](?:node:)?child_process['"`]/g
const CP_ALIAS = /(?:import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*|(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*)['"`](?:node:)?child_process['"`]/g
const CP_FN = new Set(['exec', 'execSync', 'fork'])
const FIRST_LIT = String.raw`\(\s*['"\`]([^'"\`]+)['"\`]`

/** The local names child_process's exec, execSync and fork go by in this file, and the aliases of the module. */
function childProcessNames(text: string): { fns: string[]; aliases: string[] } {
  const fns: string[] = []
  for (const m of text.matchAll(CP_NAMED)) {
    for (const part of (m[1] ?? m[2]).split(',')) {
      const [orig, local] = part.trim().split(/\s+as\s+|\s*:\s*/)
      if (CP_FN.has(orig)) fns.push(local ?? orig)
    }
  }
  const aliases = ['child_process']
  for (const m of text.matchAll(CP_ALIAS)) aliases.push(m[1] ?? m[2])
  return { fns, aliases }
}

function detectExec(file: string, text: string): Boundary[] {
  if (!CP.test(text)) return []
  const { fns, aliases } = childProcessNames(text)
  const spawn = (m: RegExpExecArray) => ({ kind: 'spawn' as const, key: m[1], side: 'consume' as const })
  return [
    ...(fns.length ? collect(file, text, new RegExp(String.raw`(?<![\w$.])(?:${fns.map(escape).join('|')})` + FIRST_LIT), spawn) : []),
    ...collect(file, text, new RegExp(String.raw`(?<![\w$.])(?:${aliases.map(escape).join('|')})\.(?:exec|execSync|fork)` + FIRST_LIT), spawn)
  ]
}
const escape = (s: string): string => s.replace(/[$]/g, String.raw`\$&`)

// fork/worker key = target file basename without extension; spawn key = the command as written.
// The spawning file is the consumer of the target process.
export function detectProcesses(file: string, text: string): Boundary[] {
  const found = [
    ...collect(file, text, FORK, (m) => ({ kind: 'fork', key: target(m), side: 'consume' })),
    ...collect(file, text, WORKER, (m) => ({ kind: 'worker', key: target(m), side: 'consume' })),
    ...collect(file, text, SPAWN, (m) => ({ kind: 'spawn', key: m[1], side: 'consume' })),
    ...detectExec(file, text),
    ...collect(file, text, CHANNEL, (m) => ({ kind: 'port', key: m[1], side: 'provide' })),
    ...collect(file, text, POST, (m) => ({ kind: 'port', key: m[1], side: 'consume' }))
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
