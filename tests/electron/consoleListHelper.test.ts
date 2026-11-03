// The script that reads one terminal's console for shellAlone.ts on Windows (consoleListHelper.ts). The proc host runs it
// as a child process, where node-pty's own helper (which answers over process.send) cannot run. Nothing here needs
// Windows: the native console call is replaced by a fake node-pty lib folder, and what is checked is the contract
// (arguments in, one JSON line out, exit codes), which is what shellAlone depends on.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-clh-'))
  return { root, userData: path.join(root, 'userData') }
})
vi.mock('electron', () => ({ app: { getPath: () => H.userData } }))

import { ensureConsoleListHelper, CONSOLE_LIST_HELPER_SOURCE, CONSOLE_LIST_HELPER_NAME, _resetConsoleListHelperForTests } from '../../src/main/consoleListHelper'

const helperFile = (): string => join(H.userData, CONSOLE_LIST_HELPER_NAME)

beforeAll(() => { mkdirSync(H.userData, { recursive: true }) })
afterAll(() => { rmSync(H.root, { recursive: true, force: true }) })
beforeEach(() => { _resetConsoleListHelperForTests(); rmSync(helperFile(), { force: true }) })

describe('ensureConsoleListHelper', () => {
  it('writes the helper into the data folder on the first call of a run, and answers its path', async () => {
    expect(await ensureConsoleListHelper()).toBe(helperFile())
    expect(readFileSync(helperFile(), 'utf8')).toBe(CONSOLE_LIST_HELPER_SOURCE)
  })

  it('replaces an older copy on the first call of a run (a newer Termpolis brings a newer helper)', async () => {
    writeFileSync(helperFile(), '// an older Termpolis wrote this')
    await ensureConsoleListHelper()
    expect(readFileSync(helperFile(), 'utf8')).toBe(CONSOLE_LIST_HELPER_SOURCE)
  })

  it('leaves it alone while it is there, and writes it again when something removed it mid-session', async () => {
    await ensureConsoleListHelper()
    writeFileSync(helperFile(), '// touched')
    await ensureConsoleListHelper()
    expect(readFileSync(helperFile(), 'utf8')).toBe('// touched')
    rmSync(helperFile())
    expect(await ensureConsoleListHelper()).toBe(helperFile())
    expect(readFileSync(helperFile(), 'utf8')).toBe(CONSOLE_LIST_HELPER_SOURCE)
  })

  it('answers null when it cannot be written, so shellAlone cannot tell (and does not claim the shell is alone)', async () => {
    const blocker = join(H.root, 'a-file')
    writeFileSync(blocker, 'x')
    const electron = await import('electron')
    const spy = vi.spyOn(electron.app, 'getPath').mockReturnValue(join(blocker, 'userData'))
    try {
      expect(await ensureConsoleListHelper()).toBeNull()
    } finally {
      spy.mockRestore()
    }
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
    return spawnSync(process.execPath, [helperFile(), ...args], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 })
  }

  beforeEach(async () => { await ensureConsoleListHelper() })

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
    expect(CONSOLE_LIST_HELPER_SOURCE).not.toMatch(/process\.send/)
    expect(existsSync(helperFile())).toBe(true)
  })
})
