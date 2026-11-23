// gitSafety.ts: the builder every git read in src/main goes through. What it adds, where, and what it leaves alone.
import { describe, expect, it } from 'vitest'
import {
  FILTER_SUBCOMMANDS,
  MUTATING_SUBCOMMANDS,
  UnsafeFilterError,
  displayFlags,
  filterOverrides,
  filterScanArgs,
  gitSubcommand,
  guardGitArgs,
  needsFilterScan,
  nullDevice,
  readOnlyPrefix,
  safetyFlags
} from '../../src/main/gitSafety'

const PREFIX_WIN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium']
const PREFIX_POSIX = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium']

describe('nullDevice and safetyFlags', () => {
  it('points hooks at the null device of the platform', () => {
    expect(nullDevice(true)).toBe('NUL')
    expect(nullDevice(false)).toBe('/dev/null')
  })

  it('keeps the four flags every Lumopolis world git run has always carried', () => {
    expect(safetyFlags(true)).toEqual(['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=NUL', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false'])
    expect(safetyFlags(false)[3]).toBe('core.hooksPath=/dev/null')
  })
})

describe('readOnlyPrefix', () => {
  it('switches off fsmonitor, hooks and signature checks, and pins the default log format', () => {
    expect(readOnlyPrefix('status', true)).toEqual(PREFIX_WIN)
    expect(readOnlyPrefix('log', false)).toEqual(PREFIX_POSIX)
  })

  it('rev-parse keeps the hooks folder, so `rev-parse --git-path hooks` still names the real one', () => {
    expect(readOnlyPrefix('rev-parse', true)).toEqual(['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium'])
  })
})

describe('displayFlags', () => {
  it('diff: no external diff, no textconv, submodules by commit, no submodule dirty check', () => {
    expect(displayFlags('diff')).toEqual(['--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty'])
  })

  it('show and log: no external diff, no textconv, submodules by commit', () => {
    expect(displayFlags('show')).toEqual(['--no-ext-diff', '--no-textconv', '--submodule=short'])
    expect(displayFlags('log')).toEqual(['--no-ext-diff', '--no-textconv', '--submodule=short'])
  })

  it('status: no submodule dirty check; anything else: nothing', () => {
    expect(displayFlags('status')).toEqual(['--ignore-submodules=dirty'])
    expect(displayFlags('rev-parse')).toEqual([])
    expect(displayFlags('ls-files')).toEqual([])
  })
})

describe('gitSubcommand', () => {
  it('finds the subcommand after global options, skipping the value of the ones that take one', () => {
    expect(gitSubcommand(['status'])).toEqual({ index: 0, name: 'status' })
    expect(gitSubcommand(['-C', '/r', '-c', 'a.b=c', '--no-pager', 'log', '-1'])).toEqual({ index: 5, name: 'log' })
    for (const g of ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source']) {
      expect(gitSubcommand([g, 'x', 'diff'])).toEqual({ index: 2, name: 'diff' })
    }
  })

  it('is null when there is none', () => {
    expect(gitSubcommand([])).toBeNull()
    expect(gitSubcommand(['--version'])).toBeNull()
    expect(gitSubcommand(['-c', 'a=b'])).toBeNull()
  })
})

describe('needsFilterScan', () => {
  it('status and diff can run a clean filter; nothing else does', () => {
    expect([...FILTER_SUBCOMMANDS]).toEqual(['status', 'diff'])
    expect(needsFilterScan(['status', '--porcelain'])).toBe(true)
    expect(needsFilterScan(['-C', '/r', 'diff', '--numstat'])).toBe(true)
    expect(needsFilterScan(['log', '-1'])).toBe(false)
    expect(needsFilterScan(['--version'])).toBe(false)
  })
})

describe('guardGitArgs', () => {
  it('a read gets the prefix before the subcommand and the display flags after it', () => {
    expect(guardGitArgs(['status', '--porcelain', '-b', '-z'], true)).toEqual([...PREFIX_WIN, 'status', '--ignore-submodules=dirty', '--porcelain', '-b', '-z'])
    expect(guardGitArgs(['diff', '--cached', '--', 'a b.ts'], false)).toEqual([
      ...PREFIX_POSIX, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty', '--cached', '--', 'a b.ts'
    ])
    expect(guardGitArgs(['rev-parse', 'HEAD'], true)).toEqual([...readOnlyPrefix('rev-parse', true), 'rev-parse', 'HEAD'])
  })

  it('an unknown subcommand counts as a read: only a named write is left alone', () => {
    expect(guardGitArgs(['frobnicate'], false)).toEqual([...PREFIX_POSIX, 'frobnicate'])
  })

  it('every write runs exactly as written: filters, hooks and the login helper stay the person’s own', () => {
    for (const sub of MUTATING_SUBCOMMANDS) expect(guardGitArgs([sub, 'x'], true)).toEqual([sub, 'x'])
    for (const sub of ['add', 'reset', 'checkout', 'apply', 'commit', 'pull', 'push']) expect(MUTATING_SUBCOMMANDS.has(sub)).toBe(true)
    expect(guardGitArgs(['-C', '/r', 'add', '--', 'f'], true)).toEqual(['-C', '/r', 'add', '--', 'f'])
  })

  it('global options stay first; the prefix and filter overrides come after them, so they win over a caller -c', () => {
    const over = ['-c', 'filter.x.clean=']
    expect(guardGitArgs(['-C', '/r', '-c', 'core.fsmonitor=true', 'status'], true, over)).toEqual([
      '-C', '/r', '-c', 'core.fsmonitor=true', ...PREFIX_WIN, ...over, 'status', '--ignore-submodules=dirty'
    ])
  })

  it('a prefix pair the caller already gave with the same value is not repeated (case of the key ignored)', () => {
    expect(guardGitArgs(['-c', 'Core.FSMonitor=false', 'log'], true)).toEqual([
      '-c', 'Core.FSMonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium',
      'log', '--no-ext-diff', '--no-textconv', '--submodule=short'
    ])
    // A dangling `-c` and a pair with no `=` are passed through and never match.
    expect(guardGitArgs(['-c', 'novalue', 'log'], false).slice(0, 4)).toEqual(['-c', 'novalue', '-c', 'core.fsmonitor=false'])
  })

  it('a display flag the caller already gave before `--` is not repeated; one after `--` is a path and does not count', () => {
    expect(guardGitArgs(['diff', '--cached', '--no-color', '--no-ext-diff'], false)).toEqual([
      ...PREFIX_POSIX, 'diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty', '--cached', '--no-color', '--no-ext-diff'
    ])
    expect(guardGitArgs(['diff', '--', '--no-textconv'], false)).toEqual([
      ...PREFIX_POSIX, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty', '--', '--no-textconv'
    ])
  })

  it('with no subcommand, the prefix goes first', () => {
    expect(guardGitArgs(['--version'], true)).toEqual([...PREFIX_WIN, '--version'])
  })
})

describe('filterScanArgs', () => {
  it('reads every filter setting with its scope, under the read-only prefix', () => {
    expect(filterScanArgs(['status'], true)).toEqual([...PREFIX_WIN, 'config', '--show-scope', '-z', '--get-regexp', '^filter\\.'])
  })

  it('keeps the -C of the command it serves and nothing else of its global options', () => {
    expect(filterScanArgs(['-C', '/r', '-c', 'a=b', '--no-pager', 'diff'], false)).toEqual([
      '-C', '/r', ...PREFIX_POSIX, 'config', '--show-scope', '-z', '--get-regexp', '^filter\\.'
    ])
    expect(filterScanArgs(['--version'], false)[0]).toBe('-c')
  })
})

describe('filterOverrides', () => {
  const entry = (scope: string, key: string, value: string): string => `${scope}\0${key}\n${value}\0`

  it('no filter settings: nothing to switch off', () => {
    expect(filterOverrides('')).toEqual([])
  })

  it('a driver the repository defines gets no program and required=false', () => {
    expect(filterOverrides(entry('local', 'filter.evil.clean', 'sh plant.sh') + entry('local', 'filter.evil.required', 'true'))).toEqual([
      '-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false'
    ])
  })

  it('a global driver alone (git-lfs as `git lfs install` sets it) is left exactly as it is', () => {
    const lfs = entry('global', 'filter.lfs.clean', 'git-lfs clean -- %f') + entry('global', 'filter.lfs.process', 'git-lfs filter-process') + entry('system', 'filter.lfs.required', 'true')
    expect(filterOverrides(lfs)).toEqual([])
  })

  it('a repository that redefines a global driver gets the person’s own settings back, the rest emptied', () => {
    const scan = entry('global', 'filter.lfs.process', 'git-lfs filter-process') + entry('command', 'filter.lfs.required', 'true') +
      entry('local', 'filter.lfs.process', 'sh plant.sh') + entry('worktree', 'filter.lfs.clean', 'sh plant.sh')
    expect(filterOverrides(scan)).toEqual([
      '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true'
    ])
  })

  it('an included file reports as local and a later git’s unknown scope counts as the repository’s', () => {
    expect(filterOverrides(entry('frobbed', 'filter.a.clean', 'x'))).toHaveLength(8)
  })

  it('a name with dots, spaces, quotes or non-ASCII is kept whole; the variable is read case-blind', () => {
    const out = filterOverrides(entry('local', 'filter.a.b c"é.CLEAN', 'x') + entry('global', 'filter.a.b c"é.Smudge', 'own'))
    expect(out).toEqual([
      '-c', 'filter.a.b c"é.clean=', '-c', 'filter.a.b c"é.smudge=own', '-c', 'filter.a.b c"é.process=', '-c', 'filter.a.b c"é.required=false'
    ])
  })

  it('each driver is switched off once however many settings it has', () => {
    expect(filterOverrides(entry('local', 'filter.x.clean', '1') + entry('local', 'filter.x.smudge', '2'))).toHaveLength(8)
  })

  it('a key with no value line, or with no variable, is read safely', () => {
    expect(filterOverrides('local\0filter.x.required\0')).toHaveLength(8)
    expect(filterOverrides(entry('local', 'filter', 'x') + entry('local', 'filter.x', 'y'))).toEqual([])
  })

  it('a driver name holding `=` cannot be written as a -c key: the read is refused, never run with it on', () => {
    expect(() => filterOverrides(entry('local', 'filter.a=b.clean', 'x'))).toThrow(UnsafeFilterError)
    try {
      filterOverrides(entry('local', 'filter.a=b.clean', 'x'))
    } catch (e) {
      expect((e as Error).name).toBe('UnsafeFilterError')
      expect((e as Error).message).toContain('"a=b"')
    }
  })
})
