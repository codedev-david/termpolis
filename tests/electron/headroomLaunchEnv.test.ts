// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import ts from 'typescript'
import {
  claudeLaunchEnv, CONTEXT_WINDOW_VAR, type LaunchEnvSources, type ClaudeWindowSettings,
} from '../../src/main/headroom/shapingEnv'

/**
 * R3 criteria 3 and 4: only Claude launches get the window, independent of the proxy's health, at every
 * spawn site that carries the proxy env. The first half runs the composition with the sources replaced;
 * the second half reads the main process's source and proves no site was missed, the way
 * noWholeFileJsonlRead proves its pattern is absent.
 */

const VAR = CONTEXT_WINDOW_VAR
const PROXY = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41999', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:41999' }
const NO_WINDOW: ClaudeWindowSettings = { env: null, savedWindow: false }

function sources(over: Partial<LaunchEnvSources> = {}): LaunchEnvSources {
  return {
    settings: () => ({ contextCap: 300000 }),
    proxyEnv: () => PROXY,
    env: {},
    readSettings: async () => NO_WINDOW,
    ...over,
  }
}

describe('the env a Claude launch gets', () => {
  afterEach(() => { vi.useRealTimers() })

  it('is the proxy route and the window, when both apply', async () => {
    expect(await claudeLaunchEnv('/work/repo', sources())).toEqual({ ...PROXY, [VAR]: '300000' })
  })

  it('still carries the window when the proxy is not healthy (R3 criterion 3)', async () => {
    expect(await claudeLaunchEnv('/work/repo', sources({ proxyEnv: () => null }))).toEqual({ [VAR]: '300000' })
    expect(await claudeLaunchEnv('/work/repo', sources({ proxyEnv: () => undefined }))).toEqual({ [VAR]: '300000' })
  })

  it('is the proxy env exactly as it was when the cap is Off: no behaviour changes for anyone who never turned it on', async () => {
    for (const settings of [() => ({ contextCap: 0 }), () => ({}), () => null, () => undefined, () => ({ contextCap: 12 })]) {
      expect(await claudeLaunchEnv('/work/repo', sources({ settings: settings as never }))).toEqual(PROXY)
    }
  })

  it('is nothing at all when there is neither a route nor a window, as a launch without either has always been', async () => {
    expect(await claudeLaunchEnv('/work/repo', sources({ proxyEnv: () => null, settings: () => ({ contextCap: 0 }) }))).toBeUndefined()
  })

  it('reads no settings file for anyone who has not turned it on', async () => {
    const readSettings = vi.fn(async () => NO_WINDOW)
    await claudeLaunchEnv('/work/repo', sources({ settings: () => ({ contextCap: 0 }), readSettings }))
    await claudeLaunchEnv('/work/repo', sources({ settings: () => ({ contextCap: 99_999 }), readSettings }))
    expect(readSettings).not.toHaveBeenCalled()
  })

  it('costs a launch nothing while the cap is Off: no timer, no read, one asynchronous step', async () => {
    // The performance claim for everyone who never turns it on, as a structure and not a stopwatch: a read is the
    // only thing that can take time, and a timer exists only to bound a read. Neither happens.
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const readSettings = vi.fn(async () => NO_WINDOW)
      for (const settings of [() => ({ contextCap: 0 }), () => ({}), () => null, () => ({ contextCap: 'x' })]) {
        await claudeLaunchEnv('/work/repo', sources({ settings: settings as never, readSettings }))
      }
      // Also when the cap is on but the environment already settled it: nothing left to find out.
      await claudeLaunchEnv('/work/repo', sources({ env: { [VAR]: '250000' }, readSettings }))
      expect(readSettings).not.toHaveBeenCalled()
      expect(timers).not.toHaveBeenCalled()
    } finally {
      timers.mockRestore()
    }
  })

  it('bounds the one read it makes with one timer, and leaves none behind', async () => {
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    await claudeLaunchEnv('/work/repo', sources())
    expect(timers).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads the settings of the folder the terminal opens in, once, and only when it matters', async () => {
    const readSettings = vi.fn(async () => NO_WINDOW)
    await claudeLaunchEnv('/work/repo', sources({ readSettings }))
    expect(readSettings).toHaveBeenCalledTimes(1)
    expect(readSettings).toHaveBeenCalledWith('/work/repo')
    readSettings.mockClear()
    await claudeLaunchEnv('/work/repo', sources({ env: { [VAR]: '250000' }, readSettings }))
    expect(readSettings).not.toHaveBeenCalled()
  })

  it('never overrides the user\'s own: the environment, the settings env block, a saved window', async () => {
    expect(await claudeLaunchEnv('/w', sources({ env: { [VAR]: '250000' } }))).toEqual(PROXY)
    expect(await claudeLaunchEnv('/w', sources({ env: { claude_code_auto_compact_window: '250000' } }))).toEqual(PROXY)
    expect(await claudeLaunchEnv('/w', sources({ readSettings: async () => ({ env: { [VAR]: '250000' }, savedWindow: false }) }))).toEqual(PROXY)
    expect(await claudeLaunchEnv('/w', sources({ readSettings: async () => ({ env: null, savedWindow: true }) }))).toEqual(PROXY)
    expect(await claudeLaunchEnv('/w', sources({ proxyEnv: () => null, readSettings: async () => ({ env: null, savedWindow: true }) }))).toBeUndefined()
  })

  it('sets the window when settings can be read and hold something else', async () => {
    const readSettings = async (): Promise<ClaudeWindowSettings> => ({ env: { API_TIMEOUT_MS: '1200000' }, savedWindow: false })
    expect(await claudeLaunchEnv('/w', sources({ readSettings }))).toEqual({ ...PROXY, [VAR]: '300000' })
  })

  it('works without a way to read settings', async () => {
    expect(await claudeLaunchEnv('/w', sources({ readSettings: undefined }))).toEqual({ ...PROXY, [VAR]: '300000' })
  })

  it('takes the proxy route AFTER the read, so its health is judged when the terminal is about to start', async () => {
    const order: string[] = []
    const out = await claudeLaunchEnv('/w', sources({
      settings: () => { order.push('settings'); return { contextCap: 300000 } },
      readSettings: async () => { order.push('read-start'); await Promise.resolve(); await Promise.resolve(); order.push('read-end'); return NO_WINDOW },
      proxyEnv: () => { order.push('proxy'); return PROXY },
    }))
    expect(out).toBeDefined()
    expect(order).toEqual(['settings', 'read-start', 'read-end', 'proxy'])
  })

  it('asks the proxy exactly once, whatever the cap says', async () => {
    for (const settings of [() => ({ contextCap: 0 }), () => ({ contextCap: 300000 })]) {
      const proxyEnv = vi.fn(() => PROXY)
      await claudeLaunchEnv('/w', sources({ settings, proxyEnv }))
      expect(proxyEnv).toHaveBeenCalledTimes(1)
    }
  })

  it('never rejects: a source that throws counts as having nothing', async () => {
    const boom = (): never => { throw new Error('boom') }
    // A settings getter that throws: no window, the route is unaffected.
    expect(await claudeLaunchEnv('/w', sources({ settings: boom }))).toEqual(PROXY)
    // A proxy that throws: launch direct, the window is unaffected.
    expect(await claudeLaunchEnv('/w', sources({ proxyEnv: boom }))).toEqual({ [VAR]: '300000' })
    // A settings read that rejects or throws was not made, so what the files hold is not known: the route is
    // unaffected and the window is left unset, rather than set over one the files may hold.
    expect(await claudeLaunchEnv('/w', sources({ readSettings: async () => { throw new Error('EACCES') } }))).toEqual(PROXY)
    expect(await claudeLaunchEnv('/w', sources({ readSettings: (() => { throw new Error('sync') }) as never }))).toEqual(PROXY)
    // Everything throws: a launch with nothing extra.
    expect(await claudeLaunchEnv('/w', sources({ settings: boom, proxyEnv: boom }))).toBeUndefined()
  })

  it('does not hold a terminal open for a settings read that hangs', async () => {
    vi.useFakeTimers()
    const pending = claudeLaunchEnv('/w', sources({ readSettings: () => new Promise<ClaudeWindowSettings>(() => { /* never */ }) }))
    await vi.advanceTimersByTimeAsync(2_000)
    // The terminal opens, with the route and without the window: it could not be told whether the user has one.
    expect(await pending).toEqual(PROXY)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('changes none of what it was given', async () => {
    const env = Object.freeze({ PATH: '/bin' })
    const proxy = Object.freeze({ ...PROXY })
    const out = await claudeLaunchEnv('/w', sources({ env, proxyEnv: () => proxy }))
    expect(out).not.toBe(proxy)
    expect(proxy).toEqual(PROXY)
    expect(env).toEqual({ PATH: '/bin' })
  })
})

// ---------------------------------------------------------------------------------------------
// The source guard: R3 criterion 4.
// ---------------------------------------------------------------------------------------------

const MAIN = join(__dirname, '..', '..', 'src', 'main')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** Every source file's text, read once. A file is parsed only if its text could hold what is looked for, which keeps this fast. */
const SOURCES = tsFiles(MAIN).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
const candidates = (needle: string | RegExp): string[] =>
  SOURCES.filter((s) => (typeof needle === 'string' ? s.text.includes(needle) : needle.test(s.text))).map((s) => s.file)

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

const calleeName = (call: ts.CallExpression): string | null => {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

/** The name a destructuring pattern takes from the object: `x` in `{ x }` and in `{ x: alias }`; null for a computed key. */
const bindingKey = (n: ts.BindingElement): string | null => {
  const key = n.propertyName ?? n.name
  return ts.isIdentifier(key) ? key.text : null
}

/** The initializer text of the nearest `const <name> = ...` visible from a node: its own function first, then each one outside it. */
function initializerInScope(node: ts.Node, name: string, sf: ts.SourceFile): string | null {
  for (let fn: ts.Node | undefined = node.parent; fn; fn = fn.parent) {
    if (!ts.isFunctionLike(fn)) continue
    let found: string | null = null
    walk(fn, (n) => {
      if (found === null && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer?.getText(sf) ?? ''
    })
    if (found !== null) return found
  }
  return null
}

/** The files that build an account-switch line (they pass `extraUnset`) and say nothing about the window variable. */
const blindToTheWindow = (sources: ReadonlyArray<{ file: string; text: string }>): string[] =>
  sources.filter((s) => s.text.includes('extraUnset') && !/CONTEXT_WINDOW_VAR|AUTO_COMPACT_WINDOW/.test(s.text)).map((s) => s.file)

describe('every spawn site that carries the proxy env also carries the window (R3 criterion 4)', () => {
  const indexFile = join(MAIN, 'index.ts')
  const index = parse(indexFile)
  const spawnCalls: ts.CallExpression[] = []
  walk(index, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'spawnTerminal') spawnCalls.push(n) })
  const sixth = (c: ts.CallExpression): string => c.arguments[5]?.getText(index) ?? ''

  it('the proxy env is taken in one place only: the helper both sites call', () => {
    const offenders: string[] = []
    for (const file of candidates('getProxyEnv')) {
      if (file.endsWith(`${sep}proxySupervisor.ts`)) continue
      const sf = parse(file)
      const at = (n: ts.Node): string => `${relative(MAIN, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
      walk(sf, (n) => {
        // A call by its name...
        if (ts.isCallExpression(n) && calleeName(n) === 'getProxyEnv') offenders.push(at(n))
        // ...by an alias, which only an import or a re-export can make (index.ts imports it once, checked below)...
        if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && (n.propertyName ?? n.name).text === 'getProxyEnv' && !file.endsWith(`${sep}index.ts`)) offenders.push(at(n))
        // ...or reached as a member of a module: `mod.getProxyEnv` or `mod['getProxyEnv']`.
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'getProxyEnv') offenders.push(at(n))
        if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'getProxyEnv') offenders.push(at(n))
        // ...or pulled out of a dynamic import by destructuring: `const { getProxyEnv: gp } = await import(...)`.
        if (ts.isBindingElement(n) && bindingKey(n) === 'getProxyEnv') offenders.push(at(n))
      })
    }
    expect(offenders, 'getProxyEnv() taken outside claudeLaunchEnv: route it through the helper so the window rides with the route').toEqual([])
  })

  // The guard above is only as good as the shapes it walks. This plants the destructuring shape in a scratch
  // source, which the real tree does not contain, and checks the same walk reports it.
  it('and the walk reports a getProxyEnv pulled out of a dynamic import by destructuring', () => {
    const planted = ts.createSourceFile('planted.ts', "async function f() { const { getProxyEnv: gp } = await import('./headroomProxy/proxySupervisor'); return gp() }", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const hits: string[] = []
    walk(planted, (n) => {
      if (ts.isBindingElement(n) && bindingKey(n) === 'getProxyEnv') hits.push(n.getText(planted))
    })
    expect(hits).toEqual(['getProxyEnv: gp'])
  })

  it('index.ts hands getProxyEnv to the helper as a function and uses it nowhere else, under its own name', () => {
    const refs: string[] = []
    const imports: ts.ImportSpecifier[] = []
    walk(index, (n) => {
      if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'getProxyEnv') imports.push(n)
      if (ts.isIdentifier(n) && n.text === 'getProxyEnv' && !ts.isImportSpecifier(n.parent)) refs.push(n.parent.getText(index))
    })
    expect(refs).toEqual(['proxyEnv: getProxyEnv'])
    // Imported once and not renamed: an `as gpe` would make every other reference invisible to this test.
    expect(imports).toHaveLength(1)
    expect(imports[0].propertyName).toBeUndefined()
  })

  it('has exactly one helper, which composes the route, the settings and the files', () => {
    const decls: ts.VariableDeclaration[] = []
    walk(index, (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'claudeLaunchEnv') decls.push(n) })
    expect(decls).toHaveLength(1)
    const body = decls[0].initializer?.getText(index) ?? ''
    expect(body).toContain('buildClaudeLaunchEnv(')
    expect(body).toContain('settings: getHeadroomSettings')
    expect(body).toContain('proxyEnv: getProxyEnv')
    expect(body).toContain('env: process.env')
    // The terminal's own folder reaches the reader as well as the user's: without it the project's settings
    // are never read, and the variable is set over a window the project file holds (CLAUDE_CODE wins).
    expect(body).toContain('readClaudeWindowSettings(agentIntegrationPaths().claudeDir, dir)')
  })

  it('finds the two terminal sites and the workflow pass-through, and no other spawn', () => {
    expect(spawnCalls.map(sixth).sort()).toEqual(['extraEnv', 'launchEnv', 'launchEnv'])
  })

  it('both terminal sites pass a launchEnv that their own function took from the helper', () => {
    const sites = spawnCalls.filter((c) => sixth(c) === 'launchEnv')
    expect(sites).toHaveLength(2)
    for (const call of sites) {
      // The terminal:create site spawns from inside a Promise executor, so the declaration is in the function around that.
      const init = initializerInScope(call, 'launchEnv', index)
      expect(init, `line ${index.getLineAndCharacterOfPosition(call.getStart(index)).line + 1}`).not.toBeNull()
      expect(init).toContain('await claudeLaunchEnv(')
    }
  })

  it('the terminal:create site asks only for a terminal that will run Claude, and the swarm site for every worker, as the proxy route always did', () => {
    const src = readFileSync(indexFile, 'utf8')
    expect(src).toContain('const launchEnv = claudeHeadroom ? await claudeLaunchEnv(cwd) : undefined')
    expect(src).toContain('const launchEnv = await claudeLaunchEnv(resolvedCwd)')
  })

  it('the workflow engine\'s spawns pass no env, so there is nothing there to compose; one that does must come through the helper', () => {
    const file = join(MAIN, 'workflow', 'adapters.ts')
    const sf = parse(file)
    const withEnv: string[] = []
    let spawns = 0
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'spawnTerminal') {
        spawns++
        // The env is the sixth argument: absent, or the literal `undefined` that skips it to reach the exit callback.
        const env = n.arguments[5]
        if (env && env.getText(sf) !== 'undefined') withEnv.push(`adapters.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
    })
    expect(spawns).toBe(2)
    expect(withEnv, 'a workflow spawn now passes an env: route it through claudeLaunchEnv, or the window is missed there').toEqual([])
  })

  // The limit of a textual scan, stated so nobody reads it as proof: it sees a name spelled in one piece. A name
  // assembled at run time (`'CLAUDE_CODE_AUTO' + '_COMPACT_WINDOW'`, or built from parts in a table) is out of
  // its reach, and that case is left to review.
  it('the helper is the only code that names the window variable outside the pure module', () => {
    const named: string[] = []
    for (const file of candidates(/AUTO_COMPACT_WINDOW/i)) {
      if (file.endsWith(`${sep}shapingEnv.ts`)) continue
      const sf = parse(file)
      walk(sf, (n) => {
        // Spelled in a string, a template, or as a name: `{ CLAUDE_CODE_AUTO_COMPACT_WINDOW: x }` and
        // `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = x` set it as surely as `env['...']` does.
        const spelled = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isIdentifier(n)
        if (spelled && n.text.toUpperCase().includes('AUTO_COMPACT_WINDOW')) {
          named.push(`${relative(MAIN, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
        }
      })
    }
    expect(named).toEqual([])
  })

  // INTEGRATION CANARY (the account switcher, fix/accounts154). The window is decided once, when the PTY is
  // made, from Termpolis's own Claude folder. The switcher moves a terminal to another sign-in by TYPING
  // `export CLAUDE_CONFIG_DIR=<profile> && claude`, and Claude Code lets this variable beat every window that
  // profile's settings hold, so the typed line has to take the variable off again when the target profile
  // holds a window of its own. That branch passes the names it takes off a line as `extraUnset`. Until it is
  // merged nothing here does, and this passes; once a file that does has no mention of the window variable
  // beside it, the merge has taken the first half of the contract (the account-aware helper) and left the
  // second, and this says so. It is deliberately about the file, not the line: the integrator may name the
  // list however the switcher's code is shaped, and edits this test then, with the pins above.
  it('a file that builds the line a terminal types to change account also deals with the window variable', () => {
    const offenders = blindToTheWindow(SOURCES).map((f) => relative(MAIN, f))
    expect(offenders, 'a typed account switch leaves our CLAUDE_CODE_AUTO_COMPACT_WINDOW in place over the target profile\'s own window: unset it there when Termpolis put it in the terminal and the profile holds one').toEqual([])
  })

  it('and that rule is not vacuous: it reports a file that unsets names on the line and never mentions the window', () => {
    const text = (names: string): string => `const line = accountLine({ set: { CLAUDE_CONFIG_DIR: dir }, extraUnset: [${names}] })`
    const sources = [
      { file: 'accountsIpc.ts', text: text("'ANTHROPIC_BASE_URL', 'TERMPOLIS_HEADROOM_PROXY'") },
      { file: 'accountsIpcDone.ts', text: text("'ANTHROPIC_BASE_URL', CONTEXT_WINDOW_VAR") },
      { file: 'accountsNamed.ts', text: text("'CLAUDE_CODE_AUTO_COMPACT_WINDOW'") },
      { file: 'unrelated.ts', text: 'export const x = 1' },
    ]
    expect(blindToTheWindow(sources)).toEqual(['accountsIpc.ts'])
    expect(blindToTheWindow([])).toEqual([])
  })
})
