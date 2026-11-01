import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

/**
 * The proxy child is a utilityProcess that serves every Claude session of an app run, and its bundle
 * is built from proxyMain.ts alone (electron.vite.config.ts). A module in its import closure that
 * reaches for electron, the filesystem or a child process either breaks the bundle or, worse, gives
 * the transform a way to depend on something other than the request body. The elision metadata, the
 * turn-shape parse and the stub-kind tally all live in that closure, so this is where they are held
 * to it. Type-only imports are erased and are not part of the closure.
 */

const SRC = join(__dirname, '..', '..', 'src', 'main')
const ENTRY = join(SRC, 'headroomProxy', 'proxyMain.ts')
// The child talks to the API through the server that proxyMain builds and through nothing else: a module in
// its closure that opens a socket of its own (net, tls, dgram, a second http client) would be a way out the
// request path does not know about. proxyMain itself is the one place that names http and https.
const FORBIDDEN = new Set([
  'electron', 'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads',
  'os', 'node:os', 'net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram', 'dns', 'node:dns', 'cluster', 'node:cluster', 'vm', 'node:vm',
])
const ONLY_IN_ENTRY = new Set(['http', 'node:http', 'https', 'node:https'])

/** Value imports and re-exports in a source file: `import x from`, `import 'x'`, `export ... from`,
 *  `require('x')` and `await import('x')`, but not `import type` or `export type`. */
function specifiers(src: string): string[] {
  const out: string[] = []
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of stripped.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'"\n;]*?from\s+['"]([^'"]+)['"]/gm)) if (!m[1]) out.push(m[2])
  for (const m of stripped.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1])
  for (const m of stripped.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const cand of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(cand) && cand.endsWith('.ts')) return cand
  return null
}

function closure(entry: string): { files: Map<string, string[]>; bare: Map<string, string[]> } {
  const files = new Map<string, string[]>()
  const bare = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const f = queue.pop() as string
    if (files.has(f)) continue
    files.set(f, [])
    for (const spec of specifiers(readFileSync(f, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(f, spec)
        if (target) { files.get(f)?.push(target); queue.push(target) }
      } else {
        const users = bare.get(spec) ?? []
        users.push(f)
        bare.set(spec, users)
      }
    }
  }
  return { files, bare }
}

const short = (f: string): string => f.replace(SRC, 'src/main').replace(/\\/g, '/')

describe('the proxy child import closure', () => {
  const { files, bare } = closure(ENTRY)

  it('actually walks the modules this release added to it', () => {
    const names = new Set([...files.keys()].map((f) => short(f)))
    for (const m of [
      'src/main/headroomProxy/usageParse.ts', 'src/main/headroomProxy/wireCompress.ts', 'src/main/headroomProxy/prefixDecay.ts',
      'src/main/headroomProxy/forwardedKinds.ts', 'src/main/headroom/elisionMeta.ts', 'src/main/headroom/router.ts',
    ]) expect(names.has(m)).toBe(true)
  })

  it('does not import electron, the filesystem, a child process or the OS', () => {
    const offenders = [...bare.entries()].filter(([spec]) => FORBIDDEN.has(spec)).map(([spec, users]) => `${spec} <- ${users.map(short).join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('names the http and https clients in the entry alone: nothing else in the closure opens a connection', () => {
    const users = [...bare.entries()].filter(([spec]) => ONLY_IN_ENTRY.has(spec)).flatMap(([spec, from]) => from.map((f) => `${spec} <- ${short(f)}`))
    expect(users.length).toBeGreaterThan(0) // the entry does name them: the walk is really reading its imports
    for (const u of users) expect(u, u).toContain('src/main/headroomProxy/proxyMain.ts')
  })

  it('does not reach the ledger, the stash, the app log or any other main-process state', () => {
    const state = [...files.keys()].map(short).filter((f) =>
      /\/(proxyLedger|proxySupervisor|ccrStore|elisionLedger|elisionStore|appLog|savingsLedger|outputEconomyStore|sessionDepth|persist|wireTier|compressToolResult|unifiedReceipt|receiptStore|receiptArtifact)\.ts$/.test(f))
    expect(state).toEqual([])
  })

  it('never imports the app log from anything in headroomProxy: logging is the main process\'s job', () => {
    const users = [...files.entries()].filter(([f]) => short(f).startsWith('src/main/headroomProxy/')).flatMap(([f, deps]) => deps.map((d) => `${short(f)} -> ${short(d)}`)).filter((e) => /appLog/.test(e))
    expect(users).toEqual([])
  })
})
