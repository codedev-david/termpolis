// 1.54.5 merge, seam 7: lane C's "Learn from conversations" switch and lane G's SHED pause are two separate pauses.
//
// The person's switch lives in memory-settings.json (main) and is changed by ONE thing: the person, through the
// memory:set-learn-conversations IPC. SHED is a state of the event-loop governor that pauses background timers while
// the loop struggles and resumes them after. If SHED ever wrote the switch, a stall would turn learning OFF for good
// (and the person, who never touched it, would find memory had stopped growing); if SHED ever read it, a stall would
// make the switch look different to what was saved. So this file pins that they share nothing:
//   - the setter has exactly one caller, the person's IPC handler;
//   - the governor / shed modules do not import the settings module at all;
//   - with the REAL settings module and the REAL shed registry, any number of SHED cycles leaves the switch and the
//     file on disk exactly as the person left them, in both positions, across a restart.
// The memory indexer's registration with the governor is made in the Wire step (GOVERNOR-REGISTRATIONS.md): it must
// compose as `paused() || shed`, never by touching the switch. Its test belongs to that step.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ts from 'typescript'

let tmpDir = ''
vi.mock('electron', () => ({ app: { getPath: () => tmpDir, getVersion: () => '9.9.9' } }))

const MAIN = join(__dirname, '..', '..', 'src', 'main')

function mainSourceFiles(dir: string = MAIN): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...mainSourceFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

function callsTo(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The channel of the ipcMain.handle(...) call this node sits in, or null. */
function enclosingHandleChannel(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'handle') {
      const first = n.arguments[0]
      return first && ts.isStringLiteralLike(first) ? first.text : null
    }
  }
  return null
}

describe('the switch has one writer: the person', () => {
  it('control: the finder sees a known call (the handler reads the switch through getLearnFromConversations)', () => {
    const sf = parse(join(MAIN, 'index.ts'))
    expect(callsTo(sf, 'getLearnFromConversations').length).toBeGreaterThan(3)
  })

  it('setLearnFromConversations is called exactly once in src/main, inside the memory:set-learn-conversations handler', () => {
    const callers: Array<{ file: string; channel: string | null }> = []
    for (const file of mainSourceFiles()) {
      const sf = parse(file)
      for (const call of callsTo(sf, 'setLearnFromConversations')) callers.push({ file: file.slice(MAIN.length + 1).replace(/\\/g, '/'), channel: enclosingHandleChannel(call) })
    }
    expect(callers).toEqual([{ file: 'index.ts', channel: 'memory:set-learn-conversations' }])
  })

  it('no governor or shed module imports the settings module, so SHED cannot read or write the switch', () => {
    for (const f of ['loopGovernor.ts', 'shedWatch.ts', 'watchGuard.ts', 'hostPriority.ts', 'threadpoolEnv.ts', 'typingTrace.ts', 'memoryTraceSources.ts']) {
      const specs = parse(join(MAIN, f)).statements
        .filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s))
        .map((s) => (s.moduleSpecifier as ts.StringLiteral).text)
      expect(specs, f).not.toContain('./memorySettings')
    }
  })
})

describe('SHED cycles do not change the switch (real settings module, real shed registry)', () => {
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-learnshed-')) })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* scratch */ } })

  async function fresh() {
    vi.resetModules()
    const settings = await import('../../src/main/memorySettings')
    const governor = await import('../../src/main/loopGovernor')
    return { settings, registry: governor.createShedRegistry() }
  }
  const file = () => join(tmpDir, 'memory-settings.json')

  for (const position of [true, false]) {
    it(`switch ${position ? 'ON' : 'OFF'}: three SHED cycles later it is still ${position ? 'ON' : 'OFF'}, in memory and on disk, and after a restart`, async () => {
      const { settings, registry } = await fresh()
      settings.setLearnFromConversations(position)
      const onDisk = readFileSync(file(), 'utf8')

      let paused = 0
      let resumed = 0
      registry.register('a-background-job', { pause: () => { paused++ }, resume: () => { resumed++ } })
      for (let i = 0; i < 3; i++) {
        registry.setShed(true)
        expect(settings.getLearnFromConversations()).toBe(position) // while shed
        registry.setShed(false)
      }
      expect({ paused, resumed }).toEqual({ paused: 3, resumed: 3 }) // the cycles really ran
      expect(settings.getLearnFromConversations()).toBe(position)
      expect(readFileSync(file(), 'utf8')).toBe(onDisk) // not one byte rewritten by SHED

      // A restart: a fresh module reads the file start-up reads (initMemorySettings), and finds what the person left.
      vi.resetModules()
      const afterRestart = await import('../../src/main/memorySettings')
      afterRestart.initMemorySettings()
      expect(afterRestart.getLearnFromConversations()).toBe(position)
    })
  }

  it('control: a person turning it off DOES change the file (so the byte-for-byte checks above can fail)', async () => {
    const { settings } = await fresh()
    settings.setLearnFromConversations(true)
    const before = existsSync(file()) ? readFileSync(file(), 'utf8') : ''
    settings.setLearnFromConversations(false)
    expect(readFileSync(file(), 'utf8')).not.toBe(before)
  })
})
