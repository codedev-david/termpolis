// AC1 (f): opening a terminal asks the file system nothing on the main thread. prepareSpawn() looks up, on the
// thread pool, what spawnTerminal used to look up with existsSync / mkdirSync / writeFileSync; spawnTerminal given
// its answer makes no file call. Every assertion is a COUNT (sync calls, spawns, writes), never a time.
// IMPORT ORDER: the counters first (they patch fs and child_process before the modules under test load).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir, homedir } from 'os'

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-prep-'))
  return { root, userData: path.join(root, 'userData'), spawned: [] as Array<{ file: string; args: string[]; opts: any }> }
})

vi.mock('electron', () => ({ app: { getPath: () => H.userData, isPackaged: false } }))
vi.mock('node-pty', () => {
  const spawn = vi.fn((file: string, args: string[], opts: any) => {
    H.spawned.push({ file, args, opts })
    return { pid: 5000 + H.spawned.length, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
  })
  return { spawn, default: { spawn } }
})
vi.mock('../../src/main/procClient', () => ({ execShellCaptureOffThread: vi.fn(async () => ({ stdout: '', stderr: '' })), execCaptureOffThread: vi.fn() }))

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

let prepareSpawn: typeof import('../../src/main/terminalSpawnPrep').prepareSpawn
let spawnTerminal: typeof import('../../src/main/terminalManager').spawnTerminal
let primeBundledToolsCheck: typeof import('../../src/main/terminalManager').primeBundledToolsCheck
let state: typeof import('../../src/main/terminalSpawnPrep').integrationScriptState

beforeAll(async () => {
  mkdirSync(H.userData, { recursive: true })
  ;({ prepareSpawn, integrationScriptState: state } = await import('../../src/main/terminalSpawnPrep'))
  ;({ spawnTerminal, primeBundledToolsCheck } = await import('../../src/main/terminalManager'))
  // Start-up does this (index.ts), on the thread pool; without it spawnTerminal would probe for jq/yq/nano with execSync.
  await primeBundledToolsCheck()
})
afterAll(() => { uninstall(); rmSync(H.root, { recursive: true, force: true }) })
beforeEach(() => { H.spawned.length = 0; state.path = null; delete process.env.TERMPOLIS_DISABLE_SHELL_INTEGRATION })

const scriptFile = (): string => join(H.userData, 'termpolis-shell-integration.ps1')

describe('prepareSpawn', () => {
  it('keeps a folder that exists, and falls back to the home folder when it is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-cwd-'))
    try {
      expect((await prepareSpawn(dir, '/bin/bash')).cwd).toBe(dir)
      expect((await prepareSpawn(join(dir, 'nope'), '/bin/bash')).cwd).toBe(homedir())
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('writes the PowerShell integration script once, finds it again, and writes it again if it was cleaned up', async () => {
    rmSync(scriptFile(), { force: true })
    const a = await prepareSpawn(process.cwd(), PS)
    expect(a.integrationScript).toBe(scriptFile())
    expect(existsSync(scriptFile())).toBe(true)
    const first = readFileSync(scriptFile(), 'utf8')
    writeFileSync(scriptFile(), 'edited by hand')
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBe(scriptFile())
    expect(readFileSync(scriptFile(), 'utf8')).toBe('edited by hand') // present: not rewritten
    rmSync(scriptFile())
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBe(scriptFile())
    expect(readFileSync(scriptFile(), 'utf8')).toBe(first) // cleaned up mid-session: written again
  })

  it('has no script for a shell that needs none, or when integration is turned off', async () => {
    expect((await prepareSpawn(process.cwd(), '/bin/bash')).integrationScript).toBeNull()
    process.env.TERMPOLIS_DISABLE_SHELL_INTEGRATION = '1'
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBeNull()
  })

  it('answers null for the script when the data folder cannot be written (the terminal then opens as before)', async () => {
    const blocker = join(H.root, 'blocker')
    writeFileSync(blocker, 'a file where the folder should be')
    const saved = state.path
    state.path = join(blocker, 'sub', 'termpolis-shell-integration.ps1') // its folder is under a file: mkdir fails
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBeNull()
    state.path = saved
  })

  it('makes no synchronous file call and no spawn (counted), however often it is asked', async () => {
    rmSync(scriptFile(), { force: true })
    arm()
    for (let i = 0; i < 25; i++) await prepareSpawn(process.cwd(), i % 2 ? PS : '/bin/bash')
    const c = disarm()
    expect(describeCounts(c)).toBe('')
  })
})

describe('spawnTerminal', () => {
  it('given its preparation, asks the file system nothing (counted) and uses what it was given', async () => {
    const prep = await prepareSpawn(process.cwd(), PS)
    arm()
    spawnTerminal('t1', PS, 'C:\\somewhere\\that\\does\\not\\exist', () => {}, [], undefined, undefined, prep)
    const c = disarm()
    expect(describeCounts(c), 'only node-pty is allowed to start the shell').toBe('')
    expect(H.spawned).toHaveLength(1)
    expect(H.spawned[0].opts.cwd).toBe(prep.cwd) // the prepared folder, not the one passed in
    expect(H.spawned[0].args.join(' ')).toContain('termpolis-shell-integration.ps1')
  })

  it('without a preparation it still looks synchronously (a workflow step, a test): the control that the counters see it', () => {
    arm()
    spawnTerminal('t2', PS, process.cwd(), () => {})
    const c = disarm()
    expect(c.sync.existsSync).toBeGreaterThan(0) // the folder, and the script
    expect(H.spawned).toHaveLength(1)
    expect(H.spawned[0].opts.cwd).toBe(process.cwd())
    expect(existsSync(scriptFile())).toBe(true)
    expect(sep).toBeTruthy()
  })
})
