import { describe, expect, it, vi } from 'vitest'
import {
  dirtySubmodules, foldSubmoduleRows, gitlinkPaths, MAX_DEPTH, MAX_GIT_AT_ONCE, MAX_GIT_PER_POLL, parseGitmodules, quotePath,
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

const TOP = '[submodule "s"]\n\tpath = s\n[submodule "t"]\n\tpath = t\n\tignore = untracked\n[submodule "u"]\n\tpath = u\n\tignore = dirty\n'

function deps(over: Partial<SubmoduleDeps> = {}): SubmoduleDeps {
  return {
    topLevel: async () => '/r',
    readText: async (file) => (file === '/r/.gitmodules' ? TOP : null),
    exists: async () => true,
    git: async (args) => (args[0] === 'ls-files' ? '160000 a 0\ts\u0000160000 b 0\tt\0' : ' M f\0'),
    join: (root, rel) => `${root}/${rel}`,
    relative: () => '',
    ...over
  }
}

/** A planted tree: every repository down to `levels` below /r lists `width` submodules m0…, each checked out. `status`
 *  answers each submodule's own status by its folder. Counts the git calls and the most running at once. */
function tree(width: number, levels: number, status: (cwd: string) => string = () => '') {
  const names = Array.from({ length: width }, (_, i) => `m${i}`)
  const calls: string[][] = []
  let running = 0
  let most = 0
  const d = deps({
    readText: async (file) => (file.split('/').length - 3 < levels ? names.map((p) => `[submodule "${p}"]\n\tpath = ${p}\n`).join('') : null),
    git: async (args, cwd) => {
      calls.push([args[0], cwd])
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 1))
      running--
      return args[0] === 'ls-files' ? names.map((p) => `160000 a 0\t${p}`).join('\0') : status(cwd)
    }
  })
  return { d, calls, most: () => most }
}

describe('dirtySubmodules', () => {
  it('asks each listed, checked-out gitlink for its own status, honouring ignore', async () => {
    const git = vi.fn(deps().git)
    expect(await dirtySubmodules('/r', false, deps({ git }))).toEqual([{ path: 's', state: 'modified' }, { path: 't', state: 'modified' }])
    expect(git.mock.calls).toEqual([
      [['ls-files', '-z', '-s', '--', ':(literal)s', ':(literal)t'], '/r'],
      [['status', '--porcelain', '-z'], '/r/s'],
      [['status', '--porcelain', '-z', '--untracked-files=no'], '/r/t']
    ])
    const noUntracked = vi.fn(deps().git)
    await dirtySubmodules('/r', true, deps({ git: noUntracked }))
    expect(noUntracked.mock.calls[1]).toEqual([['status', '--porcelain', '-z', '--untracked-files=no'], '/r/s'])
  })

  it('finds nothing without a .gitmodules, without a wanted entry, or when the listing fails', async () => {
    expect(await dirtySubmodules('/r', false, deps({ readText: async () => null }))).toEqual([])
    expect(await dirtySubmodules('/r', false, deps({ readText: async () => '[submodule "u"]\n\tpath = u\n\tignore = all\n' }))).toEqual([])
    expect(await dirtySubmodules('/r', false, deps({ git: async () => { throw new Error('no') } }))).toEqual([])
  })

  it('skips one that is not a gitlink, not checked out, clean, or whose status fails', async () => {
    const d = deps({
      exists: async (p) => p !== '/r/t/.git',
      git: async (args, cwd) => {
        if (args[0] === 'ls-files') return '160000 a 0\ts\u0000160000 b 0\tt\0'
        throw new Error(cwd)
      }
    })
    expect(await dirtySubmodules('/r', false, d)).toEqual([])
    expect(await dirtySubmodules('/r', false, deps({ git: async (a) => (a[0] === 'ls-files' ? '100644 a 0\ts\0' : ' M x\0') }))).toEqual([])
    expect(await dirtySubmodules('/r', false, deps({ git: async (a) => (a[0] === 'ls-files' ? '160000 a 0\ts\0' : '') }))).toEqual([])
    expect(await dirtySubmodules('/r', false, deps({ git: async (a) => (a[0] === 'ls-files' ? '160000 a 0\ts\0' : '?? n\0') }))).toEqual([{ path: 's', state: 'untracked' }])
  })

  it('a change in a nested submodule, down to MAX_DEPTH levels, makes the top one modified; deeper is not looked into', async () => {
    // A chain /r/m0/m0/m0/m0/m0: a status at each of the first MAX_DEPTH levels, a listing above each but the last.
    const deepest = '/r' + '/m0'.repeat(MAX_DEPTH)
    const t = tree(1, 5, (cwd) => (cwd === deepest ? '?? new\0' : ''))
    expect(await dirtySubmodules('/r', false, t.d)).toEqual([{ path: 'm0', state: 'modified' }])
    const statuses = t.calls.filter((c) => c[0] === 'status').map((c) => c[1])
    expect(statuses).toEqual(['/r/m0', '/r/m0/m0', deepest])
    expect(t.calls.filter((c) => c[0] === 'ls-files')).toHaveLength(MAX_DEPTH)
    // Clean all the way down: nothing to report. Untracked files only, in the top one: untracked.
    expect(await dirtySubmodules('/r', false, tree(2, 3).d)).toEqual([])
    expect(await dirtySubmodules('/r', false, tree(1, 1, () => '?? n\0').d)).toEqual([{ path: 'm0', state: 'untracked' }])
    // A nested status that fails is not dirty, and its own submodules are not looked into.
    const failing = tree(1, 3)
    failing.d.git = async (args, cwd) => {
      if (cwd === '/r/m0') throw new Error('broken')
      return args[0] === 'ls-files' ? '160000 a 0\tm0' : ' M f\0'
    }
    expect(await dirtySubmodules('/r', false, failing.d)).toEqual([])
  })

  it('the planted 8×3 tree: at most MAX_GIT_PER_POLL git calls a poll over every level, at most MAX_GIT_AT_ONCE at once, and what was not checked shows as modified', async () => {
    const t = tree(8, 3)
    const dirty = await dirtySubmodules('/r', false, t.d)
    expect(t.calls.length).toBeLessThanOrEqual(MAX_GIT_PER_POLL)
    expect(MAX_GIT_PER_POLL).toBe(64)
    expect(t.most()).toBeLessThanOrEqual(MAX_GIT_AT_ONCE)
    expect(MAX_GIT_AT_ONCE).toBe(4)
    expect(t.calls.filter((c) => c[0] === 'status')[0][1]).toBe('/r/m0')
    // Every top submodule has nested ones the budget did not reach: none can be called clean.
    expect(dirty).toEqual(Array.from({ length: 8 }, (_, i) => ({ path: `m${i}`, state: 'modified' })))
    // The same tree checked within the budget, two wide (1 + 2 + 2 + 4 + 4 + 8 calls): every one is asked, none is dirty.
    const small = tree(2, 3)
    expect(await dirtySubmodules('/r', false, small.d)).toEqual([])
    expect(small.calls).toHaveLength(21)
  })

  it('more submodules than the budget in one repository: the ones past it are not looked into and show as modified', async () => {
    const t = tree(MAX_GIT_PER_POLL + 6, 1)
    const exists = vi.fn(async () => true)
    t.d.exists = exists
    const dirty = await dirtySubmodules('/r', false, t.d)
    expect(t.calls).toHaveLength(MAX_GIT_PER_POLL)
    expect(exists.mock.calls.length).toBeLessThanOrEqual(MAX_GIT_PER_POLL)
    expect(dirty.map((x) => x.path)).toEqual(Array.from({ length: 7 }, (_, i) => `m${MAX_GIT_PER_POLL - 1 + i}`))
    expect(dirty.every((x) => x.state === 'modified')).toBe(true)
  })
})

describe('withSubmoduleEdits', () => {
  const pass = (_r: string, _u: boolean, load: () => Promise<DirtySubmodule[]>): Promise<DirtySubmodule[]> => load()

  it('writes the dirty submodules into a status it knows the shape of', async () => {
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', ' M a\0', deps(), pass)).toBe(' M a\0 M s\0 M t\0')
  })

  it('leaves any other command, an unknown shape, a folder outside a repository and a failure alone', async () => {
    const out = ' M a\0'
    expect(await withSubmoduleEdits(['diff', '--numstat', '-z'], '/r', out, deps(), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z', '--', 'x'], '/r', out, deps(), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', out, deps({ topLevel: async () => null }), pass)).toBe(out)
    expect(await withSubmoduleEdits(['status', '--porcelain', '-z'], '/r', out, deps({ topLevel: async () => { throw new Error('x') } }), pass)).toBe(out)
  })

  it('hands the cache the root and the untracked choice', async () => {
    const cached = vi.fn(async () => [] as DirtySubmodule[])
    await withSubmoduleEdits(['status', '--porcelain', '--untracked-files=no'], '/r/src', '', deps(), cached)
    expect(cached).toHaveBeenCalledWith('/r', true, expect.any(Function))
  })
})
