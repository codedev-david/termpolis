import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// homedir() is the picker's root, and the picker fences everything to it. To
// test that fence we make home a fixture tree we control instead of the machine
// running the suite. We do NOT mock the `os` module: vitest externalises Node
// builtins from Vite's module graph, so vi.mock('os') never reaches the SUT's
// `import { homedir } from 'os'` -- it keeps the real require('os'). Instead we
// drive the REAL homedir(): libuv reads USERPROFILE (Windows) / HOME (POSIX)
// before falling back to the passwd db, so setting those points the genuine
// os.homedir() at our fixture, and one test can point it at a path that does
// not exist to prove the root falls back cleanly.

/** Canonical home, and a directory deliberately OUTSIDE it. Real filesystem,
 *  because the whole point is that symlink/junction resolution and containment
 *  behave the way the OS actually resolves them. */
let HOME_RAW = ''
let ROOT = ''
let OUTSIDE = ''
let escapeLinked = false
let brokenLinked = false
let savedUserProfile: string | undefined
let savedHome: string | undefined

function pointHomeAt(path: string): void {
  process.env.USERPROFILE = path
  process.env.HOME = path
}

import { listHomeDirectory } from '../../src/main/remoteBridge/directoryPicker'

beforeAll(() => {
  savedUserProfile = process.env.USERPROFILE
  savedHome = process.env.HOME

  HOME_RAW = mkdtempSync(join(tmpdir(), 'tp-picker-home-'))
  OUTSIDE = mkdtempSync(join(tmpdir(), 'tp-picker-out-'))
  // realpath once: on Windows a temp dir can carry an 8.3 short name, and every
  // path the picker returns is realpath'd, so the fixture compares against the
  // canonical form or nothing lines up.
  ROOT = realpathSync(HOME_RAW)
  pointHomeAt(ROOT)

  mkdirSync(join(ROOT, 'alpha'))
  mkdirSync(join(ROOT, 'alpha', 'sub'))
  mkdirSync(join(ROOT, 'beta'))
  // A plain file at the top level: it must be filtered out, since the picker
  // offers folders only.
  writeFileSync(join(ROOT, 'readme.txt'), 'not a folder')

  // A junction that points OUT of home. readdir lists it; realpath resolves it
  // outside the root; `within` must drop it so a phone cannot ride a symlink out
  // of the fence. 'junction' rather than 'symlink' so Windows needs no admin.
  try {
    symlinkSync(OUTSIDE, join(ROOT, 'escape'), 'junction')
    escapeLinked = true
  } catch {
    escapeLinked = false
  }

  // A junction to a directory that no longer exists. readdir lists it; realpath
  // THROWS; the per-entry catch must skip it and keep the level browsable.
  try {
    const doomed = mkdtempSync(join(tmpdir(), 'tp-picker-doomed-'))
    symlinkSync(doomed, join(ROOT, 'broken'), 'junction')
    rmSync(doomed, { recursive: true, force: true })
    brokenLinked = true
  } catch {
    brokenLinked = false
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

describe('listHomeDirectory — the home root', () => {
  it('roots at home, reports no parent there, and lists only its subfolders sorted', () => {
    const listing = listHomeDirectory()
    expect(listing.path).toBe(ROOT)
    // null parent is how the phone knows to hide its ".." row: the fence is here.
    expect(listing.parent).toBeNull()
    // alpha and beta only -- readme.txt is a file, escape/broken are junctions
    // that resolve away, and all three are absent by name.
    expect(listing.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(listing.entries.map((e) => e.path)).toEqual([
      realpathSync(join(ROOT, 'alpha')),
      realpathSync(join(ROOT, 'beta')),
    ])
  })

  it('treats an empty path string the same as no path -- the root', () => {
    expect(listHomeDirectory('').path).toBe(ROOT)
  })

  it('is idempotent when handed the root path itself -- still the root, no parent', () => {
    // The phone echoes back the very path the picker offered; asking for the root
    // by its own absolute path must land ON the root (candidate === root inside
    // the fence), not one level up.
    const listing = listHomeDirectory(ROOT)
    expect(listing.path).toBe(ROOT)
    expect(listing.parent).toBeNull()
  })
})

describe('listHomeDirectory — walking into a subfolder', () => {
  it('descends into a real subfolder and names the parent to climb back to', () => {
    const listing = listHomeDirectory(join(ROOT, 'alpha'))
    expect(listing.path).toBe(realpathSync(join(ROOT, 'alpha')))
    // Below the root, so a parent IS offered -- and it is the folder above, not
    // some fixed home.
    expect(listing.parent).toBe(ROOT)
    expect(listing.entries.map((e) => e.name)).toEqual(['sub'])
    expect(listing.entries[0].path).toBe(realpathSync(join(ROOT, 'alpha', 'sub')))
  })
})

describe('listHomeDirectory — the fence', () => {
  it('falls back to the root for a real folder that sits outside home', () => {
    // The phone should only ever echo back paths the picker offered, but the
    // fence cannot depend on that: an absolute path outside home resolves fine
    // and must still be refused, landing the user back at the root.
    const listing = listHomeDirectory(OUTSIDE)
    expect(listing.path).toBe(ROOT)
    expect(listing.parent).toBeNull()
  })

  it('falls back to the root for a path that does not exist', () => {
    const listing = listHomeDirectory(join(ROOT, 'does-not-exist'))
    expect(listing.path).toBe(ROOT)
  })

  it('falls back to the root when the path is a file, not a folder', () => {
    // A file resolves and sits under home, but you cannot open a terminal "in" a
    // file, so it is refused the same as an escape.
    const listing = listHomeDirectory(join(ROOT, 'readme.txt'))
    expect(listing.path).toBe(ROOT)
  })

  it('drops a subfolder junction that escapes home', () => {
    // Guard at RUNTIME, not via it.runIf: runIf reads its condition at
    // collection time -- before beforeAll makes the junction -- so it would skip
    // even where junctions work. The flag is true wherever the OS let us build
    // the fixture (every Windows box, incl. CI), and there the escape branch of
    // `within` is exercised; a platform that refused the junction no-ops.
    if (!escapeLinked) return
    const names = listHomeDirectory().entries.map((e) => e.name)
    expect(names).not.toContain('escape')
    // A sibling real folder is still there, so the drop is the fence at work and
    // not the whole level failing to read.
    expect(names).toContain('alpha')
  })

  it('skips a dangling junction rather than failing the level', () => {
    if (!brokenLinked) return
    const names = listHomeDirectory().entries.map((e) => e.name)
    expect(names).not.toContain('broken')
    expect(names).toContain('beta')
  })
})

describe('listHomeDirectory — a home that cannot be resolved', () => {
  it('still returns a usable listing when home itself does not resolve', () => {
    // homedir() can name a path realpath cannot follow; the root falls back to
    // the raw home and the unreadable level yields no entries rather than
    // throwing -- the picker must always render SOMETHING.
    const bogus = join(ROOT, 'nope-not-real')
    pointHomeAt(bogus)
    const listing = listHomeDirectory()
    expect(listing.path).toBe(bogus)
    expect(listing.parent).toBeNull()
    expect(listing.entries).toEqual([])
  })
})
