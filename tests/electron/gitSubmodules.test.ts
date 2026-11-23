import { describe, expect, it, vi } from 'vitest'
import {
  dirtySubmodules, foldSubmoduleRows, gitlinkPaths, MAX_DEPTH, MAX_SUBMODULES_PER_POLL, parseGitmodules, quotePath,
  statusShape, submoduleState, withSubmoduleEdits, type DirtySubmodule, type SubmoduleDeps
} from '../../src/main/gitSubmodules'

describe('parseGitmodules', () => {
  it('reads each section’s path and ignore, unquoting values and dropping comments', () => {
    const text = [
      '# top comment', '[core]', '\tpath = not-a-submodule',
      '[submodule "a"]', '\tpath = libs/a', '\turl = ../a',
      '[submodule "my sub"]', '\tpath = "my sub" ; trailing comment', '\tignore = untracked',
      '[Submodule "c"]', '\tPATH = c/', '\tIGNORE = Dirty',
      '[submodule "d"]', '\tpath = d', '\tignore = all', '\tbogus line',
      '[submodule "e"]', '\tpath = we\\"ird\\tx\\n', '\tignore = sometimes'
    ].join('\r\n')
    expect(parseGitmodules(text)).toEqual([
      { path: 'libs/a', ignore: 'none' },
      { path: 'my sub', ignore: 'untracked' },
      { path: 'c', ignore: 'dirty' },
      { path: 'd', ignore: 'all' },
      { path: 'we"ird\tx', ignore: 'none' }
    ])
  })

  it('drops a path that leaves the repository, an empty one, and a repeat', () => {
    const sec = (p: string): string => `[submodule "x"]\n\tpath = ${p}\n`
    const text = ['../out', '/abs', 'C:/abs', 'a/../b', './a', 'a//b', 'a\\\\b', 'tail\\', '', 'ok', 'ok'].map(sec).join('')
    expect(parseGitmodules(text)).toEqual([{ path: 'ok', ignore: 'none' }])
    expect(parseGitmodules('[submodule "x"]\n\turl = u\n')).toEqual([])
    expect(parseGitmodules('[submodule "x"]\n\tpath = x\\bz\n')).toEqual([{ path: 'x\bz', ignore: 'none' }])
  })
})

describe('gitlinkPaths', () => {
  it('keeps stage-0 gitlinks only', () => {
    const ls = ['160000 abc 0\tsub', '100644 def 0\tfile', '160000 abc 1\tconflicted', 'garbage', '160000 abc 0\tmy sub', ''].join('\0')
    expect([...gitlinkPaths(ls)]).toEqual(['sub', 'my sub'])
  })
})

describe('statusShape', () => {
  it('knows porcelain v1 and short, with -z, -b and an untracked-files choice', () => {
    expect(statusShape(['status', '--porcelain', '-b', '-z'])).toEqual({ format: 'porcelain', z: true, untrackedNo: false })
    expect(statusShape(['status', '--porcelain=v1', '--untracked-files=no'])).toEqual({ format: 'porcelain', z: false, untrackedNo: true })
    expect(statusShape(['status', '-s', '--branch', '-uno', '-uall'])).toEqual({ format: 'short', z: false, untrackedNo: false })
    expect(statusShape(['status', '--short'])).toEqual({ format: 'short', z: false, untrackedNo: false })
  })

  it('leaves anything else alone', () => {
    for (const args of [
      ['status'], ['status', '-z'], ['status', '--porcelain=v2'], ['status', '--porcelain', '--', 'a'],
      ['status', '--porcelain', '--short'], ['status', '--short', '--porcelain'], ['status', '--porcelain', '--ignore-submodules=none'],
      ['-C', 'x', 'status', '--porcelain'], ['diff', '--porcelain'], []
    ]) expect(statusShape(args)).toBeNull()
  })
})

describe('quotePath', () => {
  it('quotes as git status does: a space, a quote, a backslash, control bytes and anything above ASCII', () => {
    expect(quotePath('plain/path')).toBe('plain/path')
    expect(quotePath('my sub')).toBe('"my sub"')
    expect(quotePath('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(quotePath('t\tn\nb\bv\vf\fr\ra\x07')).toBe('"t\\tn\\nb\\bv\\vf\\fr\\ra\\a"')
    expect(quotePath('x\x01\x7f')).toBe('"x\\001\\177"')
    expect(quotePath('é')).toBe('"\\303\\251"')
  })
})

describe('submoduleState', () => {
  it('reads a submodule’s own porcelain -z status', () => {
    expect(submoduleState('')).toBeNull()
    expect(submoduleState('## main\0')).toBeNull()
    expect(submoduleState('?? new\0!! ign\0')).toBe('untracked')
    expect(submoduleState('?? new\0 M a\0')).toBe('modified')
  })
})

describe('foldSubmoduleRows', () => {
  const mod: DirtySubmodule = { path: 'my sub', state: 'modified' }
  const unt: DirtySubmodule = { path: 'sub2', state: 'untracked' }

  it('writes porcelain -z rows after the tracked changes and before untracked ones', () => {
    const shape = { format: 'porcelain', z: true, untrackedNo: false } as const
    expect(foldSubmoduleRows('## main\0 M a\0?? n\0', shape, [mod, unt], '')).toBe('## main\0 M a\0 M my sub\0 M sub2\0?? n\0')
    expect(foldSubmoduleRows('', shape, [mod], '')).toBe(' M my sub\0')
    expect(foldSubmoduleRows(' M a\0', shape, [], '')).toBe(' M a\0')
  })

  it('writes porcelain rows root-relative and quoted, whatever folder status ran in', () => {
    const shape = { format: 'porcelain', z: false, untrackedNo: false } as const
    expect(foldSubmoduleRows(' M a\n', shape, [mod, unt], 'src')).toBe(' M a\n M "my sub"\n M sub2\n')
  })

  it('writes short rows as m or ?, relative to the folder and quoted outside -z, root-relative inside it', () => {
    expect(foldSubmoduleRows('', { format: 'short', z: false, untrackedNo: false }, [mod, unt], 'src')).toBe(' m "../my sub"\n ? ../sub2\n')
    expect(foldSubmoduleRows('?? x\n', { format: 'short', z: false, untrackedNo: false }, [mod], '')).toBe(' m "my sub"\n?? x\n')
    expect(foldSubmoduleRows('', { format: 'short', z: true, untrackedNo: false }, [mod, unt], 'src')).toBe(' m my sub\0 ? sub2\0')
  })

  it('places a row among the tracked changes in path order, as git sorts them, keeping a -z rename with its source', () => {
    const z = { format: 'porcelain', z: true, untrackedNo: false } as const
    expect(foldSubmoduleRows(' M a\0 M z\0?? b\0', z, [mod], '')).toBe(' M a\0 M my sub\0 M z\0?? b\0')
    expect(foldSubmoduleRows('R  b\0a\0 M z\0', z, [unt], '')).toBe('R  b\0a\0 M sub2\0 M z\0')
    expect(foldSubmoduleRows(' M z\0', z, [unt], '')).toBe(' M sub2\0 M z\0')
    const lines = { format: 'porcelain', z: false, untrackedNo: false } as const
    expect(foldSubmoduleRows(' M "a b"\n M zz\n', lines, [mod], '')).toBe(' M "a b"\n M "my sub"\n M zz\n')
  })

  it('does not repeat a submodule the output already lists, by itself or in a rename', () => {
    const z = { format: 'porcelain', z: true, untrackedNo: false } as const
    expect(foldSubmoduleRows(' M my sub\0', z, [mod], '')).toBe(' M my sub\0')
    expect(foldSubmoduleRows('R  sub2\0old\0', z, [unt], '')).toBe('R  sub2\0old\0')
    const lines = { format: 'porcelain', z: false, untrackedNo: false } as const
    expect(foldSubmoduleRows('R  x -> sub2\n', lines, [unt], '')).toBe('R  x -> sub2\n')
    // Output with no closing separator keeps none.
    expect(foldSubmoduleRows(' M a', lines, [unt], '')).toBe(' M a\n M sub2')
  })
})

function deps(over: Partial<SubmoduleDeps> = {}): SubmoduleDeps {
  return {
    topLevel: async () => '/r',
    readText: async () => '[submodule "s"]\n\tpath = s\n[submodule "t"]\n\tpath = t\n\tignore = untracked\n[submodule "u"]\n\tpath = u\n\tignore = dirty\n',
    exists: async () => true,
    git: async (args) => (args[0] === 'ls-files' ? '160000 a 0\ts\u0000160000 b 0\tt\0' : ' M f\0'),
    join: (root, rel) => `${root}/${rel}`,
    relative: () => '',
    ...over
  }
}

describe('dirtySubmodules', () => {
  it('asks each listed, checked-out gitlink for its own status, honouring ignore', async () => {
    const git = vi.fn(deps().git)
    expect(await dirtySubmodules('/r', false, 0, deps({ git }))).toEqual([{ path: 's', state: 'modified' }, { path: 't', state: 'modified' }])
    expect(git.mock.calls).toEqual([
      [['ls-files', '-z', '-s', '--', ':(literal)s', ':(literal)t'], '/r', 0],
      [['status', '--porcelain', '-z'], '/r/s', 1],
      [['status', '--porcelain', '-z', '--untracked-files=no'], '/r/t', 1]
    ])
    const noUntracked = vi.fn(deps().git)
    await dirtySubmodules('/r', true, 1, deps({ git: noUntracked }))
    expect(noUntracked.mock.calls[1]).toEqual([['status', '--porcelain', '-z', '--untracked-files=no'], '/r/s', 2])
  })

  it('finds nothing without a .gitmodules, without a wanted entry, or when the listing fails', async () => {
    expect(await dirtySubmodules('/r', false, 0, deps({ readText: async () => null }))).toEqual([])
    expect(await dirtySubmodules('/r', false, 0, deps({ readText: async () => '[submodule "u"]\n\tpath = u\n\tignore = all\n' }))).toEqual([])
    expect(await dirtySubmodules('/r', false, 0, deps({ git: async () => { throw new Error('no') } }))).toEqual([])
  })

  it('skips one that is not a gitlink, not checked out, clean, or whose status fails', async () => {
    const d = deps({
      exists: async (p) => p !== '/r/t/.git',
      git: async (args, cwd) => {
        if (args[0] === 'ls-files') return '160000 a 0\ts\u0000160000 b 0\tt\0'
        throw new Error(cwd)
      }
    })
    expect(await dirtySubmodules('/r', false, 0, d)).toEqual([])
    expect(await dirtySubmodules('/r', false, 0, deps({ git: async (a) => (a[0] === 'ls-files' ? '100644 a 0\ts\0' : ' M x\0') }))).toEqual([])
    expect(await dirtySubmodules('/r', false, 0, deps({ git: async (a) => (a[0] === 'ls-files' ? '160000 a 0\ts\0' : '') }))).toEqual([])
    expect(await dirtySubmodules('/r', false, 0, deps({ git: async (a) => (a[0] === 'ls-files' ? '160000 a 0\ts\0' : '?? n\0') }))).toEqual([{ path: 's', state: 'untracked' }])
  })

  it('looks into at most MAX_SUBMODULES_PER_POLL a poll', async () => {
    const n = MAX_SUBMODULES_PER_POLL + 3
    const names = Array.from({ length: n }, (_, i) => `m${i}`)
    const git = vi.fn(async (args: string[]) => (args[0] === 'ls-files' ? names.map((p) => `160000 a 0\t${p}`).join('\0') : ' M f\0'))
    const d = deps({ readText: async () => names.map((p) => `[submodule "${p}"]\n\tpath = ${p}\n`).join(''), git })
    expect(await dirtySubmodules('/r', false, 0, d)).toHaveLength(MAX_SUBMODULES_PER_POLL)
  })
})

describe('withSubmoduleEdits', () => {
  const pass = (_r: string, _u: boolean, load: () => Promise<DirtySubmodule[]>): Promise<DirtySubmodule[]> => load()

  it('writes the dirty submodules into a status it knows the shape of', async () => {
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', ' M a\0', 0, deps(), pass)).toBe(' M a\0 M s\0 M t\0')
  })

  it('leaves any other command, an unknown shape, MAX_DEPTH, a folder outside a repository and a failure alone', async () => {
    const out = ' M a\0'
    expect(await withSubmoduleEdits(['diff', '--numstat', '-z'], '/r', out, 0, deps(), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', out, MAX_DEPTH, deps(), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', out, 0, deps({ topLevel: async () => null }), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', out, 0, deps({ topLevel: async () => { throw new Error('x') } }), pass)).toBe(out)
  })

  it('hands the cache the root and the untracked choice', async () => {
    const cached = vi.fn(async () => [] as DirtySubmodule[])
    await withSubmoduleEdits(['status', '--porcelain', '--untracked-files=no'], '/r/src', '', 0, deps(), cached)
    expect(cached).toHaveBeenCalledWith('/r', true, expect.any(Function))
  })
})
