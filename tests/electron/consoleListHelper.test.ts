// The script that reads one terminal's console for shellAlone.ts on Windows (consoleListHelper.ts). The proc host runs it
// as a child process, where node-pty's own helper (which answers over process.send) cannot run. Nothing here needs
// Windows: the native console call is replaced by a fake node-pty lib folder, and what is checked is the contract
// (arguments in, one JSON line out, exit codes), which is what shellAlone depends on.
//
// EDR-1 (1.54.5): the script ships with the app (src/mcp-adapter -> resources/mcp-adapter) and is NEVER written at run
// time. Termpolis.exe writing a script into its data folder and then running it as Node is what endpoint security
// reports as a dropped payload.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-clh-'))
  const userData = path.join(root, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  return { root, userData, packaged: false }
})
vi.mock('electron', () => ({ app: { getPath: () => H.userData, get isPackaged() { return H.packaged } } }))

import { ensureConsoleListHelper, consoleListHelperPath, CONSOLE_LIST_HELPER_NAME, _resetConsoleListHelperForTests } from '../../src/main/consoleListHelper'

const REPO = resolve(__dirname, '..', '..')
const shipped = join(REPO, 'src', 'mcp-adapter', CONSOLE_LIST_HELPER_NAME)

afterAll(() => { rmSync(H.root, { recursive: true, force: true }) })
beforeEach(() => { _resetConsoleListHelperForTests(); H.packaged = false })

describe('ensureConsoleListHelper (the shipped script, never written at run time)', () => {
  it('answers the shipped script in src/mcp-adapter in development, and writes nothing into the data folder', async () => {
    expect(await ensureConsoleListHelper()).toBe(shipped)
    expect(readdirSync(H.userData)).toEqual([])
  })

  it('answers resources/mcp-adapter in a packaged app (the extraResources copy), not the data folder', () => {
    H.packaged = true
    const old = (process as any).resourcesPath
    ;(process as any).resourcesPath = join(H.root, 'resources')
    try {
      expect(consoleListHelperPath()).toBe(join(H.root, 'resources', 'mcp-adapter', CONSOLE_LIST_HELPER_NAME))
      expect(consoleListHelperPath().startsWith(H.userData)).toBe(false)
    } finally { (process as any).resourcesPath = old }
  })

  it('answers null when the file is missing (shellAlone cannot tell), writes nothing, and looks again next time', async () => {
    H.packaged = true
    const old = (process as any).resourcesPath
    const res = join(H.root, 'resources-missing')
    ;(process as any).resourcesPath = res
    try {
      expect(await ensureConsoleListHelper()).toBeNull()
      expect(existsSync(res)).toBe(false)
      expect(readdirSync(H.userData)).toEqual([])
      H.packaged = false
      expect(await ensureConsoleListHelper()).toBe(shipped)
    } finally { (process as any).resourcesPath = old }
  })

  it('checks the file once per run', async () => {
    expect(await ensureConsoleListHelper()).toBe(shipped)
    H.packaged = true // a different answer would show a second look
    expect(await ensureConsoleListHelper()).toBe(shipped)
  })

  it('is shipped by the existing extraResources entry (src/mcp-adapter **/*.cjs -> mcp-adapter)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    const entry = (pkg.build.extraResources as any[]).find((e) => e && e.from === 'src/mcp-adapter')
    expect(entry?.to).toBe('mcp-adapter')
    expect(entry?.filter).toContain('**/*.cjs')
    expect(existsSync(shipped)).toBe(true)
  })

  it('the module holds no script text and no file-writing call (nothing to drop at run time)', () => {
    const src = readFileSync(join(REPO, 'src', 'main', 'consoleListHelper.ts'), 'utf8')
    expect(src).not.toMatch(/writeFile|mkdir|copyFile|createWriteStream/)
    expect(src).not.toMatch(/getPath\(\s*['"]userData/)
  })
})

describe('the helper script, run as the proc host runs it (a child process with no IPC channel)', () => {
  function fakeNodePtyLib(listFor: string): string {
    const lib = mkdtempSync(join(tmpdir(), 'fake-node-pty-lib-'))
    writeFileSync(join(lib, 'utils.js'), `exports.loadNativeModule = (name) => { if (name !== 'conpty_console_list') throw new Error('asked for ' + name); return { dir: '', module: { getConsoleProcessList: (pid) => ${listFor} } } }\n`)
    return lib
  }

  function run(args: string[]) {
    // ELECTRON_RUN_AS_NODE as the real run sets it: on plain Node it does nothing.
    return spawnSync(process.execPath, [shipped, ...args], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 })
  }

  it('prints its own pid and the list node-pty\'s native call returned, and exits 0', () => {
    const lib = fakeNodePtyLib('[pid, 4242, 99]')
    try {
      const r = run(['777', lib])
      expect(r.status).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.list).toEqual([777, 4242, 99])
      expect(out.self).toBe(r.pid)
    } finally { rmSync(lib, { recursive: true, force: true }) }
  })

  it('prints a long list whole before it exits (the output is flushed, not cut off by the exit)', () => {
    const lib = fakeNodePtyLib('Array.from({ length: 20000 }, (_, i) => i + 1)')
    try {
      const r = run(['1', lib])
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).list).toHaveLength(20000)
    } finally { rmSync(lib, { recursive: true, force: true }) }
  })

  it('exits 1 and prints nothing when the native call throws (the shell is gone), or node-pty cannot be loaded', () => {
    const lib = fakeNodePtyLib('(() => { throw new Error("no such console") })()')
    try {
      const gone = run(['1', lib])
      expect(gone.status).toBe(1)
      expect(gone.stdout).toBe('')
    } finally { rmSync(lib, { recursive: true, force: true }) }
    const missing = run(['1', join(H.root, 'no-such-lib')])
    expect(missing.status).toBe(1)
    expect(missing.stdout).toBe('')
  })

  it('answers on stdout only: it does not use an IPC channel (process.send), which an execFile child does not have', () => {
    expect(readFileSync(shipped, 'utf8')).not.toMatch(/process\.send/)
  })
})
