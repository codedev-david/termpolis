// Lumopolis import lines for Python, Go, Rust, Java and Kotlin: the imports a file writes, read from the text the
// compile already has (scan), and resolved to the project files they name (resolve). A resolved import becomes a
// relative specifier to that exact file (`./store.py`, `../models/note.go`), so resolveImport and everything that
// reads `fileImports` treat it as it treats a JS/TS one. An import that names no project file (the standard library,
// a third-party package) is dropped: no line, and never a part of its own. Pure: no fs, no Electron, line scanning and
// linear regexes only.
//
// Comments are blanked before the scan (and, for Python and Rust, string contents too, so a docstring or a string that
// reads like an import is not one). Go, Java and Kotlin imports can only open a file, so their scan stops at the first
// declaration that is not a package clause or an import.
import { stripComments } from './detectors'

/** Files whose imports this module reads. */
export const LANG_FILE = /\.(?:py|go|rs|java|kt)$/

/** What a scan found: tagged import references, and the package a Java or Kotlin file declares. */
export interface LangScan {
  /** `py:f:<dots><module>:<names>`, `py:i:<module>`, `go:<path>`, `rs:m:<name>`, `rs:u:<a::b>` or `jv:<a.b.C>`. */
  refs: string[]
  pkg?: string
  /** A Kotlin file's top-level names (functions, properties, classes, objects), so `import a.b.helper` finds its file. */
  decls?: string[]
}

/** A Go module: the folder its go.mod is in (repository-relative, '' for the root) and the module path it declares. */
export interface GoModule {
  dir: string
  path: string
}

/** An import of a whole package (Go, a Java wildcard) links every file of a package this small, one file of a bigger one. */
export const PACKAGE_LINKS = 8
/** Use trees expand to at most this many paths (`use a::{b, c::{d, e}}`), so a pathological one stays bounded. */
const MAX_USE_PATHS = 64
/** A parenthesised Python import list closes within this many characters, or only its first line is read. */
const MAX_PY_LIST = 4000
/** A Kotlin file records at most this many top-level names. */
const MAX_KT_NAMES = 256

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const lastSeg = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const stem = (p: string): string => lastSeg(p).replace(/\.[^.]*$/, '')
const join = (...parts: string[]): string => parts.filter((s) => s !== '').join('/')
const IDENT = /^[A-Za-z_]\w*$/
const DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/

// ── scan ────────────────────────────────────────────────────────────────────────────────────────

/** `text` with the characters from `from` to `to` turned to spaces, newlines kept. */
function blankRange(out: string[], text: string, from: number, to: number): void {
  for (let k = from; k < to; k++) if (text[k] !== '\n') out[k] = ' '
}

/** Python text with `#` comments and every string literal (triple-quoted ones too) blanked, offsets kept. */
export function blankPython(text: string): string {
  const out = text.split('')
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '#') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blankRange(out, text, i, j)
      i = j
    } else if (c === '"' || c === "'") {
      const triple = text.startsWith(c + c + c, i)
      const quote = triple ? c + c + c : c
      let j = i + quote.length
      while (j < n && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++
        else if (!triple && text[j] === '\n') break
        j++
      }
      const end = Math.min(n, j + (text.startsWith(quote, j) ? quote.length : 0))
      blankRange(out, text, i, end)
      i = end
    } else i++
  }
  return out.join('')
}

const CHAR_LITERAL = /'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[^\n])|[^\\'\n])'/y
const RAW_OPEN = /b?r(#*)"/y

/** Rust text with comments (block comments nest), string and char literal contents blanked; a lifetime stays. */
export function blankRust(text: string): string {
  const out = text.split('')
  const n = text.length
  const identAt = (k: number): boolean => k >= 0 && /\w/.test(text[k])
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blankRange(out, text, i, j)
      i = j
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 0
      let j = i
      do {
        if (text.startsWith('/*', j) || text.startsWith('*/', j)) {
          depth += text[j] === '/' ? 1 : -1
          j += 2
        } else j++
      } while (depth > 0 && j < n)
      blankRange(out, text, i, j)
      i = j
      continue
    }
    if ((c === 'r' || c === 'b') && !identAt(i - 1)) {
      RAW_OPEN.lastIndex = i
      const raw = RAW_OPEN.exec(text)
      if (raw) {
        const close = text.indexOf(`"${raw[1]}`, i + raw[0].length)
        const end = close < 0 ? n : close + 1 + raw[1].length
        blankRange(out, text, i, end)
        i = end
        continue
      }
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const end = Math.min(n, j + 1)
      blankRange(out, text, i, end)
      i = end
      continue
    }
    if (c === "'") {
      CHAR_LITERAL.lastIndex = i
      const ch = CHAR_LITERAL.exec(text)
      if (ch) blankRange(out, text, i, i + ch[0].length)
      i += ch ? ch[0].length : 1
      continue
    }
    i++
  }
  return out.join('')
}

// The list after `import` is read by hand, never by a bounded `\([^)]{0,n}\)`, which backtracks n characters on every
// `(` that does not close. The lookahead after `from`'s spaces stops a run of spaces with no module after it from being
// split between the two `[ \t]+` (both groups between them can be empty), which took seconds on `from` and 50k spaces.
const PY_FROM = /(?:^|;)[ \t]*from[ \t]+(?=[.A-Za-z_])(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]*(\(?)/gm
const PY_LINE_REST = /[^\n;]*/y
const PY_IMPORT = /(?:^|;)[ \t]*import[ \t]+([^\n;]+)/gm

/** The names a `from ... import` brings in: identifiers before any `as`, never `*`. */
function importedNames(list: string): string[] {
  return list
    .replace(/[()\\]/g, ' ')
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter((s) => IDENT.test(s))
}

function scanPython(text: string): string[] {
  const t = blankPython(text)
  const refs: string[] = []
  // The next `)` at or after the scan, found once and reused while the scan is before it, so the search stays linear.
  let close = -1
  PY_FROM.lastIndex = 0
  for (let m = PY_FROM.exec(t); m !== null; m = PY_FROM.exec(t)) {
    const at = PY_FROM.lastIndex
    if (close !== Infinity && close < at) {
      const next = t.indexOf(')', at)
      close = next < 0 ? Infinity : next
    }
    let list: string
    if (m[3] === '(' && close - at <= MAX_PY_LIST) {
      list = t.slice(at, close)
      PY_FROM.lastIndex = close + 1
    } else {
      PY_LINE_REST.lastIndex = at
      list = (PY_LINE_REST.exec(t) as RegExpExecArray)[0]
    }
    const mod = m[2] ?? ''
    if ((m[1] === '' && mod === '') || (mod !== '' && !DOTTED.test(mod))) continue
    refs.push(`py:f:${m[1]}${mod}:${importedNames(list).join(',')}`)
  }
  for (const m of t.matchAll(PY_IMPORT)) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+/)[0]
      if (DOTTED.test(mod)) refs.push(`py:i:${mod}`)
    }
  }
  return refs
}

const GO_PACKAGE = /^\s*package\s+[A-Za-z_]\w*\s*;?/y
const GO_IMPORT_BLOCK = /\s*import\s*\(([^)]*)\)\s*;?/y
const GO_IMPORT_ONE = /\s*import\s+(?:[A-Za-z_.]\w*\s+)?("[^"\n]*"|`[^`]*`)\s*;?/y
const GO_PATH = /"([^"\n]*)"|`([^`]*)`/g

/** The import paths of a Go file: the import declarations right after its package clause. */
function scanGo(text: string): string[] {
  const t = stripComments(text)
  GO_PACKAGE.lastIndex = 0
  if (!GO_PACKAGE.exec(t)) return []
  let at = GO_PACKAGE.lastIndex
  const refs: string[] = []
  for (;;) {
    GO_IMPORT_BLOCK.lastIndex = at
    GO_IMPORT_ONE.lastIndex = at
    const block = GO_IMPORT_BLOCK.exec(t)
    const one = block ? null : GO_IMPORT_ONE.exec(t)
    const m = block ?? one
    if (!m) break
    for (const p of m[1].matchAll(GO_PATH)) refs.push(`go:${p[1] ?? p[2]}`)
    at = block ? GO_IMPORT_BLOCK.lastIndex : GO_IMPORT_ONE.lastIndex
  }
  return refs
}

const RS_MOD = /^[ \t]*((?:#!?\[[^\]\n]*\][ \t]*)*)(?:pub(?:\([^)\n]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm
// The tree after `use` is read by hand up to its `;`, as Python's import list is (scanRust).
const RS_USE = /^[ \t]*(?:#!?\[[^\]\n]*\][ \t]*)*(?:pub(?:\([^)\n]*\))?[ \t]+)?use[ \t]+/gm
/** A use tree ends with `;` within this many characters, or it is not read. */
const MAX_USE_CHARS = 2000
const RS_TOKEN = /::|[{},*]|[A-Za-z_]\w*|\S/g
/** Crates that are never project files. */
const RS_EXTERN = new Set(['std', 'core', 'alloc'])

/** The paths a Rust use tree names, as segment lists (`a::{b, c::d}` -> a::b, a::c::d); `self` in a group is its prefix. */
export function expandUse(tree: string): string[][] {
  const tok = tree.match(RS_TOKEN) ?? []
  const out: string[][] = []
  let k = 0
  const emit = (path: string[]): void => {
    if (out.length < MAX_USE_PATHS) out.push(path)
  }
  const list = (prefix: string[]): void => {
    while (k < tok.length && tok[k] !== '}') {
      one(prefix)
      if (tok[k] === ',') k++
      else break
    }
  }
  const one = (prefix: string[]): void => {
    if (tok[k] === '{') {
      k++
      list(prefix)
      if (tok[k] === '}') k++
      return
    }
    if (tok[k] === '*') {
      k++
      emit(prefix)
      return
    }
    if (!IDENT.test(tok[k])) {
      k = tok.length
      return
    }
    const segs = [...prefix]
    if (!(tok[k] === 'self' && prefix.length > 0)) segs.push(tok[k])
    k++
    while (tok[k] === '::') {
      k++
      if (tok[k] === '{' || tok[k] === '*') return one(segs)
      if (!IDENT.test(tok[k] ?? '')) {
        k = tok.length
        return
      }
      segs.push(tok[k++])
    }
    if (tok[k] === 'as') k += 2
    emit(segs)
  }
  list([])
  return out
}

/** At most this many attributes are read above an item, each within this many characters. */
const RS_ATTRS_ABOVE = 16
const RS_ATTR_SPAN = 1000

/**
 * The attributes on the lines above `at` (`#[path = "x"]` on a line of its own, as rustfmt writes it), across blank
 * lines, comments and other attributes. Bounded: at most RS_ATTRS_ABOVE of them, each within RS_ATTR_SPAN.
 */
function attrsAbove(t: string, at: number): string {
  let out = ''
  let k = at
  for (let n = 0; n < RS_ATTRS_ABOVE; n++) {
    let j = k - 1
    while (j >= 0 && k - j <= RS_ATTR_SPAN && /\s/.test(t[j])) j--
    if (j < 0 || t[j] !== ']') break
    let open = j - 1
    // An attribute holds no `;`, `{` or `}`: reaching one means the `]` closed something else.
    while (open > 0 && j - open <= RS_ATTR_SPAN && t[open] !== '[' && !';{}'.includes(t[open])) open--
    const hash = t[open] !== '[' ? -1 : t[open - 1] === '#' ? open - 1 : t[open - 1] === '!' && t[open - 2] === '#' ? open - 2 : -1
    if (hash < 0) break
    out += t.slice(hash, j + 1)
    k = hash
  }
  return out
}

function scanRust(text: string): string[] {
  const t = blankRust(text)
  const refs: string[] = []
  // `#[path = "..."]` points the module somewhere else; that is not followed, on the `mod` line or on the lines above.
  for (const m of t.matchAll(RS_MOD)) if (!/\bpath\b/.test(m[1] + attrsAbove(t, m.index))) refs.push(`rs:m:${m[2]}`)
  // The next `;` at or after the scan, found once and reused while the scan is before it (as Python's `)`), so a `use`
  // that never ends costs its own line, not MAX_USE_CHARS of backtracking.
  let semi = -1
  RS_USE.lastIndex = 0
  for (let m = RS_USE.exec(t); m !== null; m = RS_USE.exec(t)) {
    const at = RS_USE.lastIndex
    if (semi !== Infinity && semi < at) {
      const next = t.indexOf(';', at)
      semi = next < 0 ? Infinity : next
    }
    if (semi - at > MAX_USE_CHARS) continue
    RS_USE.lastIndex = semi + 1
    for (const path of expandUse(t.slice(at, semi))) if (!RS_EXTERN.has(path[0])) refs.push(`rs:u:${path.join('::')}`)
  }
  return refs
}

const JV_PACKAGE = /^package\s+([A-Za-z_][\w.]*)$/
const JV_IMPORT = /^import\s+(?:static\s+)?([A-Za-z_][\w.]*?(?:\.\*)?)(?:\s+as\s+\w+)?$/

// A Kotlin top-level declaration starts a line; members are indented. The head (up to `(`, `:`, `=` or `{`) holds the
// name, after any type parameters (bounds and one level of nesting included) and receiver: `fun <T : Any> List<T>.second(`
// names `second`. A head longer than 200 characters is no declaration anyone imports, and is not read.
const KT_TOP =
  /^(?:(?:public|internal|private|protected|open|final|abstract|sealed|data|enum|annotation|value|inline|suspend|operator|infix|tailrec|external|const|lateinit|expect|actual|fun)[ \t]+)*(?:fun|val|var|class|interface|object|typealias)[ \t]+((?:<(?:[^\n<>]|<[^\n<>]*>){0,200}>[ \t]*)?[^\n(:={]{1,200})(?=[\n(:={]|$)/gm

/** A Kotlin file's top-level names, at most MAX_KT_NAMES. */
function kotlinNames(t: string): string[] {
  const names = new Set<string>()
  for (const m of t.matchAll(KT_TOP)) {
    let head = m[1]
    for (let n = 0; n < 4 && head.includes('<'); n++) head = head.replace(/<[^<>]*>/g, '')
    const token = head.trim().split(/\s+/)[0]
    const name = token.slice(token.lastIndexOf('.') + 1)
    if (IDENT.test(name)) names.add(name)
    if (names.size >= MAX_KT_NAMES) break
  }
  return [...names]
}

/** A Java or Kotlin file's package and imports (the statements before its first declaration), and Kotlin's top-level names. */
function scanJvm(text: string, kotlin: boolean): LangScan {
  const refs: string[] = []
  let pkg: string | undefined
  const t = stripComments(text)
  for (const raw of t.split(/[;\n]/)) {
    const s = raw.trim()
    if (s === '' || s.startsWith('@')) continue
    const p = JV_PACKAGE.exec(s)
    const m = p ? null : JV_IMPORT.exec(s)
    if (p) pkg = p[1]
    else if (m) refs.push(`jv:${m[1]}`)
    else break
  }
  const names = kotlin ? kotlinNames(t) : []
  return { refs, ...(pkg === undefined ? {} : { pkg }), ...(names.length > 0 ? { decls: names } : {}) }
}

/** `text` without a leading byte-order mark, which Windows editors write and `^` does not skip. */
const noBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** The tagged imports (and a Java or Kotlin package) of a Python, Go, Rust, Java or Kotlin file; null for any other. */
export function scanLangImports(file: string, source: string): LangScan | null {
  const ext = LANG_FILE.exec(file)?.[0]
  if (ext === undefined) return null
  const text = noBom(source)
  if (ext === '.java' || ext === '.kt') return scanJvm(text, ext === '.kt')
  const refs = ext === '.py' ? scanPython(text) : ext === '.go' ? scanGo(text) : scanRust(text)
  return { refs: [...new Set(refs)] }
}

/** The module path a go.mod declares, or null when it declares none. */
export function goModulePath(text: string): string | null {
  const m = /^[ \t]*module[ \t]+(?:"([^"\n]+)"|`([^`\n]+)`|([^\s"`/][^\s]*))/m.exec(stripComments(noBom(text)))
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : null
}

// ── resolve ─────────────────────────────────────────────────────────────────────────────────────

/** A specifier from `importer` to the file `target` that resolveImport reads back as `target` exactly. */
export function relativeSpec(importer: string, target: string): string {
  const from = dirOf(importer).split('/').filter(Boolean)
  const to = target.split('/')
  let n = 0
  while (n < from.length && n < to.length - 1 && from[n] === to[n]) n++
  const rest = to.slice(n).join('/')
  return n === from.length ? `./${rest}` : `${'../'.repeat(from.length - n)}${rest}`
}

const RS_CRATE_FILE = new Set(['lib.rs', 'main.rs', 'build.rs'])

/**
 * Each file's resolved imports, as relative specifiers to the exact files they name (only files with at least one).
 * `scans` holds what scanLangImports found per file; `goModules` the project's go.mod files.
 */
export function resolveLangImports(
  files: readonly string[],
  scans: ReadonlyMap<string, { refs?: readonly string[]; pkg?: string; decls?: readonly string[] }>,
  goModules: readonly GoModule[]
): Map<string, string[]> {
  const has = new Set(files)
  const inDir = new Map<string, string[]>()
  for (const f of files) {
    const d = dirOf(f)
    const list = inDir.get(d)
    if (list) list.push(f)
    else inDir.set(d, [f])
  }
  const byPackage = new Map<string, string[]>()
  for (const f of files) {
    const pkg = scans.get(f)?.pkg
    if (pkg === undefined) continue
    const list = byPackage.get(pkg)
    if (list) list.push(f)
    else byPackage.set(pkg, [f])
  }
  /**
   * The files an import of a whole package reaches: every member of a small package (a small project can put each
   * file in a building of its own), and one file to stand for a bigger one, the one named after it, else the first.
   */
  const pick = (members: readonly string[], name: string): string[] =>
    members.length <= PACKAGE_LINKS ? [...members] : [members.find((f) => stem(f).toLowerCase() === name.toLowerCase()) ?? members[0]]

  // Python: a module is `m.py` or the package `m/__init__.py`.
  const pyModule = (m: string): string | null => (m !== '' && has.has(`${m}.py`) ? `${m}.py` : has.has(join(m, '__init__.py')) ? join(m, '__init__.py') : null)
  const isPackage = (d: string): boolean => has.has(join(d, '__init__.py'))
  /** Where an absolute import is looked up: a script's own folder, the folder above its top package, the root, src/. */
  const pyRoots = (importer: string): string[] => {
    const dir = dirOf(importer)
    let top = dir
    while (top !== '' && isPackage(top)) top = dirOf(top)
    return [...new Set([...(isPackage(dir) ? [] : [dir]), top, '', 'src'])]
  }
  /** What `from <module> import <names>` reaches from `base`: each name that is a submodule, else the module. */
  const pyFrom = (m: string, names: string[]): string[] => {
    const subs = names.map((n) => pyModule(join(m, n)))
    const own = names.length === 0 || subs.includes(null) ? pyModule(m) : null
    return [...subs, own].filter((x): x is string => x !== null)
  }
  const python = (importer: string, ref: string): string[] => {
    if (ref.startsWith('py:i:')) {
      const segs = ref.slice(5).split('.')
      for (const root of pyRoots(importer)) {
        for (let k = segs.length; k > 0; k--) {
          const hit = pyModule(join(root, ...segs.slice(0, k)))
          if (hit) return [hit]
        }
      }
      return []
    }
    const [, , spec, list] = ref.split(':')
    const names = list === '' ? [] : list.split(',')
    const dots = /^\.*/.exec(spec)![0].length
    const mod = spec.slice(dots).split('.').filter(Boolean)
    if (dots === 0) {
      for (const root of pyRoots(importer)) {
        const hits = pyFrom(join(root, ...mod), names)
        if (hits.length > 0) return hits
      }
      return []
    }
    let base = dirOf(importer)
    for (let up = 1; up < dots; up++) {
      if (base === '') return []
      base = dirOf(base)
    }
    return pyFrom(join(base, ...mod), names)
  }

  // Go: the longest module path the import starts with, then the package folder, if that folder is in that module.
  const modules = [...goModules].sort((a, z) => z.path.length - a.path.length)
  const moduleDirs = new Set(goModules.map((m) => m.dir))
  const go = (ref: string): string[] => {
    const path = ref.slice(3)
    const mod = modules.find((m) => path === m.path || path.startsWith(`${m.path}/`))
    if (!mod) return []
    const dir = join(mod.dir, path.slice(mod.path.length + 1))
    // A folder inside a nested module belongs to that module, not this one. `mod.dir` is above `dir`, so the walk ends.
    let at = dir
    while (at !== mod.dir && !moduleDirs.has(at)) at = dirOf(at)
    if (at !== mod.dir) return []
    const members = (inDir.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    return members.length > 0 ? pick(members, lastSeg(dir)) : []
  }

  // Rust: a module's children live in its folder (mod.rs, a crate root) or in a folder named after it.
  const crateRootFile = (f: string): boolean =>
    RS_CRATE_FILE.has(lastSeg(f)) || /(?:^|\/)src\/bin\/[^/]+\.rs$/.test(f) || (/(?:^|\/)(?:tests|examples|benches)\/[^/]+\.rs$/.test(f) && !/(?:^|\/)src\//.test(f))
  const childDir = (f: string): string => (crateRootFile(f) || lastSeg(f) === 'mod.rs' ? dirOf(f) : join(dirOf(f), stem(f)))
  const child = (d: string, name: string): string | null => (has.has(join(d, `${name}.rs`)) ? join(d, `${name}.rs`) : has.has(join(d, name, 'mod.rs')) ? join(d, name, 'mod.rs') : null)
  const rust = (importer: string, ref: string): string[] => {
    if (ref.startsWith('rs:m:')) {
      const hit = child(childDir(importer), ref.slice(5))
      return hit ? [hit] : []
    }
    // The crate's folder and root file: the importer itself when it is a crate root, else the nearest lib.rs/main.rs.
    let crateDir: string | null = null
    let crateFile: string | null = null
    if (crateRootFile(importer)) [crateDir, crateFile] = [dirOf(importer), importer]
    else {
      for (let d = dirOf(importer); ; d = dirOf(d)) {
        const root = ['lib.rs', 'main.rs'].map((n) => join(d, n)).find((f) => has.has(f))
        if (root) {
          ;[crateDir, crateFile] = [d, root]
          break
        }
        if (d === '') break
      }
    }
    const segs = ref.slice(5).split('::')
    let start = childDir(importer)
    let rest = segs.slice(1)
    if (segs[0] === 'crate') {
      if (crateDir === null) return []
      start = crateDir
    } else if (segs[0] === 'super') {
      start = dirOf(childDir(importer))
      if (childDir(importer) === crateDir) return []
      for (; rest[0] === 'super'; rest = rest.slice(1)) {
        if (start === crateDir || start === '') return []
        start = dirOf(start)
      }
    } else if (segs[0] !== 'self') rest = segs
    let found: string | null = null
    let d = start
    for (const seg of rest) {
      const hit = child(d, seg)
      if (!hit) break
      found = hit
      d = join(d, seg)
    }
    // Nothing below names a module file (`use super::Item`): the start module's own file, but only for crate, self and super.
    if (found === null && rest !== segs) found = start === crateDir ? crateFile : has.has(`${start}.rs`) ? `${start}.rs` : has.has(join(start, 'mod.rs')) ? join(start, 'mod.rs') : null
    return found ? [found] : []
  }

  // Java and Kotlin: packages as the files declare them. `a.b.C` is C.java/C.kt in package a.b, or the Kotlin file of
  // a.b that declares C at top level (a nested class or a static member reads the same way, shorter). A name no file
  // declares draws nothing, never the whole package; only a wildcard `a.b.*` reaches a package as a whole.
  const declared = new Map<string, Set<string>>()
  for (const f of files) {
    const names = scans.get(f)?.decls
    if (names !== undefined) declared.set(f, new Set(names))
  }
  const jvm = (ref: string): string[] => {
    const name = ref.slice(3)
    const wild = name.endsWith('.*')
    const segs = (wild ? name.slice(0, -2) : name).split('.')
    if (wild) return byPackage.has(segs.join('.')) ? pick(byPackage.get(segs.join('.')) as string[], segs[segs.length - 1]) : []
    for (let k = segs.length - 1; k > 0; k--) {
      const members = byPackage.get(segs.slice(0, k).join('.')) ?? []
      const hit = members.find((f) => stem(f) === segs[k]) ?? members.find((f) => declared.get(f)?.has(segs[k]))
      if (hit) return [hit]
    }
    return []
  }

  // A Go or JVM import reads the same from every file, a Python import from every file in one folder: each is resolved once.
  const once = new Map<string, string[]>()
  const shared = (ref: string, by: (r: string) => string[]): string[] => {
    let hits = once.get(ref)
    if (hits === undefined) once.set(ref, (hits = by(ref)))
    return hits
  }
  const out = new Map<string, string[]>()
  for (const f of files) {
    const refs = scans.get(f)?.refs ?? []
    const specs = new Set<string>()
    for (const ref of refs) {
      const tag = ref.slice(0, 3)
      const hits = tag === 'py:' ? shared(`${dirOf(f)}\0${ref}`, () => python(f, ref)) : tag === 'go:' ? shared(ref, go) : tag === 'rs:' ? rust(f, ref) : tag === 'jv:' ? shared(ref, jvm) : []
      for (const h of hits) if (h !== f) specs.add(relativeSpec(f, h))
    }
    if (specs.size > 0) out.set(f, [...specs])
  }
  return out
}
