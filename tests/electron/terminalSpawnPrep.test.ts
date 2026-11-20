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
beforeEach(() => { H.spawned.length = 0; for (const k of Object.keys(state)) delete state[k]; delete process.env.TERMPOLIS_DISABLE_SHELL_INTEGRATION })

const scriptFile = (): string => join(H.userData, 'termpolis-shell-integration.ps1')
const zshFile = (name: string): string => join(H.userData, 'termpolis-zsh', name)

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

  it("writes cmd's lumopolis macro file beside it, under its own name", async () => {
    const macros = join(H.userData, 'termpolis-lumopolis.doskey')
    rmSync(macros, { force: true })
    expect((await prepareSpawn(process.cwd(), 'C:/Windows/System32/cmd.exe')).integrationScript).toBe(macros)
    expect(readFileSync(macros, 'utf8')).toContain('lumopolis=@set __termpolis_lumo= $*')
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBe(scriptFile()) // the two never collide
  })

  it("writes zsh's four start-up files into their own folder, and writes them again when one goes missing", async () => {
    const dir = join(H.userData, 'termpolis-zsh')
    rmSync(dir, { recursive: true, force: true })
    expect((await prepareSpawn(process.cwd(), '/bin/zsh')).integrationScript).toBe(zshFile('.zshenv'))
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(existsSync(zshFile(f)), f).toBe(true)
    expect(readFileSync(zshFile('.zshrc'), 'utf8')).toContain('add-zsh-hook precmd __termpolis_report_cwd')
    writeFileSync(zshFile('.zshenv'), 'edited by hand')
    rmSync(zshFile('.zlogin')) // one sibling cleaned up mid-session
    expect((await prepareSpawn(process.cwd(), '/usr/bin/zsh')).integrationScript).toBe(zshFile('.zshenv'))
    expect(existsSync(zshFile('.zlogin'))).toBe(true)
    expect(readFileSync(zshFile('.zshenv'), 'utf8')).toContain('__termpolis_zdotdir') // the set is written whole
  })

  it("writes fish's file beside the others, under its own name", async () => {
    const fish = join(H.userData, 'termpolis-integration.fish')
    rmSync(fish, { force: true })
    expect((await prepareSpawn(process.cwd(), '/usr/bin/fish')).integrationScript).toBe(fish)
    expect(readFileSync(fish, 'utf8')).toContain('function __termpolis_report_cwd --on-event fish_prompt')
  })

  it('zsh and fish start plainly when their files cannot be written: no script, so no ZDOTDIR and no --init-command', async () => {
    const blocker = join(H.root, 'blocker-zf')
    writeFileSync(blocker, 'a file where the folder should be')
    state['termpolis-zsh/.zshenv'] = join(blocker, 'termpolis-zsh', '.zshenv')
    state['termpolis-integration.fish'] = join(blocker, 'sub', 'termpolis-integration.fish')
    const z = await prepareSpawn(process.cwd(), '/bin/zsh')
    const f = await prepareSpawn(process.cwd(), '/usr/bin/fish')
    expect(z.integrationScript).toBeNull()
    expect(f.integrationScript).toBeNull()
    spawnTerminal('tz', '/bin/zsh', process.cwd(), () => {}, [], undefined, undefined, z)
    spawnTerminal('tf', '/usr/bin/fish', process.cwd(), () => {}, [], undefined, undefined, f)
    expect(H.spawned[0].args).toEqual(['--login'])
    expect(H.spawned[0].opts.env.ZDOTDIR).toBe(process.env.ZDOTDIR) // untouched: whatever it was
    expect(H.spawned[1].args).toEqual([])
    delete state['termpolis-zsh/.zshenv']
    delete state['termpolis-integration.fish']
  })

  it('writes nothing for zsh or fish when integration is turned off', async () => {
    process.env.TERMPOLIS_DISABLE_SHELL_INTEGRATION = '1'
    expect((await prepareSpawn(process.cwd(), '/bin/zsh')).integrationScript).toBeNull()
    expect((await prepareSpawn(process.cwd(), '/usr/bin/fish')).integrationScript).toBeNull()
    spawnTerminal('td', '/bin/zsh', process.cwd(), () => {}, [], undefined, undefined, await prepareSpawn(process.cwd(), '/bin/zsh'))
    expect(H.spawned[0].opts.env.ZDOTDIR).toBe(process.env.ZDOTDIR)
    expect(H.spawned[0].opts.env.TERMPOLIS_LUMOPOLIS_NONCE).toBeUndefined()
  })

  it('has no script for a shell that needs none, or when integration is turned off', async () => {
    expect((await prepareSpawn(process.cwd(), '/bin/bash')).integrationScript).toBeNull()
    process.env.TERMPOLIS_DISABLE_SHELL_INTEGRATION = '1'
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBeNull()
  })

  it('answers null for the script when the data folder cannot be written (the terminal then opens as before)', async () => {
    const blocker = join(H.root, 'blocker')
    writeFileSync(blocker, 'a file where the folder should be')
    state['termpolis-shell-integration.ps1'] = join(blocker, 'sub', 'termpolis-shell-integration.ps1') // its folder is under a file: mkdir fails
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBeNull()
    delete state['termpolis-shell-integration.ps1']
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

  it("without a preparation, zsh's four files are written synchronously, and a missing one again; ZDOTDIR points at them", () => {
    rmSync(join(H.userData, 'termpolis-zsh'), { recursive: true, force: true })
    spawnTerminal('tz1', '/bin/zsh', process.cwd(), () => {})
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(existsSync(zshFile(f)), f).toBe(true)
    rmSync(zshFile('.zprofile'))
    spawnTerminal('tz2', '/bin/zsh', process.cwd(), () => {})
    expect(existsSync(zshFile('.zprofile'))).toBe(true)
    expect(H.spawned[1].args).toEqual(['--login'])
    expect(H.spawned[1].opts.env.ZDOTDIR).toBe(join(H.userData, 'termpolis-zsh').replace(/\\/g, '/'))
  })

  it('without a preparation, fish gets its file and --init-command', () => {
    spawnTerminal('tf1', '/usr/bin/fish', process.cwd(), () => {})
    expect(H.spawned[0].args[0]).toBe('--init-command')
    expect(H.spawned[0].args[1]).toContain('termpolis-integration.fish')
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
