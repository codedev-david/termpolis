// AC1 (f): opening a terminal asks the file system nothing on the main thread. prepareSpawn() looks up, on the
// thread pool, what spawnTerminal used to look up with existsSync / mkdirSync / writeFileSync; spawnTerminal given
// its answer makes no file call. Every assertion is a COUNT (sync calls, spawns, writes), never a time.
// IMPORT ORDER: the counters first (they patch fs and child_process before the modules under test load).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, renameSync, utimesSync } from 'fs'
import { dirname, join, sep } from 'path'
import type { IntegrationFile } from '../../src/main/shellIntegration'
import { readAppLog } from '../../src/main/appLog'
import { tmpdir, homedir } from 'os'

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-prep-'))
  const userData = path.join(root, 'userData')
  // A temp file a held write left in an earlier run: the first prepare's sweep removes it (see "leftover temp files").
  const plantedTemp = path.join(userData, 'termpolis-shell-integration.ps1.4242.1.abc123.tmp')
  return { root, userData, plantedTemp, spawned: [] as Array<{ file: string; args: string[]; opts: any }> }
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
  writeFileSync(H.plantedTemp, 'left by a refused write')
  const longAgo = new Date(Date.now() - 10 * 60_000)
  utimesSync(H.plantedTemp, longAgo, longAgo)
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
    const writes = vi.spyOn((await import('fs')).promises, 'writeFile')
    try {
      expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBe(scriptFile())
      expect(writes).not.toHaveBeenCalled() // present and whole: not rewritten
    } finally { writes.mockRestore() }
    writeFileSync(scriptFile(), 'edited by hand')
    expect((await prepareSpawn(process.cwd(), PS)).integrationScript).toBe(scriptFile())
    expect(readFileSync(scriptFile(), 'utf8')).toBe(first) // not the size written (#28: it may be cut short): written again
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

  it('without a preparation (a test, a spawner wired without a prepare) it still looks synchronously: the control that the counters see it', () => {
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

    it(`${name}: a refused rename with no old file to keep (a fresh install) tries a second temp file, then writes the file directly, leaving no temp file`, async () => {
      const dir = mkdtempSync(join(H.root, 'none-'))
      const target = join(dir, 'f.ps1')
      const sources: string[] = []
      const sleeps: number[] = []
      await expect(write(target, 'new', { rename: (a) => { sources.push(a); throw refused('EPERM') }, sleep: (ms) => { sleeps.push(ms) } })).resolves.toBe('written')
      expect(readFileSync(target, 'utf8')).toBe('new')
      expect(readdirSync(dir)).toEqual(['f.ps1'])
      expect(sources).toHaveLength(6) // the first temp file 5 times, the second once
      expect(new Set(sources).size).toBe(2)
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200) // the sync path blocks no longer than before
    })

    it(`${name}: on a fresh install the second temp file's rename goes through, so the file is never written directly`, async () => {
      const dir = mkdtempSync(join(H.root, 'second-'))
      const target = join(dir, 'f.ps1')
      const writes: string[] = []
      const sources: string[] = []
      let refusals = 5 // every try on the first temp file: the scanner holds that one
      const io = {
        writeFile: (p: string, c: string) => { writes.push(p); writeFileSync(p, c) },
        rename: (a: string, b: string) => { sources.push(a); if (refusals-- > 0) throw refused('EBUSY'); renameSync(a, b) },
        sleep: () => {},
      }
      await expect(write(target, 'whole', io)).resolves.toBe('written')
      expect(readFileSync(target, 'utf8')).toBe('whole')
      expect(writes).not.toContain(target)
      expect(writes).toHaveLength(2)
      expect(sources).toEqual([...Array(5).fill(writes[0]), writes[1]])
      expect(tmpsIn(dir)).toEqual([])
    })

    for (const code of ['EPERM', 'EACCES']) {
      it(`${name}: a temp file that cannot be written (${code}) is that failure, not a refused rename: no rename, no keep, no direct write`, async () => {
        const dir = mkdtempSync(join(H.root, 'tmpfail-'))
        const target = join(dir, 'f.ps1')
        writeFileSync(target, 'old')
        let renames = 0
        const io = { writeFile: () => { throw Object.assign(new Error(`${code}: open`), { code }) }, rename: () => { renames++ }, sleep: () => {} }
        await expect(write(target, 'new', io)).rejects.toThrow(code)
        await expect(write(join(dir, 'fresh.ps1'), 'new', io)).rejects.toThrow(code) // nothing there: still no direct write
        expect(renames).toBe(0)
        expect(readFileSync(target, 'utf8')).toBe('old')
        expect(readdirSync(dir)).toEqual(['f.ps1'])
      })
    }

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
      expect(tmpsIn(dir)).toHaveLength(4) // what the held temp files leave (two for the fresh one); the sweep removes them later
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

    // #28. The direct write of a fresh install truncates the file and then writes it: cut short (a full disk, EIO), it
    // must not leave half a script that a later spawn keeps (a refused rename keeps whatever file is there) and sources.
    const cutShortIo = (target: string, code: string) => ({
      rename: () => { throw refused('EPERM') },
      sleep: () => {},
      writeFile: (p: string, c: string) => { if (p === target) { writeFileSync(p, c.slice(0, 3)); throw refused(code) } writeFileSync(p, c) },
    })
    for (const code of ['ENOSPC', 'EIO']) {
      it(`${name}: a direct write cut short (${code}) on a fresh install leaves no half file behind, and the failure is reported`, async () => {
        const dir = mkdtempSync(join(H.root, 'cut-'))
        const target = join(dir, 'f.ps1')
        await expect(write(target, 'the whole script', cutShortIo(target, code))).rejects.toThrow(code)
        expect(readdirSync(dir)).toEqual([])
      })
    }

    it(`${name}: a half file that cannot be removed either (the scanner holds it) is never kept: the next write with renames still refused writes it whole`, async () => {
      const dir = mkdtempSync(join(H.root, 'cutheld-'))
      const target = join(dir, 'f.ps1')
      const io = cutShortIo(target, 'ENOSPC')
      const held = { ...io, rm: (p: string) => { if (p === target) throw refused('EBUSY'); rmSync(p, { force: true }) } }
      await expect(write(target, 'the whole script', held)).rejects.toThrow('ENOSPC') // the write's failure, not the removal's
      expect(readFileSync(target, 'utf8')).toBe('the')
      const stillRefused = { rename: () => { throw refused('EPERM') }, sleep: () => {} }
      await expect(write(target, 'the whole script', stillRefused)).resolves.toBe('written') // not 'kept': half a file is no old copy
      expect(readFileSync(target, 'utf8')).toBe('the whole script')
      await expect(write(target, 'a newer script', stillRefused)).resolves.toBe('kept') // whole again, so it is kept as before
      expect(readFileSync(target, 'utf8')).toBe('the whole script')
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

    // #28. A prepare that fails part way through the set (a full disk while it rewrites a file cleaned up mid-session)
    // drops the record, so no later spawn takes the half-written set as present and sources it.
    it(`${name}: a rewrite that fails part way drops the record, and the next spawn writes the set again, whole`, async () => {
      const { INTEGRATION_FILES, integrationFileSet } = await import('../../src/main/shellIntegration')
      const file = INTEGRATION_FILES.zsh
      const p = join(H.userData, file.name)
      const set = integrationFileSet(file, p)
      expect(await ensure(file)).toBe(p)
      expect(state[file.name]).toBe(p)
      rmSync(zshFile('.zshrc')) // cleaned up mid-session
      const zshrc = zshFile('.zshrc')
      const failing = {
        rename: () => { throw refused('EPERM') }, // a scanner holds every rename: the missing file is written directly
        sleep: () => {},
        rm: (x: string) => { if (x === zshrc) throw refused('EBUSY'); rmSync(x, { force: true }) }, // and the half file stays
        writeFile: (x: string, c: string) => { if (x === zshrc) { writeFileSync(x, c.slice(0, 7)); throw refused('ENOSPC') } writeFileSync(x, c) },
      }
      expect(await ensure(file, failing)).toBeNull()
      expect(state[file.name]).toBeUndefined() // the record goes with the failure
      expect(await ensure(file)).toBe(p)
      for (const f of set) expect(readFileSync(f.path, 'utf8'), f.path).toBe(f.content)
      expect(state[file.name]).toBe(p)
    })

    it(`${name}: a recorded file found cut short since (not the size written) is written again before it is used, even with renames refused`, async () => {
      const { INTEGRATION_FILES } = await import('../../src/main/shellIntegration')
      const file = INTEGRATION_FILES.cmd
      const target = join(H.userData, file.name)
      expect(await ensure(file)).toBe(target)
      expect(state[file.name]).toBe(target)
      writeFileSync(target, file.content.slice(0, 12)) // cut short behind Termpolis's back
      expect(await ensure(file)).toBe(target)
      expect(readFileSync(target, 'utf8')).toBe(file.content)
      writeFileSync(target, file.content.slice(0, 12))
      expect(await ensure(file, { rename: () => { throw refused('EBUSY') }, sleep: () => {} })).toBe(target) // not kept: written directly
      expect(readFileSync(target, 'utf8')).toBe(file.content)
      expect(state[file.name]).toBe(target)
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
    await (await import('../../src/main/terminalSpawnPrep')).integrationTempSweep() // the planted leftover is gone
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

// Fix round 4 (I1). The direct write on a fresh install truncates and then writes, so it is only safe if nothing reads
// or writes that file meanwhile. Every spawn takes the file's integration lock: one arriving mid-write waits for it and
// counts the file present only once the write has finished, and the synchronous fallback, which cannot wait, opens
// without integration while the lock is held. Interleavings are forced with deferred promises, never with sleeps.
describe('no spawn reads an integration file mid-write', () => {
  const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
  /** Lets the event loop (and the thread pool) turn up to `turns` times; true once `p` has settled. Not a timer. */
  const settlesWithin = async (p: Promise<unknown>, turns = 400): Promise<boolean> => {
    let settled = false
    void p.then(() => { settled = true }, () => { settled = true })
    for (let i = 0; i < turns && !settled; i++) await new Promise((r) => setImmediate(r))
    return settled
  }
  const ps = async () => (await import('../../src/main/shellIntegration')).INTEGRATION_FILES.powershell

  /** A scanner that refuses every rename, and a direct write of the target that stops halfway until `gate` opens. */
  const slowFreshInstall = (target: string, gate: Promise<void>, onDirect: () => void, done: () => void = () => {}) => ({
    rename: () => { throw refused('EPERM') },
    sleep: () => {},
    writeFile: async (p: string, c: string) => {
      if (p !== target) { writeFileSync(p, c); return }
      writeFileSync(p, c.slice(0, 10)) // truncated, then a first part: what a reader mid-write would see
      onDirect()
      await gate
      writeFileSync(p, c)
      done()
    },
  })

  it('a spawn arriving during a slow direct write waits for it, never sees the half-written file and never counts it present early', async () => {
    const file = await ps()
    const target = scriptFile()
    rmSync(target, { force: true })
    const gate = deferred()
    const direct = deferred()
    const a = ensureIntegrationScriptAsync(file, slowFreshInstall(target, gate.promise, direct.resolve))
    await direct.promise
    expect(readFileSync(target, 'utf8')).toBe(file.content.slice(0, 10)) // A is mid-write now
    const bCalls: string[] = []
    const b = ensureIntegrationScriptAsync(file, {
      rename: (x) => { bCalls.push(`rename ${x}`); throw refused('EPERM') },
      writeFile: (x, c) => { bCalls.push(`write ${x}`); writeFileSync(x, c) },
      sleep: () => {},
    }).then((r) => ({ r, seen: readFileSync(target, 'utf8') }))
    expect(await settlesWithin(b)).toBe(false)
    expect(state[file.name]).toBeUndefined() // not present until the write has finished
    expect(bCalls).toEqual([])
    gate.resolve()
    expect(await a).toBe(target)
    expect(await b).toEqual({ r: target, seen: file.content })
    expect(bCalls).toEqual([]) // it found A's finished file and wrote nothing
    expect(state[file.name]).toBe(target)
  })

  it('two concurrent fallbacks on a fresh install never write the file at the same time: the second finds the first one finished', async () => {
    const file = await ps()
    const target = scriptFile()
    rmSync(target, { force: true })
    let active = 0
    let maxActive = 0
    let directs = 0
    const gate = deferred()
    const firstDirect = deferred()
    const io = () => slowFreshInstall(target, gate.promise, () => { directs++; active++; maxActive = Math.max(maxActive, active); firstDirect.resolve() }, () => { active-- })
    const seen = (p: Promise<string | null>) => p.then((r) => ({ r, seen: readFileSync(target, 'utf8') }))
    const a = seen(ensureIntegrationScriptAsync(file, io()))
    const b = seen(ensureIntegrationScriptAsync(file, io()))
    await firstDirect.promise
    expect(await settlesWithin(b)).toBe(false)
    expect(directs).toBe(1)
    gate.resolve()
    expect(await a).toEqual({ r: target, seen: file.content })
    expect(await b).toEqual({ r: target, seen: file.content })
    expect(maxActive).toBe(1)
    expect(directs).toBe(1)
    expect(readdirSync(H.userData).filter((n) => n.startsWith(`${file.name}.`))).toEqual([])
  })

  it('a rename cannot land during a direct write: the other spawn renames nothing until it is done, and then needs nothing', async () => {
    const file = await ps()
    const target = scriptFile()
    rmSync(target, { force: true })
    const gate = deferred()
    const direct = deferred()
    const a = ensureIntegrationScriptAsync(file, slowFreshInstall(target, gate.promise, direct.resolve))
    await direct.promise
    const renames: string[] = []
    const b = ensureIntegrationScriptAsync(file, { rename: (x, y) => { renames.push(x); renameSync(x, y) } })
    expect(await settlesWithin(b)).toBe(false)
    expect(renames).toEqual([])
    gate.resolve()
    expect(await a).toBe(target)
    expect(await b).toBe(target)
    expect(renames).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe(file.content)
  })

  it('the synchronous fallback never runs while a prepare holds the file: it opens that terminal without integration, and touches nothing', async () => {
    const file = await ps()
    const target = scriptFile()
    rmSync(target, { force: true })
    const gate = deferred()
    const writing = deferred()
    const a = ensureIntegrationScriptAsync(file, { writeFile: async (p, c) => { writing.resolve(); await gate.promise; writeFileSync(p, c) } })
    await writing.promise // A's temp file is being written on the thread pool
    const calls: string[] = []
    const record = { writeFile: (p: string) => { calls.push(p) }, rename: (p: string) => { calls.push(p) }, rm: (p: string) => { calls.push(p) }, exists: () => { calls.push('exists'); return false }, sleep: () => {} }
    expect(ensureIntegrationScript(file, record)).toBeNull()
    expect(calls).toEqual([])
    expect(state[file.name]).toBeUndefined()
    gate.resolve()
    expect(await a).toBe(target)
    expect(ensureIntegrationScript(file, record)).toBe(target) // free again, and present: nothing written
    expect(calls).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe(file.content)
  })

  for (const [name, ensure] of [
    ['async (prepareSpawn)', (f: IntegrationFile, io: object) => ensureIntegrationScriptAsync(f, io)],
    ['sync (the fallback)', async (f: IntegrationFile, io: object) => ensureIntegrationScript(f, io)],
  ] as const) {
    it(`${name}: a temp write refused with EPERM over an old file is not logged as a refused rename and is not a keep: no script for this spawn`, async () => {
      const { INTEGRATION_FILES } = await import('../../src/main/shellIntegration')
      const file = INTEGRATION_FILES.cmd
      const target = join(H.userData, file.name)
      writeFileSync(target, 'an old release')
      let renames = 0
      const io = { writeFile: () => { throw Object.assign(new Error('EPERM: open'), { code: 'EPERM' }) }, rename: () => { renames++ }, sleep: () => {} }
      expect(await ensure(file, io)).toBeNull()
      expect(renames).toBe(0)
      expect(state[file.name]).toBeUndefined()
      expect(readFileSync(target, 'utf8')).toBe('an old release')
      expect(readAppLog(5000).filter((e) => e.msg.includes(target) && e.msg.includes('could not be replaced'))).toEqual([])
    })
  }
})

// Fix round 5. The lock must not turn one stuck write into a queue every later terminal of that shell waits in. Only the
// WAIT is limited: a spawn queued behind another prepare for longer than INTEGRATION_WAIT_MS opens without integration,
// and the lock stays held until the stuck write settles, so nothing writes beside it. Timers are vitest's fake clock and
// the writes are gated by deferred promises; nothing sleeps.
describe('a write that never settles does not hold up later spawns', () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
  const settlesWithin = async (p: Promise<unknown>, turns = 400): Promise<boolean> => {
    let settled = false
    void p.then(() => { settled = true }, () => { settled = true })
    for (let i = 0; i < turns && !settled; i++) await new Promise((r) => setImmediate(r))
    return settled
  }
  const turn = () => new Promise((r) => setImmediate(r))
  const files = async () => (await import('../../src/main/shellIntegration')).INTEGRATION_FILES
  const lockApi = async () => {
    const m = await import('../../src/main/terminalSpawnPrep')
    return { WAIT: m.INTEGRATION_WAIT_MS, HOLD: (m as { INTEGRATION_HOLD_MS?: number }).INTEGRATION_HOLD_MS, busy: m.integrationFileBusy, underLock: m.underIntegrationLock }
  }
  /** Every file call a spawn makes through its io, so a test can say "this one touched nothing". */
  const recording = (calls: string[]) => ({
    writeFile: (p: string, c: string) => { calls.push(`write ${p}`); writeFileSync(p, c) },
    rename: (a: string, b: string) => { calls.push(`rename ${a}`); renameSync(a, b) },
    rm: (p: string) => { calls.push(`rm ${p}`); rmSync(p, { force: true }) },
    exists: (p: string) => { calls.push(`exists ${p}`); return existsSync(p) },
    sleep: () => {},
  })

  it('waits at most INTEGRATION_WAIT_MS behind a stuck write, then opens without integration; the lock stays held, and once the write lands the next spawn works normally', async () => {
    const { WAIT, busy } = await lockApi()
    expect(WAIT).toBeGreaterThanOrEqual(3_000)
    expect(WAIT).toBeLessThanOrEqual(5_000)
    const file = (await files()).powershell
    const target = scriptFile()
    rmSync(target, { force: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stuck = deferred()
      const writing = deferred()
      const a = ensureIntegrationScriptAsync(file, { writeFile: async (p, c) => { writing.resolve(); await stuck.promise; writeFileSync(p, c) } })
      await writing.promise // A's temp write is on the thread pool, and will not come back until the test says so
      expect(vi.getTimerCount()).toBe(1) // A waited for nothing (no wait timer on a free lock): only its own hold cap (#44)
      const bCalls: string[] = []
      const b = ensureIntegrationScriptAsync(file, recording(bCalls))
      vi.advanceTimersByTime(WAIT - 1_000)
      const cCalls: string[] = []
      const c = ensureIntegrationScriptAsync(file, recording(cCalls)) // queued before B gives up
      vi.advanceTimersByTime(999)
      expect(await settlesWithin(b)).toBe(false)
      vi.advanceTimersByTime(1)
      expect(await b).toBeNull() // waited exactly INTEGRATION_WAIT_MS: this terminal opens without integration
      expect(bCalls).toEqual([])
      expect(busy(file.name)).toBe(true) // not freed on timeout: the stuck write may still land
      // While it is stuck, a later spawn does not wait the whole limit again: it opens without integration at once, with no timer.
      const dCalls: string[] = []
      const d = ensureIntegrationScriptAsync(file, recording(dCalls))
      expect(await settlesWithin(d, 3)).toBe(true)
      expect(await d).toBeNull()
      expect(vi.getTimerCount()).toBe(2) // only C's wait, and A's hold cap
      expect(ensureIntegrationScript(file, recording(dCalls))).toBeNull() // the sync fallback too
      expect(dCalls).toEqual([])
      expect(await settlesWithin(c)).toBe(false)
      stuck.resolve() // the stuck write lands at last
      expect(await a).toBe(target)
      expect(await c).toBe(target) // C was still in its wait: it runs now, normally, and needs to write nothing
      expect(cCalls).toEqual([])
      expect(vi.getTimerCount()).toBe(0) // C's wait timer was cleared when its turn came, and each hold cap as its job settled
      await turn()
      expect(busy(file.name)).toBe(false)
      const eCalls: string[] = []
      expect(await ensureIntegrationScriptAsync(file, recording(eCalls))).toBe(target) // the next spawn: normal
      expect(eCalls).toEqual([])
      expect(readFileSync(target, 'utf8')).toBe(file.content)
      expect(state[file.name]).toBe(target)
    } finally {
      vi.useRealTimers()
    }
  })

  // #44. The wait above limits only the spawns queued behind a stuck write; the spawn whose own write is stuck would
  // wait for ever, so its terminal never opened. It has its own, longer cap (a first PowerShell under a cloud scan must
  // still get its integration): past it, that terminal opens without integration, and the lock is still held.
  it('a prepare whose own write never settles answers null after INTEGRATION_HOLD_MS; later spawns answer null at once; once it lands, the next spawn is normal', async () => {
    const { HOLD, WAIT, busy } = await lockApi()
    expect(HOLD).toBe(15_000)
    expect(HOLD!).toBeGreaterThan(WAIT)
    const file = (await files()).powershell
    const target = scriptFile()
    rmSync(target, { force: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stuck = deferred()
      const writing = deferred()
      const a = ensureIntegrationScriptAsync(file, { writeFile: async (p, c) => { writing.resolve(); await stuck.promise; writeFileSync(p, c) } })
      await writing.promise
      expect(vi.getTimerCount()).toBe(1) // its hold cap, started when its job did
      vi.advanceTimersByTime(HOLD! - 1)
      expect(await settlesWithin(a)).toBe(false)
      vi.advanceTimersByTime(1)
      expect(await settlesWithin(a)).toBe(true)
      expect(await a).toBeNull() // this terminal opens without integration
      expect(busy(file.name)).toBe(true) // not freed: the stuck write may still land, and nothing may write beside it
      const dCalls: string[] = []
      const d = ensureIntegrationScriptAsync(file, recording(dCalls))
      expect(await settlesWithin(d, 3)).toBe(true)
      expect(await d).toBeNull() // no wait behind a write known stuck
      expect(ensureIntegrationScript(file, recording(dCalls))).toBeNull()
      expect(dCalls).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      stuck.resolve() // it lands at last, whole
      for (const end = Date.now() + 10_000; busy(file.name) && Date.now() < end;) await turn() // its rename is real file IO
      expect(busy(file.name)).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe(file.content)
      const eCalls: string[] = []
      expect(await ensureIntegrationScriptAsync(file, recording(eCalls))).toBe(target) // the next spawn: normal
      expect(eCalls).toEqual([])
      expect(vi.getTimerCount()).toBe(0) // its hold cap went with its job
    } finally {
      vi.useRealTimers()
    }
  })

  it('a job that settles in time clears its hold cap: no timer is left behind, and its answer is its own', async () => {
    const { underLock, busy } = await lockApi()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const gate = deferred()
      const a = underLock('hold-clears', async () => { await gate.promise; return 'a' }, null)
      await turn()
      expect(vi.getTimerCount()).toBe(1)
      gate.resolve()
      expect(await a).toBe('a')
      await turn()
      expect(vi.getTimerCount()).toBe(0)
      expect(busy('hold-clears')).toBe(false)
      // A job that rejects in time rejects its own caller, and clears its cap too.
      await expect(underLock('hold-clears', async () => { throw new Error('boom') }, null)).rejects.toThrow('boom')
      await turn()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a job that rejects after its hold cap answered null leaves nothing unhandled, and frees the lock', async () => {
    const { HOLD, underLock, busy } = await lockApi()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const gate = deferred()
      const a = underLock('hold-late-reject', async () => { await gate.promise; throw new Error('late') }, null)
      await turn()
      vi.advanceTimersByTime(HOLD!)
      expect(await settlesWithin(a)).toBe(true)
      expect(await a).toBeNull()
      gate.resolve()
      await turn()
      await turn()
      expect(busy('hold-late-reject')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // #73 pins. A waiter that gave up is dropped: its job never runs, even after the stuck job ahead of it settles.
  it('a waiter that gave up never runs its job, even once the stuck job ahead of it settles', async () => {
    const { WAIT, underLock, busy } = await lockApi()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stuck = deferred()
      const a = underLock('pin-gave-up', async () => { await stuck.promise; return 'a' }, null)
      const bJob = vi.fn(async () => 'b')
      const b = underLock('pin-gave-up', bJob, null)
      vi.advanceTimersByTime(WAIT)
      expect(await b).toBeNull()
      stuck.resolve()
      expect(await a).toBe('a')
      await turn()
      await turn()
      expect(bJob).not.toHaveBeenCalled()
      expect(busy('pin-gave-up')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // The stall is cleared by the next turn of the queue: a spawn arriving while a waiter queued earlier runs its (slow)
  // job waits its turn like any other, rather than answer null at once as if the old stuck write were still running.
  it('once the stuck job settles, the stall is over: a spawn arriving during the next job queues behind it', async () => {
    const { WAIT, underLock } = await lockApi()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const name = 'pin-stall-reset'
      const stuck = deferred()
      const a = underLock(name, async () => { await stuck.promise; return 'a' }, null)
      const b = underLock(name, async () => 'b', null)
      vi.advanceTimersByTime(WAIT - 1_000)
      const cGate = deferred()
      const cStarted = deferred()
      const c = underLock(name, async () => { cStarted.resolve(); await cGate.promise; return 'c' }, null)
      vi.advanceTimersByTime(1_000)
      expect(await b).toBeNull() // B gave up: stalled
      stuck.resolve()
      expect(await a).toBe('a')
      await cStarted.promise // C's turn came (B's was skipped)
      const d = underLock(name, async () => 'd', null)
      expect(await settlesWithin(d, 5)).toBe(false) // queued behind C, not turned away
      cGate.resolve()
      expect(await c).toBe('c')
      expect(await d).toBe('d')
    } finally {
      vi.useRealTimers()
    }
  })

  // Timers without unref (a host whose setTimeout answers a number): the lock still works, and no spawn rejects.
  it('works where setTimeout answers a plain number with no unref', async () => {
    const { underLock } = await lockApi()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => 7) as never)
    try {
      const a = underLock('pin-no-unref', async () => 'a', null)
      const b = underLock('pin-no-unref', async () => 'b', null)
      await expect(a).resolves.toBe('a')
      await expect(b).resolves.toBe('b')
    } finally {
      spy.mockRestore()
    }
  })

  it('the stuck write landing late overlaps no other write of that file: nothing writes it until it settles, and then only one at a time', async () => {
    const { WAIT, busy } = await lockApi()
    const file = (await files()).powershell
    const target = scriptFile()
    rmSync(target, { force: true })
    let active = 0
    let maxActive = 0
    const writes: string[] = []
    const stuck = deferred()
    const direct = deferred()
    const refused = (code: string) => Object.assign(new Error(code), { code })
    const tracked = (who: string, gate?: Promise<void>) => ({
      // A: a scanner refuses every rename, so a fresh install falls through to the direct write. The others rename normally.
      rename: (x: string, y: string) => { if (gate) throw refused('EPERM'); writes.push(`${who} rename`); renameSync(x, y) },
      sleep: () => {},
      writeFile: async (p: string, c: string) => {
        active++
        maxActive = Math.max(maxActive, active)
        writes.push(`${who} ${p === target ? 'direct' : 'temp'}`)
        try {
          if (p === target && gate) { writeFileSync(p, c.slice(0, 10)); direct.resolve(); await gate; throw refused('EIO') } // half written, then it fails
          writeFileSync(p, c)
        } finally { active-- }
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const a = ensureIntegrationScriptAsync(file, tracked('A', stuck.promise))
      await direct.promise
      const b = ensureIntegrationScriptAsync(file, tracked('B'))
      vi.advanceTimersByTime(WAIT)
      expect(await b).toBeNull()
      const c = ensureIntegrationScriptAsync(file, tracked('C'))
      expect(await c).toBeNull()
      expect(ensureIntegrationScript(file, tracked('S') as never)).toBeNull()
      expect(writes.filter((w) => !w.startsWith('A'))).toEqual([]) // nobody wrote beside the stuck write
      stuck.resolve()
      expect(await a).toBeNull() // it failed in the end: nothing recorded, so the next spawn writes again
      expect(state[file.name]).toBeUndefined()
      await turn()
      expect(busy(file.name)).toBe(false)
      const before = writes.length
      const e = ensureIntegrationScriptAsync(file, tracked('E'))
      const f = ensureIntegrationScriptAsync(file, tracked('F'))
      expect(await e).toBe(target)
      expect(await f).toBe(target)
      expect(writes.slice(before).every((w) => w.startsWith('E'))).toBe(true) // F found E's finished file
      expect(maxActive).toBe(1)
      expect(readFileSync(target, 'utf8')).toBe(file.content)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a job that rejects does not poison the lock: the next job still runs, the lock is freed, and nothing is left unhandled', async () => {
    const { busy, underLock } = await lockApi()
    const name = 'round5-reject'
    const ran: string[] = []
    const first = underLock(name, async () => { ran.push('first'); throw new Error('boom') }, null)
    const second = underLock(name, async () => { ran.push('second'); return 'second ran' }, null)
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe('second ran')
    expect(ran).toEqual(['first', 'second'])
    await turn()
    expect(busy(name)).toBe(false)
    // Alone, a rejecting job frees the lock as well.
    await expect(underLock(name, async () => { throw new Error('alone') }, null)).rejects.toThrow('alone')
    await turn()
    expect(busy(name)).toBe(false)
    expect(await underLock(name, async () => 'after', null)).toBe('after')
  })

  it('a job queued right behind one that recorded the file does not check it again; a prepare on a free lock still does', async () => {
    const fs = await import('fs')
    const file = (await files()).powershell
    expect(await ensureIntegrationScriptAsync(file)).toBe(scriptFile()) // recorded and present
    const access = vi.spyOn(fs.promises, 'stat') // the check: each file there, and the size written (#28)
    try {
      const answers = await Promise.all(Array.from({ length: 6 }, () => ensureIntegrationScriptAsync(file)))
      expect(answers.every((x) => x === scriptFile())).toBe(true)
      expect(access).toHaveBeenCalledTimes(1) // the first checked; the five queued behind it took its word
      await turn()
      expect(await ensureIntegrationScriptAsync(file)).toBe(scriptFile())
      expect(access).toHaveBeenCalledTimes(2) // alone, on a free lock: checked again (it may have been cleaned up)
      // Behind a job that did not record the file (it failed), the next one checks for itself.
      const failing = { writeFile: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } }
      rmSync(scriptFile(), { force: true })
      const [x, y] = await Promise.all([ensureIntegrationScriptAsync(file, failing), ensureIntegrationScriptAsync(file)])
      expect(x).toBeNull() // checked (1), found it gone, failed to write, and dropped the record (#28)
      expect(y).toBe(scriptFile()) // no record and no word from x: wrote it, with nothing to check
      expect(access).toHaveBeenCalledTimes(3)
      expect(readFileSync(scriptFile(), 'utf8')).toBe(file.content)
    } finally {
      access.mockRestore()
    }
  })

  it('a prepare that answered null frees the lock: the synchronous fallback is not turned away and writes the file', async () => {
    const { busy } = await lockApi()
    const file = (await files()).cmd
    const target = join(H.userData, file.name)
    rmSync(target, { force: true })
    expect(await ensureIntegrationScriptAsync(file, { writeFile: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })).toBeNull()
    expect(busy(file.name)).toBe(false)
    expect(ensureIntegrationScript(file)).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(file.content)
  })
})

// M3. A temp file the scanner still held could not be removed when its write gave up; the first prepare of a run sweeps
// such leftovers, and only those: our own temp names beside an integration file, older than a minute.
describe('leftover temp files are swept', () => {
  it('removes only our stale temp names, in the integration folders, and leaves fresh ones, other files and what it cannot remove', async () => {
    const { sweepStaleIntegrationTemps, STALE_TEMP_MS } = await import('../../src/main/terminalSpawnPrep')
    const root = mkdtempSync(join(H.root, 'sweep-'))
    mkdirSync(join(root, 'termpolis-zsh'))
    const now = Date.now()
    const put = (rel: string, ageMs: number, dir = false): string => {
      const p = join(root, rel)
      if (dir) mkdirSync(p); else writeFileSync(p, 'x')
      const t = new Date(now - ageMs)
      utimesSync(p, t, t)
      return p
    }
    const old = STALE_TEMP_MS + 60_000
    const gone = [
      put('termpolis-shell-integration.ps1.1234.7.k3j9zq.tmp', old),
      put('termpolis-lumopolis.doskey.99.1.a.tmp', old),
      put('termpolis-integration.fish.5.12.abc123.tmp', old),
      put(join('termpolis-zsh', '.zshenv.42.3.x1y2z3.tmp'), old),
      put(join('termpolis-zsh', '.zlogin.42.4..tmp'), old),
    ]
    const kept = [
      put('termpolis-shell-integration.ps1', old), // the file itself
      put('termpolis-shell-integration.ps1.1234.8.fresh1.tmp', STALE_TEMP_MS - 5_000), // a write in flight
      put('termpolis-shell-integration.ps1.tmp', old), // not our pattern
      put('termpolis-shell-integration.ps1.12x4.1.abc.tmp', old),
      put('termpolis-shell-integration.ps1.1.2.toolongname.tmp', old),
      put('someone-else.ps1.1234.7.k3j9zq.tmp', old), // not an integration file
      put('.zshenv.42.3.x1y2z3.tmp', old), // a zsh name, but outside the zsh folder
      put(join('termpolis-zsh', 'termpolis-integration.fish.1.1.a.tmp'), old), // a fish name, but in the zsh folder
      put('termpolis-integration.fish.7.7.held.tmp', old, true), // cannot be removed: left for the next run
    ]
    expect((await sweepStaleIntegrationTemps(root, now)).sort()).toEqual([...gone].sort())
    for (const p of gone) expect(existsSync(p), p).toBe(false)
    for (const p of kept) expect(existsSync(p), p).toBe(true)
    expect(await sweepStaleIntegrationTemps(join(root, 'not made yet'), now)).toEqual([]) // no folders: nothing, no throw
  })

  it('a folder listing that is not a list skips that folder, and the sweep still resolves with what the other folders gave', async () => {
    const { sweepStaleIntegrationTemps, STALE_TEMP_MS } = await import('../../src/main/terminalSpawnPrep')
    const fs = require('fs') as typeof import('fs')
    const root = mkdtempSync(join(H.root, 'sweep-odd-'))
    mkdirSync(join(root, 'termpolis-zsh'))
    const now = Date.now()
    const stale = join(root, 'termpolis-zsh', '.zshenv.42.3.x1y2z3.tmp')
    writeFileSync(stale, 'x')
    const t = new Date(now - STALE_TEMP_MS - 60_000)
    utimesSync(stale, t, t)
    const real = fs.promises.readdir
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: string, ...rest: unknown[]) =>
      dir === root ? Promise.resolve(undefined) : (real as (...a: unknown[]) => unknown)(dir, ...rest)) as typeof fs.promises.readdir)
    try {
      expect(await sweepStaleIntegrationTemps(root, now)).toEqual([stale])
    } finally { spy.mockRestore() }
    expect(existsSync(stale)).toBe(false)
  })

  it('entries of a folder listing that are not names are skipped, and the sweep still resolves with what the rest gave', async () => {
    const { sweepStaleIntegrationTemps, STALE_TEMP_MS } = await import('../../src/main/terminalSpawnPrep')
    const fs = require('fs') as typeof import('fs')
    const root = mkdtempSync(join(H.root, 'sweep-odd-names-'))
    mkdirSync(join(root, 'termpolis-zsh'))
    const now = Date.now()
    const stale = join(root, 'termpolis-zsh', '.zshenv.42.3.x1y2z3.tmp')
    writeFileSync(stale, 'x')
    const t = new Date(now - STALE_TEMP_MS - 60_000)
    utimesSync(stale, t, t)
    const real = fs.promises.readdir
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: string, ...rest: unknown[]) =>
      dir === root ? Promise.resolve([undefined, {}]) : (real as (...a: unknown[]) => unknown)(dir, ...rest)) as typeof fs.promises.readdir)
    try {
      expect(await sweepStaleIntegrationTemps(root, now)).toEqual([stale])
    } finally { spy.mockRestore() }
    expect(existsSync(stale)).toBe(false)
  })

  it('the first prepare of the run starts the sweep of the data folder, once', async () => {
    const { integrationTempSweep } = await import('../../src/main/terminalSpawnPrep')
    const sweep = integrationTempSweep()
    expect(sweep).toBeDefined() // started by the first prepare in this file, before this test
    expect(await sweep).toContain(H.plantedTemp)
    expect(existsSync(H.plantedTemp)).toBe(false)
    await prepareSpawn(process.cwd(), PS)
    expect(integrationTempSweep()).toBe(sweep)
  })
})
