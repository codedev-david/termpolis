import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  realpath as realpathCallback,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, parse, resolve } from 'path'
import { promisify } from 'util'

// homedir() is where the picker opens, and the one place it lists the drives. To
// test that we make home a fixture tree we control instead of the machine running
// the suite. We do NOT mock the `os` module: vitest externalises Node builtins
// from Vite's module graph, so vi.mock('os') never reaches the SUT's
// `import { homedir } from 'os'` -- it keeps the real require('os'). Instead we
// drive the REAL homedir(): libuv reads USERPROFILE (Windows) / HOME (POSIX)
// before falling back to the passwd db, so setting those points the genuine
// os.homedir() at our fixture, and one test can point it at a path that does
// not exist to prove home falls back cleanly.
//
// The drives and, where a test must see exactly which paths were touched, the
// filesystem itself come in through the picker's own `deps` seam -- the same
// reason: vi.mock('fs') would not reach it either.

/** Home as created, and canonical -- every path the picker returns is
 *  realpath'd, so the fixture compares against the canonical form. A folder
 *  OUTSIDE home stands in for one on another drive. Real filesystem, because
 *  junction resolution and de-duplication must behave the way the OS actually
 *  resolves them. */
let HOME_RAW = ''
let ROOT = ''
let OUTSIDE = ''
let escapeLinked = false
let brokenLinked = false
let aliasLinked = false
let savedUserProfile: string | undefined
let savedHome: string | undefined

function pointHomeAt(path: string): void {
  process.env.USERPROFILE = path
  process.env.HOME = path
}

import {
  isNetworkOrDevicePath,
  listDirectory,
  MAX_PICKER_ENTRIES,
  type PickerDirent,
  type PickerFs,
} from '../../src/main/remoteBridge/directoryPicker'
import { DRIVE_PROBE_TIMEOUT_MS } from '../../src/main/remoteBridge/driveRoots'
import { MAX_PAYLOAD_BYTES } from '../../src/main/remoteBridge/outputChunker'

/** No drives, for the tests that are about folders. The drive rows have their own. */
const NO_DRIVES = { driveRoots: async (): Promise<string[]> => [] }

/** Independent of the SUT's own predicate on purpose: a test that asked the code
 *  under test what counts as a network path could never catch it being wrong. */
const NETWORK_OR_DEVICE = /^[\\/]{2}/

/** The bytes the bridge would put on the wire for this listing -- the same
 *  `{kind,id,data}` envelope relayClient encodes, with the widest id it can carry. */
function wireBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify({ kind: 'ok', id: Number.MAX_SAFE_INTEGER, data }))
}

/** The folders home is expected to offer, in order: alpha and beta always; the
 *  junction out to OUTSIDE wherever the OS let the fixture make one. The
 *  junction onto beta (`alias`) and the dangling one (`broken`) never appear. */
function homeFolders(): Array<{ name: string; path: string }> {
  return [
    { name: 'alpha', path: join(ROOT, 'alpha') },
    { name: 'beta', path: join(ROOT, 'beta') },
    ...(escapeLinked ? [{ name: 'escape', path: OUTSIDE }] : []),
  ]
}

const dirent = (name: string, kind: 'dir' | 'link' | 'file'): PickerDirent => ({
  name,
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
})

/** The real filesystem, with every path it is asked about written down -- and a
 *  network or device path refused right here, without ever reaching the OS. A
 *  regression in the picker then fails the assertion that reads `touched`,
 *  instead of making the machine running the suite reach out to a host. */
function recordingFs(): { fs: PickerFs; touched: string[] } {
  const touched: string[] = []
  const realpathJs = promisify(realpathCallback)
  const note = (path: string): void => {
    touched.push(path)
    if (NETWORK_OR_DEVICE.test(path)) throw Object.assign(new Error(`refused in test: ${path}`), { code: 'ENOENT' })
  }
  return {
    touched,
    fs: {
      realpath: async (path) => { note(path); return realpathJs(path) },
      stat: async (path) => { note(path); return fsp.stat(path) },
      readdir: async (path) => { note(path); return fsp.readdir(path, { withFileTypes: true }) },
    },
  }
}

beforeAll(() => {
  savedUserProfile = process.env.USERPROFILE
  savedHome = process.env.HOME

  HOME_RAW = mkdtempSync(join(tmpdir(), 'tp-picker-home-'))
  // realpath once: on Windows a temp dir can carry an 8.3 short name, and every
  // path the picker returns is realpath'd, so the fixture compares against the
  // canonical form or nothing lines up.
  ROOT = realpathSync(HOME_RAW)
  OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'tp-picker-out-')))
  pointHomeAt(ROOT)

  mkdirSync(join(ROOT, 'alpha'))
  mkdirSync(join(ROOT, 'alpha', 'sub'))
  mkdirSync(join(ROOT, 'beta'))
  mkdirSync(join(OUTSIDE, 'projects'))
  // A plain file at the top level: it must be filtered out, since the picker
  // offers folders only.
  writeFileSync(join(ROOT, 'readme.txt'), 'not a folder')

  // A junction that points OUT of home, the way a user links D:\projects into
  // their profile. 'junction' rather than 'symlink' so Windows needs no admin.
  try {
    symlinkSync(OUTSIDE, join(ROOT, 'escape'), 'junction')
    escapeLinked = true
  } catch {
    escapeLinked = false
  }

  // A junction to a directory that no longer exists. readdir lists it; realpath
  // THROWS; it must be skipped and the level kept browsable.
  try {
    const doomed = mkdtempSync(join(tmpdir(), 'tp-picker-doomed-'))
    symlinkSync(doomed, join(ROOT, 'broken'), 'junction')
    rmSync(doomed, { recursive: true, force: true })
    brokenLinked = true
  } catch {
    brokenLinked = false
  }

  // A junction onto a sibling -- the shape of Windows' own `My Documents` ->
  // `Documents` in every profile. Two rows for one folder is one `path` twice,
  // and the phone keys its rows by `path`.
  try {
    symlinkSync(join(ROOT, 'beta'), join(ROOT, 'alias'), 'junction')
    aliasLinked = true
  } catch {
    aliasLinked = false
  }
})

afterAll(() => {
  // Restore the machine's real home first, THEN clean the fixtures.
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome

  rmSync(HOME_RAW, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

beforeEach(() => {
  pointHomeAt(ROOT)
})

describe('listDirectory — home, where the picker opens', () => {
  it('opens at home with no parent: the drive roots first, then home\'s subfolders sorted', async () => {
    const listing = await listDirectory(undefined, { driveRoots: async () => ['C:\\', 'D:\\'] })
    expect(listing.path).toBe(ROOT)
    // null parent is how the phone knows to hide its ".." row: home is the top,
    // and the way out of it is a drive row, not "..".
    expect(listing.parent).toBeNull()
    // Drive rows are named by their own path -- `D:\` is what a Windows user
    // looks for -- and come first, ahead of the alphabetical folders.
    expect(listing.entries).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'D:\\', path: 'D:\\' },
      ...homeFolders(),
    ])
  })

  it('leaves out a drive root that is home itself', async () => {
    // A home at the root of a drive (a kiosk or service account's D:\) would
    // otherwise be offered as a row inside itself.
    const listing = await listDirectory(undefined, { driveRoots: async () => [ROOT, 'D:\\'] })
    expect(listing.entries[0]).toEqual({ name: 'D:\\', path: 'D:\\' })
    expect(listing.entries.map((e) => e.path)).not.toContain(ROOT)
  })

  it('treats an empty path string the same as no path -- home', async () => {
    expect((await listDirectory('', NO_DRIVES)).path).toBe(ROOT)
  })

  it('is idempotent when handed home\'s own path -- still home, no parent, drives offered', async () => {
    // The phone echoes back the very path the picker offered; asking for home by
    // its own absolute path must land ON home, drive rows and all.
    const listing = await listDirectory(ROOT, { driveRoots: async () => ['D:\\'] })
    expect(listing.path).toBe(ROOT)
    expect(listing.parent).toBeNull()
    expect(listing.entries[0]).toEqual({ name: 'D:\\', path: 'D:\\' })
  })

  it('lets a drive row claim its path before a home junction to the same place', async () => {
    // A junction in home that points at a drive root would be a second row with
    // the drive's own path. The drive row comes first and keeps it.
    if (!escapeLinked) return
    const listing = await listDirectory(undefined, { driveRoots: async () => [OUTSIDE] })
    expect(listing.entries[0]).toEqual({ name: OUTSIDE, path: OUTSIDE })
    expect(listing.entries.map((e) => e.name)).not.toContain('escape')
  })

  it('probes the drives only at home, never on the way down', async () => {
    // Every other level is one folder's subfolders; asking for the drives there
    // would put the slowest drive's answer in front of every tap.
    const driveRoots = vi.fn(async () => ['D:\\'])
    const listing = await listDirectory(join(ROOT, 'alpha'), { driveRoots })
    expect(driveRoots).not.toHaveBeenCalled()
    expect(listing.entries.map((e) => e.name)).toEqual(['sub'])
  })

  it('still offers the drives when home itself cannot be resolved', async () => {
    // homedir() can name a path realpath cannot follow; home falls back to the
    // raw path and its unreadable level yields no folders rather than throwing --
    // and the drive rows are still there, so the user is never stuck.
    const bogus = join(ROOT, 'nope-not-real')
    pointHomeAt(bogus)
    const listing = await listDirectory(undefined, { driveRoots: async () => ['D:\\'] })
    expect(listing.path).toBe(bogus)
    expect(listing.parent).toBeNull()
    expect(listing.entries).toEqual([{ name: 'D:\\', path: 'D:\\' }])
  })

  it('opens on this machine\'s real drives when none are injected', async () => {
    const listing = await listDirectory()
    if (process.platform === 'win32') {
      const system = `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`
      expect(listing.entries).toContainEqual({ name: system, path: system })
    } else {
      expect(listing.entries[0]).toEqual({ name: '/', path: '/' })
    }
  })
})

describe('listDirectory — anywhere on the desktop', () => {
  it('descends into a real subfolder and names the parent to climb back to', async () => {
    const listing = await listDirectory(join(ROOT, 'alpha'), NO_DRIVES)
    expect(listing.path).toBe(join(ROOT, 'alpha'))
    // Below home, so a parent IS offered -- and it is the folder above.
    expect(listing.parent).toBe(ROOT)
    expect(listing.entries).toEqual([{ name: 'sub', path: join(ROOT, 'alpha', 'sub') }])
  })

  it('lists a folder outside home instead of bouncing back to home', async () => {
    // The fence this replaces sent every path outside home back to home, which
    // is what kept a phone off D:\. A real folder anywhere is listed as itself.
    const listing = await listDirectory(OUTSIDE, NO_DRIVES)
    expect(listing.path).toBe(OUTSIDE)
    expect(listing.parent).toBe(dirname(OUTSIDE))
    expect(listing.entries).toEqual([{ name: 'projects', path: join(OUTSIDE, 'projects') }])
  })

  it('gives a filesystem root home as its parent, never itself', async () => {
    // dirname('D:\\') is 'D:\\' and dirname('/') is '/': a root left to dirname
    // would offer a ".." that reloads the same level forever. Up from a drive
    // goes back to home, where the drives are listed.
    const top = parse(ROOT).root
    const listing = await listDirectory(top, NO_DRIVES)
    expect(listing.path).toBe(top)
    expect(listing.parent).toBe(ROOT)
    expect(listing.entries.length).toBeGreaterThan(0)
  })

  it('follows a junction out of home to the folder it names', async () => {
    // The fence used to drop this row -- the one workaround a user had, linking
    // D:\projects into their profile, went nowhere. It is offered at its target.
    if (!escapeLinked) return
    expect((await listDirectory(undefined, NO_DRIVES)).entries).toContainEqual({ name: 'escape', path: OUTSIDE })
    const listing = await listDirectory(join(ROOT, 'escape'), NO_DRIVES)
    expect(listing.path).toBe(OUTSIDE)
    expect(listing.entries.map((e) => e.name)).toEqual(['projects'])
  })

  it('never repeats a path: a junction onto a sibling is dropped and the real folder kept', async () => {
    // The phone keys each row by its path (FlatList keyExtractor), so two rows
    // for one folder is a duplicate key on the phone. The REAL folder keeps its
    // row; the junction is the duplicate, whichever sorts first.
    if (!aliasLinked) return
    const listing = await listDirectory(undefined, NO_DRIVES)
    const names = listing.entries.map((e) => e.name)
    expect(names).toContain('beta')
    expect(names).not.toContain('alias')
    const paths = listing.entries.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('falls back to home for a path that does not exist', async () => {
    const listing = await listDirectory(join(ROOT, 'does-not-exist'), NO_DRIVES)
    expect(listing.path).toBe(ROOT)
    expect(listing.parent).toBeNull()
  })

  it('falls back to home when the path is a file, not a folder', async () => {
    // A file resolves, but you cannot open a terminal "in" a file.
    expect((await listDirectory(join(ROOT, 'readme.txt'), NO_DRIVES)).path).toBe(ROOT)
  })

  it('falls back to home for a request whose path is not text', async () => {
    // `path` crosses the wire unvalidated; the dispatcher hands it straight here.
    expect((await listDirectory(42 as unknown as string, NO_DRIVES)).path).toBe(ROOT)
  })

  it('skips a dangling junction rather than failing the level', async () => {
    // Guard at RUNTIME, not via it.runIf: runIf reads its condition at
    // collection time -- before beforeAll makes the junction -- so it would skip
    // even where junctions work.
    if (!brokenLinked) return
    const names = (await listDirectory(undefined, NO_DRIVES)).entries.map((e) => e.name)
    expect(names).not.toContain('broken')
    expect(names).toContain('beta')
  })
})

describe('listDirectory — network and device paths are refused unopened', () => {
  it.each([
    ['a UNC share', '\\\\attacker.invalid\\share'],
    ['a folder inside a UNC share', '\\\\attacker.invalid\\share\\repo'],
    ['a forward-slash UNC share', '//attacker.invalid/share'],
    ['a mixed-slash UNC share', '\\/attacker.invalid/share'],
    ['a Win32 long-path name', '\\\\?\\C:\\Windows'],
    ['a long-path UNC name', '\\\\?\\UNC\\attacker.invalid\\share'],
    ['a device-namespace pipe', '\\\\.\\pipe\\termpolis-no-such-pipe'],
  ])('answers %s with home, and nothing touches it', async (_label, path) => {
    // On Windows, merely opening \\host\share makes the OS connect to that host
    // and offer it the signed-in user's NTLM hash. The check must therefore come
    // BEFORE the first filesystem call -- a refusal after realpath has already
    // reached out would be too late.
    const { fs, touched } = recordingFs()
    const listing = await listDirectory(path, { ...NO_DRIVES, fs })
    expect(listing.path).toBe(ROOT)
    expect(listing.parent).toBeNull()
    // The seam was really used (home was resolved and read through it) ...
    expect(touched.length).toBeGreaterThan(0)
    // ... and not one call named the requested path's host.
    expect(touched.filter((p) => NETWORK_OR_DEVICE.test(p))).toEqual([])
  })

  it('does not list a local path that resolves to a network share', async () => {
    // A symlink on a local disk can point at \\nas\share. The picker never offers
    // such a path, so it does not list one either -- home instead -- and it does
    // not go on to stat it.
    const statted: string[] = []
    const fs: PickerFs = {
      realpath: async (path) => (path === join(ROOT, 'to-nas') ? '\\\\nas\\share' : path),
      stat: async (path) => { statted.push(path); return { isDirectory: () => true } },
      readdir: async () => [],
    }
    const listing = await listDirectory(join(ROOT, 'to-nas'), { ...NO_DRIVES, fs })
    expect(listing.path).toBe(ROOT)
    expect(statted).not.toContain('\\\\nas\\share')
  })

  it('does not offer a folder link that resolves to a network share', async () => {
    const statted: string[] = []
    const fs: PickerFs = {
      realpath: async (path) => (path === join(ROOT, 'nas') ? '\\\\nas\\share' : path),
      stat: async (path) => { statted.push(path); return { isDirectory: () => true } },
      readdir: async (path) => (path === ROOT ? [dirent('plain', 'dir'), dirent('nas', 'link')] : []),
    }
    const listing = await listDirectory(undefined, { ...NO_DRIVES, fs })
    expect(listing.entries).toEqual([{ name: 'plain', path: join(ROOT, 'plain') }])
    expect(statted).not.toContain('\\\\nas\\share')
  })

  it('does not offer a link to a file', async () => {
    const fs: PickerFs = {
      realpath: async (path) => path,
      stat: async (path) => ({ isDirectory: () => !path.endsWith('notes.lnk') }),
      readdir: async (path) => (path === ROOT ? [dirent('notes.lnk', 'link'), dirent('repo', 'dir')] : []),
    }
    const listing = await listDirectory(undefined, { ...NO_DRIVES, fs })
    expect(listing.entries.map((e) => e.name)).toEqual(['repo'])
  })

  it.each([
    ['\\\\server\\share', true],
    ['//server/share', true],
    ['\\/server/share', true],
    ['\\\\?\\C:\\x', true],
    ['\\\\.\\COM1', true],
    ['C:\\Users\\dev', false],
    ['D:\\', false],
    ['D:\\projects', false],
    ['/home/dev', false],
    ['/', false],
    ['\\rooted\\on\\this\\drive', false],
    ['relative\\path', false],
    ['', false],
  ])('isNetworkOrDevicePath(%j) is %s', (path, expected) => {
    expect(isNetworkOrDevicePath(path)).toBe(expected)
  })
})

describe('listDirectory — one listing, one relay frame', () => {
  let BIG = ''
  const FOLDERS = MAX_PICKER_ENTRIES + 100

  beforeAll(() => {
    BIG = realpathSync(mkdtempSync(join(tmpdir(), 'tp-picker-big-')))
    for (let i = 0; i < FOLDERS; i++) mkdirSync(join(BIG, `folder-${String(i).padStart(4, '0')}`))
  })

  afterAll(() => {
    rmSync(BIG, { recursive: true, force: true })
  })

  it('caps a folder of 2,100 subfolders at MAX_PICKER_ENTRIES, keeping the first by name', async () => {
    // C:\Windows\WinSxS holds ~23,000 folders: 5 MiB of listing that the relay
    // would refuse whole, leaving the phone an error and no way past it.
    const listing = await listDirectory(BIG, NO_DRIVES)
    expect(MAX_PICKER_ENTRIES).toBe(2_000)
    expect(listing.entries).toHaveLength(MAX_PICKER_ENTRIES)
    expect(listing.entries[0].name).toBe('folder-0000')
    expect(listing.entries[MAX_PICKER_ENTRIES - 1].name).toBe('folder-1999')
    expect(wireBytes(listing)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
  })

  it('stops before the frame is full when names are long, even under the row cap', async () => {
    // 1,500 rows is under the cap, but at ~2 KB a row it is ~3 MB: the byte
    // budget has to bind first, and it has to be TIGHT -- one row more would not
    // fit -- or it is only a guess.
    const long = (i: number): string => `${String(i).padStart(4, '0')}-${'x'.repeat(1_000)}`
    const fs: PickerFs = {
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true }),
      readdir: async (path) => (path === ROOT ? Array.from({ length: 1_500 }, (_, i) => dirent(long(i), 'dir')) : []),
    }
    const listing = await listDirectory(undefined, { ...NO_DRIVES, fs })
    expect(listing.entries.length).toBeGreaterThan(0)
    expect(listing.entries.length).toBeLessThan(1_500)
    expect(wireBytes(listing)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    const next = { name: long(listing.entries.length), path: join(ROOT, long(listing.entries.length)) }
    expect(wireBytes({ ...listing, entries: [...listing.entries, next] })).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })

  it('counts a path\'s escaped backslashes, not just its characters', async () => {
    // JSON spells each Windows `\` as `\\`, so a budget measured in characters
    // under-counts a deep Windows path by one byte per separator -- here ~47 per
    // row, enough that a character count would let ~50 rows too many through.
    const deep = resolve(ROOT, ...Array.from({ length: 40 }, () => 'd'))
    const fs: PickerFs = {
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true }),
      readdir: async (path) => (path === deep ? Array.from({ length: 1_900 }, (_, i) => dirent(`${i}-${'y'.repeat(400)}`, 'dir')) : []),
    }
    const listing = await listDirectory(deep, { ...NO_DRIVES, fs })
    expect(listing.path).toBe(deep)
    expect(listing.entries.length).toBeGreaterThan(0)
    expect(listing.entries.length).toBeLessThan(1_900)
    expect(wireBytes(listing)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
  })
})

describe('listDirectory — what must not break a listing', () => {
  it('still lists home when the drive probe fails outright', async () => {
    // The drives are an addition to home, never a condition of it.
    const listing = await listDirectory(undefined, { driveRoots: async () => { throw new Error('probe exploded') } })
    expect(listing.path).toBe(ROOT)
    expect(listing.entries.map((e) => e.name)).toContain('alpha')
  })

  it('lists a folder without a link that hangs, once the link has had its time', async () => {
    // A link to a dead network drive hangs exactly as the drive does. Home is the
    // one level the user cannot get around, so one such link must not hold it.
    vi.useFakeTimers()
    try {
      const fs: PickerFs = {
        realpath: (path) => (path === join(ROOT, 'dead') ? new Promise<string>(() => {}) : Promise.resolve(path)),
        stat: async () => ({ isDirectory: () => true }),
        readdir: async (path) => (path === ROOT ? [dirent('dead', 'link'), dirent('live', 'link'), dirent('repo', 'dir')] : []),
      }
      const pending = listDirectory(undefined, { ...NO_DRIVES, fs })
      await vi.advanceTimersByTimeAsync(DRIVE_PROBE_TIMEOUT_MS)
      expect((await pending).entries.map((e) => e.name)).toEqual(['live', 'repo'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats paths that differ only in case as one folder on Windows, and as two elsewhere', async () => {
    // Two links whose targets differ only in case: one folder on NTFS, so one
    // row; two folders on a case-sensitive Linux disk, so two.
    const fs: PickerFs = {
      realpath: async (path) => {
        if (path === join(ROOT, 'upper')) return join(ROOT, 'Shared')
        if (path === join(ROOT, 'lower')) return join(ROOT, 'shared')
        return path
      },
      stat: async () => ({ isDirectory: () => true }),
      readdir: async (path) => (path === ROOT ? [dirent('lower', 'link'), dirent('upper', 'link')] : []),
    }
    const onWindows = await listDirectory(undefined, { ...NO_DRIVES, fs, platform: 'win32' })
    const onLinux = await listDirectory(undefined, { ...NO_DRIVES, fs, platform: 'linux' })
    expect(onWindows.entries.map((e) => e.name)).toEqual(['lower'])
    expect(onLinux.entries.map((e) => e.name)).toEqual(['lower', 'upper'])
  })

  it('keeps two plain folders whose names differ only in case, even on Windows', async () => {
    // A directory switched to case-sensitive (as WSL does) can hold both. Each is
    // its own entry with its own path -- only a link can repeat one -- so folding
    // case must never merge them.
    const fs: PickerFs = {
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true }),
      readdir: async (path) => (path === ROOT ? [dirent('Repo', 'dir'), dirent('repo', 'dir')] : []),
    }
    const listing = await listDirectory(undefined, { ...NO_DRIVES, fs, platform: 'win32' })
    expect(listing.entries.map((e) => e.path).sort()).toEqual([join(ROOT, 'Repo'), join(ROOT, 'repo')])
  })
})
