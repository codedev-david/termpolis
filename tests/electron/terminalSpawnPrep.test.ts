// AC1 (f): opening a terminal asks the file system nothing on the main thread. prepareSpawn() looks up, on the
// thread pool, what spawnTerminal used to look up with existsSync / mkdirSync / writeFileSync; spawnTerminal given
// its answer makes no file call. Every assertion is a COUNT (sync calls, spawns, writes), never a time.
// IMPORT ORDER: the counters first (they patch fs and child_process before the modules under test load).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { dirname, join, sep } from 'path'
import type { IntegrationFile } from '../../src/main/shellIntegration'
import { readAppLog } from '../../src/main/appLog'
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
let writeWholeFile: typeof import('../../src/main/terminalSpawnPrep').writeWholeFile
let writeWholeFileSync: typeof import('../../src/main/terminalManager').writeWholeFileSync
let ensureIntegrationScriptAsync: typeof import('../../src/main/terminalSpawnPrep').ensureIntegrationScriptAsync
let ensureIntegrationScript: typeof import('../../src/main/terminalManager').ensureIntegrationScript

beforeAll(async () => {
  mkdirSync(H.userData, { recursive: true })
  ;({ prepareSpawn, integrationScriptState: state, writeWholeFile, ensureIntegrationScriptAsync } = await import('../../src/main/terminalSpawnPrep'))
  ;({ spawnTerminal, primeBundledToolsCheck, writeWholeFileSync, ensureIntegrationScript } = await import('../../src/main/terminalManager'))
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

// A shell starting while another terminal's prepareSpawn rewrites the integration files must never read half of one:
// each file is written to a temp file beside it and renamed into place. Windows can refuse that rename while another
// process has either file open (EPERM, EBUSY, EACCES): the rename is tried again, then the old file (whole) stays, or with
// none the file is written directly. Nothing is thrown into spawn.
describe('the integration files are written whole', () => {
  const tmpsIn = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

  type Io = { writeFile?: (p: string, c: string) => void; rename?: (a: string, b: string) => void; rm?: (p: string) => void; sleep?: (ms: number) => void }
  for (const [name, write] of [
    ['async (prepareSpawn)', (p: string, c: string, io?: Io) => writeWholeFile(p, c, io)],
    ['sync (the fallback)', async (p: string, c: string, io?: Io) => writeWholeFileSync(p, c, io)],
  ] as const) {
    it(`${name}: writes a temp file in the same folder, then renames it over the file, leaving no temp file`, async () => {
      const dir = mkdtempSync(join(H.root, 'whole-'))
      const target = join(dir, 'f.ps1')
      writeFileSync(target, 'old')
      const renames: Array<[string, string]> = []
      await expect(write(target, 'new', { rename: (a, b) => { renames.push([a, b]); renameSync(a, b) } })).resolves.toBe('written')
      expect(readFileSync(target, 'utf8')).toBe('new')
      expect(renames).toHaveLength(1)
      expect(renames[0][1]).toBe(target)
      expect(renames[0][0].startsWith(`${target}.`) && renames[0][0].endsWith('.tmp')).toBe(true)
      expect(tmpsIn(dir)).toEqual([])
      await expect(write(join(dir, 'g.sh'), 'made')).resolves.toBe('written') // the real calls by default, and a new file too
      expect(readFileSync(join(dir, 'g.sh'), 'utf8')).toBe('made')
      expect(tmpsIn(dir)).toEqual([])
    })

    it(`${name}: a rename refused a few times (a scanner reading the new temp file) is tried again, 50 ms apart, and then succeeds`, async () => {
      const dir = mkdtempSync(join(H.root, 'retry-'))
      const target = join(dir, 'f.ps1')
      writeFileSync(target, 'old')
      const sleeps: number[] = []
      let refusals = 3
      const rename = (a: string, b: string): void => { if (refusals-- > 0) throw refused('EBUSY'); renameSync(a, b) }
      await expect(write(target, 'new', { rename, sleep: (ms) => { sleeps.push(ms) } })).resolves.toBe('written')
      expect(readFileSync(target, 'utf8')).toBe('new')
      expect(sleeps).toEqual([50, 50, 50])
      expect(tmpsIn(dir)).toEqual([])
      // The real pause between tries, on a fresh file: refused twice, then through.
      let twice = 2
      await expect(write(join(dir, 'h.ps1'), 'paused', { rename: (a, b) => { if (twice-- > 0) throw refused('EPERM'); renameSync(a, b) } })).resolves.toBe('written')
      expect(readFileSync(join(dir, 'h.ps1'), 'utf8')).toBe('paused')
    })

    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      it(`${name}: a rename still refused with ${code} after every retry keeps the old file, removes the temp file and throws nothing`, async () => {
        const dir = mkdtempSync(join(H.root, 'busy-'))
        const target = join(dir, 'f.ps1')
        writeFileSync(target, 'old and whole')
        const sleeps: number[] = []
        let tries = 0
        await expect(write(target, 'new', { rename: () => { tries++; throw refused(code) }, sleep: (ms) => { sleeps.push(ms) } })).resolves.toBe('kept')
        expect(tries).toBe(5)
        expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(250) // the sync path blocks the main thread this long at most
        expect(readFileSync(target, 'utf8')).toBe('old and whole')
        expect(tmpsIn(dir)).toEqual([])
      })
    }

    it(`${name}: any other rename failure fails at once, even over a whole old file (the caller then answers null), leaving no temp file`, async () => {
      const dir = mkdtempSync(join(H.root, 'other-'))
      const target = join(dir, 'f.ps1')
      writeFileSync(target, 'old')
      let tries = 0
      await expect(write(target, 'new', { rename: () => { tries++; throw refused('EIO') } })).rejects.toThrow('EIO')
      expect(tries).toBe(1)
      expect(readFileSync(target, 'utf8')).toBe('old')
      expect(tmpsIn(dir)).toEqual([])
    })

    it(`${name}: a refused rename with no old file to keep (a fresh install) writes the file directly, leaving no temp file`, async () => {
      const dir = mkdtempSync(join(H.root, 'none-'))
      await expect(write(join(dir, 'f.ps1'), 'new', { rename: () => { throw refused('EPERM') }, sleep: () => {} })).resolves.toBe('written')
      expect(readFileSync(join(dir, 'f.ps1'), 'utf8')).toBe('new')
      expect(readdirSync(dir)).toEqual(['f.ps1'])
    })

    it(`${name}: the temp file itself held (its rename refused, its removal refused too): the old file stays, or with none the file is written directly; the original error is not lost`, async () => {
      const dir = mkdtempSync(join(H.root, 'held-'))
      const target = join(dir, 'f.ps1')
      writeFileSync(target, 'old')
      const held = { rename: () => { throw refused('EBUSY') }, rm: () => { throw refused('EBUSY') }, sleep: () => {} }
      await expect(write(target, 'new', held)).resolves.toBe('kept')
      expect(readFileSync(target, 'utf8')).toBe('old')
      await expect(write(join(dir, 'fresh.ps1'), 'first run', held)).resolves.toBe('written')
      expect(readFileSync(join(dir, 'fresh.ps1'), 'utf8')).toBe('first run')
      // Another failure with the temp file held is still that failure, not the removal's.
      await expect(write(target, 'new', { ...held, rename: () => { throw refused('EIO') } })).rejects.toThrow('EIO')
      expect(tmpsIn(dir)).toHaveLength(3) // what the held temp files leave; the scanner lets go later
    })

    it(`${name}: a temp file cut short (a full disk) is removed and the failure reported`, async () => {
      const dir = mkdtempSync(join(H.root, 'full-'))
      const target = join(dir, 'f.ps1')
      writeFileSync(target, 'old')
      const writeFile = (p: string, c: string): void => { writeFileSync(p, c.slice(0, 2)); throw refused('ENOSPC') }
      await expect(write(target, 'new content', { writeFile })).rejects.toThrow('ENOSPC')
      expect(readFileSync(target, 'utf8')).toBe('old')
      expect(tmpsIn(dir)).toEqual([])
    })
  }

  // A refusal that kept an old file must not count as written, or nothing tries again that run: a scanner that always
  // refuses would freeze an old script across releases, and zsh's four files could stay half old, half new.
  for (const [name, ensure] of [
    ['async (prepareSpawn)', (f: IntegrationFile, io?: Io) => ensureIntegrationScriptAsync(f, io)],
    ['sync (the fallback)', async (f: IntegrationFile, io?: Io) => ensureIntegrationScript(f, io)],
  ] as const) {
    it(`${name}: a kept old file answers its path but is not recorded, so the next spawn writes it again, and the app log is told once`, async () => {
      const { INTEGRATION_FILES, integrationFileSet } = await import('../../src/main/shellIntegration')
      const file = INTEGRATION_FILES.zsh
      const p = join(H.userData, file.name)
      const set = integrationFileSet(file, p)
      mkdirSync(dirname(p), { recursive: true })
      for (const f of set) writeFileSync(f.path, 'an old release')
      const refusing = { rename: (a: string, b: string) => { if (b.endsWith('.zshrc')) throw refused('EBUSY'); renameSync(a, b) }, sleep: () => {} }
      const before = readAppLog(5000).length
      expect(await ensure(file, refusing)).toBe(p)
      expect(state[file.name]).toBeUndefined()
      expect(readFileSync(zshFile('.zshrc'), 'utf8')).toBe('an old release')
      expect(await ensure(file, refusing)).toBe(p) // still refused: still not recorded, and not logged twice
      expect(state[file.name]).toBeUndefined()
      expect(await ensure(file)).toBe(p) // the scanner let go
      expect(state[file.name]).toBe(p)
      for (const f of set) expect(readFileSync(f.path, 'utf8'), f.path).toBe(f.content)
      const told = readAppLog(5000).slice(before).filter((e) => e.msg.includes('.zshrc') && e.msg.includes('could not be replaced'))
      expect(told.length).toBeLessThanOrEqual(1) // once per file per run: the other mode may have told it already
      expect(readAppLog(5000).filter((e) => e.msg.includes(zshFile('.zshrc')) && e.msg.includes('could not be replaced'))).toHaveLength(1)
    })
  }
  it('gives every write its own temp name, so concurrent writers never share one', async () => {
    const dir = mkdtempSync(join(H.root, 'names-'))
    const target = join(dir, 'f')
    const tmps: string[] = []
    const rec = (a: string, b: string): void => { tmps.push(a); renameSync(a, b) }
    await Promise.all([writeWholeFile(target, '1', { rename: rec }), writeWholeFile(target, '2', { rename: rec })])
    writeWholeFileSync(target, '3', { rename: rec })
    expect(new Set(tmps).size).toBe(3)
    expect(readFileSync(target, 'utf8')).toBe('3')
  })

  it('many terminals preparing at once, for every shell with files: each answers its file, every file whole, no temp file left', async () => {
    rmSync(join(H.userData, 'termpolis-zsh'), { recursive: true, force: true })
    rmSync(scriptFile(), { force: true })
    const shells = [PS, 'C:/Windows/System32/cmd.exe', '/bin/zsh', '/usr/bin/fish']
    const answers = await Promise.all(Array.from({ length: 24 }, (_, i) => prepareSpawn(process.cwd(), shells[i % 4])))
    expect(answers.every((a) => a.integrationScript !== null)).toBe(true)
    // Asked again with the state forgotten (a fresh run over the files of the last): rewritten in place, all at once.
    for (const k of Object.keys(state)) delete state[k]
    await Promise.all(Array.from({ length: 24 }, (_, i) => prepareSpawn(process.cwd(), shells[i % 4])))
    const { integrationFile, integrationFileSet, detectShellKind } = await import('../../src/main/shellIntegration')
    for (const sh of shells) {
      const file = integrationFile(detectShellKind(sh))!
      for (const f of integrationFileSet(file, join(H.userData, file.name))) expect(readFileSync(f.path, 'utf8'), f.path).toBe(f.content)
    }
    expect(tmpsIn(H.userData)).toEqual([])
    expect(tmpsIn(join(H.userData, 'termpolis-zsh'))).toEqual([])
  })

  it('the fallback writes through the same whole-file write: zsh files written there leave no temp file', () => {
    rmSync(join(H.userData, 'termpolis-zsh'), { recursive: true, force: true })
    spawnTerminal('tw', '/bin/zsh', process.cwd(), () => {})
    expect(existsSync(zshFile('.zshrc'))).toBe(true)
    expect(tmpsIn(join(H.userData, 'termpolis-zsh'))).toEqual([])
  })
})
