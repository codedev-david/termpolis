/**
 * Every git Termpolis starts from src/main goes through the git-safety builders (src/main/gitSafety.ts), so a folder
 * that arrives with a planted `.git` never runs a program just because Termpolis read it.
 *
 *  1. Only the files listed in STARTERS may name git's binary (resolveGitBin, a gitBin dependency, or a literal
 *     `git` handed to a call). Everything else starts git through safeGitAsync (gitCommand.ts) or cachedGit
 *     (gitCache.ts, which calls safeGitAsync), where guardGitArgs puts the read-only prefix on every read.
 *  2. Inside those files, every spawn of git hands it an argument list built by guardGitArgs or filterScanArgs, or
 *     one that starts with the world host's safetyFlags. A bare list fails. A spawn of a guardGitArgs or filterScanArgs
 *     list also hands guardGitEnv's variables (GIT_NO_LAZY_FETCH) in its options, and a seam that only passes a list
 *     through passes them on, so a partial clone missing an object never starts a fetch. (The safetyFlags lists, the
 *     world host's ls-files, rev-parse and config, load no object and so cannot fetch one.)
 *  3. No string in src/main asks git for an external diff, a textconv, a signature check (`--show-signature`, `%G`
 *     in a format), or switches fsmonitor or hooks back on.
 *  4. Every literal git command the code writes is run through guardGitArgs here, as safeGitAsync would: a read
 *     comes out with the prefix, a diff, show or log with --no-ext-diff --no-textconv, and its subcommand is one this
 *     file knows to be a read or a write (a new subcommand has to be placed on purpose).
 *
 * The detectors are run on made-up sources first (the self-check), so a guard that stopped seeing anything fails too.
 * Read with TypeScript's own parser, as tests/electron/endpointActivityGuard.test.ts does.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import ts from 'typescript'
import { MUTATING_SUBCOMMANDS, displayFlags, gitSubcommand, guardGitArgs, needsFilterScan, readOnlyPrefix } from '../../src/main/gitSafety'

const ROOT = join(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')

/** The files that may name git's binary, and why each is safe. */
const STARTERS: Record<string, string> = {
  'src/main/binPath.ts': 'defines resolveGitBin; finds git, starts nothing',
  'src/main/gitCommand.ts': 'safeGitAsync: every argv through guardGitArgs, the filter-driver read through filterScanArgs',
  'src/main/index.ts': 'hands resolveGitBin to createWorldRuns; its own git calls go through safeGitAsync',
  'src/main/world/worldRuns.ts': 'every git through guardGitArgs',
  'src/main/world/fileSnapshot.ts': 'runs the repoFileList.ts builders, each of which starts with safetyFlags (checked below)',
  'src/main/world/gitSource.ts': 'clone and refresh of a copy in userData, every step starting with safetyFlags',
  'src/main/world/gitLogin.ts': 'reads config only, with safetyFlags',
  'src/main/world/worldHost.ts': 'hands resolveGitBin to clone and the file snapshot',
  'src/main/agentIntegrationManager.ts': "finds git's folder on PATH to locate Git Bash; starts nothing"
}

/** Spawn helpers: a call to one of these whose first argument is git's binary starts git. */
const SPAWNERS = new Set(['execOffThread', 'execCaptureOffThread', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'fork'])
/** The names git's resolved binary goes by in the starter files. */
const GIT_BIN_NAMES = new Set(['bin', 'gitBin'])
/** Argument lists a starter may hand git by name, and what makes each safe (checked below where it can be). */
const TRACED_ARGS: Record<string, Record<string, string>> = {
  'src/main/world/fileSnapshot.ts': { args: 'listRepo hands only the repoFileList.ts builders, each starting with safetyFlags' },
  'src/main/world/gitSource.ts': { args: 'the clone steps, each an `args: [...flags, …]` list (checked below)' }
}

/** Subcommands Termpolis writes that only read. A new one must be added here, or to MUTATING_SUBCOMMANDS, on purpose. */
const KNOWN_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'diff-tree', 'remote', 'branch', 'config', 'for-each-ref', 'symbolic-ref', 'cat-file', 'show-ref', 'ls-remote', 'blame', 'describe', 'shortlog', 'name-rev', 'merge-base', 'check-ignore'])

interface Source { rel: string; sf: ts.SourceFile; text: string }

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function parse(rel: string, text: string): Source {
  return { rel, text, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }
}

const SOURCES: Source[] = sourceFiles(MAIN).map((f) => parse(relative(ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')))

function walk(n: ts.Node, visit: (n: ts.Node) => void): void {
  visit(n)
  ts.forEachChild(n, (c) => walk(c, visit))
}

const lineOf = (s: Source, n: ts.Node): number => s.sf.getLineAndCharacterOfPosition(n.getStart(s.sf)).line + 1
const calleeName = (call: ts.CallExpression): string => {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return ''
}
const isStringish = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)

/** Rule 1: where a file names git's binary. */
function namesGitBinary(s: Source): string[] {
  const out: string[] = []
  walk(s.sf, (n) => {
    if (ts.isIdentifier(n) && (n.text === 'resolveGitBin' || n.text === 'gitBin')) out.push(`${s.rel}:${lineOf(s, n)} ${n.text}`)
    if (ts.isCallExpression(n) && n.arguments.length > 0) {
      const first = n.arguments[0]
      if (isStringish(first) && /^git(\.exe)?$/i.test(first.text)) out.push(`${s.rel}:${lineOf(s, n)} ${calleeName(n) || 'call'}('${first.text}')`)
    }
  })
  return out
}

/** Whether `argv`, handed to git in `s`, is built by the safety builders. */
function guardedArgv(s: Source, argv: ts.Expression): boolean {
  if (ts.isCallExpression(argv)) return ['guardGitArgs', 'filterScanArgs'].includes(calleeName(argv))
  if (ts.isArrayLiteralExpression(argv)) {
    const first = argv.elements[0]
    if (first === undefined) return false
    if (ts.isSpreadElement(first)) {
      const e = first.expression
      if (ts.isCallExpression(e)) return calleeName(e) === 'safetyFlags'
      if (ts.isIdentifier(e)) return new RegExp(`\\b${e.text}\\s*=\\s*safetyFlags\\(`).test(s.text)
      return false
    }
    // `git --version` reads no repository.
    return argv.elements.length === 1 && isStringish(first) && first.text === '--version'
  }
  if (ts.isIdentifier(argv)) {
    if (TRACED_ARGS[s.rel]?.[argv.text] !== undefined) return true
    // A list built once and named: `const scanArgs = filterScanArgs(…)`.
    return new RegExp(`\\b${argv.text}\\s*=\\s*(guardGitArgs|filterScanArgs)\\(`).test(s.text)
  }
  return false
}

/** A seam that only passes a binary and its list through (`exec: async (bin, args, opts) => execCapture…(bin, args)`):
 *  whoever calls it chose the list, and that call is checked where it is written. */
function passThrough(call: ts.CallExpression): boolean {
  const [bin, argv] = call.arguments
  if (!ts.isIdentifier(bin) || !ts.isIdentifier(argv)) return false
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const params = n.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''))
      return params.includes(bin.text) && params.includes(argv.text)
    }
  }
  return false
}

/** Helpers handed git's path that only look at where it lies. */
const PATH_CHECKS = new Set(['binInside', 'binInsideFolder'])

/** A helper declared in the same file whose own body hands git a guardGitArgs list (worldRuns' `run`). */
function guardingWrapper(s: Source, name: string): boolean {
  let found = false
  walk(s.sf, (n) => {
    const named = (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) ||
      (ts.isFunctionDeclaration(n) && n.name?.text === name)
    if (named && /\bguardGitArgs\(/.test(n.getText(s.sf))) found = true
  })
  return found
}

/** Rule 2: spawns of git whose argument list is not built by the safety builders. */
function unguardedSpawns(s: Source): string[] {
  const out: string[] = []
  walk(s.sf, (n) => {
    if (!ts.isCallExpression(n) || n.arguments.length < 2) return
    const bin = n.arguments[0]
    const spawner = SPAWNERS.has(calleeName(n))
    // `gitBin` starts git whatever the helper is called; `bin` or a literal git only when handed to a spawn helper.
    const isGit = (ts.isIdentifier(bin) && (bin.text === 'gitBin' || (GIT_BIN_NAMES.has(bin.text) && spawner))) ||
      (isStringish(bin) && /^git(\.exe)?$/i.test(bin.text) && spawner)
    if (isGit && !spawner && (PATH_CHECKS.has(calleeName(n)) || guardingWrapper(s, calleeName(n)))) return
    if (isGit && !passThrough(n) && !guardedArgv(s, n.arguments[1])) out.push(`${s.rel}:${lineOf(s, n)} ${n.getText(s.sf).slice(0, 120)}`)
  })
  return out
}

/** Whether `opts`, the options handed with a guarded list, carry guardGitEnv's variables. */
function carriesReadEnv(s: Source, opts: ts.Expression | undefined): boolean {
  if (opts === undefined) return false
  if (/\bguardGitEnv\(/.test(opts.getText(s.sf))) return true
  return ts.isIdentifier(opts) && new RegExp(`\\b${opts.text}\\s*=\\s*guardGitEnv\\(`).test(s.text)
}

/** Whether a pass-through seam also forwards its caller's options (`{ cwd: o.cwd }`): then the caller's environment
 *  must go through too. A seam that builds its own options (a timeout of its own) is not a git seam's options. */
function forwardsOptions(call: ts.CallExpression): boolean {
  const opts = call.arguments[2]
  if (opts === undefined) return false
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const third = n.parameters[2]
      if (third === undefined || !ts.isIdentifier(third.name)) return false
      return new RegExp(`\\b${third.name.text}\\.`).test(opts.getText())
    }
  }
  return false
}

/** Rule 2, the environment: spawns of a guarded list without GIT_NO_LAZY_FETCH, and pass-through seams that drop it. */
function spawnsWithoutReadEnv(s: Source): string[] {
  const out: string[] = []
  walk(s.sf, (n) => {
    if (!ts.isCallExpression(n) || n.arguments.length < 2) return
    const [bin, argv, opts] = n.arguments
    const spawner = SPAWNERS.has(calleeName(n))
    const isGit = (ts.isIdentifier(bin) && (bin.text === 'gitBin' || (GIT_BIN_NAMES.has(bin.text) && spawner)))
    if (!isGit) return
    const built = (ts.isCallExpression(argv) && ['guardGitArgs', 'filterScanArgs'].includes(calleeName(argv))) ||
      (ts.isIdentifier(argv) && new RegExp(`\\b${argv.text}\\s*=\\s*(guardGitArgs|filterScanArgs)\\(`).test(s.text))
    const bad = passThrough(n) ? forwardsOptions(n) && !/\baddEnv\b/.test(opts!.getText(s.sf)) : built && !carriesReadEnv(s, opts)
    if (bad) out.push(`${s.rel}:${lineOf(s, n)} ${n.getText(s.sf).slice(0, 120)}`)
  })
  return out
}

/** Rule 3: strings that would turn back on what the read-only prefix and display flags switch off. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['external diff', /^--ext-diff$/],
  ['textconv', /^--textconv$/],
  ['signature check', /^--show-signature$/],
  ['signature format', /%G[?GSKUFPT]/],
  ['fsmonitor on', /^core\.fsmonitor=(?!false$)/i],
  ['hooks moved', /^core\.hooksPath=/i],
  ['external diff config', /^diff\.external=/i],
  ['signature config', /^log\.showSignature=(?!false$)/i]
]
function forbiddenStrings(s: Source): string[] {
  const out: string[] = []
  walk(s.sf, (n) => {
    const texts: string[] = []
    if (isStringish(n)) texts.push(n.text)
    else if (ts.isTemplateExpression(n)) texts.push(n.head.text, ...n.templateSpans.map((t) => t.literal.text))
    for (const t of texts) for (const [label, re] of FORBIDDEN) if (re.test(t)) out.push(`${s.rel}:${lineOf(s, n)} ${label}: ${t}`)
  })
  return out
}

/** Rule 4: literal git commands, as the code writes them: the first argument of a git call, or a list assigned to
 *  `args` and handed to one. Only the leading string literals are kept (a spread or a variable ends the list). */
const GIT_CALLS = new Set(['safeGitAsync', 'cachedGit', 'run', 'git'])
function literalCommands(s: Source): Array<{ at: string; argv: string[] }> {
  const out: Array<{ at: string; argv: string[] }> = []
  const take = (arr: ts.ArrayLiteralExpression): void => {
    const argv: string[] = []
    for (const e of arr.elements) {
      if (!isStringish(e)) break
      argv.push(e.text)
    }
    if (argv.length > 0) out.push({ at: `${s.rel}:${lineOf(s, arr)}`, argv })
  }
  const arraysIn = (e: ts.Expression): ts.ArrayLiteralExpression[] =>
    ts.isArrayLiteralExpression(e) ? [e] : ts.isConditionalExpression(e) ? [...arraysIn(e.whenTrue), ...arraysIn(e.whenFalse)] : ts.isParenthesizedExpression(e) ? arraysIn(e.expression) : []
  walk(s.sf, (n) => {
    // safeGitAsync(args, opts), and worldRuns' git(root, args).
    if (ts.isCallExpression(n) && GIT_CALLS.has(calleeName(n))) n.arguments.slice(0, 2).flatMap(arraysIn).forEach(take)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'args' && n.initializer) arraysIn(n.initializer).forEach(take)
  })
  return out
}
/** Files whose literal commands go to git: the ones that call safeGitAsync or cachedGit, or hand a `git` dependency. */
const gitCallingFiles = (): Source[] => SOURCES.filter((s) => /\b(safeGitAsync|cachedGit|guardGitArgs)\b|\bgit:\s*\(args/.test(s.text) || s.rel === 'src/main/commitScan.ts')

/** What is wrong with `argv` once guardGitArgs has been applied, or null. */
function guardProblem(argv: string[], isWindows: boolean): string | null {
  const sub = gitSubcommand(argv)
  if (sub === null) return null
  if (MUTATING_SUBCOMMANDS.has(sub.name)) return null
  if (!KNOWN_READS.has(sub.name)) return `subcommand '${sub.name}' is neither a known read nor a write`
  const run = guardGitArgs(argv, isWindows, [])
  const at = gitSubcommand(run)!.index
  const leading = run.slice(0, at)
  for (let i = 1; i < readOnlyPrefix(sub.name, isWindows).length; i += 2) {
    const pair = readOnlyPrefix(sub.name, isWindows)[i]
    if (!leading.includes(pair)) return `no ${pair}`
  }
  for (const flag of displayFlags(sub.name)) if (!run.slice(at).includes(flag)) return `no ${flag}`
  return null
}

/** True when `s` calls guardGitArgs with no filter overrides (guardGitArgs then throws on a FILTER_SUBCOMMANDS read). */
function callsGuardUnscanned(s: Source): boolean {
  let found = false
  walk(s.sf, (n) => {
    if (ts.isCallExpression(n) && calleeName(n) === 'guardGitArgs' && n.arguments.length < 3) found = true
  })
  return found
}
/** Literal commands in `s` that need a filter scan, which a file calling guardGitArgs unscanned cannot give them. */
const unscannedFilterReads = (s: Source): string[] =>
  literalCommands(s).filter((c) => needsFilterScan(c.argv)).map((c) => `${c.at} ${c.argv.join(' ')}`)

describe('git safety guard: who may start git', () => {
  it('only the listed files name git’s binary', () => {
    const unlisted = SOURCES.filter((s) => STARTERS[s.rel] === undefined).flatMap(namesGitBinary)
    expect(unlisted).toEqual([])
  })

  it('every listed file still exists and still names git (a stale entry is a hole someone can reuse)', () => {
    for (const rel of Object.keys(STARTERS)) {
      const s = SOURCES.find((x) => x.rel === rel)
      expect(s, rel).toBeDefined()
      expect(namesGitBinary(s!).length, rel).toBeGreaterThan(0)
    }
  })

  it('every spawn of git in those files hands it a guarded argument list', () => {
    // Only a file that names git can start it (the first test keeps that list closed); elsewhere a `bin` is some other
    // program (procHost.ts, mnemeDistiller.ts).
    expect(SOURCES.filter((s) => namesGitBinary(s).length > 0).flatMap(unguardedSpawns)).toEqual([])
  })

  it('every spawn of a guarded list carries GIT_NO_LAZY_FETCH, and every pass-through seam hands it on', () => {
    expect(SOURCES.filter((s) => namesGitBinary(s).length > 0).flatMap(spawnsWithoutReadEnv)).toEqual([])
  })

  it('safeGitAsync puts every argument list through guardGitArgs, and cachedGit goes through safeGitAsync', () => {
    const cmd = SOURCES.find((s) => s.rel === 'src/main/gitCommand.ts')!
    expect(cmd.text).toMatch(/execOffThread\(bin, guardGitArgs\(args, isWindows, overrides\), \{[^}]*addEnv: guardGitEnv\(args\)/)
    const cache = SOURCES.find((s) => s.rel === 'src/main/gitCache.ts')!
    expect(cache.text).toMatch(/safeGitAsync\(args, opts\)/)
    expect(namesGitBinary(cache)).toEqual([])
  })

  it('the traced lists are what they say: every repoFileList builder and every clone step starts with safetyFlags', () => {
    const list = SOURCES.find((s) => s.rel === 'src/main/repoFileList.ts')!
    const builders: string[] = []
    walk(list.sf, (n) => {
      if (ts.isReturnStatement(n) && n.expression && ts.isArrayLiteralExpression(n.expression)) {
        builders.push(n.expression.getText(list.sf))
        expect(guardedArgv(list, n.expression), n.expression.getText(list.sf)).toBe(true)
      }
    })
    expect(builders.length).toBeGreaterThanOrEqual(4)
    const src = SOURCES.find((s) => s.rel === 'src/main/world/gitSource.ts')!
    let steps = 0
    walk(src.sf, (n) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'args' && ts.isArrayLiteralExpression(n.initializer)) {
        steps++
        expect(guardedArgv(src, n.initializer), n.initializer.getText(src.sf)).toBe(true)
      }
    })
    expect(steps).toBeGreaterThanOrEqual(3)
  })
})

describe('git safety guard: what git is asked', () => {
  it('no string in src/main turns back on an external diff, textconv, a signature check, fsmonitor or hooks', () => {
    const found = SOURCES.filter((s) => s.rel !== 'src/main/gitSafety.ts').flatMap(forbiddenStrings)
    expect(found).toEqual([])
  })

  it('every literal git command comes out of guardGitArgs with the prefix, and diff/show/log with the display flags', () => {
    const commands = gitCallingFiles().flatMap(literalCommands)
    // The sweep sees the commands the reviewer listed: the dot's status, the rail's numstat, the commit scan's
    // patch, the world's diff-tree, a show.
    const seen = new Set(commands.map((c) => gitSubcommand(c.argv)?.name))
    for (const sub of ['status', 'diff', 'log', 'show', 'rev-parse', 'diff-tree', 'commit', 'push']) expect(seen.has(sub), sub).toBe(true)
    for (const isWindows of [true, false]) {
      const problems = commands.map((c) => ({ ...c, problem: guardProblem(c.argv, isWindows) })).filter((c) => c.problem !== null)
      expect(problems).toEqual([])
    }
  })

  it('a file that hands guardGitArgs no filter scan writes no command that can run a filter (worldRuns)', () => {
    const unscanned = SOURCES.filter(callsGuardUnscanned)
    expect(unscanned.map((s) => s.rel)).toContain('src/main/world/worldRuns.ts')
    expect(unscanned.flatMap(unscannedFilterReads)).toEqual([])
  })
})

describe('git safety guard: the detectors see what they must (self-check)', () => {
  it('a new file that starts git by itself is caught', () => {
    const s = parse('src/main/newWatcher.ts', "import { resolveGitBin } from './binPath'\nexport async function poll() { const bin = await resolveGitBin(); return execOffThread(bin, ['status']) }\n")
    expect(namesGitBinary(s).length).toBeGreaterThan(0)
    expect(unguardedSpawns(s)).toHaveLength(1)
    expect(namesGitBinary(parse('src/main/x.ts', "execFile('git', ['status'])"))).toEqual(["src/main/x.ts:1 execFile('git')"])
  })

  it('an unguarded spawn in a listed file is caught; a guarded one, or one that starts with safetyFlags, is not', () => {
    const s = parse('src/main/world/worldRuns.ts', [
      "d.exec(gitBin, ['status', '--porcelain'], {})",
      'd.exec(gitBin, args, {})',
      "d.exec(gitBin, guardGitArgs(args, true), {})",
      "deps.execFile(bin, [...safetyFlags(true), 'config', '--list'], {})",
      "const flags = safetyFlags(true); deps.execFile(gitBin, [...flags, 'fetch'], {})",
      "deps.execFile(gitBin, [...other, 'fetch'], {})",
      "deps.execFile(gitBin, [], {})",
      "deps.execFile(gitBin, ['--version'], {})",
      "deps.execFile(gitBin, [...(x as string[])], {})",
      "deps.execFile(gitBin, build(args), {})",
      "d.exec(gh, ['run', 'list'], {})",
      "const scanArgs = filterScanArgs(a, true); execOffThread(bin, scanArgs, {})",
      'const exec = async (bin, args, o) => execCaptureOffThread(bin, args, o)',
      'const f = async (bin) => execCaptureOffThread(bin, args, o)',
      "run(gitBin, ['status'])",
      'binInside(gitBin, root, rp)',
      "const wrap = async (gitBin, root, args) => d.exec(gitBin, guardGitArgs(args, true), {}); wrap(gitBin, root, ['status'])"
    ].join('\n'))
    expect(unguardedSpawns(s).map((h) => h.split(' ')[0])).toEqual([
      'src/main/world/worldRuns.ts:1', 'src/main/world/worldRuns.ts:2', 'src/main/world/worldRuns.ts:6', 'src/main/world/worldRuns.ts:7',
      'src/main/world/worldRuns.ts:9', 'src/main/world/worldRuns.ts:10', 'src/main/world/worldRuns.ts:14', 'src/main/world/worldRuns.ts:15'
    ])
    expect(unguardedSpawns(parse('src/main/world/fileSnapshot.ts', 'exec(bin, args, {})'))).toEqual([])
  })

  it('a guarded spawn without GIT_NO_LAZY_FETCH, or a seam that drops it, is caught', () => {
    const s = parse('src/main/world/worldRuns.ts', [
      "d.exec(gitBin, guardGitArgs(args, true), { cwd })",
      "d.exec(gitBin, guardGitArgs(args, true), { cwd, addEnv: guardGitEnv(args) })",
      "const scanArgs = filterScanArgs(a, true); execOffThread(bin, scanArgs, { cwd })",
      "const env = guardGitEnv(a); execOffThread(bin, guardGitArgs(a, true), env)",
      'const exec = async (bin, args, o) => execCaptureOffThread(bin, args, { cwd: o.cwd })',
      'const exec2 = async (bin, args, o) => execCaptureOffThread(bin, args, { cwd: o.cwd, addEnv: o.addEnv })',
      "deps.execFile(gitBin, [...safetyFlags(true), 'ls-files'], {})",
      'execOffThread(bin, guardGitArgs(a, true))'
    ].join('\n'))
    expect(spawnsWithoutReadEnv(s).map((h) => h.split(' ')[0])).toEqual([
      'src/main/world/worldRuns.ts:1', 'src/main/world/worldRuns.ts:3', 'src/main/world/worldRuns.ts:5', 'src/main/world/worldRuns.ts:8'
    ])
  })

  it('the forbidden strings are seen in plain and template strings', () => {
    const s = parse('src/main/x.ts', "const a = ['log', '--show-signature', '--ext-diff', '--textconv', '-c', 'core.fsmonitor=true', '-c', 'core.hooksPath=.githooks']\nconst f = `--format=%G? ${x}`\nconst ok = ['--no-ext-diff', 'core.fsmonitor=false', 'log.showSignature=false', '%Gx']\nconst d = 'diff.external=x'; const l = 'log.showSignature=true'")
    expect(forbiddenStrings(s).map((h) => h.split(' ').slice(1).join(' '))).toEqual([
      'signature check: --show-signature', 'external diff: --ext-diff', 'textconv: --textconv', 'fsmonitor on: core.fsmonitor=true',
      'hooks moved: core.hooksPath=.githooks', 'signature format: --format=%G? ', 'external diff config: diff.external=x', 'signature config: log.showSignature=true'
    ])
  })

  it('literal commands are read from git calls and `args` lists, and a new subcommand must be placed on purpose', () => {
    const s = parse('src/main/x.ts', "safeGitAsync(['blame', '--', f], o)\nconst args = c ? ['add', '--', ...files] : (['frob', 'x'])\nrun([v, 'status'])\nother(['status'])\ngit(root, ['diff-tree', '-r'])")
    expect(literalCommands(s).map((c) => c.argv)).toEqual([['blame', '--'], ['add', '--'], ['frob', 'x'], ['diff-tree', '-r']])
    expect(guardProblem(['frob', 'x'], true)).toBe("subcommand 'frob' is neither a known read nor a write")
    expect(guardProblem(['add', '.'], true)).toBeNull()
    expect(guardProblem(['--version'], true)).toBeNull()
    expect(guardProblem(['diff', '--cached'], false)).toBeNull()
    const unscanned = parse('src/main/world/worldRuns.ts', "const run = (args) => d.exec(gitBin, guardGitArgs(args, true), {}); run(['status', '--porcelain']); run(['diff-tree', '-r'])")
    expect(callsGuardUnscanned(unscanned)).toBe(true)
    expect(unscannedFilterReads(unscanned)).toEqual(['src/main/world/worldRuns.ts:1 status --porcelain'])
    expect(callsGuardUnscanned(parse('src/main/gitCommand.ts', 'guardGitArgs(args, isWindows, overrides)'))).toBe(false)
  })
})
