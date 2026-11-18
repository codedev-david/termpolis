// Lumopolis technology chips: the technologies a building is made with, read from the code (its files'
// extensions and the packages they import) and from the labelling model's `stack`, each named by one
// glossary key so its chip has a plain-English definition. Pure: no fs, no Electron.
import { SCRIPT_FILE } from './imports'
import { stripComments } from './detectors'

/** One plain-English line per technology the code itself shows. Wins over a model's definition of the same term. */
export const BUILTIN_TECH: Readonly<Record<string, string>> = {
  TypeScript: 'JavaScript with types, checked before it runs',
  JavaScript: 'The language of the web and of Node.js',
  Python: 'A general-purpose scripting language',
  Go: "Google's compiled language for services and tools",
  Rust: 'A compiled language that is memory-safe without a garbage collector',
  Java: 'A compiled language that runs on the Java virtual machine',
  Kotlin: 'A modern language for the Java virtual machine and Android',
  'C#': "Microsoft's language for .NET",
  Ruby: 'A dynamic scripting language',
  PHP: 'A scripting language for web servers',
  Swift: "Apple's language for its platforms",
  'Node.js': 'Runs JavaScript outside the browser, with files, processes and networking',
  Electron: 'Builds desktop apps from a web page and Node.js',
  React: 'Builds the user interface from components',
  Vue: 'Builds the user interface from components and templates',
  Svelte: 'Builds the user interface from components compiled ahead of time',
  Angular: "Google's framework for web apps",
  'Next.js': 'A React framework for web sites rendered on the server',
  'Three.js': 'Draws 3D scenes in the browser with WebGL',
  SQLite: 'A database kept in a single local file',
  PostgreSQL: 'A database server',
  Redis: 'An in-memory store for data and queues',
  'xterm.js': 'Draws a terminal in a web page',
  Monaco: "The code editor that powers VS Code",
  Express: 'A web server framework for Node.js',
  WebSocket: 'A two-way connection that stays open between programs',
  Zod: 'Checks the shape of data at run time',
  Zustand: 'Keeps shared state for a React app',
  Vitest: 'Runs the unit tests',
  Jest: 'Runs the unit tests',
  Playwright: 'Drives a real browser or app for end-to-end tests',
  Django: 'A Python web framework',
  Flask: 'A small Python web framework',
  FastAPI: 'A Python framework for web APIs'
}

/** The languages, by file extension. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift'
}

/** Node's built-in modules a building imports when it runs in Node. */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'timers', 'tls', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib'
])

/** Packages to the technology they show (package names as imported, without a subpath). */
const PACKAGES: Readonly<Record<string, string>> = {
  electron: 'Electron',
  react: 'React', 'react-dom': 'React',
  vue: 'Vue', svelte: 'Svelte', '@angular/core': 'Angular', next: 'Next.js',
  three: 'Three.js',
  'better-sqlite3': 'SQLite', sqlite3: 'SQLite', sqlite: 'SQLite', 'sql.js': 'SQLite',
  pg: 'PostgreSQL', redis: 'Redis', ioredis: 'Redis',
  '@xterm/xterm': 'xterm.js', xterm: 'xterm.js',
  'monaco-editor': 'Monaco', '@monaco-editor/react': 'Monaco',
  express: 'Express', ws: 'WebSocket', zod: 'Zod', zustand: 'Zustand',
  vitest: 'Vitest', jest: 'Jest', '@jest/globals': 'Jest', '@playwright/test': 'Playwright', playwright: 'Playwright',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI'
}

/** Other spellings of a technology, lower case (the keys' own lower case needs no entry). */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', js: 'JavaScript', node: 'Node.js', nodejs: 'Node.js', 'node js': 'Node.js',
  'react.js': 'React', reactjs: 'React', 'vue.js': 'Vue', vuejs: 'Vue', three: 'Three.js', threejs: 'Three.js',
  'better-sqlite3': 'SQLite', sqlite3: 'SQLite', postgres: 'PostgreSQL', xterm: 'xterm.js', '@xterm/xterm': 'xterm.js',
  'monaco editor': 'Monaco', 'monaco-editor': 'Monaco', 'express.js': 'Express', websockets: 'WebSocket', ws: 'WebSocket',
  nextjs: 'Next.js', csharp: 'C#', 'c sharp': 'C#', golang: 'Go', '@playwright/test': 'Playwright'
}

const BY_LOWER = new Map<string, string>([
  ...Object.keys(BUILTIN_TECH).map((k): [string, string] => [k.toLowerCase(), k]),
  ...Object.entries(ALIASES)
])
const ORDER = new Map(Object.keys(BUILTIN_TECH).map((k, i) => [k, i]))

/** The most chips a building's stack keeps. */
export const MAX_STACK = 8

/** The builtin technology `term` names, whatever its case or spelling; undefined when it names none. */
export function canonicalTech(term: string): string | undefined {
  return BY_LOWER.get(term.trim().toLowerCase())
}

// `from 'x'`, `import 'x'`, `import('x')`, `require('x')` with a bare specifier; linear (no nested quantifiers).
const PACKAGE_SPEC = /\b(?:from|import|require)\s*(?:\(\s*)?['"`]([@a-z0-9_][^'"`\s]*)['"`]/gi

/** The package a bare specifier imports: `@scope/name` or `name`, with `node:` taken off and no subpath. */
function packageOf(spec: string): string {
  const s = spec.replace(/^node:/, '')
  const parts = s.split('/')
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// `import type ... from 'x'` and `export type ... from 'x'`: types only, gone once compiled. What may stand
// between `type` and `from` is spelled out (a braced list, a name, or `* as name`), so a type alias such as
// `export type A = number` never reaches into the next statement. Every scan is bounded, so a huge
// generated file is read in linear time.
const TYPE_ONLY = /\b(?:import|export)\s+type\s+(?:\{[^}]{0,2000}\}|\*\s+as\s+[\w$]+|[\w$]+)\s*from\s*['"`][^'"`\n]{0,300}['"`]/g
// `import { a, type B } from 'x'`: types only when every name it brings in is marked `type`.
const BRACED = /\bimport\s*\{([^}]{0,2000})\}\s*from\s*['"`][^'"`\n]{0,300}['"`]/g

/** The text without its type-only imports and re-exports, which name no technology the code runs. */
function dropTypeOnly(text: string): string {
  return text.replace(TYPE_ONLY, '').replace(BRACED, (m, names: string) => {
    const parts = names.split(',').map((x) => x.trim()).filter((x) => x !== '')
    return parts.length > 0 && parts.every((x) => /^type\s/.test(x)) ? '' : m
  })
}

/** The packages a script's text imports, in order of first appearance; comments, type-only and relative imports ignored. */
export function packageImports(file: string, text: string): string[] {
  if (!SCRIPT_FILE.test(file)) return []
  const out = new Set<string>()
  for (const m of dropTypeOnly(stripComments(text)).matchAll(PACKAGE_SPEC)) out.add(packageOf(m[1]))
  return [...out]
}

/**
 * What a package shows: its technology, Node.js for a built-in module of a script that runs in Node (a
 * Python `os` is no Node.js, nor is a renderer's `events` or `buffer` polyfill), undefined for anything else.
 */
function techOfPackage(pkg: string, node: boolean): string | undefined {
  const p = packageOf(pkg)
  if (Object.hasOwn(PACKAGES, p)) return PACKAGES[p]
  return node && NODE_BUILTINS.has(p) ? 'Node.js' : undefined
}

/**
 * The technologies a building's files show: the languages of their extensions and the technologies of
 * the packages they import (`packagesOf`: the bare specifiers one file imports), in BUILTIN_TECH's order.
 */
export function detectStack(members: readonly string[], packagesOf: (file: string) => readonly string[], opts: { browser?: boolean } = {}): string[] {
  const found = new Set<string>()
  for (const f of members) {
    const i = f.lastIndexOf('.')
    const ext = i > f.lastIndexOf('/') ? f.slice(i + 1).toLowerCase() : ''
    if (Object.hasOwn(EXTENSIONS, ext)) found.add(EXTENSIONS[ext])
    const node = opts.browser !== true && SCRIPT_FILE.test(f)
    for (const p of packagesOf(f)) {
      const t = techOfPackage(p, node)
      if (t) found.add(t)
    }
  }
  return [...found].sort((a, z) => (ORDER.get(a) as number) - (ORDER.get(z) as number))
}

/**
 * A list of technologies each named by its glossary key: a builtin technology in any case or spelling
 * becomes its key, another term becomes the glossary key it matches ignoring case, and a term the
 * glossary has no key for is dropped (a chip needs a definition). `first` comes first; no repeats.
 */
export function techChips(first: readonly string[], terms: readonly string[], glossary: Readonly<Record<string, string>>, max = MAX_STACK): string[] {
  const keys = new Map(Object.keys(glossary).map((k) => [k.toLowerCase(), k]))
  const out = new Set<string>(first)
  for (const t of terms) {
    const k = canonicalTech(t) ?? keys.get(t.trim().toLowerCase())
    if (k !== undefined) out.add(k)
  }
  return [...out].slice(0, max)
}
