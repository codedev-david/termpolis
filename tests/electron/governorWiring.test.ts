/**
 * How the governor is wired into the app (1.54.5 hotfix, lane G): ONE call in src/main/index.ts, one small
 * block in diagnostics:collect, and the unit suite itself never starts a real governor.
 *
 * Lanes A, B and C all edit src/main/index.ts and diagnostics.ts in the same hotfix, and the three branches are
 * merged later. So the footprint in each shared file is pinned here: the merge step can see at a glance that
 * nothing else of lane G is in them, and a stray second hook fails this file.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

vi.mock('electron', () => ({ app: { getVersion: vi.fn(() => '9.9.9') } }))

const MAIN = join(__dirname, '..', '..', 'src', 'main')
const read = (f: string) => readFileSync(join(MAIN, f), 'utf8')

function callsTo(text: string, name: string): ts.CallExpression[] {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  const out: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function importsFrom(text: string, specifier: string): ts.ImportDeclaration[] {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
  return sf.statements.filter(
    (s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === specifier,
  )
}

describe('src/main/index.ts footprint', () => {
  const text = read('index.ts')

  it('control: the call counter counts (a synthetic file with two calls reports two)', () => {
    expect(callsTo('installLoopGovernor(app); function f() { installLoopGovernor(app) }', 'installLoopGovernor')).toHaveLength(2)
  })

  it('has exactly ONE call into the governor, inside the whenReady handler', () => {
    const calls = callsTo(text, 'installLoopGovernor')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments.map((a) => a.getText())).toEqual(['app'])
    expect(text.indexOf('installLoopGovernor(app)')).toBeGreaterThan(text.indexOf('app.whenReady()'))
  })

  it('imports the governor from ./loopGovernor (once): the installer, and the SHED wait the reflect handler uses', () => {
    const imports = importsFrom(text, './loopGovernor')
    expect(imports).toHaveLength(1)
    const named = (imports[0].importClause?.namedBindings as ts.NamedImports).elements.map((e) => e.name.text)
    expect(named).toEqual(['installLoopGovernor', 'whenNotShed'])
    // 1.54.5: whenNotShed is awaited only by background passes, never on the typing path: memory:reflect-session (wire
    // step), and the code index of memory:ingest-code (before the sweep, and as its pause) and code-graph:build (HP-3).
    const channelOf = (n: ts.Node): string | null => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isCallExpression(p) && p.expression.getText() === 'ipcMain.handle' && ts.isStringLiteral(p.arguments[0])) return p.arguments[0].text
      }
      return null
    }
    expect(callsTo(text, 'whenNotShed').map(channelOf).sort()).toEqual([
      'code-graph:build', 'memory:ingest-code', 'memory:ingest-code', 'memory:reflect-session',
    ])
  })

  it('registers the other lanes’ pausables once, right after the governor is installed (shedRegistrations.ts)', () => {
    expect(importsFrom(text, './shedRegistrations')).toHaveLength(1)
    expect(callsTo(text, 'registerShedTargets')).toHaveLength(1)
    const install = text.indexOf('installLoopGovernor(app)')
    const reg = text.indexOf('registerShedTargets(')
    expect(reg).toBeGreaterThan(install)
    // The next statement, not somewhere further down: only the call's own comment lies between them.
    expect(text.slice(install, reg).split('\n').length).toBeLessThanOrEqual(5)
  })

  it('places the call after initAppLog (so its transition lines reach the log file) and not next to other lanes\' hooks', () => {
    const at = text.indexOf('installLoopGovernor(app)')
    expect(at).toBeGreaterThan(text.indexOf("initAppLog(app.getPath('userData'))"))
    const lineStart = text.lastIndexOf('\n', at) + 1
    const previous = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1)
    expect(previous).not.toMatch(/startTypingTrace|initAppLog/) // a line of its own away from lane B's call
  })
})

describe('diagnostics:collect carries a separate, small governor block', () => {
  it('has the block, as plain numbers/booleans, and leaves the other seven fields as they were', async () => {
    const { collectDiagnostics } = await import('../../src/main/diagnostics')
    const d = collectDiagnostics() as unknown as Record<string, unknown>
    expect(d.appVersion).toBe('9.9.9')
    const g = d.governor as Record<string, unknown>
    expect(g).toBeTruthy()
    expect(g).toMatchObject({ enabled: false, shed: false, transitions: 0, lastP99Ms: null })
    expect(Object.keys(g).sort()).toEqual([
      'enabled', 'enters', 'errors', 'forcedLeaves', 'freeMB', 'idleFloorMs', 'lastDelayMs', 'lastP99Ms', 'maxDelayMs',
      'registered', 'samples', 'shed', 'shedForMs', 'totalShedMs', 'transitions',
    ])
    expect(JSON.stringify(g)).not.toMatch(/undefined|NaN/)
  })

  it('reflects a live governor (control: the block is not a constant)', async () => {
    const gov = await import('../../src/main/loopGovernor')
    const { collectDiagnostics } = await import('../../src/main/diagnostics')
    let tick: () => void = () => {}
    let now = 0
    gov.startLoopGovernor({
      env: {}, platform: 'linux', config: { idleFloorMs: 0 }, registry: gov.createShedRegistry(), log: () => {},
      createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 150e6 }),
      setInterval: ((fn: () => void) => { tick = fn; return {} }) as never, clearInterval: () => {},
      now: () => now, freemem: () => 0,
    })
    for (let i = 0; i < 3; i++) { now += 2000; tick() }
    const g = (collectDiagnostics() as unknown as { governor: Record<string, unknown> }).governor
    // idleFloorMs: the effective floor (here the config's 0) sits beside the raw lastP99Ms and the net lastDelayMs
    expect(g).toMatchObject({ enabled: true, shed: true, transitions: 1, samples: 3, lastP99Ms: 150, lastDelayMs: 150, idleFloorMs: 0 })
    gov.__resetLoopGovernorForTests()
  })

  it('leaves the Report-a-Problem markdown alone (it prints the seven original fields only)', async () => {
    const { collectDiagnostics, formatDiagnosticsMarkdown } = await import('../../src/main/diagnostics')
    expect(formatDiagnosticsMarkdown(collectDiagnostics())).not.toMatch(/governor|shed/i)
  })
})
