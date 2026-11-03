/**
 * What a REAL child process of Termpolis sees of UV_THREADPOOL_SIZE (1.54.5 hotfix, merge SEAM 8: lane G, the
 * event-loop governor, sets the variable for main).
 *
 * threadpoolEnv.ts puts UV_THREADPOOL_SIZE=16 in the main process's environment so libuv starts a pool of 16
 * threads, starts the pool on the spot, and takes the variable out again before anything else runs. The rule it
 * serves: a user's shell, an agent CLI, a workflow command, a utility host, an updated copy of Termpolis itself
 * are all children of the main process, and none of them may see a variable the user never set. Children
 * started WITHOUT an env option inherit the parent's environment block, so no per-spawn cleanup could cover them;
 * only a clean process.env does.
 *
 * Proof here is a counter on real processes, not a fake: a plain Node process imports the TRANSPILED
 * threadpoolEnv.ts first (as index.ts does), starts a grandchild with NO env option (the implicit inheritance a
 * `spawn(bin)` or a utilityProcess.fork gets) and reports what the grandchild printed. The control that shows
 * the check can fail: the same run with the variable left in place (what the merge looked like before the fix)
 * leaks 16 into the grandchild.
 *
 * That the pool is still 16 after the variable is gone is the Windows probe in threadpoolEnv.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import ts from 'typescript'

const ENV_MODULE = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'threadpoolEnv.ts'), 'utf8')

const GRANDCHILD = "process.stdout.write(process.env.UV_THREADPOOL_SIZE === undefined ? 'unset' : 'set:' + process.env.UV_THREADPOOL_SIZE)"

/** The entry's tail: ask a grandchild what it inherited and report it with the parent's own view. */
const REPORT = `
import { execFileSync } from 'node:child_process'
const grandchild = execFileSync(process.execPath, ['-e', ${JSON.stringify(GRANDCHILD)}], { encoding: 'utf8', windowsHide: true })
console.log('RESULT ' + JSON.stringify({ own: process.env.UV_THREADPOOL_SIZE ?? null, grandchild }))
`

interface Report { own: string | null; grandchild: string }

function transpiled(): string {
  return ts.transpileModule(ENV_MODULE, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

function run(entrySource: string, env: Record<string, string> = {}): Promise<Report> {
  const dir = mkdtempSync(join(tmpdir(), 'tp-threadpool-child-'))
  writeFileSync(join(dir, 'threadpoolEnv.mjs'), transpiled())
  writeFileSync(join(dir, 'entry.mjs'), entrySource)
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'UV_THREADPOOL_SIZE' && k !== 'TERMPOLIS_NO_GOVERNOR') base[k] = v
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'entry.mjs')], { env: { ...base, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const guard = setTimeout(() => { child.kill(); reject(new Error(`entry timed out: ${out} ${err}`)) }, 45_000)
    child.on('close', () => {
      clearTimeout(guard)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ }
      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
      if (!line) return reject(new Error(`no RESULT line: ${out} ${err}`))
      resolve(JSON.parse(line.slice('RESULT '.length)) as Report)
    })
  })
}

describe('a real grandchild of a process that imported threadpoolEnv first', () => {
  it('user environment without the variable: the process has none after the import, and a child started with no env option has none', async () => {
    const r = await run(`import './threadpoolEnv.mjs'\n${REPORT}`)
    expect(r).toEqual({ own: null, grandchild: 'unset' })
  }, 60_000)

  it('CONTROL: with the variable left in place (set by hand, no release) the same grandchild inherits 16, so this check can fail', async () => {
    const r = await run(`process.env.UV_THREADPOOL_SIZE = '16'\n${REPORT}`)
    expect(r).toEqual({ own: '16', grandchild: 'set:16' })
  }, 60_000)

  it('the pool could not be started on the spot (no process.getBuiltinModule): still no variable in the process and none in the grandchild', async () => {
    const r = await run(`process.getBuiltinModule = undefined\nawait import('./threadpoolEnv.mjs')\n${REPORT}`)
    expect(r).toEqual({ own: null, grandchild: 'unset' })
  }, 60_000)

  it("control: a value the user set reaches the grandchild untouched (8, and 16 too: the user's own 16 is not Termpolis's default)", async () => {
    expect(await run(`import './threadpoolEnv.mjs'\n${REPORT}`, { UV_THREADPOOL_SIZE: '8' })).toEqual({ own: '8', grandchild: 'set:8' })
    expect(await run(`import './threadpoolEnv.mjs'\n${REPORT}`, { UV_THREADPOOL_SIZE: '16' })).toEqual({ own: '16', grandchild: 'set:16' })
  }, 90_000)

  it('the kill switch (TERMPOLIS_NO_GOVERNOR=1) touches nothing: no variable in the process, none in the grandchild', async () => {
    const r = await run(`import './threadpoolEnv.mjs'\n${REPORT}`, { TERMPOLIS_NO_GOVERNOR: '1' })
    expect(r).toEqual({ own: null, grandchild: 'unset' })
  }, 60_000)
})
