// GUARD TEST: the Lumopolis world host's import graph must stay loadable inside a utilityProcess.
//
// A utilityProcess's 'electron' module has no `app`, `ipcMain`, `BrowserWindow`, … and the main
// bundle is ESM, so a NAMED import of one of those anywhere in worldHost's transitive graph is a
// link-time SyntaxError: the child dies before running a line and every world call just fails.
// TypeScript, eslint and in-process unit tests cannot see that (memoryHostImportGraph.test.ts tells the
// story of the time it happened to the memory host). worldHost reaches Electron only through
// `process.parentPort`, so the rule here is stricter: no value import from 'electron' at all, only
// `import type`.
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../src')
const ENTRY = path.join(SRC, 'main', 'world', 'worldHost.ts')

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [`${base}.ts`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]) {
    if (c.endsWith('.ts') && fs.existsSync(c)) return c
  }
  return null
}

interface Hit {
  file: string
  text: string
}

/** BFS over worldHost's local imports (static, re-exports and dynamic), collecting electron imports. */
function walk(): { visited: Set<string>; electron: Hit[] } {
  const visited = new Set<string>()
  const electron: Hit[] = []
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)
    // Comments may quote the banned form; strip them before scanning.
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const specs: { clause: string; spec: string }[] = []
    for (const m of code.matchAll(/^[ \t]*(import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
      specs.push({ clause: `${m[1]} ${m[2]}`, spec: m[3] })
    }
    for (const m of code.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push({ clause: 'dynamic', spec: m[1] })
    for (const m of code.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) specs.push({ clause: 'side-effect', spec: m[1] })
    for (const { clause, spec } of specs) {
      if (spec === 'electron' || spec.startsWith('electron/')) {
        if (!/^import\s+type\s/.test(clause)) electron.push({ file: path.relative(SRC, file), text: clause.replace(/\s+/g, ' ') })
        continue
      }
      // A type-only import is erased at build time and loads nothing.
      if (/^(import|export)\s+type\s/.test(clause)) continue
      const local = resolveLocal(file, spec)
      if (local) queue.push(local)
    }
  }
  return { visited, electron }
}

describe('worldHost import graph', () => {
  const { visited, electron } = walk()

  it('walks the real graph (the compiler, store and priority helper are reached)', () => {
    const names = [...visited].map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
    expect(names).toEqual(
      expect.arrayContaining(['main/world/worldHost.ts', 'main/world/compile.ts', 'main/world/worldStore.ts', 'main/hostPriority.ts'])
    )
    expect(names).not.toContain('main/world/worldClient.ts')
  })

  it('worldHost bundle imports no electron APIs besides parentPort', () => {
    expect(electron).toEqual([])
  })
})
