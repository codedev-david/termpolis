// WPA item 4: one folder, one key, however the path is spelled.
import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'crypto'
import {
  canonicalProjectPath, projectKeyOf, legacyProjectKeyOf, projectKeyAliases, expandShortPath, hasShortPart, SHORT_SCAN_MAX,
  SHORT_MEMO_MAX, SHORT_MEMO_HIT_MS, SHORT_MEMO_MISS_MS,
} from '../../src/main/projectKey'
import type { ShortPathFs } from '../../src/main/projectKey'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'

const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

describe('canonicalProjectPath', () => {
  it('a Windows path, its Git Bash spelling, other case, doubled and trailing separators: one spelling', () => {
    const forms = [
      'C:\\Users\\David\\repos\\termpolis',
      'c:/users/david/repos/termpolis',
      '/c/Users/David/repos/termpolis',
      '/C/Users/David/repos/termpolis/',
      '/cygdrive/c/Users/David/repos/termpolis',
      'C:\\Users\\David\\\\repos\\termpolis\\\\',
      '  C:/Users/DAVID/Repos/Termpolis  ',
    ]
    for (const f of forms) expect(canonicalProjectPath(f, 'win32')).toBe('c:/users/david/repos/termpolis')
  })
  it('the Git Bash drive is only read as a drive on Windows', () => {
    expect(canonicalProjectPath('/c/Users/x', 'linux')).toBe('/c/users/x')
    expect(canonicalProjectPath('/c/Users/x', 'darwin')).toBe('/c/users/x')
  })
  it('a one-letter folder that is not first, or a longer first folder, is left alone', () => {
    expect(canonicalProjectPath('/repo/c/x', 'win32')).toBe('/repo/c/x')
    expect(canonicalProjectPath('/cc/x', 'win32')).toBe('/cc/x')
  })
  it('a one-letter root folder (`/r`, or a bare `/c`) keeps the spelling, and so the key, it had before WPA', () => {
    expect(canonicalProjectPath('/r', 'win32')).toBe('/r')
    expect(canonicalProjectPath('/c/', 'win32')).toBe('/c')
    expect(projectKeyOf('/r', 'win32')).toBe(legacyProjectKeyOf('/r'))
  })
  it('a UNC share keeps its leading pair of separators', () => {
    expect(canonicalProjectPath('\\\\server\\share\\repo', 'win32')).toBe('//server/share/repo')
  })
  it('a bare name, a bare drive, empty and non-text are not paths', () => {
    expect(canonicalProjectPath('termpolis', 'win32')).toBe('')
    expect(canonicalProjectPath('C:\\', 'win32')).toBe('')
    expect(canonicalProjectPath('   ', 'win32')).toBe('')
    expect(canonicalProjectPath(undefined as unknown as string, 'win32')).toBe('')
  })
  it('defaults to this platform', () => {
    expect(canonicalProjectPath('/repo/a')).toBe('/repo/a')
  })
})

describe('projectKeyOf', () => {
  it('every spelling of one folder gives one key', () => {
    const keys = new Set(['C:\\R\\termpolis', '/c/R/termpolis', 'c:/r/termpolis/', 'C:\\R\\\\termpolis'].map((f) => projectKeyOf(f, 'win32')))
    expect(keys.size).toBe(1)
  })
  it('a key written before WPA from a Windows path is unchanged (no stored note changes key)', () => {
    expect(projectKeyOf('C:\\Users\\DavidEngelhart\\repos\\termpolis', 'win32')).toBe(sha('c:/users/davidengelhart/repos/termpolis'))
    expect(projectKeyOf('/home/me/repo', 'linux')).toBe(sha('/home/me/repo'))
    expect(projectKeyOf('/home/me/repo')).toBe(legacyProjectKeyOf('/home/me/repo'))
  })
  it('two folders with one name never share a key; a bare name has none', () => {
    expect(projectKeyOf('/work/acme/api', 'linux')).not.toBe(projectKeyOf('/work/globex/api', 'linux'))
    expect(projectKeyOf('api', 'linux')).toBeUndefined()
  })
})

describe('legacyProjectKeyOf and projectKeyAliases', () => {
  it('the legacy key is the old hash of this exact spelling', () => {
    expect(legacyProjectKeyOf('/c/Users/X/repo')).toBe(sha('/c/users/x/repo'))
    expect(legacyProjectKeyOf('repo')).toBeUndefined()
  })
  it('a Windows path also matches notes written from Git Bash', () => {
    const a = projectKeyAliases('C:\\Users\\X\\repo', 'win32')
    expect(a).toEqual([sha('c:/users/x/repo'), sha('/c/users/x/repo'), sha('/cygdrive/c/users/x/repo')])
  })
  it('a Git Bash path matches the canonical key and its own old key', () => {
    expect(projectKeyAliases('/c/Users/X/repo', 'win32')).toEqual([sha('c:/users/x/repo'), sha('/c/users/x/repo'), sha('/cygdrive/c/users/x/repo')])
  })
  it('doubled separators: the old key of that spelling is kept as an alias', () => {
    expect(projectKeyAliases('/home/x//repo', 'linux')).toEqual([sha('/home/x/repo'), sha('/home/x//repo')])
  })
  it('on Linux a plain path has one key, and a bare name none', () => {
    expect(projectKeyAliases('/home/x/repo', 'linux')).toEqual([sha('/home/x/repo')])
    expect(projectKeyAliases('repo', 'linux')).toEqual([])
  })
  it('a drive root folder path keeps its alias', () => {
    expect(projectKeyAliases('D:\\repo', 'win32')).toEqual([sha('d:/repo'), sha('/d/repo'), sha('/cygdrive/d/repo')])
  })
  it('defaults to this platform', () => {
    expect(projectKeyAliases('/repo/a')[0]).toBe(projectKeyOf('/repo/a'))
  })
})

describe('expandShortPath (8.3 names)', () => {
  // A fake folder tree: names per folder, and a file id per full path.
  const fakeFs = (tree: Record<string, string[]>, ids: Record<string, number>): ShortPathFs & { reads: string[] } => {
    const reads: string[] = []
    return {
      reads,
      readdir: vi.fn(async (dir: string) => { reads.push(dir); if (!tree[dir]) throw new Error('ENOENT'); return tree[dir] }),
      ino: vi.fn(async (p: string) => { if (ids[p] === undefined) throw new Error('ENOENT'); return ids[p] }),
    }
  }
  it('spells out each short part by the entry of its folder with the same file id, and only those parts', async () => {
    const fs = fakeFs(
      { 'C:\\Users\\': ['Public', 'DavidEngelhart', 'Default'], 'C:\\Users\\DavidEngelhart\\repos\\': ['termpolis-t3', 'TERMPO~2'] },
      { 'C:\\Users\\DAVIDE~1': 7, 'C:\\Users\\Public': 1, 'C:\\Users\\DavidEngelhart': 7, 'C:\\Users\\Default': 3,
        'C:\\Users\\DavidEngelhart\\repos\\TERMPO~1': 9, 'C:\\Users\\DavidEngelhart\\repos\\termpolis-t3': 9 },
    )
    const out = await expandShortPath('C:\\Users\\DAVIDE~1\\repos\\TERMPO~1\\src', 'win32', fs)
    expect(out).toBe('C:\\Users\\DavidEngelhart\\repos\\termpolis-t3\\src')
    expect(fs.reads).toEqual(['C:\\Users\\', 'C:\\Users\\DavidEngelhart\\repos\\']) // never the folders with no short part
    expect(projectKeyOf(out, 'win32')).toBe(projectKeyOf('C:\\Users\\DavidEngelhart\\repos\\termpolis-t3\\src', 'win32'))
  })
  it('the likely names (squeezed, uppercased, starting with the part before the ~) are compared first', async () => {
    const fs = fakeFs({ 'C:\\': ['aaa', 'bbb', 'Program Files'] }, { 'C:\\PROGRA~1': 5, 'C:\\aaa': 1, 'C:\\bbb': 2, 'C:\\Program Files': 5 })
    expect(await expandShortPath('C:\\PROGRA~1', 'win32', fs)).toBe('C:\\Program Files')
    expect((fs.ino as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['C:\\PROGRA~1', 'C:\\Program Files'])
  })
  it('a name that only looks short is kept as the folder spells it; forward separators are kept', async () => {
    const fs = fakeFs({ 'C:/': ['Build~1'] }, { 'C:/BUILD~1': 4 })
    expect(await expandShortPath('C:/BUILD~1/x', 'win32', fs)).toBe('C:/Build~1/x')
    expect(await expandShortPath('C:/BUILD~1/', 'win32', fs)).toBe('C:/Build~1/')
  })
  it('a part with no matching id, a file system with no ids, a missing folder, or a folder past the scan cap leaves the path as it was', async () => {
    expect(await expandShortPath('C:\\NOPE~1\\x', 'win32', fakeFs({ 'C:\\': ['a'] }, { 'C:\\NOPE~1': 8, 'C:\\a': 1 }))).toBe('C:\\NOPE~1\\x')
    expect(await expandShortPath('C:\\NOPE~1', 'win32', fakeFs({ 'C:\\': ['NOPE'] }, { 'C:\\NOPE~1': 0, 'C:\\NOPE': 0 }))).toBe('C:\\NOPE~1')
    expect(await expandShortPath('C:\\NOPE~1', 'win32', fakeFs({}, {}))).toBe('C:\\NOPE~1')
    expect(await expandShortPath('C:\\NOPE~1', 'win32', fakeFs({}, { 'C:\\NOPE~1': 3 }))).toBe('C:\\NOPE~1')
    const many = Array.from({ length: SHORT_SCAN_MAX }, (_, n) => `z${n}`)
    const ids: Record<string, number> = { 'C:\\LONG~1': 99, 'C:\\last': 99 }
    for (const n of many) ids[`C:\\${n}`] = 1
    expect(await expandShortPath('C:\\LONG~1', 'win32', fakeFs({ 'C:\\': [...many, 'last'] }, ids))).toBe('C:\\LONG~1')
  })
  it('an entry that cannot be read is skipped, and the next one is compared', async () => {
    const fs = fakeFs({ 'C:\\': ['gone', 'Right'] }, { 'C:\\RIGHT~1': 6, 'C:\\Right': 6 })
    expect(await expandShortPath('C:\\RIGHT~1', 'win32', fs)).toBe('C:\\Right')
  })
  it('a path with no short part, another platform, or non-text is never read', async () => {
    const fs = fakeFs({}, {})
    expect(await expandShortPath('C:\\Users\\David\\repos', 'win32', fs)).toBe('C:\\Users\\David\\repos')
    expect(await expandShortPath('/home/a~1/x', 'linux', fs)).toBe('/home/a~1/x')
    expect(await expandShortPath(5 as unknown as string, 'win32', fs)).toBe(5)
    expect(fs.reads).toEqual([])
    expect(fs.ino).not.toHaveBeenCalled()
  })
  describe('memoised, bounded, keyed by the input path (WPA fix round 2, R-M4)', () => {
    const tree = (): ShortPathFs & { reads: string[] } => fakeFs(
      { 'C:\\': ['Program Files', 'Other'] },
      { 'C:\\PROGRA~1': 5, 'C:\\Program Files': 5, 'C:\\Other': 2, 'C:\\OTHER~1': 2, 'C:\\NOPE~1': 8 }, // NOPE~1 has an id but no long name in the folder
    )
    it('the same path a second time reads nothing; another spelling of the input is its own entry', async () => {
      const fs = tree()
      expect(await expandShortPath('C:\\PROGRA~1\\x', 'win32', fs)).toBe('C:\\Program Files\\x')
      expect(await expandShortPath('C:\\PROGRA~1\\x', 'win32', fs)).toBe('C:\\Program Files\\x')
      expect(fs.reads).toHaveLength(1)
      expect(await expandShortPath('C:\\PROGRA~1\\y', 'win32', fs)).toBe('C:\\Program Files\\y')
      expect(fs.reads).toHaveLength(2)
    })
    it('two calls at once share one scan', async () => {
      const fs = tree()
      const [a, b] = await Promise.all([expandShortPath('C:\\PROGRA~1', 'win32', fs), expandShortPath('C:\\PROGRA~1', 'win32', fs)])
      expect([a, b]).toEqual(['C:\\Program Files', 'C:\\Program Files'])
      expect(fs.reads).toHaveLength(1)
    })
    it('holds at most SHORT_MEMO_MAX paths, the least recently used forgotten first', async () => {
      const fs = tree()
      await expandShortPath('C:\\PROGRA~1\\first', 'win32', fs)
      for (let n = 1; n < SHORT_MEMO_MAX; n++) await expandShortPath(`C:\\PROGRA~1\\p${n}`, 'win32', fs)
      expect(fs.reads).toHaveLength(SHORT_MEMO_MAX)
      await expandShortPath('C:\\PROGRA~1\\first', 'win32', fs) // used again: now the newest
      await expandShortPath('C:\\PROGRA~1\\one-more', 'win32', fs) // past the bound: p1, the oldest, goes
      expect(fs.reads).toHaveLength(SHORT_MEMO_MAX + 1)
      await expandShortPath('C:\\PROGRA~1\\first', 'win32', fs)
      expect(fs.reads).toHaveLength(SHORT_MEMO_MAX + 1)
      await expandShortPath('C:\\PROGRA~1\\p1', 'win32', fs)
      expect(fs.reads).toHaveLength(SHORT_MEMO_MAX + 2)
    })
    it('a found path is read again after SHORT_MEMO_HIT_MS, a path left short after SHORT_MEMO_MISS_MS', async () => {
      const fs = tree()
      let t = 1_000
      const now = (): number => t
      await expandShortPath('C:\\PROGRA~1', 'win32', fs, now)
      await expandShortPath('C:\\NOPE~1', 'win32', fs, now) // not in the folder: left short
      expect(fs.reads).toHaveLength(2)
      t += SHORT_MEMO_MISS_MS - 1
      await expandShortPath('C:\\NOPE~1', 'win32', fs, now)
      expect(fs.reads).toHaveLength(2)
      t += 1
      expect(await expandShortPath('C:\\NOPE~1', 'win32', fs, now)).toBe('C:\\NOPE~1') // a folder made since would be found now
      expect(fs.reads).toHaveLength(3)
      await expandShortPath('C:\\PROGRA~1', 'win32', fs, now)
      expect(fs.reads).toHaveLength(3)
      t = 1_000 + SHORT_MEMO_HIT_MS
      expect(await expandShortPath('C:\\PROGRA~1', 'win32', fs, now)).toBe('C:\\Program Files')
      expect(fs.reads).toHaveLength(4)
    })
  })
  it('defaults: the real file system on this platform never throws', async () => {
    const out = await expandShortPath('C:\\DOES-NOT~1\\EXIST~2')
    expect(typeof out).toBe('string')
  })
  it('hasShortPart: only a Windows path with a short-looking part', () => {
    expect(hasShortPart('C:\\Users\\DAVIDE~1\\x', 'win32')).toBe(true)
    expect(hasShortPart('C:\\Users\\David\\x', 'win32')).toBe(false)
    expect(hasShortPart('C:\\Users\\DAVIDE~1\\x', 'linux')).toBe(false)
    expect(hasShortPart(7, 'win32')).toBe(false)
    expect(typeof hasShortPart('/x')).toBe('boolean')
  })
})

describe('WPA fix M1/M7: shell spellings and the Cygwin alias', () => {
  it('a quoted path, a file:// URI and a WSL /mnt/c path read as the folder they name', () => {
    const want = 'c:/users/x/repo'
    expect(canonicalProjectPath('"C:\\Users\\X\\repo"', 'win32')).toBe(want)
    expect(canonicalProjectPath('file:///C:/Users/X/repo', 'win32')).toBe(want)
    expect(canonicalProjectPath('/mnt/c/Users/X/repo', 'win32')).toBe(want)
    expect(canonicalProjectPath('/C:/Users/X/repo', 'win32')).toBe(want)
  })
  it('a note written from Cygwin before WPA keeps matching', () => {
    expect(projectKeyAliases('C:\\Users\\X\\repo', 'win32')).toContain(legacyProjectKeyOf('/cygdrive/c/Users/X/repo'))
    expect(projectKeyAliases('/cygdrive/c/Users/X/repo', 'win32')).toContain(legacyProjectKeyOf('/cygdrive/c/Users/X/repo'))
  })
  it('a path the shell reader cannot read (a POSIX folder on Windows, a relative one on Linux) is keyed as given', () => {
    expect(canonicalProjectPath('/usr/bin', 'win32')).toBe('/usr/bin')
    expect(canonicalProjectPath('rel/x', 'linux')).toBe('rel/x')
  })
  it('a quoted drive root is a bare drive: nothing to key on', () => {
    expect(canonicalProjectPath('"C:'+String.fromCharCode(92)+'"', 'win32')).toBe('')
  })
  it('normal Windows roots keep the key they had before WPA (M2: world stores, code graphs, annotations key on these)', () => {
    for (const r of ['C:\\Users\\DavidEngelhart\\repos\\termpolis', 'D:\\work\\api', 'C:\\Users\\X\\My Repo']) {
      expect(projectKeyOf(r, 'win32')).toBe(legacyProjectKeyOf(r))
    }
  })
})

describe('expandShortPath on a real Windows file system (8.3 names)', () => {
  it('spells out a real short name, and keeps a junction as the junction (no realpath)', async (ctx) => {
    if (process.platform !== 'win32') { console.warn('skipped: 8.3 short names exist only on Windows'); ctx.skip(); return }
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'wpa83-'))
    try {
      await fsp.mkdir(path.join(parent, 'longfoldernamewpa'))
      await fsp.mkdir(path.join(parent, 'targetfolderwpa'))
      let shortOn = true
      try { await fsp.lstat(path.join(parent, 'LONGFO~1')) } catch { shortOn = false }
      if (!shortOn) { console.warn('skipped: 8.3 short names are turned off on this volume (fsutil 8dot3name)'); ctx.skip(); return }
      // The temp folder may itself be spelled short (TEMP under `DAVIDE~1`): its long form is the base every answer starts with.
      const base = await expandShortPath(parent)
      expect(hasShortPart(base)).toBe(false)
      expect(await expandShortPath(path.join(parent, 'LONGFO~1', 'inner'))).toBe(path.join(base, 'longfoldernamewpa', 'inner'))
      await fsp.symlink(path.join(parent, 'targetfolderwpa'), path.join(parent, 'junctionnamewpa'), 'junction')
      expect(await expandShortPath(path.join(parent, 'JUNCTI~1'))).toBe(path.join(base, 'junctionnamewpa'))
    } finally {
      // The junction first, as a link (never through it), then the folder.
      await fsp.rm(path.join(parent, 'junctionnamewpa'), { force: true }).catch(() => fsp.rmdir(path.join(parent, 'junctionnamewpa')).catch(() => {}))
      await fsp.rm(parent, { recursive: true, force: true })
    }
  })
})
