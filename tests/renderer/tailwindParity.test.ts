/**
 * Tailwind 4 is set up to render exactly what the Tailwind 3.4 build did (see the comments in
 * src/renderer/src/index.css). Four parts of that setup are easy to undo by accident, and undoing
 * any of them changes pixels without failing anything else. This file pins them in the source;
 * scripts/verifyRendererCss.cjs checks the built CSS for the same things in CI.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')
const INDEX_CSS = fs.readFileSync(path.join(RENDERER, 'index.css'), 'utf8')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [full] : []
  })
}

// What the @source glob in index.css hands Tailwind: every .ts, .tsx, .js and .jsx file under src/.
const SOURCES = sourceFiles(path.join(ROOT, 'src'))

describe('Tailwind v3 parity setup', () => {
  it('gives every space-y-* src/ uses its v3 rule, and stops v4 generating its own', () => {
    const used = new Set<string>()
    for (const file of SOURCES) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?<![\w-])space-([xy])-(\d+(?:\.\d+)?|px)(?![\w.-])/g)) {
        used.add(`space-${m[1]}-${m[2]}`)
      }
    }
    expect(used.size).toBeGreaterThan(0)
    const blocked = /@source not inline\("space-y-\{([^}]*)\}"\);/.exec(INDEX_CSS)?.[1].split(',') ?? []
    for (const cls of used) {
      // v4's space-x-* changed the same way; add its v3 rule before using one.
      expect(cls, 'only space-y-* has v3 rules in index.css').toMatch(/^space-y-/)
      expect(blocked, `${cls} must be listed in @source not inline("space-y-{...}")`).toContain(cls.slice('space-y-'.length))
      expect(INDEX_CSS, `${cls} needs its v3 rule in index.css`).toContain(`.${cls.replace('.', '\\.')} > :not([hidden]) ~ :not([hidden])`)
    }
  })

  it('uses space-y-* only as a bare class, the one form the v3 rules and the blocklist cover', () => {
    // A variant (md:space-y-4) or important (!space-y-4, space-y-4!) form is a different
    // candidate, which the blocklist does not name, so v4 generates its own rule for it. A
    // negative, arbitrary or reverse value has no v3 rule here at all.
    const uncovered = /[\w\]*-]:!?-?space-[xy]-|!-?space-[xy]-|space-[xy]-[\w.]+!|(?<![\w-])-space-[xy]-|space-[xy]-(?:\[|\(|reverse)/g
    const found: string[] = []
    for (const file of SOURCES) {
      const source = fs.readFileSync(file, 'utf8')
      for (const m of source.matchAll(uncovered)) {
        found.push(`${path.relative(ROOT, file)}:${source.slice(0, m.index).split('\n').length}: ${m[0]}`)
      }
    }
    expect(found).toEqual([])
  })

  it('scans only src/, as the v3 content glob did', () => {
    expect(INDEX_CSS).toContain('@import "tailwindcss/utilities.css" layer(utilities) source(none);')
    expect(INDEX_CSS).toContain('@source "../../**/*.{ts,tsx,js,jsx}";')
  })

  it('keeps every @import above every other statement (Vite inlines them with postcss-import)', () => {
    const lines = INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.trim()).filter(Boolean)
    const lastImport = lines.map(l => l.startsWith('@import ')).lastIndexOf(true)
    const firstOther = lines.findIndex(l => !l.startsWith('@import ') && !/^@layer [\w, ]+;$/.test(l))
    expect(lastImport).toBeGreaterThan(-1)
    expect(lastImport).toBeLessThan(firstOther)
  })

  it('keeps Lightning CSS from rewriting colours (optimize: false)', () => {
    const config = fs.readFileSync(path.join(ROOT, 'postcss.config.js'), 'utf8')
    expect(config).toMatch(/'@tailwindcss\/postcss':\s*\{\s*optimize:\s*false\s*\}/)
  })
})
