// sessionStore: the renderer saves its session after every change to its state, and the MCP list_terminals tool (called
// constantly by a swarm) used to read the whole file again each time. The file is read once now, kept in memory, and
// written on the thread pool at most once per half second. Counters only.
// IMPORT ORDER: the counters first (they patch fs before the module under test loads).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const H = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => H.dir, getVersion: () => '9.9.9' } }))

type Mod = typeof import('../../src/main/sessionStore')
let mod: Mod
let files: typeof import('../../src/main/offMainFiles').offMainFiles
const file = (): string => path.join(H.dir, 'session.json')

beforeEach(async () => {
  H.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  vi.resetModules()
  mod = await import('../../src/main/sessionStore')
  files = (await import('../../src/main/offMainFiles')).offMainFiles
})
afterEach(async () => {
  await files.idle()
  try { fs.rmSync(H.dir, { recursive: true, force: true }) } catch { /* best effort */ }
})
afterAll(() => { uninstall() })

const session = (names: string[]) => ({
  terminals: names.map((name, i) => ({ id: `t${i}`, name, color: '#888', shellType: 'bash', cwd: '/repo', fontSize: 12, theme: 'default', fontFamily: 'monospace' })),
  workspaces: [],
  defaultShell: 'bash',
  viewMode: 'grid', // an old value the loader migrates
})

describe('sessionStore', () => {
  it('saving 200 times and listing 200 times costs no synchronous call on the main thread (counted)', async () => {
    mod.loadSession() // start-up: the one read of the file (absent here)
    arm()
    for (let i = 0; i < 200; i++) {
      mod.saveSession(session([`a${i}`]) as never)
      mod.loadSession()
    }
    expect(describeCounts(disarm())).toBe('')
  })

  it('loadSession answers what a load of the saved file would: normalised, migrated, with the defaults filled in', async () => {
    mod.saveSession(session(['one']) as never)
    const s = mod.loadSession()
    expect(s.viewMode).toBe('split') // 'grid' migrates
    expect(s.terminals).toHaveLength(1)
    expect(s.terminals[0].name).toBe('one')
    expect((s as { appVersion?: string }).appVersion).toBe('9.9.9')
    await files.idle()
    // ...and the file on disk, read the old way by a fresh module, says the same.
    vi.resetModules()
    const fresh = await import('../../src/main/sessionStore')
    expect(fresh.loadSession()).toEqual(s)
  })

  it('the write is coalesced: a burst of saves is one file write holding the LAST session', async () => {
    mod.loadSession()
    const before = files.stats().writes
    for (let i = 0; i < 50; i++) mod.saveSession(session([`burst${i}`]) as never)
    await files.idle()
    expect(files.stats().writes - before).toBe(1)
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).terminals[0].name).toBe('burst49')
  })

  it('what loadSession hands out is a copy: a caller that changes it cannot change what the next one sees', async () => {
    mod.saveSession(session(['x']) as never)
    const a = mod.loadSession()
    a.terminals[0].name = 'tampered'
    a.terminals.length = 0
    expect(mod.loadSession().terminals[0].name).toBe('x')
  })

  it('a missing file is the default session, and a damaged one is too', async () => {
    expect(mod.loadSession().terminals).toEqual([])
    vi.resetModules()
    fs.writeFileSync(file(), '{ not json')
    const fresh = await import('../../src/main/sessionStore')
    expect(fresh.loadSession().terminals).toEqual([])
    expect(fresh.loadRestoreSession().terminals).toEqual([])
  })

  it('reads a saved file once, at start-up, and answers every later call from memory', async () => {
    fs.writeFileSync(file(), JSON.stringify(session(['saved'])))
    arm()
    const first = mod.loadSession() // the one read
    const afterFirst = disarm()
    expect(afterFirst.sync.readFileSync).toBe(1)
    arm()
    for (let i = 0; i < 100; i++) mod.loadSession()
    expect(describeCounts(disarm())).toBe('')
    expect(first.terminals[0].name).toBe('saved')
  })
})
