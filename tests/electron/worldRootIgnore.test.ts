import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { foldsCaseAt, parseRootIgnore, readRootIgnore } from '../../src/main/world/rootIgnore'

describe('rootIgnore: the plain patterns of a walked folder\'s own .gitignore', () => {
  it('a name or glob with no slash matches at any depth, files and folders alike', () => {
    const ig = parseRootIgnore('# a comment\n\n*.log\ngenerated\ntmp?.ts   \n')
    expect(ig('app.log', false)).toBe(true)
    expect(ig('src/deep/app.log', false)).toBe(true)
    expect(ig('generated', true)).toBe(true)
    expect(ig('src/generated', true)).toBe(true)
    expect(ig('src/generated', false)).toBe(true)
    expect(ig('src/tmp1.ts', false)).toBe(true)
    expect(ig('src/tmp12.ts', false)).toBe(false)
    expect(ig('src/app.ts', false)).toBe(false)
    // A comment line is not a pattern.
    expect(ig('# a comment', false)).toBe(false)
  })

  it('a trailing slash matches folders only', () => {
    const ig = parseRootIgnore('cache/\n')
    expect(ig('cache', true)).toBe(true)
    expect(ig('src/cache', true)).toBe(true)
    expect(ig('cache', false)).toBe(false)
  })

  it('a leading or inner slash anchors the pattern to the folder', () => {
    const ig = parseRootIgnore('/root-only.ts\nsrc/gen\n/build/\n')
    expect(ig('root-only.ts', false)).toBe(true)
    expect(ig('sub/root-only.ts', false)).toBe(false)
    expect(ig('src/gen', true)).toBe(true)
    expect(ig('pkg/src/gen', true)).toBe(false)
    expect(ig('build', true)).toBe(true)
    expect(ig('pkg/build', true)).toBe(false)
  })

  it('** is any number of folders: a leading **/ floats the rest, a trailing /** is everything inside the folder (not the folder), an inner /**/ is zero or more folders, a lone ** is everything', () => {
    const ig = parseRootIgnore('**/fixtures/big\nlogs/**\na/**/b\n')
    expect(ig('fixtures/big', true)).toBe(true)
    expect(ig('a/b/fixtures/big', false)).toBe(true)
    expect(ig('a/fixtures', true)).toBe(false)
    expect(ig('logs', true)).toBe(false)
    expect(ig('logs/app.log', false)).toBe(true)
    expect(ig('logs/deep', true)).toBe(true)
    expect(ig('a/logs/app.log', false)).toBe(false)
    expect(ig('a/b', false)).toBe(true)
    expect(ig('a/x/y/b', true)).toBe(true)
    expect(ig('a/xb', false)).toBe(false)
    const every = parseRootIgnore('**\n')
    expect(every('x', false)).toBe(true)
    expect(every('d/e/f', true)).toBe(true)
    expect(parseRootIgnore('**/**/tmp\n')('a/tmp', true)).toBe(true)
  })

  it('a leading ! re-includes what an earlier line left out; the last line that matches decides, as in git', () => {
    const top = parseRootIgnore('/*\n!/src\n!package.json\n')
    expect(top('src', true)).toBe(false)
    expect(top('lib', true)).toBe(true)
    expect(top('package.json', false)).toBe(false)
    expect(top('README.md', false)).toBe(true)
    const only = parseRootIgnore('*\n!*/\n!*.ts\n')
    expect(only('src', true)).toBe(false)
    expect(only('a.ts', false)).toBe(false)
    expect(only('src/deep/b.ts', false)).toBe(false)
    expect(only('a.md', false)).toBe(true)
    expect(only('src/b.md', false)).toBe(true)
    // Order matters: a later exclusion wins over an earlier re-inclusion.
    expect(parseRootIgnore('*.log\n!keep.log\n*.log\n')('keep.log', false)).toBe(true)
    expect(parseRootIgnore('*.log\n!keep.log\n')('keep.log', false)).toBe(false)
    // A lone ! is no pattern.
    expect(parseRootIgnore('!\n')('a', false)).toBe(false)
  })

  it('leaves out what it does not support: character classes, escapes, empty parts', () => {
    const ig = parseRootIgnore('a//b\n[ab].js\n\\#lit.py\n\\!bang.ts\n')
    expect(ig('a/b', true)).toBe(false)
    expect(ig('a.js', false)).toBe(false)
    expect(ig('#lit.py', false)).toBe(false)
    expect(ig('!bang.ts', false)).toBe(false)
    // Regex characters in a name are literal.
    expect(parseRootIgnore('a+b.(x)\n')('a+b.(x)', false)).toBe(true)
  })

  it('an empty file ignores nothing', () => {
    expect(parseRootIgnore('')('a.ts', false)).toBe(false)
  })

  it('reads the folder\'s own .gitignore; none, or one it cannot read, is undefined', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-ignore-'))
    try {
      expect(await readRootIgnore(dir)).toBeUndefined()
      fs.writeFileSync(path.join(dir, '.gitignore'), 'out-of-here/\r\n')
      const ig = await readRootIgnore(dir)
      expect(ig?.('out-of-here', true)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // WP5, WP1 F1: git matches ignoring case when core.ignorecase is on, which it sets on a file system that folds case.
  it('matches ignoring case only when asked to', () => {
    const exact = parseRootIgnore('Build/\n*.LOG\n')
    expect(exact('build', true)).toBe(false)
    expect(exact('a.log', false)).toBe(false)
    expect(exact('Build', true)).toBe(true)
    const folded = parseRootIgnore('Build/\n*.LOG\n', { foldCase: true })
    expect(folded('build', true)).toBe(true)
    expect(folded('src/a.log', false)).toBe(true)
    expect(parseRootIgnore('*.log\n!Keep.log\n', { foldCase: true })('keep.LOG', false)).toBe(false)
  })

  it('asks the folder\'s file system whether it folds case, as git does: the .gitignore under another case is the same file', async () => {
    const ids = (map: Record<string, { dev: bigint | number; ino: bigint | number }>) =>
      async (p: string) => {
        const id = map[path.basename(p)]
        if (!id) throw new Error('ENOENT')
        return id
      }
    expect(await foldsCaseAt('/r', ids({ '.gitignore': { dev: 1n, ino: 9n }, '.GITIGNORE': { dev: 1n, ino: 9n } }))).toBe(true)
    expect(await foldsCaseAt('/r', ids({ '.gitignore': { dev: 1n, ino: 9n }, '.GITIGNORE': { dev: 1n, ino: 8n } }))).toBe(false)
    expect(await foldsCaseAt('/r', ids({ '.gitignore': { dev: 1n, ino: 9n }, '.GITIGNORE': { dev: 2n, ino: 9n } }))).toBe(false)
    expect(await foldsCaseAt('/r', ids({ '.gitignore': { dev: 1n, ino: 9n } }))).toBe(false)
    // No file ids (0), or no .gitignore at all: the platform decides (Windows and macOS fold case).
    const byPlatform = process.platform === 'win32' || process.platform === 'darwin'
    expect(await foldsCaseAt('/r', ids({ '.gitignore': { dev: 1, ino: 0 } }))).toBe(byPlatform)
    expect(await foldsCaseAt('/r', ids({}))).toBe(byPlatform)
  })

  it('reads a real folder\'s case rule into its matcher', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-ignore-case-'))
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'Dist/\n')
      const folds = await foldsCaseAt(dir)
      expect(folds).toBe(fs.existsSync(path.join(dir, '.GITIGNORE')))
      expect((await readRootIgnore(dir))?.('dist', true)).toBe(folds)
      const same = async () => ({ dev: 1n, ino: 5n })
      expect((await readRootIgnore(dir, same))?.('dist', true)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
