/**
 * The check on the BUILT renderer CSS. Tailwind 4 runs behind a parity layer that makes it emit
 * what Tailwind 3.4 did, and a v4 default coming back changes pixels without failing anything:
 * tests/renderer/tailwindParity.test.ts can only read the source, so a Tailwind or Vite upgrade
 * that compiles the same source differently gets past it. scripts/verifyRendererCss.cjs reads the
 * build in CI. These tests drive it with stylesheets shaped like Tailwind 4's real output; each
 * failure case is what the real toolchain emitted when one part of the parity layer was undone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const guard = require('../../scripts/verifyRendererCss.cjs')

const THEME = `@theme {
  --font-sans: ui-sans-serif, system-ui, sans-serif;
  --color-*: initial;
  --color-green-400: #4ade80;
  --color-gray-200: #e5e7eb;
  --text-xs: 0.75rem;
  --text-xs--line-height: 1rem;
}
@custom-variant hover (&:hover);
`

const UTILITIES = Array.from({ length: guard.MIN_UTILITY_RULES }, (_, i) => `  .u-${i} {\n    order: ${i};\n  }`)

/** A stylesheet shaped like the parity build's, with any part swapped out. */
function stylesheet(parts: { theme?: string; base?: string; utilities?: string[]; extra?: string } = {}): string {
  const theme = parts.theme ?? `    --font-sans: ui-sans-serif, system-ui, sans-serif;
    --color-green-400: #4ade80;
    --color-gray-200: #e5e7eb;
    --text-xs: 0.75rem;
    --text-xs--line-height: 1rem;`
  const base = parts.base ?? `  *,
::before,
::after {
    box-sizing: border-box;
    border-color: #e5e7eb;
  }
  input::placeholder,
textarea::placeholder {
    opacity: 1;
    color: #9ca3af;
  }
  button,
[role="button"] {
    cursor: pointer;
  }`
  const utilities = parts.utilities ?? UTILITIES
  return `/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
${theme}
  }
}
@layer base {
${base}
}
@layer utilities {
${utilities.join('\n')}
}
${parts.extra ?? ''}`
}

const theme = guard.readTheme(THEME)
const problems = (css: string): string[] => guard.checkStylesheet(css, theme)

describe('reading the v3 parity theme', () => {
  it('maps each custom property the theme defines to its value', () => {
    expect(theme.get('--color-green-400')).toBe('#4ade80')
    expect(theme.get('--text-xs--line-height')).toBe('1rem')
    expect(theme.get('--font-sans')).toBe('ui-sans-serif, system-ui, sans-serif')
  })

  it('skips the `--color-*: initial` reset, which names no property', () => {
    expect([...theme.keys()].some((name: string) => name.includes('*'))).toBe(false)
  })

  it('reads the real tailwind-v3-theme.css: v3 hex colours and rem line heights', () => {
    const real = guard.readTheme(
      readFileSync(resolve(__dirname, '..', '..', 'src', 'renderer', 'src', 'tailwind-v3-theme.css'), 'utf8'),
    )
    const colours = [...real.entries()].filter(([name]: [string, string]) => name.startsWith('--color-'))
    expect(colours.length).toBeGreaterThan(200)
    expect(colours.every(([, value]: [string, string]) => /^#[0-9a-f]{3,6}$/.test(value))).toBe(true)
    expect(real.get('--color-green-400')).toBe('#4ade80')
    expect(real.get('--text-xs--line-height')).toBe('1rem')
  })
})

describe('checking one built stylesheet', () => {
  it('passes what the parity setup emits', () => {
    expect(problems(stylesheet())).toEqual([])
  })

  it.each([
    ['postcss-import wrapped the utilities in `@media source(none)`', '  @media source(none) {\n    .x { order: 1; }\n  }', /@media source/],
    ["v4's space-y rule came back", '  :where(.space-y-4 > :not(:last-child)) {\n    margin-bottom: 1rem;\n  }', /space-x\/space-y/],
    ['hover: is wrapped in @media (hover: hover) again', '  @media (hover: hover) {\n    .hover\\:x:hover { order: 1; }\n  }', /hover: hover/],
  ])('fails when %s', (_, rule, message) => {
    expect(problems(stylesheet({ utilities: [...UTILITIES, rule] }))).toEqual([expect.stringMatching(message)])
  })

  it('fails minified output, which rewrites the CSS the parity layer pins', () => {
    const minified = stylesheet({ theme: '    --color-green-400:#4ade80;\n    --text-xs--line-height:1rem;' })
    expect(problems(minified)).toEqual([expect.stringContaining('lacks `--text-xs--line-height: 1rem`')])
  })

  it("fails v4's Preflight in place of v3's, naming each missing v3 rule", () => {
    const v4 = stylesheet({
      base: `  *,
::after,
::before {
    box-sizing: border-box;
    border: 0 solid;
  }
  ::placeholder {
    color: currentcolor;
  }`,
    })
    expect(problems(v4)).toEqual([
      expect.stringContaining('`::after { border-color: #e5e7eb }`'),
      expect.stringContaining('`::placeholder { color: #9ca3af }`'),
      expect.stringContaining('`[role="button"] { cursor: pointer }`'),
    ])
  })

  it("does not count a utility that happens to match a Preflight rule as the Preflight", () => {
    const css = stylesheet({
      base: '  button,\n[role="button"] {\n    cursor: pointer;\n  }\n  *,\n::before,\n::after {\n    border-color: #e5e7eb;\n  }',
      utilities: [...UTILITIES, '  .placeholder\\:text-\\[\\#9ca3af\\]::placeholder {\n    color: #9ca3af;\n  }'],
    })
    expect(problems(css)).toEqual([expect.stringContaining('`::placeholder { color: #9ca3af }`')])
  })

  it("fails a colour that is v4's OKLCH value instead of v3's hex, saying what it should be", () => {
    const css = stylesheet({ theme: '    --color-green-400: oklch(79.2% 0.209 151.711);\n    --text-xs--line-height: 1rem;' })
    expect(problems(css)).toEqual(['emits `--color-green-400: oklch(79.2% 0.209 151.711)`; tailwind-v3-theme.css says `#4ade80`'])
  })

  it("fails a colour from v4's palette that v3 never had", () => {
    const css = stylesheet({ theme: '    --color-mauve-500: oklch(54.2% 0.034 322.5);\n    --text-xs--line-height: 1rem;' })
    expect(problems(css)).toEqual(["emits `--color-mauve-500`, which is not in v3's palette"])
  })

  it("fails v4's own value for a font or text size the parity theme sets", () => {
    const css = stylesheet({
      theme: '    --font-sans: -apple-system, BlinkMacSystemFont, sans-serif;\n    --color-green-400: #4ade80;\n    --text-xs--line-height: 1rem;\n    --text-xs: .75rem;',
    })
    expect(problems(css)).toEqual([
      expect.stringContaining('emits `--font-sans: -apple-system'),
      'emits `--text-xs: .75rem`; tailwind-v3-theme.css says `0.75rem`',
    ])
  })

  it('leaves alone a theme value the parity theme does not set, since v4 and v3 agree on it', () => {
    const css = stylesheet({ theme: '    --font-mono: ui-monospace, monospace;\n    --color-green-400: #4ade80;\n    --text-xs--line-height: 1rem;' })
    expect(problems(css)).toEqual([])
  })

  it("judges only the theme layer's variables: a utility may set a --color-* of its own", () => {
    const css = stylesheet({ utilities: [...UTILITIES, '  .\\[--color-accent\\:\\#f00\\] {\n    --color-accent: #f00;\n  }'] })
    expect(problems(css)).toEqual([])
  })

  it('fails a build that emits no theme colour at all', () => {
    expect(problems(stylesheet({ theme: '    --text-xs--line-height: 1rem;' }))).toEqual([
      expect.stringContaining('emits no theme colours at all'),
    ])
  })

  it('fails a build whose utilities shrank to what an unscanned src/ leaves', () => {
    expect(problems(stylesheet({ utilities: UTILITIES.slice(0, 6) }))).toEqual([
      `has 6 utility rules, under ${guard.MIN_UTILITY_RULES}: Tailwind is not scanning src/ as the @source glob says`,
    ])
  })

  it('ignores the un-layered third-party CSS bundled into the same file', () => {
    // Font Awesome, xterm and the font faces ship in the app's stylesheet beside Tailwind's layers.
    const extra = `.xterm .xterm-viewport { color: red; }
@media (hover: hover) { .fa-button:hover { cursor: pointer; } }
:root { --color-brand: oklch(50% 0.1 200); }`
    expect(problems(stylesheet({ extra }))).toEqual([])
  })

  it('counts only the utilities layer toward the floor', () => {
    const css = stylesheet({ utilities: UTILITIES.slice(1) }).replace('@layer base {', `@layer base {\n  .counted-nowhere { order: 0; }`)
    expect(problems(css)).toEqual([expect.stringContaining(`has ${guard.MIN_UTILITY_RULES - 1} utility rules`)])
  })
})

describe('verifying a build directory', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `renderer-css-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(dir, 'assets'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const asset = (name: string, css: string): void => writeFileSync(join(dir, 'assets', name), css, 'utf8')

  it("checks only the stylesheet holding Tailwind's utilities, not third-party CSS", () => {
    asset('index-abc.css', stylesheet())
    // monaco's own CSS may use anything, a hover media query included.
    asset('monaco-bootstrap-def.css', '@media (hover: hover) { .monaco-button:hover { cursor: pointer; } }')
    asset('index-abc.js', '@layer utilities {')
    expect(guard.tailwindStylesheets(join(dir, 'assets')).map((s: { file: string }) => s.file)).toEqual([
      join(dir, 'assets', 'index-abc.css'),
    ])
    expect(guard.verify(dir, THEME)).toEqual([])
  })

  it('names the file each problem is in', () => {
    asset('index-abc.css', stylesheet({ utilities: [...UTILITIES, '  @media (hover: hover) { .x:hover { order: 1; } }'] }))
    expect(guard.verify(dir, THEME)).toEqual([expect.stringMatching(/index-abc\.css has hover: wrapped/)])
  })

  it('fails a build with no Tailwind output at all', () => {
    asset('monaco-bootstrap-def.css', '.monaco-editor { color: red; }')
    expect(guard.verify(dir, THEME)).toEqual([expect.stringContaining("has Tailwind's utilities layer")])
  })

  it('checks against the real parity theme by default', () => {
    asset('index-abc.css', stylesheet({ theme: '    --color-green-400: #4ade80;\n    --text-xs--line-height: 1rem;' }))
    expect(guard.verify(dir)).toEqual([])
  })

  it('exits 0 on a good build and says so', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    asset('index-abc.css', stylesheet({ theme: '    --color-green-400: #4ade80;\n    --text-xs--line-height: 1rem;' }))
    expect(guard.main([dir])).toBe(0)
    expect(log.mock.calls[0][0]).toMatch(/^OK:/)
  })

  it('exits 1 and prints each problem on a bad build', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    asset(
      'index-abc.css',
      stylesheet({ theme: '    --color-mauve-500: oklch(54.2% 0.034 322.5);\n    --color-green-400: oklch(79.2% 0.209 151.711);\n    --text-xs--line-height: 1rem;' }),
    )
    expect(guard.main([dir])).toBe(1)
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^FAIL: .*index-abc\.css emits `--color-mauve-500`/),
      expect.stringMatching(/^FAIL: .*index-abc\.css emits `--color-green-400: oklch/),
    ])
  })

  it('exits 2 when there is no build to read', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(guard.main([join(dir, 'nope')])).toBe(2)
    expect(err.mock.calls[0][0]).toContain('npm run build')
  })
})
