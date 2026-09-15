import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, truncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeForMatch,
  sfMatches,
  parseLcovForFile,
  findLcov,
  readFileCoverage,
  LCOV_CANDIDATES,
  MAX_LCOV_BYTES,
} from '../../src/main/coverageReader'

describe('normalizeForMatch', () => {
  it('turns Windows separators into forward slashes', () => {
    expect(normalizeForMatch('src\\main\\a.ts')).toBe('src/main/a.ts')
  })

  it('strips a leading ./, including a repeated one', () => {
    expect(normalizeForMatch('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeForMatch('././src/a.ts')).toBe('src/a.ts')
  })

  it('lowercases a drive letter, which tools disagree about', () => {
    expect(normalizeForMatch('C:\\repo\\a.ts')).toBe('c:/repo/a.ts')
  })

  it('leaves the rest of the path case alone, because Linux is case-sensitive', () => {
    expect(normalizeForMatch('src/Foo.ts')).toBe('src/Foo.ts')
  })
})

describe('sfMatches', () => {
  it('matches an identical path', () => {
    expect(sfMatches('src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('matches an absolute SF against a repo-relative target', () => {
    expect(sfMatches('/home/me/repo/src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('matches across separator styles', () => {
    expect(sfMatches('C:\\repo\\src\\a.ts', 'src/a.ts')).toBe(true)
  })

  it('refuses a path that merely ENDS with the same characters', () => {
    // The boundary check: `foosrc/a.ts` ends with the string `src/a.ts` but not with
    // the PATH `src/a.ts`. Without this, an unrelated file reports coverage as yours.
    expect(sfMatches('foosrc/a.ts', 'src/a.ts')).toBe(false)
  })

  it('refuses an unrelated file', () => {
    expect(sfMatches('src/b.ts', 'src/a.ts')).toBe(false)
  })

  it('still matches a genuinely nested copy — the documented limit of suffix matching', () => {
    expect(sfMatches('vendor/other/src/a.ts', 'src/a.ts')).toBe(true)
  })
})

describe('parseLcovForFile', () => {
  it('returns null when the file has no record at all', () => {
    // Null and {} are different answers: null means "no data, show nothing",
    // {} means "recorded, but no executable lines".
    expect(parseLcovForFile('SF:src/other.ts\nDA:1,1\nend_of_record\n', 'src/a.ts')).toBeNull()
  })

  it('returns an empty map for a file recorded with no DA lines', () => {
    expect(parseLcovForFile('SF:src/a.ts\nend_of_record\n', 'src/a.ts')).toEqual({})
  })

  it('reads hit counts for the requested file only', () => {
    const lcov = [
      'SF:src/other.ts', 'DA:1,99', 'end_of_record',
      'SF:src/a.ts', 'DA:1,3', 'DA:2,0', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 3, 2: 0 })
  })

  it('SUMS a file that appears in more than one record', () => {
    // Two test projects covering the same source. First-wins would under-report a
    // line that only the second project exercises.
    const lcov = [
      'SF:src/a.ts', 'DA:1,2', 'DA:2,0', 'end_of_record',
      'SF:src/a.ts', 'DA:1,3', 'DA:2,5', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 5, 2: 5 })
  })

  it('tolerates CRLF line endings', () => {
    expect(parseLcovForFile('SF:src/a.ts\r\nDA:7,4\r\nend_of_record\r\n', 'src/a.ts')).toEqual({ 7: 4 })
  })

  it('ignores the checksum field some writers append to DA', () => {
    expect(parseLcovForFile('SF:src/a.ts\nDA:7,4,d41d8cd9\nend_of_record\n', 'src/a.ts')).toEqual({ 7: 4 })
  })

  it('skips malformed DA records rather than poisoning the map with NaN', () => {
    const lcov = [
      'SF:src/a.ts',
      'DA:5',          // no comma at all
      'DA:foo,1',      // unparseable line number
      'DA:6,bar',      // unparseable hit count
      'DA:7,1',        // the only good one
      'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 7: 1 })
  })

  it('ignores DA lines belonging to a different file', () => {
    const lcov = [
      'SF:src/a.ts', 'DA:1,1', 'end_of_record',
      'SF:src/other.ts', 'DA:2,9', 'end_of_record',
    ].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 1 })
  })

  it('ignores other lcov record types', () => {
    const lcov = ['SF:src/a.ts', 'FN:1,foo', 'FNDA:3,foo', 'LF:10', 'LH:4', 'DA:1,1', 'end_of_record'].join('\n')
    expect(parseLcovForFile(lcov, 'src/a.ts')).toEqual({ 1: 1 })
  })
})

describe('findLcov', () => {
  it('returns the first candidate that exists', () => {
    const present = join('/repo', 'coverage', 'lcov.info')
    expect(findLcov('/repo', p => p === present)).toBe(present)
  })

  it('falls through to a later candidate', () => {
    const present = join('/repo', 'lcov.info')
    expect(findLcov('/repo', p => p === present)).toBe(present)
  })

  it('returns null when a repo has produced no coverage at all', () => {
    expect(findLcov('/repo', () => false)).toBeNull()
  })

  it('tries every documented candidate before giving up', () => {
    const tried: string[] = []
    findLcov('/repo', p => { tried.push(p); return false })
    expect(tried).toHaveLength(LCOV_CANDIDATES.length)
  })

  it('looks for the .NET and Python filenames, not only lcov.info', () => {
    // The whole non-JS world is why this list exists in more than one shape: coverlet
    // names its lcov output coverage.info and coverage.py names it coverage.lcov, so a
    // list of lcov.info paths finds nothing in a correctly instrumented repo.
    expect(LCOV_CANDIDATES).toContain('coverage.info')
    expect(LCOV_CANDIDATES).toContain('coverage.lcov')
  })
})

describe('findLcov, for paths that cannot be fixed strings', () => {
  const dirsFrom = (dirs: Record<string, string[]>) => (p: string) => dirs[p] ?? []

  it('finds coverlet collector output under a per-run guid directory', () => {
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40'],
      [join('/repo', 'TestResults', '8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40')]: ['coverage.info'],
    })
    expect(findLcov('/repo', () => false, readDir))
      .toBe(join('/repo', 'TestResults', '8f3c4a21-0b19-4e77-9f2d-5c1a7e6b3d40', 'coverage.info'))
  })

  it('ignores a guid directory holding some other coverage format', () => {
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['abc'],
      [join('/repo', 'TestResults', 'abc')]: ['coverage.cobertura.xml'],
    })
    expect(findLcov('/repo', () => false, readDir)).toBeNull()
  })

  it('takes a single simplecov tracefile whatever the project named it', () => {
    const readDir = dirsFrom({ [join('/repo', 'coverage', 'lcov')]: ['my_app.lcov'] })
    expect(findLcov('/repo', () => false, readDir))
      .toBe(join('/repo', 'coverage', 'lcov', 'my_app.lcov'))
  })

  it('refuses simplecov per-file fragments rather than passing one off as the repo', () => {
    // simplecov-lcov's default mode writes one .lcov per source file. Returning any one of
    // them would report that single file's coverage as the whole repository's — wrong in
    // the direction that still looks like a plausible number.
    const readDir = dirsFrom({
      [join('/repo', 'coverage', 'lcov')]: ['lib-foo.lcov', 'lib-bar.lcov'],
    })
    expect(findLcov('/repo', () => false, readDir)).toBeNull()
  })

  it('prefers a fixed candidate over anything found by scanning', () => {
    const present = join('/repo', 'coverage', 'lcov.info')
    const readDir = dirsFrom({
      [join('/repo', 'TestResults')]: ['x'],
      [join('/repo', 'TestResults', 'x')]: ['coverage.info'],
    })
    expect(findLcov('/repo', p => p === present, readDir)).toBe(present)
  })

  it('does not scan at all when a fixed candidate hits', () => {
    // The cost claim in the doc comment: an ordinary repo pays the stat calls it always
    // paid, and nothing else.
    const present = join('/repo', 'coverage', 'lcov.info')
    const scanned: string[] = []
    findLcov('/repo', p => p === present, p => { scanned.push(p); return [] })
    expect(scanned).toEqual([])
  })

  it('treats an unreadable directory as empty rather than throwing', () => {
    // The default readDir hits the real filesystem, and /repo does not exist.
    expect(findLcov('/repo', () => false)).toBeNull()
  })
})

describe('readFileCoverage', () => {
  let root: string

  const writeLcov = (body: string, rel = 'coverage/lcov.info') => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
    return p
  }

  /** Force explicit mtimes — real clock granularity is too coarse to rely on here. */
  const setMtime = (p: string, secondsFromEpoch: number) => {
    const d = new Date(secondsFromEpoch * 1000)
    utimesSync(p, d, d)
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tp-cov-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('returns null for a repo with no coverage artifact — the common case, not an error', () => {
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('returns null for a file the artifact does not mention', () => {
    writeLcov('SF:src/other.ts\nDA:1,1\nend_of_record\n')
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('reads the hit counts and names the artifact it used', () => {
    const lcovPath = writeLcov('SF:src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), 'x')
    setMtime(join(root, 'src/a.ts'), 1_000)
    setMtime(lcovPath, 2_000)

    const cov = readFileCoverage(root, 'src/a.ts')
    expect(cov).toMatchObject({ source: lcovPath, lines: { 1: 3, 2: 0 }, stale: false })
  })

  it('flags coverage older than the file it describes', () => {
    const lcovPath = writeLcov('SF:src/a.ts\nDA:1,3\nend_of_record\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), 'x')
    setMtime(lcovPath, 1_000)
    setMtime(join(root, 'src/a.ts'), 2_000)

    expect(readFileCoverage(root, 'src/a.ts')?.stale).toBe(true)
  })

  it('treats a source file that no longer exists as stale, not as a crash', () => {
    writeLcov('SF:src/gone.ts\nDA:1,1\nend_of_record\n')
    expect(readFileCoverage(root, 'src/gone.ts')?.stale).toBe(true)
  })

  it('refuses an artifact too large to parse without blocking the main process', () => {
    const p = writeLcov('SF:src/a.ts\nDA:1,1\nend_of_record\n')
    // Extend rather than write 32 MB: statSync reports the size either way.
    truncateSync(p, MAX_LCOV_BYTES + 1)
    expect(readFileCoverage(root, 'src/a.ts')).toBeNull()
  })

  it('finds an artifact at a non-default candidate path', () => {
    const p = writeLcov('SF:src/a.ts\nDA:1,1\nend_of_record\n', 'lcov.info')
    expect(readFileCoverage(root, 'src/a.ts')?.source).toBe(p)
  })

  it('matches an artifact written with absolute SF paths', () => {
    writeLcov(`SF:${join(root, 'src/a.ts')}\nDA:1,1\nend_of_record\n`)
    expect(readFileCoverage(root, 'src/a.ts')?.lines).toEqual({ 1: 1 })
  })
})
