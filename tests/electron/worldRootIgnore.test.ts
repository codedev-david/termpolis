import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseRootIgnore, readRootIgnore } from '../../src/main/world/rootIgnore'

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

  it('a leading **/ floats the rest; a trailing /** is the folder itself', () => {
    const ig = parseRootIgnore('**/fixtures/big\nlogs/**\n')
    expect(ig('fixtures/big', true)).toBe(true)
    expect(ig('a/b/fixtures/big', false)).toBe(true)
    expect(ig('a/fixtures', true)).toBe(false)
    expect(ig('logs', true)).toBe(true)
    expect(ig('logs', false)).toBe(false)
    expect(ig('a/logs', true)).toBe(false)
  })

  it('leaves out what it does not support: negation, other **, character classes, escapes', () => {
    const ig = parseRootIgnore('*.ts\n!keep.ts\na/**/b\n[ab].js\n\\#lit.py\n')
    // The negation is not honoured: keep.ts stays ignored, as *.ts says.
    expect(ig('keep.ts', false)).toBe(true)
    expect(ig('a/x/b', true)).toBe(false)
    expect(ig('a.js', false)).toBe(false)
    expect(ig('#lit.py', false)).toBe(false)
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
})
