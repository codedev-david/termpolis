#!/usr/bin/env node
/**
 * Prove the built renderer CSS is still what Tailwind 3 shipped.
 *
 * The renderer runs Tailwind 4 behind a parity layer (described at the top of
 * src/renderer/src/index.css) that makes it emit what Tailwind 3.4 did: v3's
 * palette, line heights and Preflight, hover on every device, v3's space-y-*
 * rules, a scan of src/ only, and no Lightning CSS rewrite. Every piece of that
 * can be undone without failing a test -- a v4 default creeping back changes
 * pixels, not behaviour -- and tests/renderer/tailwindParity.test.ts can only
 * read the source. A Tailwind or Vite upgrade that changes what the same source
 * compiles to gets past it. This reads what the build actually emitted.
 *
 * Run against a completed `npm run build`:
 *
 *   node scripts/verifyRendererCss.cjs out/renderer
 *
 * Only Tailwind's own output is checked: the cascade layers it emits, in the
 * stylesheet that holds its utilities layer. Font Awesome, xterm and the font
 * faces are bundled into that same file un-layered, and monaco's CSS into its
 * own; a rule of theirs must not fail this.
 */
const { readFileSync, readdirSync, existsSync } = require('fs')
const { join, resolve } = require('path')
const postcss = require('postcss')

const THEME_SOURCE = resolve(__dirname, '..', 'src', 'renderer', 'src', 'tailwind-v3-theme.css')

/** The app uses ~800 utility rules. A build far below that stopped scanning src/ (a broken
 *  @source, or postcss-import mangling `source(none)`) and is missing most of its styling.
 *  Lower it on purpose if the app really sheds classes, never to get a build through. */
const MIN_UTILITY_RULES = 750

/** What a stock v4 setup emits and the parity layer exists to prevent. */
const FORBIDDEN = [
  [/@media\s+source\(/, '`@media source(...)`: postcss-import wrapped the utilities import, so Tailwind no longer sees `source(none)`'],
  [/:where\(\s*\.space-[xy]/, "v4's space-x/space-y rule, which loses to a child's own margin (index.css keeps the v3 rules)"],
  [/@media\s*\(\s*hover\s*:\s*hover\s*\)/, "hover: wrapped in @media (hover: hover), v4's default (tailwind-v3-theme.css restores v3's)"],
]

/** Exact text, spacing included, so a minifier that rewrites the CSS fails this too. */
const REQUIRED_TEXT = [
  ['--text-xs--line-height: 1rem', "v3's rem line height for text-xs (v4's is a unitless ratio)"],
]

/** Preflight rules v3 has and v4 does not, as [selector part, property, value]. Looked for in
 *  the base layer only: a utility such as placeholder:text-[#9ca3af] matches them too. */
const PREFLIGHT_MARKERS = [
  ['::after', 'border-color', '#e5e7eb'],
  ['::placeholder', 'color', '#9ca3af'],
  ['[role="button"]', 'cursor', 'pointer'],
]

/** The custom properties the v3 parity theme defines, by name. `--color-*: initial` is not one. */
function readTheme(source) {
  const theme = new Map()
  postcss.parse(source).walkAtRules('theme', (rule) => {
    rule.walkDecls(/^--/, (decl) => {
      if (!decl.prop.includes('*')) theme.set(decl.prop, decl.value)
    })
  })
  return theme
}

/** Every built stylesheet that holds Tailwind's utilities layer: the app's own CSS. */
function tailwindStylesheets(assetsDir) {
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ file: join(assetsDir, name), css: readFileSync(join(assetsDir, name), 'utf8') }))
    .filter(({ css }) => /@layer\s+utilities\s*\{/.test(css))
}

/** Everything wrong with one built stylesheet, measured against the parity theme. */
function checkStylesheet(css, theme) {
  const problems = []
  const layers = []
  postcss.parse(css).walkAtRules('layer', (layer) => {
    if (layer.nodes) layers.push(layer)
  })
  const rulesIn = (name) => {
    const rules = []
    for (const layer of layers) if (layer.params === name) layer.walkRules((rule) => rules.push(rule))
    return rules
  }

  // Tested on the layers as written, so a minifier's rewrite shows.
  const tailwind = layers.map(String).join('\n')
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(tailwind)) problems.push(`has ${why}`)
  }
  for (const [text, why] of REQUIRED_TEXT) {
    if (!tailwind.includes(text)) problems.push(`lacks \`${text}\`: ${why}`)
  }

  const base = rulesIn('base')
  for (const [selector, prop, value] of PREFLIGHT_MARKERS) {
    const found = base.some(
      (rule) => rule.selector.includes(selector) && rule.nodes.some((n) => n.prop === prop && n.value === value),
    )
    if (!found) problems.push(`lacks v3 Preflight's \`${selector} { ${prop}: ${value} }\` (tailwind-v3-preflight.css)`)
  }

  // Tailwind emits a theme variable only where a class uses it, so the colours present depend on
  // the app. Each one present must be v3's, and one outside v3's palette means v4's came back.
  let colours = 0
  for (const layer of layers) {
    if (layer.params !== 'theme') continue
    layer.walkDecls(/^--(color|text|font)-/, (decl) => {
      if (decl.prop.startsWith('--color-')) colours++
      if (!theme.has(decl.prop)) {
        if (decl.prop.startsWith('--color-')) problems.push(`emits \`${decl.prop}\`, which is not in v3's palette`)
      } else if (decl.value !== theme.get(decl.prop)) {
        problems.push(`emits \`${decl.prop}: ${decl.value}\`; tailwind-v3-theme.css says \`${theme.get(decl.prop)}\``)
      }
    })
  }
  if (colours === 0) problems.push('emits no theme colours at all, so tailwind-v3-theme.css never reached the build')

  const utilities = rulesIn('utilities').length
  if (utilities < MIN_UTILITY_RULES) {
    problems.push(`has ${utilities} utility rules, under ${MIN_UTILITY_RULES}: Tailwind is not scanning src/ as the @source glob says`)
  }
  return problems
}

/** Every problem across the built renderer CSS, each naming its file. */
function verify(rendererDir, themeSource = readFileSync(THEME_SOURCE, 'utf8')) {
  const assets = join(rendererDir, 'assets')
  const sheets = tailwindStylesheets(assets)
  if (sheets.length === 0) {
    return [`no stylesheet in ${assets} has Tailwind's utilities layer. Is index.css still imported by main.tsx?`]
  }
  const theme = readTheme(themeSource)
  return sheets.flatMap(({ file, css }) => checkStylesheet(css, theme).map((p) => `${file} ${p}`))
}

function main(argv) {
  const dir = resolve(argv[0] || 'out/renderer')
  if (!existsSync(join(dir, 'assets'))) {
    console.error(`FAIL: ${join(dir, 'assets')} does not exist. Run \`npm run build\` first.`)
    return 2
  }
  const problems = verify(dir)
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`)
    return 1
  }
  console.log(`OK: the renderer CSS in ${dir} is what the Tailwind 3 parity setup should emit.`)
  return 0
}

module.exports = { MIN_UTILITY_RULES, readTheme, tailwindStylesheets, checkStylesheet, verify, main }

if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}
