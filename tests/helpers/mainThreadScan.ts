// The scanner behind tests/electron/mainThreadScan.test.ts (AC1: no spawn and no synchronous file
// work on the Electron main thread, which also pumps every PTY).
//
// It reads src/main with the TypeScript parser (no type checking: fast, and the answer must not
// depend on a build) and returns every CALL SITE of
//   * a `*Sync(` function: fs.readFileSync, existsSync, execSync, scryptSync, gunzipSync and a
//     project function named like one (flushHistorySync(): a call to something that blocks);
//   * a child-process creation: spawn / exec / execFile / fork / execSync / spawnSync /
//     execFileSync bound to child_process (named import, namespace, require, dynamic import),
//     electron's utilityProcess.fork and node-pty's spawn.
// A RegExp's .exec() is not a child process and is not counted: only names that the file bound to
// child_process count.
//
// Sites are keyed by (file, enclosing function) and counted per call name, never by line number, so
// an edit that moves code does not disturb the allowlist and an edit that ADDS a call does.
//
// HP-2 (1.54.5): also element access (fs['existsSync']), `import x = require(...)`, a function
// destructured from a namespace variable, a require() of a run-time path, new Worker() from
// worker_threads, electron's shell.openPath/openExternal/showItemInFolder, a third-party process
// wrapper (cross-spawn, tree-kill, execa, ...), and every file outside src/main that main imports
// (followed transitively). Not seen: a new CALLER of an allowlisted helper (mainThreadHotPaths pins
// the hot paths) and CPU work such as JSON.parse.

import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

export type SiteKind = 'sync' | 'spawn'

export interface Site {
  file: string
  /** The enclosing function chain, e.g. `whenReady.then > handle('terminal:export')`; `<module>` at top level. */
  fn: string
  /** The call's name: `readFileSync`, `fs.readFileSync` -> `readFileSync`; `utilityProcess.fork`, `pty.spawn`, `spawn`. */
  call: string
  kind: SiteKind
  line: number
}

export interface SiteGroup {
  file: string
  fn: string
  calls: Record<string, number>
  lines: Record<string, number[]>
}

const CP_FNS = new Set(['spawn', 'exec', 'execFile', 'fork', 'execSync', 'spawnSync', 'execFileSync'])
const CP_MODULE = /^(node:)?child_process$/
const FS_MODULE = /^(node:)?fs$/
const WORKER_MODULE = /^(node:)?worker_threads$/
/** Third-party modules whose exports start or signal processes. A call of anything imported from one counts. */
const WRAPPER_MODULE = /^(cross-spawn|tree-kill|execa|ps-tree|ps-list|pidtree|find-process|open|node-cmd|shelljs)$/
const SHELL_FNS = new Set(['openPath', 'openExternal', 'showItemInFolder'])

export function sourceFilesOf(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFilesOf(p))
    else if (/\.(ts|tsx|cts|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

function isStringish(n: ts.Node | undefined): n is ts.StringLiteralLike {
  return !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
  )
}

function calleeLabel(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression
  const prefix = ts.isNewExpression(call) ? 'new ' : ''
  if (ts.isIdentifier(e)) return prefix + e.text
  if (ts.isPropertyAccessExpression(e)) return prefix + e.name.text
  return prefix + 'call'
}

type CallLike = ts.CallExpression | ts.NewExpression

function callBase(call: CallLike): string {
  const arg0 = call.arguments?.[0]
  return calleeLabel(call) + (isStringish(arg0) ? `('${arg0.text}')` : '')
}

/** For one function scope: the start offsets of the calls (directly in it, not in a nested function)
 *  that take a callback, grouped by the label such a callback gets. */
function indexScope(scope: ts.Node): Map<string, number[]> {
  const m = new Map<string, number[]>()
  const walk = (n: ts.Node): void => {
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.some((a) => isFunctionLike(a))) {
      const base = callBase(n)
      const list = m.get(base) ?? []
      list.push(n.getStart())
      m.set(base, list)
    }
    ts.forEachChild(n, (c) => { if (!isFunctionLike(c)) walk(c) })
  }
  ts.forEachChild(scope, (c) => { if (!isFunctionLike(c)) walk(c) })
  return m
}

/** A stable name for one function in a chain. Anonymous callbacks are named after the call they are
 *  passed to (handle('terminal:kill'), setInterval, on('data')), numbered when one function
 *  holds several alike. */
function fnLabel(fn: ts.FunctionLikeDeclaration, scope: ts.Node, scopes: Map<ts.Node, Map<string, number[]>>): string {
  if (ts.isFunctionDeclaration(fn)) return fn.name ? fn.name.text : 'default'
  if (ts.isConstructorDeclaration(fn)) return 'constructor'
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    const cls = fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) && fn.parent.name ? `${fn.parent.name.text}.` : ''
    return cls + fn.name.getText()
  }
  let p: ts.Node = fn.parent
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText()
  if (ts.isExportAssignment(p)) return 'default'
  let wrapped: ts.Node = fn
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) { wrapped = p; p = p.parent }
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === wrapped) return 'iife'
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === wrapped)) {
    const base = callBase(p)
    let idx = scopes.get(scope)
    if (!idx) scopes.set(scope, (idx = indexScope(scope)))
    const list = idx.get(base) ?? []
    const at = list.indexOf(p.getStart())
    return at > 0 ? `${base}#${at + 1}` : base
  }
  return 'anonymous'
}

export function scanFile(file: string, root: string): Site[] {
  return scanFileFull(file, root).sites
}

function scanFileFull(file: string, root: string): { sites: Site[]; imports: string[] } {
  const rel = relative(root, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  // Names this file bound to child_process, electron's utilityProcess and node-pty.
  const fsNamed = new Map<string, string>() // local alias -> the fs function it was imported as (`readFileSync as rf`)
  const fsNamespace = new Set<string>() // local names of the whole fs module (`import * as fs`, `import fs`, `const fs = require('fs')`)
  const cpNamed = new Map<string, string>() // local -> imported child_process function
  const cpNamespace = new Set<string>() // local names of the whole module
  const utilityLocals = new Set<string>()
  const ptyNamespace = new Set<string>()
  const ptySpawnLocals = new Set<string>()
  const shellLocals = new Set<string>() // electron's shell
  const workerLocals = new Set<string>() // worker_threads' Worker
  const wtNamespace = new Set<string>()
  const wrapperLocals = new Map<string, string>() // local -> third-party process module it came from
  const imports: string[] = [] // relative module specifiers, followed by scanMainThreadSites

  /** `require('m')`, `await import('m')`, with any parentheses and casts around it. */
  const isModuleExpr = (e: ts.Expression | undefined, wanted: RegExp): boolean => {
    if (!e) return false
    let x: ts.Expression = e
    while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = (x as ts.ParenthesizedExpression).expression
    if (!ts.isCallExpression(x)) return false
    const callee = x.expression
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
    const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
    return (isRequire || isDynamicImport) && isStringish(x.arguments[0]) && wanted.test(x.arguments[0].text)
  }
  const isCpModuleExpr = (e: ts.Expression | undefined): boolean => isModuleExpr(e, CP_MODULE)
  /** The module a `require('m')` / `import('m')` names, or ''. */
  const moduleOf = (e: ts.Expression | undefined): string => {
    if (!e) return ''
    let x: ts.Expression = e
    while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = (x as ts.ParenthesizedExpression).expression
    if (!ts.isCallExpression(x)) return ''
    const callee = x.expression
    const ok = (ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword
    return ok && isStringish(x.arguments[0]) ? x.arguments[0].text : ''
  }
  /** A whole module bound to one local name (`import x = require`, `const x = require`, `import * as x`, `import x`). */
  const bindNamespace = (mod: string, local: string): void => {
    if (FS_MODULE.test(mod)) fsNamespace.add(local)
    else if (CP_MODULE.test(mod)) cpNamespace.add(local)
    else if (mod === 'node-pty') ptyNamespace.add(local)
    else if (WORKER_MODULE.test(mod)) wtNamespace.add(local)
    else if (WRAPPER_MODULE.test(mod)) wrapperLocals.set(local, mod)
  }

  const bind = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
      && n.moduleSpecifier.text.startsWith('.') && !(ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly)) {
      imports.push(n.moduleSpecifier.text)
    }
    if (ts.isCallExpression(n) && isStringish(n.arguments[0]) && n.arguments[0].text.startsWith('.')
      && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      imports.push(n.arguments[0].text)
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isStringish(n.moduleReference.expression)) {
      bindNamespace(n.moduleReference.expression.text, n.name.text)
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause && !n.importClause.isTypeOnly) {
      const mod = n.moduleSpecifier.text
      const c = n.importClause
      if (WORKER_MODULE.test(mod) || WRAPPER_MODULE.test(mod)) {
        if (c.name) bindNamespace(mod, c.name.text)
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) bindNamespace(mod, c.namedBindings.name.text)
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) {
            if (WRAPPER_MODULE.test(mod)) wrapperLocals.set(el.name.text, mod)
            else if ((el.propertyName ?? el.name).text === 'Worker') workerLocals.add(el.name.text)
          }
        }
      }
      if (mod === 'electron' && c.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'shell') shellLocals.add(el.name.text)
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text
      const c = n.importClause
      if (c) {
        if (FS_MODULE.test(mod) && c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) fsNamed.set(el.name.text, (el.propertyName ?? el.name).text)
        }
        if (FS_MODULE.test(mod)) {
          if (c.name) fsNamespace.add(c.name.text)
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) fsNamespace.add(c.namedBindings.name.text)
        }
        if (CP_MODULE.test(mod)) {
          if (c.name) cpNamespace.add(c.name.text)
          if (c.namedBindings) {
            if (ts.isNamespaceImport(c.namedBindings)) cpNamespace.add(c.namedBindings.name.text)
            else for (const el of c.namedBindings.elements) cpNamed.set(el.name.text, (el.propertyName ?? el.name).text)
          }
        } else if (mod === 'electron' && c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'utilityProcess') utilityLocals.add(el.name.text)
        } else if (mod === 'node-pty') {
          if (c.name) ptyNamespace.add(c.name.text)
          if (c.namedBindings) {
            if (ts.isNamespaceImport(c.namedBindings)) ptyNamespace.add(c.namedBindings.name.text)
            else for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'spawn') ptySpawnLocals.add(el.name.text)
          }
        }
      }
    }
    if (ts.isVariableDeclaration(n)) {
      const req = moduleOf(n.initializer)
      if (req && ts.isIdentifier(n.name) && (WORKER_MODULE.test(req) || WRAPPER_MODULE.test(req))) bindNamespace(req, n.name.text)
      if (req === 'electron' && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name) && (el.propertyName ?? el.name).getText() === 'shell') shellLocals.add(el.name.text)
      }
      // const { readFileSync } = fs, where fs is the whole module bound earlier
      const init = n.initializer
      if (init && ts.isIdentifier(init) && ts.isObjectBindingPattern(n.name) && (fsNamespace.has(init.text) || cpNamespace.has(init.text))) {
        const into = fsNamespace.has(init.text) ? fsNamed : cpNamed
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) into.set(el.name.text, (el.propertyName ?? el.name).getText())
      }
      if (isModuleExpr(n.initializer, FS_MODULE) && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) fsNamed.set(el.name.text, (el.propertyName ?? el.name).getText())
      }
      if (isModuleExpr(n.initializer, FS_MODULE) && ts.isIdentifier(n.name)) fsNamespace.add(n.name.text)
      if (isCpModuleExpr(n.initializer)) {
        if (ts.isIdentifier(n.name)) cpNamespace.add(n.name.text)
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) cpNamed.set(el.name.text, (el.propertyName ?? el.name).getText())
        }
      } else if (isModuleExpr(n.initializer, /^electron$/) && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name) && (el.propertyName ?? el.name).getText() === 'utilityProcess') utilityLocals.add(el.name.text)
      } else if (isModuleExpr(n.initializer, /^node-pty$/)) {
        if (ts.isIdentifier(n.name)) ptyNamespace.add(n.name.text)
        else if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) if (ts.isIdentifier(el.name) && (el.propertyName ?? el.name).getText() === 'spawn') ptySpawnLocals.add(el.name.text)
      }
    }
    // const run = promisify(execFile)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      const c = n.initializer
      const callee = ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ''
      const a = c.arguments[0]
      if (callee === 'promisify' && a && ts.isIdentifier(a) && cpNamed.has(a.text)) cpNamed.set(n.name.text, cpNamed.get(a.text) as string)
    }
    ts.forEachChild(n, bind)
  }
  bind(sf)

  const sites: Site[] = []
  const scopes = new Map<ts.Node, Map<string, number[]>>()

  const functionChain = (node: ts.Node): string => {
    const parts: string[] = []
    let n: ts.Node | undefined = node.parent
    while (n) {
      if (isFunctionLike(n)) {
        // The scope that numbers its anonymous callbacks is the next function out.
        let scope: ts.Node = sf
        for (let s = n.parent; s; s = s.parent) if (isFunctionLike(s)) { scope = s; break }
        parts.unshift(fnLabel(n, scope, scopes))
      }
      n = n.parent
    }
    return parts.length ? parts.join(' > ') : '<module>'
  }

  const record = (node: ts.Node, call: string, kind: SiteKind): void => {
    sites.push({ file: rel, fn: functionChain(node), call, kind, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
  }

  const isCallee = (n: ts.Node): boolean => !!n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n

  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n)) {
      const e = n.expression
      if ((ts.isIdentifier(e) && workerLocals.has(e.text))
        || (ts.isPropertyAccessExpression(e) && e.name.text === 'Worker' && ts.isIdentifier(e.expression) && wtNamespace.has(e.expression.text))) {
        record(n, 'new Worker', 'spawn')
      }
    }
    if (ts.isCallExpression(n)) {
      const e = n.expression
      if (ts.isIdentifier(e)) {
        if (fsNamed.has(e.text) && /Sync$/.test(fsNamed.get(e.text) as string)) record(n, fsNamed.get(e.text) as string, 'sync')
        else if (/Sync$/.test(e.text) && e.text.length > 4) record(n, e.text, 'sync')
        else if (cpNamed.has(e.text) && CP_FNS.has(cpNamed.get(e.text) as string)) record(n, cpNamed.get(e.text) as string, 'spawn')
        else if (ptySpawnLocals.has(e.text)) record(n, 'pty.spawn', 'spawn')
        else if (wrapperLocals.has(e.text)) record(n, wrapperLocals.get(e.text) as string, 'spawn')
        else if (e.text === 'require' && n.arguments.length > 0 && !isStringish(n.arguments[0])) record(n, 'require(dynamic)', 'sync')
      } else if (ts.isElementAccessExpression(e) && isStringish(e.argumentExpression)) {
        // fs['existsSync'](p), cp['spawn'](...)
        const name = e.argumentExpression.text
        const obj = e.expression
        if (/Sync$/.test(name) && name.length > 4) record(n, name, 'sync')
        else if (CP_FNS.has(name) && ts.isIdentifier(obj) && cpNamespace.has(obj.text)) record(n, name, 'spawn')
      } else if (ts.isPropertyAccessExpression(e)) {
        const name = e.name.text
        const obj = e.expression
        if (/Sync$/.test(name) && name.length > 4) record(n, name, 'sync')
        else if (SHELL_FNS.has(name) && ts.isIdentifier(obj) && shellLocals.has(obj.text)) record(n, `shell.${name}`, 'spawn')
        else if (ts.isIdentifier(obj) && wrapperLocals.has(obj.text)) record(n, wrapperLocals.get(obj.text) as string, 'spawn')
        else if (CP_FNS.has(name) && ((ts.isIdentifier(obj) && cpNamespace.has(obj.text)) || isCpModuleExpr(obj))) record(n, name, 'spawn')
        else if (name === 'fork' && ts.isIdentifier(obj) && utilityLocals.has(obj.text)) record(n, 'utilityProcess.fork', 'spawn')
        else if (name === 'spawn' && ts.isIdentifier(obj) && ptyNamespace.has(obj.text)) record(n, 'pty.spawn', 'spawn')
      }
    } else if (ts.isIdentifier(n) && fsNamed.has(n.text) && /Sync$/.test(fsNamed.get(n.text) as string)) {
      // A synchronous fs function used as a VALUE (`{ exists: existsSync }`, `deps = { readFileSync }`, `.map(statSync)`):
      // whoever is handed it calls it on this thread, in a file this scan would not otherwise look at.
      const p = n.parent
      const declares = ts.isImportSpecifier(p) || ts.isBindingElement(p) || ts.isVariableDeclaration(p) && p.name === n || ts.isParameter(p) && p.name === n
      const propName = ts.isPropertyAccessExpression(p) && p.name === n || ts.isPropertyAssignment(p) && p.name === n || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) && p.name === n
      if (!declares && !propName && !isCallee(n) && !ts.isTypeQueryNode(p) && !ts.isExportSpecifier(p)) record(n, `${fsNamed.get(n.text)}(ref)`, 'sync')
    } else if (ts.isPropertyAccessExpression(n) && /Sync$/.test(n.name.text) && n.name.text.length > 4 && !isCallee(n) && !ts.isTypeQueryNode(n.parent)
      && ((ts.isIdentifier(n.expression) && fsNamespace.has(n.expression.text)) || isModuleExpr(n.expression, FS_MODULE))) {
      record(n, `${n.name.text}(ref)`, 'sync') // `fs.statSync` handed on without being called
    } else if (ts.isIdentifier(n) && cpNamed.has(n.text) && CP_FNS.has(cpNamed.get(n.text) as string)) {
      // The function used as a VALUE (a default parameter `spawnImpl = spawn`, promisify(execFile),
      // an injected seam): whoever calls it spawns on this thread.
      const p = n.parent
      const declares = ts.isImportSpecifier(p) || ts.isBindingElement(p) || ts.isVariableDeclaration(p) && p.name === n || ts.isParameter(p) && p.name === n
      const propName = ts.isPropertyAccessExpression(p) && p.name === n || ts.isPropertyAssignment(p) && p.name === n || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) && p.name === n
      if (!declares && !propName && !isCallee(n) && !ts.isTypeQueryNode(p) && !ts.isExportSpecifier(p)) record(n, `${cpNamed.get(n.text)}(ref)`, 'spawn')
    } else if (ts.isPropertyAccessExpression(n) && CP_FNS.has(n.name.text) && ts.isIdentifier(n.expression) && cpNamespace.has(n.expression.text) && !isCallee(n) && !ts.isTypeQueryNode(n.parent)) {
      record(n, `${n.name.text}(ref)`, 'spawn')
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { sites, imports }
}

/** The source file a relative specifier names, or null (a .js/.json/.node asset, a .d.ts, or nothing). */
function resolveSource(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (!/\.(ts|tsx|cts|mts)$/.test(cand) || /\.d\.ts$/.test(cand)) continue
    try { if (statSync(cand).isFile()) return cand } catch { /* not this one */ }
  }
  return null
}

/** Every site in src/main, and (HP-2, S09) in every file outside it that main imports, followed transitively:
 *  shared code runs on main as much as main's own. Type-only imports are not followed. */
export function scanMainThreadSites(root: string): Site[] {
  const sites: Site[] = []
  const own = sourceFilesOf(join(root, 'src', 'main')).sort()
  const seen = new Set(own.map((f) => resolve(f)))
  const outside: string[] = []
  const follow = (file: string, imports: string[]): void => {
    for (const spec of imports) {
      const target = resolveSource(file, spec)
      if (target && !seen.has(resolve(target))) { seen.add(resolve(target)); outside.push(target) }
    }
  }
  for (const f of own) {
    const r = scanFileFull(f, root)
    sites.push(...r.sites)
    follow(f, r.imports)
  }
  for (let i = 0; i < outside.length; i++) {
    const r = scanFileFull(outside[i], root)
    sites.push(...r.sites)
    follow(outside[i], r.imports)
  }
  return sites
}

export function groupSites(sites: Site[]): Map<string, SiteGroup> {
  const out = new Map<string, SiteGroup>()
  for (const s of sites) {
    const key = `${s.file} :: ${s.fn}`
    let g = out.get(key)
    if (!g) out.set(key, (g = { file: s.file, fn: s.fn, calls: {}, lines: {} }))
    g.calls[s.call] = (g.calls[s.call] ?? 0) + 1
    ;(g.lines[s.call] ??= []).push(s.line)
  }
  return out
}
