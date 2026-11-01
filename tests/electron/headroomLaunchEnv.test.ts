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
    // A settings read that rejects or throws: counts as not set.
    expect(await claudeLaunchEnv('/w', sources({ readSettings: async () => { throw new Error('EACCES') } }))).toEqual({ ...PROXY, [VAR]: '300000' })
    expect(await claudeLaunchEnv('/w', sources({ readSettings: (() => { throw new Error('sync') }) as never }))).toEqual({ ...PROXY, [VAR]: '300000' })
    // Everything throws: a launch with nothing extra.
    expect(await claudeLaunchEnv('/w', sources({ settings: boom, proxyEnv: boom }))).toBeUndefined()
  })

  it('does not hold a terminal open for a settings read that hangs', async () => {
    vi.useFakeTimers()
    const pending = claudeLaunchEnv('/w', sources({ readSettings: () => new Promise<ClaudeWindowSettings>(() => { /* never */ }) }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ ...PROXY, [VAR]: '300000' })
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
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === 'getProxyEnv') {
          offenders.push(`${relative(MAIN, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
        }
      })
    }
    expect(offenders, 'getProxyEnv() called directly: route it through claudeLaunchEnv so the window rides with the route').toEqual([])
  })

  it('index.ts hands getProxyEnv to the helper as a function and uses it nowhere else', () => {
    const refs: string[] = []
    walk(index, (n) => {
      if (ts.isIdentifier(n) && n.text === 'getProxyEnv' && !ts.isImportSpecifier(n.parent)) refs.push(n.parent.getText(index))
    })
    expect(refs).toEqual(['proxyEnv: getProxyEnv'])
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
    expect(body).toContain('readClaudeWindowSettings(agentIntegrationPaths().claudeDir')
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

  it('the helper is the only code that names the window variable outside the pure module', () => {
    const named: string[] = []
    for (const file of candidates(/AUTO_COMPACT_WINDOW/i)) {
      if (file.endsWith(`${sep}shapingEnv.ts`)) continue
      const sf = parse(file)
      walk(sf, (n) => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.toUpperCase().includes('AUTO_COMPACT_WINDOW')) {
          named.push(`${relative(MAIN, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
        }
      })
    }
    expect(named).toEqual([])
  })
})
