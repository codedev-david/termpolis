import { describe, it, expect } from 'vitest'
const {
  familyForPath, looksLikeCode, guessFamily, outlineCode, stripNumbering,
  OUTLINE_MIN_LINES, OUTLINE_MIN_RUN, OUTLINE_MIN_GAIN, NUMBERED_MIN_RATIO,
} = await import('../../src/main/headroomProxy/codeOutline')

/**
 * A realistic TypeScript module: imports, a type, a class with methods, a free function, and
 * bodies long enough that dropping them is the whole point.
 */
const TS_SRC = `import { readFile, writeFile } from 'node:fs/promises'
import type { Thing, Options } from './types'

const DEFAULT_LIMIT = 20

export interface Loaded {
  path: string
  value: Thing
}

export class Loader {
  private cache = new Map<string, Thing>()

  async load(path: string): Promise<Thing> {
    const hit = this.cache.get(path)
    if (hit) {
      return hit
    }
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Thing
    this.cache.set(path, parsed)
    return parsed
  }

  async save(path: string, value: Thing): Promise<void> {
    const body = JSON.stringify(value, null, 2)
    await writeFile(path, body, 'utf8')
    this.cache.set(path, value)
    for (const key of this.cache.keys()) {
      if (key.startsWith('tmp/')) {
        this.cache.delete(key)
      }
    }
  }

  clear(): void {
    this.cache.clear()
  }
}

export function summarize(items: Thing[], opts: Options): string {
  const lines: string[] = []
  for (const item of items) {
    if (lines.length >= DEFAULT_LIMIT) {
      break
    }
    if (opts.verbose) {
      lines.push(\`\${item.name}: \${item.value} (verbose)\`)
    } else {
      lines.push(item.name)
    }
  }
  return lines.join('\\n')
}
`

const PY_SRC = `import os
import sys
from typing import Optional


DEFAULT_LIMIT = 20


class Loader:
    """Loads things."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.cache = {}
        self.hits = 0

    def load(self, name: str) -> Optional[str]:
        hit = self.cache.get(name)
        if hit is not None:
            self.hits += 1
            return hit
        path = os.path.join(self.root, name)
        with open(path) as fh:
            data = fh.read()
        self.cache[name] = data
        return data

    @property
    def size(self) -> int:
        return len(self.cache)


def summarize(items, limit=DEFAULT_LIMIT):
    out = []
    for item in items:
        if len(out) >= limit:
            break
        out.append(str(item))
    return "\\n".join(out)
`

/** Wrap source in the Read tool's `cat -n` gutter. */
function numbered(src: string): string {
  return src.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
}

describe('familyForPath', () => {
  it('maps brace-family and indent-family extensions', () => {
    for (const p of ['src/a.ts', 'a.tsx', 'x/y.go', 'Main.java', 'lib.rs', 'a.cpp', 'z.swift']) {
      expect(familyForPath(p)).toBe('brace')
    }
    for (const p of ['a.py', 'stub.pyi', 'app.rb', 'x.cr']) expect(familyForPath(p)).toBe('indent')
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(familyForPath('  C:\\src\\Main.TS  ')).toBe('brace')
    expect(familyForPath('SCRIPT.PY')).toBe('indent')
  })

  it('returns null for anything it does not recognise, including non-strings', () => {
    expect(familyForPath('notes.md')).toBeNull()
    expect(familyForPath('Makefile')).toBeNull()
    expect(familyForPath('archive.tar.gz')).toBeNull()
    expect(familyForPath(undefined)).toBeNull()
    expect(familyForPath(42)).toBeNull()
    expect(familyForPath(null)).toBeNull()
    expect(familyForPath({ file_path: 'a.ts' })).toBeNull()
  })
})

describe('stripNumbering', () => {
  it('removes a cat -n gutter and leaves the code indentation intact', () => {
    const out = stripNumbering(numbered('a\n  b\n\tc').split('\n'))
    expect(out).toEqual(['a', '  b', '\tc'])
  })

  it('refuses when the gutter is not overwhelmingly present', () => {
    const lines = ['     1\tone', 'plain two', 'plain three', 'plain four']
    expect(lines.filter((l) => /^\s*\d+\t/.test(l)).length / lines.length).toBeLessThan(NUMBERED_MIN_RATIO)
    expect(stripNumbering(lines)).toBeNull()
  })

  it('refuses on all-blank input rather than dividing by zero', () => {
    expect(stripNumbering(['', '   ', ''])).toBeNull()
  })

  it('leaves an un-numbered line alone inside an otherwise numbered block', () => {
    const lines = ['     1\tone', '     2\ttwo', '     3\tthree', '     4\tfour', '     5\tfive', 'stray']
    expect(stripNumbering(lines)).toEqual(['one', 'two', 'three', 'four', 'five', 'stray'])
  })
})

describe('outlineCode — brace family', () => {
  const outline = outlineCode(TS_SRC, 'brace')

  it('keeps every import, type, class and function signature', () => {
    for (const sig of [
      "import { readFile, writeFile } from 'node:fs/promises'",
      "import type { Thing, Options } from './types'",
      'const DEFAULT_LIMIT = 20',
      'export interface Loaded {',
      'export class Loader {',
      '  private cache = new Map<string, Thing>()',
      '  async load(path: string): Promise<Thing> {',
      '  async save(path: string, value: Thing): Promise<void> {',
      '  clear(): void {',
      'export function summarize(items: Thing[], opts: Options): string {',
    ]) {
      expect(outline).toContain(sig)
    }
  })

  it('drops the bodies and says how many lines went', () => {
    expect(outline).not.toContain('this.cache.set(path, parsed)')
    expect(outline).not.toContain("lines.push(item.name)")
    expect(outline).toMatch(/… \d+ lines …/)
  })

  it('does not mistake control flow for a signature', () => {
    // `if (hit) {` wears the exact `(…) {` shape a method does; keeping those would keep the body.
    expect(outline).not.toContain('if (hit) {')
    expect(outline).not.toContain('for (const item of items) {')
  })

  it('is meaningfully smaller than the source', () => {
    expect(outline.length).toBeLessThan(TS_SRC.length * (1 - OUTLINE_MIN_GAIN))
  })

  it('indents the marker like the body it replaces', () => {
    expect(outline).toMatch(/\n {4}… \d+ lines …/)
  })

  it('is deterministic — the same bytes in give the same bytes out', () => {
    expect(outlineCode(TS_SRC, 'brace')).toBe(outline)
    expect(outlineCode(TS_SRC, 'brace')).toBe(outlineCode(TS_SRC.slice(0), 'brace'))
  })

  it('reaches the same result with no family hint at all', () => {
    expect(outlineCode(TS_SRC)).toBe(outline)
  })
})

describe('outlineCode — indent family', () => {
  const outline = outlineCode(PY_SRC, 'indent')

  it('keeps imports, the class, every def and the decorator', () => {
    for (const sig of [
      'import os',
      'from typing import Optional',
      'class Loader:',
      '    def __init__(self, root: str) -> None:',
      '    def load(self, name: str) -> Optional[str]:',
      '    @property',
      '    def size(self) -> int:',
      'def summarize(items, limit=DEFAULT_LIMIT):',
    ]) {
      expect(outline).toContain(sig)
    }
  })

  it('drops indented body statements', () => {
    expect(outline).not.toContain('self.cache[name] = data')
    expect(outline).not.toContain('out.append(str(item))')
  })

  it('is meaningfully smaller and deterministic', () => {
    expect(outline.length).toBeLessThan(PY_SRC.length * (1 - OUTLINE_MIN_GAIN))
    expect(outlineCode(PY_SRC, 'indent')).toBe(outline)
  })

  it('measures TAB indentation, so tab-indented source outlines like space-indented source', () => {
    // Tabs are ordinary in real Python. If a tab did not count as depth, every body line would
    // read as column 0 — top level — and the outline would keep the whole file.
    const tabbed = PY_SRC.replace(/^ {4}/gm, '\t').replace(/^\t {4}/gm, '\t\t')
    const tabOutline = outlineCode(tabbed, 'indent')
    expect(tabOutline).toContain('class Loader:')
    expect(tabOutline).toContain('\tdef __init__(self, root: str) -> None:')
    expect(tabOutline).not.toContain('self.cache[name] = data')
    expect(tabOutline.length).toBeLessThan(tabbed.length * (1 - OUTLINE_MIN_GAIN))
  })
})

describe('outlineCode — line-numbered Read output', () => {
  const src = numbered(TS_SRC)
  const outline = outlineCode(src, 'brace')

  it('sees through the gutter and still finds the structure', () => {
    expect(outline).toMatch(/\d+\texport class Loader \{/)
    expect(outline).toMatch(/\d+\t {2}async load\(path: string\): Promise<Thing> \{/)
    expect(outline).not.toContain('this.cache.set(path, parsed)')
  })

  it('KEEPS the numbers on the lines it emits — they are how an agent addresses a location', () => {
    for (const line of outline.split('\n')) {
      if (line.includes('… ') && line.includes(' lines …')) continue
      expect(line).toMatch(/^\s*\d+\t/)
    }
  })

  it('wins at least as much as it does on the bare source', () => {
    expect(outline.length).toBeLessThan(src.length * (1 - OUTLINE_MIN_GAIN))
  })
})

describe('outlineCode — refuses to make things worse', () => {
  it('returns short input byte-identical', () => {
    const short = Array.from({ length: OUTLINE_MIN_LINES - 1 }, (_, i) => `const x${i} = ${i}`).join('\n')
    expect(outlineCode(short, 'brace')).toBe(short)
  })

  it('returns all-structure input byte-identical — there is nothing to drop', () => {
    const decls = Array.from({ length: 40 }, (_, i) => `import { thing${i} } from './m${i}'`).join('\n')
    expect(outlineCode(decls, 'brace')).toBe(decls)
  })

  it('returns prose byte-identical rather than shredding it', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `This is ordinary sentence number ${i} of a document.`).join('\n')
    expect(outlineCode(prose, 'brace')).toBe(prose)
  })

  it('emits short body runs verbatim instead of a marker that would cost more', () => {
    const src = [
      'export function a(): void {',
      '  doThing()',            // a 1-line run
      '}',
      'export function b(): void {',
      '  doThing()',
      '  doOther()',            // a 2-line run
      '}',
      'export function c(): void {',
      ...Array.from({ length: 30 }, (_, i) => `  step${i}()`),
      '}',
    ].join('\n')
    const out = outlineCode(src, 'brace')
    expect(out).toContain('  doThing()')
    expect(out).toContain('  doOther()')
    expect(out).toContain(`  … 30 lines …`)
    expect(OUTLINE_MIN_RUN).toBe(3)
  })
})

describe('outlineCode — masking', () => {
  it('is not fooled by braces inside strings', () => {
    const src = [
      'export function open(): void {',
      '  const s = "} not a real close {"',
      ...Array.from({ length: 20 }, (_, i) => `  step${i}()`),
      '}',
      'export function after(): void {',
      ...Array.from({ length: 20 }, (_, i) => `  more${i}()`),
      '}',
    ].join('\n')
    const out = outlineCode(src, 'brace')
    // If the string's `}` had counted, `after` would have looked nested and been dropped.
    expect(out).toContain('export function after(): void {')
    expect(out).not.toContain('step5()')
  })

  it('is not fooled by braces inside block comments', () => {
    const src = [
      '/* a comment with { and } and function foo() { */',
      'export function real(): void {',
      ...Array.from({ length: 20 }, (_, i) => `  step${i}()`),
      '}',
      'export function alsoReal(): void {',
      ...Array.from({ length: 20 }, (_, i) => `  more${i}()`),
      '}',
    ].join('\n')
    const out = outlineCode(src, 'brace')
    expect(out).toContain('export function alsoReal(): void {')
  })

  it('keeps # lines in brace languages — they are attributes and directives, not comments', () => {
    const src = [
      '#include <stdio.h>',
      '#define LIMIT 20',
      'int main(void) {',
      ...Array.from({ length: 25 }, (_, i) => `  work(${i});`),
      '  return 0;',
      '}',
    ].join('\n')
    const out = outlineCode(src, 'brace')
    expect(out).toContain('#include <stdio.h>')
    expect(out).toContain('#define LIMIT 20')
    expect(out).toContain('int main(void) {')
    expect(out).not.toContain('work(7);')
  })

  it('treats # as a comment in indent languages', () => {
    const src = [
      '# a comment mentioning def fake(): and class Fake:',
      'def real(a, b):',
      ...Array.from({ length: 25 }, (_, i) => `    step${i}()`),
      '    return a',
      '',
      'def alsoReal(c):',
      ...Array.from({ length: 25 }, (_, i) => `    more${i}()`),
      '    return c',
    ].join('\n')
    const out = outlineCode(src, 'indent')
    expect(out).toContain('def real(a, b):')
    expect(out).toContain('def alsoReal(c):')
    expect(out).not.toContain('step9()')
  })

  it('handles CRLF sources without leaving the carriage returns behind', () => {
    const crlf = TS_SRC.split('\n').join('\r\n')
    const out = outlineCode(crlf, 'brace')
    expect(out).toContain('export class Loader {\r')
    expect(out).not.toContain('this.cache.set(path, parsed)')
    expect(out.length).toBeLessThan(crlf.length)
  })
})

describe('looksLikeCode', () => {
  it('accepts real source in both families', () => {
    expect(looksLikeCode(TS_SRC)).toBe(true)
    expect(looksLikeCode(PY_SRC)).toBe(true)
    expect(looksLikeCode(numbered(TS_SRC))).toBe(true)
  })

  it('rejects prose, logs and command output', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `This is ordinary sentence number ${i}.`).join('\n')
    const log = Array.from({ length: 40 }, (_, i) => `2026-08-09T12:00:0${i % 10}Z INFO request finished in ${i}ms`).join('\n')
    const ls = Array.from({ length: 40 }, (_, i) => `-rw-r--r-- 1 dave dave ${i * 31} Aug  9 12:00 file${i}.bin`).join('\n')
    expect(looksLikeCode(prose)).toBe(false)
    expect(looksLikeCode(log)).toBe(false)
    expect(looksLikeCode(ls)).toBe(false)
  })

  it('rejects anything too short to judge', () => {
    expect(looksLikeCode('export function a() {\n  return 1\n}')).toBe(false)
    expect(looksLikeCode(`${TS_SRC.split('\n').slice(0, 5).join('\n')}\n\n\n\n\n\n\n\n\n\n\n\n`)).toBe(false)
  })

  it('short-circuits to true when the path already told us the family', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `Sentence ${i}.`).join('\n')
    expect(looksLikeCode(prose, 'brace')).toBe(true)
    expect(looksLikeCode(prose, null)).toBe(false)
  })
})

describe('guessFamily', () => {
  it('calls brace-heavy source brace and everything else indent', () => {
    expect(guessFamily(TS_SRC)).toBe('brace')
    expect(guessFamily(PY_SRC)).toBe('indent')
    expect(guessFamily(numbered(TS_SRC))).toBe('brace')
  })
})
