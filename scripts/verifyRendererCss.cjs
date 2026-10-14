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
 * own; a rule of theirs must not fail this. The exception is a condition wrapped
 * around a layer, which can only show outside the layers and which none of that
 * CSS has (see checkStylesheet).
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

/** Rules only v4's Preflight has. Imported beside v3's, it passes the markers above while its
 *  reset zeroes every table cell's padding. v4 nests its placeholder colour in @supports. */
const V4_PREFLIGHT_MARKERS = [
  ['::file-selector-button', 'padding', '0'],
  ['::placeholder', 'color', 'color-mix(in oklab, currentcolor 50%, transparent)'],
]

/** Checks that do not trust tailwind-v3-theme.css, since a v4-style edit can change that file
 *  along with the build: v3's palette is all hex where v4's is OKLCH, one v3 colour is pinned
 *  here outright, and v3's line heights are rem where v4's are calc() ratios. */
const V3_HEX = /^#(?:[0-9a-f]{3}){1,2}$/i
const V3_GREEN_400 = '#4ade80'
const V4_LINE_HEIGHT = /^calc\(/

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

/** The at-rule, other than a layer, that a node sits inside, if any. */
function conditionAround(node) {
  for (let parent = node.parent; parent && parent.type !== 'root'; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name !== 'layer') return parent
  }
  return undefined
}

/** Whether any of the layers gives a selector containing `selector` the declaration `prop: value`,
 *  counting one inside an at-rule nested in the rule. */
function declares(layers, [selector, prop, value]) {
  let found = false
  for (const layer of layers) {
    layer.walkDecls(prop, (decl) => {
      let rule = decl.parent
      while (rule.type !== 'rule' && rule !== layer) rule = rule.parent
      if (rule !== layer && rule.selector.includes(selector) && decl.value === value) found = true
    })
  }
  return found
}

/** Everything wrong with one built stylesheet, measured against the parity theme. */
function checkStylesheet(css, theme) {
  const problems = []
  const root = postcss.parse(css)
  const layers = []
  root.walkAtRules('layer', (layer) => {
    if (layer.nodes) layers.push(layer)
  })
  const named = (name) => layers.filter((layer) => layer.params === name)

  // postcss-import inlines an @import inside an at-rule for each of its conditions, outside the
  // layer it names: `layer(utilities) source(none)` becomes `@media source(none) { @layer
  // utilities {...} }`, and Tailwind has to unwrap it. Chromium takes a condition it does not know
  // as false, so a wrapper left in place switches off every rule in the layer, and the checks
  // below, which read the layers' contents, still pass. Hence these two look at the whole file.
  root.walkAtRules('media', (media) => {
    if (/\bsource\(/.test(media.params)) {
      problems.push(`has \`@media ${media.params}\`: postcss-import wrapped the utilities import, so Tailwind no longer sees \`source(none)\``)
    }
  })
  for (const layer of layers) {
    const condition = conditionAround(layer)
    if (condition) {
      problems.push(
        `has \`@layer ${layer.params}\` inside \`@${condition.name} ${condition.params}\`, so the layer applies only where that holds (postcss-import puts an @import's conditions there)`,
      )
    }
  }

  // Tested on the layers as written, so a minifier's rewrite shows.
  const tailwind = layers.map(String).join('\n')
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(tailwind)) problems.push(`has ${why}`)
  }
  for (const [text, why] of REQUIRED_TEXT) {
    if (!tailwind.includes(text)) problems.push(`lacks \`${text}\`: ${why}`)
  }

  const base = named('base')
  for (const marker of PREFLIGHT_MARKERS) {
    const [selector, prop, value] = marker
    if (!declares(base, marker)) problems.push(`lacks v3 Preflight's \`${selector} { ${prop}: ${value} }\` (tailwind-v3-preflight.css)`)
  }
  for (const marker of V4_PREFLIGHT_MARKERS) {
    const [selector, prop, value] = marker
    if (declares(base, marker)) {
      problems.push(`has v4 Preflight's \`${selector} { ${prop}: ${value} }\`: tailwindcss/preflight.css is imported beside or instead of tailwind-v3-preflight.css`)
    }
  }

  // Tailwind emits a theme variable only where a class uses it, so the colours present depend on
  // the app. Each one present must be v3's, and one outside v3's palette means v4's came back.
  let colours = 0
  for (const layer of named('theme')) {
    layer.walkDecls(/^--(color|text|font)-/, (decl) => {
      const colour = decl.prop.startsWith('--color-')
      if (colour) colours++
      const expected = theme.get(decl.prop)
      // The first two measure the build against tailwind-v3-theme.css. The rest are reached when
      // the file agrees with the build or does not set the value, so they catch an edit of the
      // file itself.
      if (expected !== undefined && decl.value !== expected) {
        problems.push(`emits \`${decl.prop}: ${decl.value}\`; tailwind-v3-theme.css says \`${expected}\``)
      } else if (colour && expected === undefined) {
        problems.push(`emits \`${decl.prop}\`, which is not in v3's palette`)
      } else if (colour && !V3_HEX.test(decl.value)) {
        problems.push(`emits \`${decl.prop}: ${decl.value}\`, as tailwind-v3-theme.css now says, but v3's palette is all hex`)
      } else if (decl.prop === '--color-green-400' && decl.value !== V3_GREEN_400) {
        problems.push(`emits \`${decl.prop}: ${decl.value}\`, as tailwind-v3-theme.css now says, but v3's is \`${V3_GREEN_400}\``)
      } else if (decl.prop.endsWith('--line-height') && V4_LINE_HEIGHT.test(decl.value)) {
        problems.push(`emits \`${decl.prop}: ${decl.value}\`, v4's unitless ratio, where v3's line heights are rem`)
      }
    })
  }
  if (colours === 0) problems.push('emits no theme colours at all, so tailwind-v3-theme.css never reached the build')

  let utilities = 0
  for (const layer of named('utilities')) {
    layer.walkRules(() => {
      utilities++
    })
  }
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
