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
 *   2. BEHAVIOUR: the pool is started with 16 in place when the variable is unset or empty, the user's own value
 *      is kept (and nothing is started), nothing at all happens with the kill switch.
 *   3. RELEASE (the merge's SEAM 8): the variable is put back exactly as the user had it (deleted, or the empty
 *      string) before anything else can run, so no shell, agent CLI, host or relaunched Termpolis inherits it;
 *      and when the pool cannot be started on the spot the variable is still put back (default pool: today).
 *   4. EFFECT in a real Node process (Windows, named pipes): with the module imported first the pool is large
 *      enough to run a 7th operation while 6 are blocked, although the variable is gone again by then; with the
 *      same module imported AFTER the first pool use it is not (negative control). Counters, with asymmetric
 *      timeouts (a free thread answers in microseconds, so a 5 s allowance cannot fail by being slow; the stuck
 *      case can only pass by really being stuck).
 *
 * WHERE THE POOL IS FIRST USED (measured/searched, 11-03, Node 24.21): Node's ESM loader and CJS package loading
 * do not touch the pool (probes T1 to T3 in the lane-G notes); no module-level code in src/main submits pool work
 * (the only module-level crypto call is the synchronous randomBytes(32) in mcpServer.ts); the first real use is
 * inside whenReady handlers (initAppLog's first appendFile, settings reads). Rollup hoists EXTERNAL imports above
 * bundled code, so an external package that did async pool work while loading would still come first; that part
 * is read in real Electron by e2e/loop-governor.spec.ts (unverified until CI runs it).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { createRequire } from 'module'
import { spawn, spawnSync } from 'child_process'
import ts from 'typescript'

const MAIN = join(__dirname, '..', '..', 'src', 'main')
const read = (f: string) => readFileSync(join(MAIN, f), 'utf8')

type Host = { getBuiltinModule?: unknown }
const saved = {
  size: process.env.UV_THREADPOOL_SIZE,
  kill: process.env.TERMPOLIS_NO_GOVERNOR,
  builtin: (process as unknown as Host).getBuiltinModule,
}
afterEach(() => {
  if (saved.size === undefined) delete process.env.UV_THREADPOOL_SIZE; else process.env.UV_THREADPOOL_SIZE = saved.size
  if (saved.kill === undefined) delete process.env.TERMPOLIS_NO_GOVERNOR; else process.env.TERMPOLIS_NO_GOVERNOR = saved.kill
  ;(process as unknown as Host).getBuiltinModule = saved.builtin
  vi.resetModules()
})

async function freshImport(): Promise<typeof import('../../src/main/threadpoolEnv')> {
  vi.resetModules()
  return import('../../src/main/threadpoolEnv')
}

/**
 * Stand in for process.getBuiltinModule so the test sees THE MOMENT THE POOL WOULD START: every async stat the
 * module submits records what the variable holds right then (that is what libuv would read), and calls counts how
 * many times the module asked for a built-in at all.
 */
function stubPoolStart(impl?: (id: string) => unknown): { atStat: Array<string | undefined>; calls: string[] } {
  const atStat: Array<string | undefined> = []
  const calls: string[] = []
  ;(process as unknown as Host).getBuiltinModule = (id: string) => {
    calls.push(id)
    if (impl) return impl(id)
    return { stat: (_path: string, _done: () => void) => { atStat.push(process.env.UV_THREADPOOL_SIZE) } }
  }
  return { atStat, calls }
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

describe('behaviour: the pool is started with the default in place', () => {
  it('unset: libuv would read 16 at the first submission (counter: the variable at the moment of the stat)', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    delete process.env.TERMPOLIS_NO_GOVERNOR
    const probe = stubPoolStart()
    const m = await freshImport()
    expect(probe.atStat).toEqual(['16'])
    expect(probe.calls).toEqual(['node:fs'])
    expect(m.threadpoolEnvState).toEqual({ applied: true, started: true, original: undefined })
  })

  it('the empty string (libuv treats that as unset): 16 at the moment of the stat as well', async () => {
    process.env.UV_THREADPOOL_SIZE = ''
    delete process.env.TERMPOLIS_NO_GOVERNOR
    const probe = stubPoolStart()
    const m = await freshImport()
    expect(probe.atStat).toEqual(['16'])
    expect(m.threadpoolEnvState).toEqual({ applied: true, started: true, original: '' })
  })

  it.each(['8', '16', '64'])("the user's own value (%s) is kept and the module does nothing at all (control: a default, not an override; the user's 16 is not ours)", async (value) => {
    process.env.UV_THREADPOOL_SIZE = value
    delete process.env.TERMPOLIS_NO_GOVERNOR
    const probe = stubPoolStart()
    const m = await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe(value)
    expect(probe.atStat).toEqual([])
    expect(probe.calls).toEqual([])
    expect(m.threadpoolEnvState).toEqual({ applied: false, started: false, original: undefined })
  })

  it.each(['1', 'true'])('TERMPOLIS_NO_GOVERNOR=%s leaves the process alone: nothing set, nothing started, behaviour identical to today', async (value) => {
    delete process.env.UV_THREADPOOL_SIZE
    process.env.TERMPOLIS_NO_GOVERNOR = value
    const probe = stubPoolStart()
    const m = await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined()
    expect(probe.calls).toEqual([])
    expect(m.threadpoolEnvState.applied).toBe(false)
  })

  it('control: any other value of the kill switch is not the kill switch', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    process.env.TERMPOLIS_NO_GOVERNOR = '0'
    const probe = stubPoolStart()
    await freshImport()
    expect(probe.atStat).toEqual(['16'])
  })

  it('the unit suite itself runs with the kill switch on, so no test ever starts a real governor by accident', () => {
    expect(saved.kill).toBe('1')
    expect(process.env.TERMPOLIS_NO_HOST_PRIORITY).toBe('1')
  })
})

describe('release (SEAM 8): the variable is put back exactly as the user had it, before anything else runs', () => {
  it('unset before: unset after (a child of this process inherits nothing)', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    delete process.env.TERMPOLIS_NO_GOVERNOR
    stubPoolStart()
    await freshImport()
    expect('UV_THREADPOOL_SIZE' in process.env).toBe(false)
  })

  it('the empty string before: the empty string after (restored exactly, not deleted)', async () => {
    process.env.UV_THREADPOOL_SIZE = ''
    delete process.env.TERMPOLIS_NO_GOVERNOR
    stubPoolStart()
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe('')
  })

  it('it is put back synchronously, not from the stat callback (nothing can run in between)', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    delete process.env.TERMPOLIS_NO_GOVERNOR
    let done: (() => void) | undefined
    stubPoolStart(() => ({ stat: (_p: string, cb: () => void) => { done = cb } }))
    await freshImport()
    expect(done).toBeTypeOf('function') // the callback has NOT run (the stub holds it)
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined()
  })

  const failures: Array<[string, () => void]> = [
    ['there is no process.getBuiltinModule (an older runtime)', () => { ;(process as unknown as Host).getBuiltinModule = undefined }],
    ['process.getBuiltinModule throws', () => { stubPoolStart(() => { throw new Error('boom') }) }],
    ['the fs module it returns is missing', () => { stubPoolStart(() => undefined) }],
    ['the fs module has no stat', () => { stubPoolStart(() => ({})) }],
    ['stat throws', () => { stubPoolStart(() => ({ stat: () => { throw new Error('boom') } })) }],
  ]
  it.each(failures)('fail open when %s: no throw, nothing started, the variable is put back anyway (default pool, as today)', async (_name, arrange) => {
    delete process.env.UV_THREADPOOL_SIZE
    delete process.env.TERMPOLIS_NO_GOVERNOR
    arrange()
    const m = await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined()
    expect(m.threadpoolEnvState).toEqual({ applied: true, started: false, original: undefined })
  })

  it('fail open with the empty string before: the empty string comes back too', async () => {
    process.env.UV_THREADPOOL_SIZE = ''
    delete process.env.TERMPOLIS_NO_GOVERNOR
    ;(process as unknown as Host).getBuiltinModule = undefined
    await freshImport()
    expect(process.env.UV_THREADPOOL_SIZE).toBe('')
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

// WHICH RUNTIME THE PROBE RUNS ON. On Windows, libuv before 1.52.0 read UV_THREADPOOL_SIZE with the C
// runtime's getenv(), which only sees the environment the process STARTED with: process.env writes go through
// SetEnvironmentVariableW and never reach it, so on such a runtime nothing a module does can size the pool and
// the probe would measure that runtime, not this module. libuv 1.52.0 ("unix,win: look up UV_THREADPOOL_SIZE
// with uv_os_getenv") fixed it. The app runs on Electron, whose Node (43.7.9: Node 24.21, libuv 1.52.1) has the
// fix; the test runner may not (CI's setup-node 22.23.4 does not: that is why this failed there on its first
// run). So the probe runs on the installed Electron in Node mode when it is the version package.json pins (CI),
// else on the runner's own Node (a stale local Electron would measure a runtime the app no longer ships), and
// on Windows the runtime it picks must have the fix: on CI that is asserted, never skipped.
const PKG = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }

function libuvAtLeast(version: string, min: [number, number]): boolean {
  const [maj, minor] = version.split('.').map(Number)
  return maj > min[0] || (maj === min[0] && minor >= min[1])
}

interface ProbeRuntime { exe: string; env: NodeJS.ProcessEnv; label: string; uv: string }

function libuvOf(exe: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(exe, ['-p', 'process.versions.uv'], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  return r.status === 0 ? r.stdout.trim() : null
}

function pickProbeRuntime(): ProbeRuntime {
  const pinned = PKG.devDependencies?.electron ?? PKG.dependencies?.electron
  try {
    // Resolved by hand, not require('electron'): the unit config may alias or mock that module.
    const pkgJson = createRequire(__filename).resolve('electron/package.json')
    const installed = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version
    const exe = join(dirname(pkgJson), 'dist', readFileSync(join(dirname(pkgJson), 'path.txt'), 'utf8').trim())
    if (pinned && installed === pinned.replace(/^[\^~]/, '') && existsSync(exe)) {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      const uv = libuvOf(exe, env)
      if (uv) return { exe, env, label: `Electron ${installed} (Node mode)`, uv }
    }
  } catch {
    // no Electron binary here: fall through to the runner's Node
  }
  return { exe: process.execPath, env: { ...process.env }, label: `Node ${process.versions.node}`, uv: process.versions.uv ?? '0.0.0' }
}

const probeRuntime = process.platform === 'win32' ? pickProbeRuntime() : null
const probeRuntimeSizesPool = probeRuntime !== null && libuvAtLeast(probeRuntime.uv, [1, 52])

function transpiledEnvModule(): string {
  return ts.transpileModule(read('threadpoolEnv.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

function runChild(entrySource: string, allowMs: number): Promise<{ seventhOperationCompleted: boolean; env: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'termpolis-pool-'))
  writeFileSync(join(dir, 'threadpoolEnv.mjs'), transpiledEnvModule())
  writeFileSync(join(dir, 'probe.mjs'), PROBE)
  writeFileSync(join(dir, 'entry.mjs'), entrySource)
  if (!probeRuntime) throw new Error('the pool probe is Windows only')
  const env: NodeJS.ProcessEnv = { ...probeRuntime.env, PROBE_ALLOW_MS: String(allowMs) }
  delete env.UV_THREADPOOL_SIZE
  delete env.TERMPOLIS_NO_GOVERNOR
  return new Promise((resolve, reject) => {
    const child = spawn(probeRuntime.exe, [join(dir, 'entry.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

describe.skipIf(process.platform !== 'win32')('the runtime the pool probe runs on', () => {
  it('can size the pool from process.env (libuv >= 1.52.0 on Windows); on CI this is required, never a silent skip', () => {
    if (process.env.CI || probeRuntimeSizesPool) {
      expect({ runtime: probeRuntime?.label, libuv: probeRuntime?.uv, sizesPool: probeRuntimeSizesPool })
        .toEqual({ runtime: probeRuntime?.label, libuv: probeRuntime?.uv, sizesPool: true })
    }
  })
})

describe.skipIf(!probeRuntimeSizesPool)('effect in a real Node process (Windows named pipes park pool threads without any timing assumption)', () => {
  it('imported FIRST: 6 parked operations leave the pool able to run a 7th (pool is 16), although the variable is already gone again', async () => {
    const r = await runChild(
      "import './threadpoolEnv.mjs'\nimport { probe } from './probe.mjs'\nawait probe(6)\n",
      5000,
    )
    expect(r.env).toBeNull() // released: the pool has read 16, nothing that starts later inherits it
    expect(r.seventhOperationCompleted).toBe(true)
  }, 60_000)

  it('control: imported AFTER the first pool use, the same 6 parked operations leave NO thread for a 7th (pool stayed at 4)', async () => {
    const r = await runChild(
      "import fs from 'node:fs'\nawait new Promise((r) => fs.stat('.', () => r()))\nawait import('./threadpoolEnv.mjs')\nconst { probe } = await import('./probe.mjs')\nawait probe(6)\n",
      1500,
    )
    expect(r.env).toBeNull() // released as well: the module cannot tell the pool was running already, and must leave no variable behind
    expect(r.seventhOperationCompleted).toBe(false)
  }, 60_000)
})
