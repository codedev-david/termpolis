// 1.54.5 (EDR2-2): the console helper's counters say whether it ever costs a submit its answer. A helper that could not
// be found or written (a packaged build missing resources/mcp-adapter/termpolis-console-list.cjs) used to count nothing
// at all: every submit check came back "cannot tell" and diagnostics showed runs 0, failures 0. It is counted now
// (missingHelper), and the counters ride in diagnostics:collect (typing.extra.consoleList), read only when asked for.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

const h = vi.hoisted(() => ({ exec: vi.fn(), ensure: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: vi.fn(() => '9.9.9') } }))
vi.mock('../../src/main/procClient', () => ({ execCaptureOffThread: h.exec }))
vi.mock('../../src/main/consoleListHelper', () => ({ ensureConsoleListHelper: h.ensure }))

const { collectDiagnostics } = await import('../../src/main/diagnostics')
const { registerTypingTraceSource } = await import('../../src/main/typingTrace')
const { shellAlone, readConsoleProcessList, consoleListCounters, _resetShellAloneForTests } = await import('../../src/main/shellAlone')

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

beforeEach(() => {
  _resetShellAloneForTests()
  h.exec.mockReset()
  h.ensure.mockReset()
})

describe('EDR2-2: a missing console helper is counted', () => {
  it('a helper that is not there (null) or cannot be written (throws) counts missingHelper, runs nothing, and cannot tell', async () => {
    h.ensure.mockResolvedValueOnce(null)
    expect(await shellAlone(100, POWERSHELL, 'win32')).toBeNull()
    h.ensure.mockRejectedValueOnce(new Error('no resources folder'))
    expect(await readConsoleProcessList(101)).toBeNull()
    expect(consoleListCounters()).toEqual({ runs: 0, failures: 0, timeouts: 0, missingHelper: 2 })
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('control: a helper that is there counts a run, not a missing helper; the reset clears it', async () => {
    h.ensure.mockResolvedValue('C:\\data\\termpolis-console-list.cjs')
    h.exec.mockResolvedValue({ stdout: JSON.stringify({ self: 900, list: [900, 100] }), stderr: '' })
    expect(await shellAlone(100, POWERSHELL, 'win32')).toBe(true)
    expect(consoleListCounters()).toEqual({ runs: 1, failures: 0, timeouts: 0, missingHelper: 0 })
    h.ensure.mockResolvedValueOnce(null)
    await readConsoleProcessList(100)
    _resetShellAloneForTests()
    expect(consoleListCounters()).toEqual({ runs: 0, failures: 0, timeouts: 0, missingHelper: 0 })
  })
})

describe('EDR2-2: the counters reach diagnostics:collect', () => {
  it('registered the way index.ts does, they show under typing.extra.consoleList, numbers only, read when asked', async () => {
    registerTypingTraceSource('consoleList', () => consoleListCounters())
    h.ensure.mockResolvedValueOnce(null)
    await shellAlone(100, POWERSHELL, 'win32')
    expect(collectDiagnostics().typing!.extra.consoleList).toEqual({ runs: 0, failures: 0, timeouts: 0, missingHelper: 1 })
  })

  it('index.ts registers it once, right after startTypingTrace(), in the same block, through a closure', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
    const sf = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true)
    const calls: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    const start = calls.find((c) => (c.expression as ts.Identifier).text === 'startTypingTrace')!
    const reg = calls.filter((c) => (c.expression as ts.Identifier).text === 'registerTypingTraceSource'
      && ts.isStringLiteral(c.arguments[0]) && c.arguments[0].text === 'consoleList')
    expect(reg).toHaveLength(1)
    expect(reg[0].getStart()).toBeGreaterThan(start.getStart())
    expect(reg[0].parent.parent).toBe(start.parent.parent)
    // a closure, so a suite that mocks ./shellAlone without consoleListCounters never touches it at start-up
    expect(ts.isArrowFunction(reg[0].arguments[1])).toBe(true)
    expect(reg[0].arguments[1].getText()).toContain('consoleListCounters()')
  })
})
