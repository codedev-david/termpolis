import { describe, expect, it } from 'vitest'
import { lsFilesArgs, lsSubmoduleArgs, mergeListings, parseLsFiles, unquoteGitPath } from '../../src/main/repoFileList'

describe('repoFileList: the git file listing every map reads', () => {
  it('lists tracked and untracked files, unquoted and NUL separated, honouring the ignore files', () => {
    expect(lsFilesArgs('/r')).toEqual(['-c', 'core.quotepath=false', '-C', '/r', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    // --recurse-submodules works only with --cached, so the submodules' files come from a second listing.
    expect(lsSubmoduleArgs('/r')).toEqual(['-c', 'core.quotepath=false', '-C', '/r', 'ls-files', '-z', '--cached', '--recurse-submodules'])
  })

  it('parses -z output: names with spaces, quotes, newlines and non-ASCII letters arrive as written', () => {
    expect(parseLsFiles('src/a.ts\0src/my file.ts\0src/a"b.ts\0src/new\nline.ts\0src/café.ts\0src/日本/データ.ts\0src/😀.ts\0')).toEqual([
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
    expect(parseLsFiles(out)).toEqual([
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
    expect(parseLsFiles('a.ts\r\nb.ts\r\n')).toEqual(['a.ts', 'b.ts'])
  })

  it('drops duplicates and names that are not valid UTF-8 (the read would miss them)', () => {
    expect(parseLsFiles('a.ts\0a.ts\0b�.ts\0')).toEqual(['a.ts'])
    expect(parseLsFiles('"b\\377.ts"\na.ts\n')).toEqual(['a.ts'])
    expect(parseLsFiles('')).toEqual([])
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
