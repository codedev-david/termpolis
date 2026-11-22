import { describe, expect, it, vi } from 'vitest'
import {
  IGNORED_DIRS,
  MAP_FILE_CAP,
  NESTED_DEPTH,
  SKIP_DIRS,
  isIgnoredPath,
  inSkippedPath,
  listRepo,
  lsFilesArgs,
  lsSubmoduleArgs,
  mergeListings,
  parseLsFiles,
  parseTaggedListing,
  toplevelArgs,
  unquoteGitPath
} from '../../src/main/repoFileList'

describe('repoFileList: the git file listing every map reads', () => {
  it('lists tracked and untracked files, tagged, unquoted and NUL separated, honouring the ignore files', () => {
    expect(lsFilesArgs('/r')).toEqual(['-c', 'core.quotepath=false', '-C', '/r', 'ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'])
    // --recurse-submodules works only with --cached, so the submodules' files come from a second listing.
    expect(lsSubmoduleArgs('/r')).toEqual(['-c', 'core.quotepath=false', '-C', '/r', 'ls-files', '-z', '--cached', '--recurse-submodules'])
    expect(toplevelArgs('/r/sub')).toEqual(['-C', '/r/sub', 'rev-parse', '--show-toplevel'])
  })

  it('parses -z output: names with spaces, quotes, newlines and non-ASCII letters arrive as written', () => {
    expect(parseLsFiles('src/a.ts\0src/my file.ts\0src/a"b.ts\0src/new\nline.ts\0src/café.ts\0src/日本/データ.ts\0src/😀.ts\0').names).toEqual([
      'src/a.ts',
      'src/my file.ts',
      'src/a"b.ts',
      'src/new\nline.ts',
      'src/café.ts',
      'src/日本/データ.ts',
      'src/😀.ts'
    ])
  })

  it('parses plain output, one name a line, undoing git C quoting (octal UTF-8 bytes and escapes)', () => {
    const out = [
      'src/a.ts',
      '"src/caf\\303\\251.ts"',
      '"src/\\346\\227\\245\\346\\234\\254/x.ts"',
      '"src/\\360\\237\\230\\200.ts"',
      '"src/a\\"b.ts"',
      '"src/new\\nline.ts"',
      '"src/tab\\there.ts"',
      '"src/back\\\\slash.ts"',
      '"src/\\a\\b\\f\\r\\v.ts"',
      '"src/odd\\q.ts"',
      'src/ spaced .ts',
      '',
      ''
    ].join('\n')
    expect(parseLsFiles(out).names).toEqual([
      'src/a.ts',
      'src/café.ts',
      'src/日本/x.ts',
      'src/😀.ts',
      'src/a"b.ts',
      'src/new\nline.ts',
      'src/tab\there.ts',
      'src/back\\slash.ts',
      'src/\x07\b\f\r\v.ts',
      'src/oddq.ts',
      'src/ spaced .ts'
    ])
    // Windows line ends from a plain listing are not part of the name.
    expect(parseLsFiles('a.ts\r\nb.ts\r\n').names).toEqual(['a.ts', 'b.ts'])
  })

  it('sets apart names that are not valid UTF-8 (they decode with U+FFFD, so no read would find them), and drops duplicates', () => {
    expect(parseLsFiles('a.ts\0a.ts\0b�.ts\0c�.ts\0')).toEqual({ names: ['a.ts'], unreadable: ['b�.ts', 'c�.ts'] })
    expect(parseLsFiles('"b\\377.ts"\na.ts\n')).toEqual({ names: ['a.ts'], unreadable: ['b�.ts'] })
    // A name that really holds U+FFFD reads the same and is set apart the same way.
    expect(parseLsFiles('src/real-�.ts\0').unreadable).toEqual(['src/real-�.ts'])
    expect(parseLsFiles('')).toEqual({ names: [], unreadable: [] })
  })

  it('parses a tagged listing: H (and other states) tracked, ? untracked, a trailing slash a nested repository', () => {
    const out = ['? b.ts', '? nested/', '? sub/inner/', '? x�.ts', 'H a.ts', 'S skip.ts', 'H y�.ts', 'H a.ts', ''].join('\0')
    expect(parseTaggedListing(out)).toEqual({
      tracked: ['a.ts', 'skip.ts'],
      untracked: ['b.ts', 'nested/', 'sub/inner/'],
      unreadableTracked: ['y�.ts'],
      unreadableUntracked: ['x�.ts']
    })
    // Plain (test) output works too.
    expect(parseTaggedListing('H "caf\\303\\251.ts"\n? b.ts\n')).toEqual({ tracked: ['café.ts'], untracked: ['b.ts'], unreadableTracked: [], unreadableUntracked: [] })
  })

  it('unquotes only a quoted name', () => {
    expect(unquoteGitPath('plain.ts')).toBe('plain.ts')
    expect(unquoteGitPath('"')).toBe('"')
    expect(unquoteGitPath('"x.ts"')).toBe('x.ts')
    // A trailing lone backslash stays.
    expect(unquoteGitPath('"x\\"')).toBe('x\\')
  })

  it('merges the submodule listing: its files join, the gitlink entry for the submodule folder goes', () => {
    const own = ['.gitmodules', 'libs/shared', 'src/main.ts', 'src/new.ts']
    const recursed = ['.gitmodules', 'libs/shared/lib/util.ts', 'libs/shared/lib/more.ts', 'src/main.ts']
    expect(mergeListings(own, recursed)).toEqual(['.gitmodules', 'libs/shared/lib/more.ts', 'libs/shared/lib/util.ts', 'src/main.ts', 'src/new.ts'])
    // No submodule listing: the own listing as it was, sorted.
    expect(mergeListings(['b.ts', 'a.ts'], [])).toEqual(['a.ts', 'b.ts'])
  })
})

describe('repoFileList: folders no map reads', () => {
  it('the ignored folders and suffixes: generated or third-party code no world shows', () => {
    expect([...IGNORED_DIRS].sort()).toEqual(['.next', '.venv', '__pycache__', 'bower_components', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor', 'venv'])
    expect(isIgnoredPath('node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('packages/a/node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('src/app.min.js')).toBe(true)
    expect(isIgnoredPath('src/app.min.css')).toBe(true)
    expect(isIgnoredPath('src/app.bundle.js')).toBe(true)
    expect(isIgnoredPath('src/build.ts')).toBe(false)
    // Only folders count: a file named like an ignored folder stays.
    expect(isIgnoredPath('src/vendor')).toBe(false)
  })

  it('the skip folders: the ignored ones plus version control, tox environments and .NET build output', () => {
    for (const d of IGNORED_DIRS) expect(SKIP_DIRS.has(d)).toBe(true)
    for (const d of ['.git', '.hg', '.svn', '.tox', 'obj']) expect(SKIP_DIRS.has(d)).toBe(true)
    expect(SKIP_DIRS.has('bin')).toBe(false)
    expect(SKIP_DIRS.has('env')).toBe(false)
    expect(inSkippedPath('.tox/py311/lib/x.py')).toBe(true)
    expect(inSkippedPath('app/obj/Debug/x.cs')).toBe(true)
    expect(inSkippedPath('packages/x/node_modules/')).toBe(true)
    expect(inSkippedPath('src/app.bundle.js')).toBe(true)
    expect(inSkippedPath('src/obj.ts')).toBe(false)
    expect(inSkippedPath('bin/run.sh')).toBe(false)
  })
})

/** A fake git: answers by the -C folder and the listing kind; null is a refusal. */
function fakeGit(answers: Record<string, string | null>) {
  return vi.fn(async (args: string[]): Promise<string | null> => {
    const dir = args[args.indexOf('-C') + 1]
    const kind = args.includes('--recurse-submodules') ? 'sub' : args.includes('rev-parse') ? 'top' : 'ls'
    const key = `${kind} ${dir}`
    if (!(key in answers)) throw new Error(`unexpected git ${key}`)
    return answers[key]
  })
}
const z = (...entries: string[]): string => entries.map((e) => `${e}\0`).join('')
const existsIn = (paths: string[]) => async (p: string): Promise<boolean> => paths.includes(p)

describe('repoFileList: listRepo, the whole listing of a repository', () => {
  it('is null when git refuses the folder', async () => {
    expect(await listRepo('/r', { git: fakeGit({ 'ls /r': null }), exists: existsIn(['/r/.git']) })).toBeNull()
  })

  it('keeps a drive or file-system root as it is (no trailing separator to trim)', async () => {
    expect(await listRepo('C:\\', { git: fakeGit({ 'ls C:\\': null }), exists: existsIn([]) })).toBeNull()
    expect(await listRepo('/', { git: fakeGit({ 'ls /': null }), exists: existsIn([]) })).toBeNull()
  })

  it('lists tracked and untracked files, sorted, and keeps a tracked file in a skip folder (the code index reads what was committed)', async () => {
    const git = fakeGit({ 'ls /r': z('? b.ts', 'H a.ts', 'H build/gen.ts') })
    expect(await listRepo('/r/', { git, exists: existsIn(['/r/.git']) })).toEqual({ files: ['a.ts', 'b.ts', 'build/gen.ts'], unreadable: [], capped: false })
  })

  it('drops untracked files in skip folders and virtual environments before anything reads them', async () => {
    const git = fakeGit({
      'ls /r': z(
        'H src/a.ts',
        '? src/b.ts',
        '? packages/x/node_modules/lib/index.js',
        '? .venv/lib/site.py',
        '? .tox/py/x.py',
        '? app/obj/Debug/x.cs',
        '? env/pyvenv.cfg',
        '? env/lib/y.py',
        '? tools/py/pyvenv.cfg',
        '? tools/py/lib/z.py',
        '? src/env/config.ts',
        '? dist/app.bundle.js',
        '? src/app.bundle.js',
        '? node_modules/x�.js',
        '? src/q�.ts'
      )
    })
    expect(await listRepo('/r', { git, exists: existsIn(['/r/.git']) })).toEqual({
      files: ['src/a.ts', 'src/b.ts', 'src/env/config.ts'],
      unreadable: ['src/q�.ts'],
      capped: false
    })
  })

  it('recurses into submodules declared at the root; the recursed listing replaces the tracked half, unreadable names included', async () => {
    const git = fakeGit({
      'ls /r': z('H .gitmodules', 'H libs/shared', 'H src/a.ts', 'H t�.ts', '? src/new.ts'),
      'sub /r': z('.gitmodules', 'libs/shared/x.ts', 'libs/shared/w�.ts', 'src/a.ts', 't�.ts')
    })
    expect(await listRepo('/r', { git, exists: existsIn(['/r/.git', '/r/.gitmodules']) })).toEqual({
      files: ['.gitmodules', 'libs/shared/x.ts', 'src/a.ts', 'src/new.ts'],
      unreadable: ['libs/shared/w�.ts', 't�.ts'],
      capped: false
    })
  })

  it('keeps the own listing when the submodule listing fails', async () => {
    const git = fakeGit({ 'ls /r': z('H .gitmodules', 'H libs/shared', 'H src/a.ts', 'H t�.ts'), 'sub /r': null })
    expect(await listRepo('/r', { git, exists: existsIn(['/r/.git', '/r/.gitmodules']) })).toEqual({
      files: ['.gitmodules', 'libs/shared', 'src/a.ts'],
      unreadable: ['t�.ts'],
      capped: false
    })
  })

  it('finds submodules from the repository top when the folder is a subfolder of the repository', async () => {
    const git = fakeGit({
      'ls /r/services': z('H a.ts', 'H lib'),
      'top /r/services': '/r\n',
      'sub /r/services': z('a.ts', 'lib/x.ts')
    })
    expect(await listRepo('/r/services', { git, exists: existsIn(['/r/.gitmodules']) })).toEqual({ files: ['a.ts', 'lib/x.ts'], unreadable: [], capped: false })
  })

  it('a subfolder of a repository without submodules runs no submodule listing; nor does a failed top lookup', async () => {
    const git = fakeGit({ 'ls /r/services': z('H a.ts'), 'top /r/services': '/r\n' })
    expect(await listRepo('/r/services', { git, exists: existsIn([]) })).toEqual({ files: ['a.ts'], unreadable: [], capped: false })
    const refused = fakeGit({ 'ls /r/services': z('H a.ts'), 'top /r/services': null })
    expect(await listRepo('/r/services', { git: refused, exists: existsIn([]) })).toEqual({ files: ['a.ts'], unreadable: [], capped: false })
  })

  it('lists a nested repository (not a submodule) with its own listing, under the same rules, to the nesting limit', async () => {
    const git = fakeGit({
      'ls /r': z('H src/a.ts', '? tools/sdk/', '? notrepo/', '? node_modules/dep/', '? refused/'),
      'ls /r/tools/sdk': z('H index.ts', '? new.ts', '? node_modules/x.js', '? deeper/', '? n�.ts'),
      'ls /r/tools/sdk/deeper': z('H d.ts', '? d2/'),
      'ls /r/tools/sdk/deeper/d2': z('H e.ts', '? d3/'),
      'ls /r/refused': null
    })
    const exists = existsIn(['/r/.git', '/r/tools/sdk/.git', '/r/tools/sdk/deeper/.git', '/r/tools/sdk/deeper/d2/.git', '/r/tools/sdk/deeper/d2/d3/.git', '/r/refused/.git'])
    expect(NESTED_DEPTH).toBe(3)
    expect(await listRepo('/r', { git, exists })).toEqual({
      files: ['src/a.ts', 'tools/sdk/deeper/d.ts', 'tools/sdk/deeper/d2/e.ts', 'tools/sdk/index.ts', 'tools/sdk/new.ts'],
      unreadable: ['tools/sdk/n�.ts'],
      capped: false
    })
    // The dependency folder's repository is never listed, nor one past the limit.
    expect(git.mock.calls.map((c) => c[0][c[0].indexOf('-C') + 1])).not.toContain('/r/node_modules/dep')
    expect(git.mock.calls.map((c) => c[0][c[0].indexOf('-C') + 1])).not.toContain('/r/tools/sdk/deeper/d2/d3')
  })

  it('nested repositories share one file cap; the root repository is not cut', async () => {
    const many = (n: number, pre: string): string[] => Array.from({ length: n }, (_, i) => `H ${pre}${String(i).padStart(6, '0')}.ts`)
    const git = fakeGit({
      'ls /r': z(...many(5, 'root'), '? a/', '? b/'),
      'ls /r/a': z(...many(MAP_FILE_CAP - 2, 'f')),
      'ls /r/b': z(...many(5, 'g'))
    })
    const got = await listRepo('/r', { git, exists: existsIn(['/r/.git', '/r/a/.git', '/r/b/.git']) })
    expect(got?.capped).toBe(true)
    expect(got?.files.length).toBe(5 + MAP_FILE_CAP)
    expect(got?.files.filter((f) => f.startsWith('b/'))).toEqual(['b/g000000.ts', 'b/g000001.ts'])
  })

  it('keeps at most the cap of unreadable names', async () => {
    const bad = Array.from({ length: MAP_FILE_CAP + 3 }, (_, i) => `H x${i}�.ts`)
    const got = await listRepo('/r', { git: fakeGit({ 'ls /r': z(...bad) }), exists: existsIn(['/r/.git']) })
    expect(got?.unreadable.length).toBe(MAP_FILE_CAP)
  })
})
