#!/usr/bin/env node
/**
 * Prove every third-party import in a built main-process entry actually loads.
 *
 * The main bundle and its utilityProcess children are ESM (package.json says
 * `"type": "module"`), and electron-vite externalizes real dependencies rather
 * than bundling them. That combination has one failure mode that no unit test
 * can reach: a CommonJS dependency whose named exports Node's cjs-module-lexer
 * cannot see through. `import { Terminal } from '@xterm/headless'` type-checks,
 * passes vitest (which interops it happily), builds without a word -- and then
 * throws `SyntaxError: Named export 'Terminal' not found` the instant the built
 * child starts. A utilityProcess that dies on its first line is silent: the
 * Remote pane opened a pairing modal that never filled in a QR, because the
 * bridge was already gone. The fix in that case was to bundle the dependency,
 * but the point of this script is that the NEXT one gets caught here rather
 * than in an e2e failure three shards deep.
 *
 * Run against a completed `electron-vite build`:
 *
 *   node scripts/verifyChildEntryImports.cjs out/main
 *
 * Node builtins and `electron` are skipped: they are provided by the runtime,
 * not resolved from node_modules, and `electron` is not importable outside an
 * Electron process at all.
 */
const { readFileSync, readdirSync, existsSync } = require('fs')
const { join, resolve } = require('path')
const { builtinModules } = require('module')

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** Runtime-provided, never resolved from node_modules. `electron` cannot even be
 *  imported from plain node, so asking would fail every run for no reason. */
function isProvided(specifier) {
  return BUILTINS.has(specifier) || specifier === 'electron' || specifier.startsWith('electron/')
}

/** Relative and absolute specifiers are the bundle's own chunks -- rollup emitted
 *  them and they resolve by construction. */
function isInternal(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/')
}

/**
 * Pull the top-level static imports out of a built ES module.
 *
 * Deliberately a regex over the emitted bundle rather than a parse: rollup's
 * output for these entries is a flat list of import statements at the top of
 * the file, and a real parser is a dependency this script should not need to
 * run in CI before anything else has been installed.
 *
 * Anchored to the start of a line, which is what keeps it honest. The word
 * `import` also appears inside string literals in the minified body and in
 * dynamic `import(...)` calls, and an unanchored match reads those as package
 * names -- the first draft of this script reported a dependency called
 * `', event: level === '`.
 */
function readImports(source) {
  const found = []
  // `import x from "s"`, `import { a, b as c } from "s"`, `import * as n from "s"`
  const withBindings = /^import\s+([^;]+?)\s+from\s*["']([^"']+)["']/gm
  for (const [, clause, specifier] of source.matchAll(withBindings)) {
    found.push({ specifier, names: namedBindings(clause) })
  }
  // `import "s"` -- a side-effect import binds nothing but still has to resolve.
  const bare = /^import\s*["']([^"']+)["']/gm
  for (const [, specifier] of source.matchAll(bare)) found.push({ specifier, names: [] })
  return found
}

/** The names a clause actually asks the module to export. A default or namespace
 *  import asks for nothing by name -- those always work against CommonJS, and it
 *  is only the braces that can fail. */
function namedBindings(clause) {
  const braces = clause.match(/\{([^}]*)\}/)
  if (!braces) return []
  return braces[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
    .filter((name) => name.length > 0 && name !== 'default')
}

/** Every entry point in the build directory. Chunks are shared code the entries
 *  import; whatever they pull in shows up through the entry that uses them. */
function entryFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(dir, name))
}

/**
 * Load each third-party specifier and confirm the bindings the bundle asks for
 * are really there. `load` is injected so the test can drive both verdicts
 * without publishing a broken package to npm.
 */
async function verify(dir, load = (specifier) => import(specifier)) {
  const problems = []
  const checked = new Set()
  for (const file of entryFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const { specifier, names } of readImports(source)) {
      if (isProvided(specifier) || isInternal(specifier)) continue
      const key = `${specifier}::${names.join(',')}`
      if (checked.has(key)) continue
      checked.add(key)
      let mod
      try {
        mod = await load(specifier)
      } catch (e) {
        problems.push(`${file}: import of '${specifier}' fails at runtime -- ${e.message}`)
        continue
      }
      const missing = names.filter((name) => !(name in mod))
      if (missing.length > 0) {
        problems.push(
          `${file}: '${specifier}' has no export named ${missing.map((n) => `'${n}'`).join(', ')}. ` +
            `It is CommonJS that Node cannot read named exports from. Bundle it into the entry ` +
            `(electron.vite.config.ts, externalizeDepsPlugin exclude) or import its default.`,
        )
      }
    }
  }
  return problems
}

async function main(argv) {
  const dir = resolve(argv[0] || 'out/main')
  if (!existsSync(dir)) {
    console.error(`FAIL: ${dir} does not exist. Run \`npm run build\` first.`)
    return 2
  }
  const problems = await verify(dir)
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`)
    return 1
  }
  console.log(`OK: every third-party import in ${dir} resolves and exports what it is asked for.`)
  return 0
}

module.exports = { isProvided, isInternal, readImports, namedBindings, entryFiles, verify, main }

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
