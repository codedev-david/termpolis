/**
 * UV_THREADPOOL_SIZE = 16, set before anything can use libuv's pool (1.54.5 hotfix, lane G).
 *
 * WHY: libuv reads UV_THREADPOOL_SIZE ONCE, when the first piece of pool work is submitted (async fs, crypto,
 * dns.lookup, zlib). Default is 4. With Defender making every open slow, four slow opens occupy the whole
 * pool and every other async fs/crypto call queues behind them. The value must therefore be in place before
 * the first pool use of the process. It is read at pool start and not again, so "set it later" is a no-op.
 *
 * WHAT IS PROVEN HERE:
 *   1. ORDER (static): the very first statement of src/main/index.ts is `import './threadpoolEnv'`, and that
 *      module has no imports at all, so nothing can run (or use the pool) before it. ES imports are hoisted, so
 *      a plain assignment written as the first line of the file body would run AFTER every import: a leading
 *      side-effect import is the only way to be first.
 *   2. BEHAVIOUR: 16 when unset or empty, the user's own value when set, nothing at all with the kill switch.
 *   3. EFFECT in a real Node process (Windows, named pipes): with the module imported first the pool is large
 *      enough to run a 7th operation while 6 are blocked; with the same module imported AFTER the first pool use
 *      it is not (negative control). Counters, with asymmetric timeouts (a free thread answers in microseconds,
 *      so a 5 s allowance cannot fail by being slow; the stuck case can only pass by really being stuck).
 *
 * WHERE THE POOL IS FIRST USED (measured/searched, 11-03, Node 24.21): Node's ESM loader and CJS package loading
 * do not touch the pool (probes T1 to T3 in the lane-G notes); no module-level code in src/main submits pool work
 * (the only module-level crypto call is the synchronous randomBytes(32) in mcpServer.ts); the first real use is
 * inside whenReady handlers (initAppLog's first appendFile, settings reads). Rollup hoists EXTERNAL imports above
 * bundled code, so an external package that did async pool work while loading would still come first; that part
 * is read in real Electron by e2e/loop-governor.spec.ts (unverified until CI runs it).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import ts from 'typescript'

const MAIN = join(__dirname, '..', '..', 'src', 'main')
const read = (f: string) => readFileSync(join(MAIN, f), 'utf8')

const saved = { size: process.env.UV_THREADPOOL_SIZE, kill: process.env.TERMPOLIS_NO_GOVERNOR }
afterEach(() => {
  if (saved.size === undefined) delete process.env.UV_THREADPOOL_SIZE; else process.env.UV_THREADPOOL_SIZE = saved.size
  if (saved.kill === undefined) delete process.env.TERMPOLIS_NO_GOVERNOR; else process.env.TERMPOLIS_NO_GOVERNOR = saved.kill
  vi.resetModules()
})

async function freshImport(): Promise<void> {
  vi.resetModules()
  await import('../../src/main/threadpoolEnv')
}

describe('order: nothing can run before threadpoolEnv', () => {
  it("the first statement of src/main/index.ts is the side-effect import of './threadpoolEnv'", () => {
    const sf = ts.createSourceFile('index.ts', read('index.ts'), ts.ScriptTarget.Latest, true)
    const first = sf.statements[0]
    expect(ts.isImportDeclaration(first)).toBe(true)
    const decl = first as ts.ImportDeclaration
    expect(decl.importClause).toBeUndefined() // `import './x'`: no bindings, evaluated only for its effect
    expect((decl.moduleSpecifier as ts.StringLiteral).text).toBe('./threadpoolEnv')
  })

  it('control: the check would catch a real regression (an import placed first that is not the module)', () => {
    const sf = ts.createSourceFile('x.ts', "import { app } from 'electron'\nimport './threadpoolEnv'\n", ts.ScriptTarget.Latest, true)
    const first = sf.statements[0] as ts.ImportDeclaration
    expect((first.moduleSpecifier as ts.StringLiteral).text).not.toBe('./threadpoolEnv')
  })

  it('threadpoolEnv.ts has no import, no require and no dynamic import: it cannot pull anything in ahead of its own statement', () => {
    const sf = ts.createSourceFile('threadpoolEnv.ts', read('threadpoolEnv.ts'), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) found.push('import')
      if (ts.isCallExpression(n)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('dynamic import')
        if (ts.isIdentifier(n.expression) && n.expression.text === 'require') found.push('require')
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(found).toEqual([])
    expect(read('threadpoolEnv.ts')).toMatch(/UV_THREADPOOL_SIZE\s*=\s*'16'/)
  })
})

describe('behaviour', () => {
  it('sets 16 when the variable is unset', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    delete process.env.TERMPOLIS_NO_GOVERNOR
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe('16')
  })

  it('sets 16 when the variable is the empty string (libuv treats that as unset)', async () => {
    process.env.UV_THREADPOOL_SIZE = ''
    delete process.env.TERMPOLIS_NO_GOVERNOR
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe('16')
  })

  it("keeps the user's own value (control: it is a default, not an override)", async () => {
    process.env.UV_THREADPOOL_SIZE = '8'
    delete process.env.TERMPOLIS_NO_GOVERNOR
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe('8')
  })

  it('TERMPOLIS_NO_GOVERNOR=1 leaves the variable alone: behaviour identical to today', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    process.env.TERMPOLIS_NO_GOVERNOR = '1'
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined()
  })

  it('the unit suite itself runs with the kill switch on, so no test ever starts a real governor by accident', () => {
    expect(saved.kill).toBe('1')
    expect(process.env.TERMPOLIS_NO_HOST_PRIORITY).toBe('1')
  })
})

// ── real Node, real libuv ───────────────────────────────────────────

const PROBE = `
import net from 'node:net'
import fs from 'node:fs'
export async function probe(blockers) {
  const pipe = '\\\\\\\\.\\\\pipe\\\\tp-pool-' + process.pid + '-' + Date.now()
  const server = net.createServer((s) => s.on('error', () => {}))
  await new Promise((r) => server.listen(pipe, r))
  const fds = []
  for (let i = 0; i < blockers; i++) fds.push(await new Promise((res) => fs.open(pipe, 'r', (e, f) => res(e ? -1 : f))))
  for (const fd of fds) fs.read(fd, Buffer.alloc(1), 0, 1, null, () => {}) // each one parks a pool thread for good
  await new Promise((r) => setTimeout(r, 100)) // let every blocker reach its thread
  const allowance = Number(process.env.PROBE_ALLOW_MS)
  const done = await Promise.race([
    new Promise((r) => fs.stat('.', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), allowance)),
  ])
  console.log('RESULT ' + JSON.stringify({ seventhOperationCompleted: done, env: process.env.UV_THREADPOOL_SIZE ?? null }))
  process.kill(process.pid, 'SIGKILL') // parked pool threads would hold a normal exit open
}
`

function transpiledEnvModule(): string {
  return ts.transpileModule(read('threadpoolEnv.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

function runChild(entrySource: string, allowMs: number): Promise<{ seventhOperationCompleted: boolean; env: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'termpolis-pool-'))
  writeFileSync(join(dir, 'threadpoolEnv.mjs'), transpiledEnvModule())
  writeFileSync(join(dir, 'probe.mjs'), PROBE)
  writeFileSync(join(dir, 'entry.mjs'), entrySource)
  const env = { ...process.env, PROBE_ALLOW_MS: String(allowMs) }
  delete env.UV_THREADPOOL_SIZE
  delete env.TERMPOLIS_NO_GOVERNOR
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'entry.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const guard = setTimeout(() => { child.kill(); reject(new Error(`probe timed out: ${out} ${err}`)) }, 45_000)
    child.on('close', () => {
      clearTimeout(guard)
      rmSync(dir, { recursive: true, force: true })
      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
      if (!line) reject(new Error(`no result: ${out} ${err}`))
      else resolve(JSON.parse(line.slice(7)))
    })
  })
}

describe.skipIf(process.platform !== 'win32')('effect in a real Node process (Windows named pipes park pool threads without any timing assumption)', () => {
  it('imported FIRST: 6 parked operations leave the pool able to run a 7th (pool is 16)', async () => {
    const r = await runChild(
      "import './threadpoolEnv.mjs'\nimport { probe } from './probe.mjs'\nawait probe(6)\n",
      5000,
    )
    expect(r.env).toBe('16')
    expect(r.seventhOperationCompleted).toBe(true)
  }, 60_000)

  it('control: imported AFTER the first pool use, the same 6 parked operations leave NO thread for a 7th (pool stayed at 4)', async () => {
    const r = await runChild(
      "import fs from 'node:fs'\nawait new Promise((r) => fs.stat('.', () => r()))\nawait import('./threadpoolEnv.mjs')\nconst { probe } = await import('./probe.mjs')\nawait probe(6)\n",
      1500,
    )
    expect(r.env).toBe('16') // the variable IS set: libuv already started its pool and will not read it again
    expect(r.seventhOperationCompleted).toBe(false)
  }, 60_000)
})
