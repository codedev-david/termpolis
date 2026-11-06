/**
 * Background hosts lower THEIR OWN priority (1.54.5 hotfix, lane G, "PRIORITY, decided").
 *
 * DECISION (David): nothing in Termpolis ever sets ANOTHER process's priority, and main never changes its own
 * (children inherit it, and main is the thread that echoes keystrokes). Each background host lowers itself, at
 * its own startup, as the first thing it does: the memory host, the proc host, the Headroom proxy entry and the
 * remote bridge entry. On Windows a child process inherits a BELOW_NORMAL parent's class, so the git calls the
 * proc host starts run below normal too: that is the point (they are background reads), and the kill switch
 * TERMPOLIS_NO_HOST_PRIORITY=1 restores today's behaviour.
 *
 * COUNTERS (the proof): calls to os.setPriority counted through an injected fake os module (vi.mock cannot
 * replace a Node builtin: it is a silent no-op, so the code takes the module as a parameter): exactly one call
 * per host, the pid argument is the literal 0 (the calling process), the priority is the below-normal constant,
 * and no other file in src/main can call setPriority at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import ts from 'typescript'
import * as nodeOs from 'os'
import { lowerHostPriority, __setHostPriorityDepsForTests, type HostPriorityDeps } from '../../src/main/hostPriority'

const SRC_MAIN = join(__dirname, '..', '..', 'src', 'main')
const BELOW_NORMAL = 10 // os.constants.priority.PRIORITY_BELOW_NORMAL on every platform Node supports

function fakeOs(over: { setPriority?: (pid: number, p: number) => void; constants?: unknown } = {}) {
  const calls: Array<[number, number]> = []
  return {
    calls,
    os: {
      setPriority: (pid: number, p: number) => { calls.push([pid, p]); over.setPriority?.(pid, p) },
      constants: over.constants ?? { priority: { PRIORITY_BELOW_NORMAL: BELOW_NORMAL, PRIORITY_NORMAL: 0 } },
    },
  }
}

afterEach(() => {
  __setHostPriorityDepsForTests(null)
  vi.resetModules()
})

describe('lowerHostPriority', () => {
  it('makes exactly one os.setPriority call, for the calling process (pid 0), at below-normal', () => {
    const { os, calls } = fakeOs()
    expect(lowerHostPriority({ os, env: {} })).toBe('lowered')
    expect(calls).toEqual([[0, BELOW_NORMAL]])
  })

  it('never uses a foreign pid: the first argument is the literal 0, not process.pid and not undefined', () => {
    const { os, calls } = fakeOs()
    lowerHostPriority({ os, env: {} })
    expect(calls[0][0]).toBe(0)
    expect(Object.is(calls[0][0], 0)).toBe(true)
    expect(calls[0][0]).not.toBe(process.pid)
  })

  it('uses the platform constant, whatever its value (control: not a hard-coded number)', () => {
    const { os, calls } = fakeOs({ constants: { priority: { PRIORITY_BELOW_NORMAL: 7 } } })
    lowerHostPriority({ os, env: {} })
    expect(calls).toEqual([[0, 7]])
  })

  it('TERMPOLIS_NO_HOST_PRIORITY=1 (or true): no call at all', () => {
    for (const v of ['1', 'true']) {
      const { os, calls } = fakeOs()
      expect(lowerHostPriority({ os, env: { TERMPOLIS_NO_HOST_PRIORITY: v } })).toBe('disabled')
      expect(calls).toEqual([])
    }
  })

  it('EDR-2: TERMPOLIS_NO_HOST_PRIORITY=<host list> leaves only the named hosts alone', () => {
    const env = { TERMPOLIS_NO_HOST_PRIORITY: 'proc, bridge' }
    const proc = fakeOs()
    expect(lowerHostPriority({ os: proc.os, env, host: 'proc' })).toBe('disabled')
    expect(proc.calls).toEqual([])
    const memory = fakeOs() // control: a host the list does not name is still lowered
    expect(lowerHostPriority({ os: memory.os, env, host: 'memory' })).toBe('lowered')
    expect(memory.calls).toEqual([[0, BELOW_NORMAL]])
    const anon = fakeOs() // control: a caller that names no host is not matched by a list
    expect(lowerHostPriority({ os: anon.os, env })).toBe('lowered')
  })

  it('EDR-2: a host named by the caller still sees the test seam (deps merge, they do not replace it)', () => {
    const { os, calls } = fakeOs()
    __setHostPriorityDepsForTests({ os, env: {} })
    expect(lowerHostPriority({ host: 'memory' })).toBe('lowered')
    expect(calls).toEqual([[0, BELOW_NORMAL]])
  })

  it('control: "0" and an unset variable do not disable it', () => {
    for (const env of [{ TERMPOLIS_NO_HOST_PRIORITY: '0' }, {}]) {
      const { os, calls } = fakeOs()
      expect(lowerHostPriority({ os, env })).toBe('lowered')
      expect(calls).toHaveLength(1)
    }
  })

  it('is best effort: a refusal (EPERM and friends) is swallowed and reported, never thrown', () => {
    const { os, calls } = fakeOs({ setPriority: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } })
    expect(() => lowerHostPriority({ os, env: {} })).not.toThrow()
    expect(lowerHostPriority({ os, env: {} })).toBe('failed')
    expect(calls).toHaveLength(2) // control: it did try each time, it just did not let the failure out
  })

  it('an os without the constant (very old runtime) is left alone: no call, no throw', () => {
    const { os, calls } = fakeOs({ constants: {} })
    expect(lowerHostPriority({ os, env: {} })).toBe('unsupported')
    expect(calls).toEqual([])
  })

  it('with no arguments at all it reads the real environment: the unit suite runs with the kill switch on, so nothing happens', () => {
    expect(process.env.TERMPOLIS_NO_HOST_PRIORITY).toBe('1')
    expect(lowerHostPriority()).toBe('disabled')
  })

  it('smoke: against the REAL os module in this very process it does not throw (and the test puts the priority back)', () => {
    const real = lowerHostPriority({ env: {} })
    expect(['lowered', 'failed']).toContain(real)
    if (real === 'lowered') {
      try { nodeOs.setPriority(0, nodeOs.constants.priority.PRIORITY_NORMAL) } catch { /* POSIX cannot raise it again: a throwaway worker */ }
    }
  })

  it('does not remember: calling twice makes two calls (so a host that called it twice would be caught by the counters below)', () => {
    const { os, calls } = fakeOs()
    lowerHostPriority({ os, env: {} })
    lowerHostPriority({ os, env: {} })
    expect(calls).toHaveLength(2)
  })
})

// ── static: the only setPriority in src/main ─────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

interface PriorityCall { file: string; firstArg: string }
function setPriorityCalls(file: string, text = readFileSync(file, 'utf8')): PriorityCall[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: PriorityCall[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : ''
      if (name === 'setPriority') found.push({ file, firstArg: n.arguments[0]?.getText(sf) ?? '' })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('nothing else can touch a process priority', () => {
  it('control: the scanner flags a foreign-pid call and a bare call', () => {
    expect(setPriorityCalls('x.ts', 'os.setPriority(pid, 10)')).toEqual([{ file: 'x.ts', firstArg: 'pid' }])
    expect(setPriorityCalls('x.ts', 'setPriority(child.pid, 19)')).toHaveLength(1)
    expect(setPriorityCalls('x.ts', 'os.getPriority(0)')).toEqual([])
  })

  it('exactly one setPriority call exists in src/main, in hostPriority.ts, and its first argument is the literal 0', () => {
    const all = sourceFiles(SRC_MAIN).flatMap((f) => setPriorityCalls(f))
    expect(all.map((c) => relative(SRC_MAIN, c.file).split(sep).join('/'))).toEqual(['hostPriority.ts'])
    expect(all[0].firstArg).toBe('0')
  })
})

// ── static: each host calls it first, once ─────────────────────────────

// The hosts that do background work only, lowered. Each names itself, so TERMPOLIS_NO_HOST_PRIORITY can list it alone.
const HOSTS: Array<{ name: string; file: string; host: string; load: () => Promise<unknown> }> = [
  { name: 'memory host', file: 'memoryHost.ts', host: 'memory', load: () => import('../../src/main/memoryHost') },
  { name: 'proc host', file: 'procHost.ts', host: 'proc', load: () => import('../../src/main/procHost') },
]

// EDR-2: the hosts on an interactive path stay at normal priority. The Headroom proxy carries every model reply an
// agent streams, and the remote bridge carries what is typed on the phone: both are what someone is waiting on.
const INTERACTIVE: Array<{ name: string; file: string; load: () => Promise<unknown> }> = [
  { name: 'Headroom proxy entry', file: 'headroomProxy/proxyMain.ts', load: () => import('../../src/main/headroomProxy/proxyMain') },
  { name: 'remote bridge entry', file: 'remoteBridge/entry.ts', load: () => import('../../src/main/remoteBridge/entry') },
]

/** How many lowerHostPriority(...) calls a file makes, whatever their arguments. */
function lowerCalls(file: string, text: string): number {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let calls = 0
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'lowerHostPriority') calls++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return calls
}

/** The statements of the body of the `if (parentPort) { … }` block, which is what runs only inside a fork. */
function childBlockStatements(text: string): ts.Statement[] {
  const sf = ts.createSourceFile('host.ts', text, ts.ScriptTarget.Latest, true)
  for (const st of sf.statements) {
    if (ts.isIfStatement(st) && ts.isIdentifier(st.expression) && st.expression.text === 'parentPort' && ts.isBlock(st.thenStatement)) {
      return [...st.thenStatement.statements]
    }
  }
  return []
}

describe('each background host lowers its own priority first, once, only when it is a forked child', () => {
  it('control: a block that does something else first is reported as not-first', () => {
    const stmts = childBlockStatements("if (parentPort) { process.on('x', () => {}); lowerHostPriority({ host: 'x' }) }")
    expect(stmts[0].getText()).not.toMatch(/^lowerHostPriority\(/)
  })

  for (const host of HOSTS) {
    it(`${host.name}: lowerHostPriority({ host: '${host.host}' }) is the first statement of the fork-only block and appears once in the file`, () => {
      const text = readFileSync(join(SRC_MAIN, host.file), 'utf8')
      const stmts = childBlockStatements(text)
      expect(stmts.length).toBeGreaterThan(0)
      expect(stmts[0].getText()).toBe(`lowerHostPriority({ host: '${host.host}' })`)
      expect(lowerCalls(host.file, text)).toBe(1)
    })
  }

  it('control: the counter sees a call wherever it is', () => {
    expect(lowerCalls('x.ts', "if (parentPort) { foo(); lowerHostPriority() }")).toBe(1)
  })

  for (const host of INTERACTIVE) {
    it(`EDR-2: ${host.name} never lowers its priority: no lowerHostPriority call anywhere in the file`, () => {
      expect(lowerCalls(host.file, readFileSync(join(SRC_MAIN, host.file), 'utf8'))).toBe(0)
    })
  }
})

// ── dynamic: really import each host as a child and count the fake os calls ─

interface FakePort { on: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }

/**
 * A fresh module graph with the fake os installed in ITS copy of hostPriority (vi.resetModules gives the host a new
 * copy, so a seam set on the copy this file imported at the top would never be seen by the host).
 */
async function freshGraph(deps: HostPriorityDeps): Promise<void> {
  vi.resetModules()
  const fresh = await import('../../src/main/hostPriority')
  fresh.__setHostPriorityDepsForTests(deps)
}

/** Import a host module as if `process.parentPort` existed, then undo every process-level side effect of doing so. */
async function importAsChild(load: () => Promise<unknown>, deps: HostPriorityDeps): Promise<FakePort> {
  const port: FakePort = { on: vi.fn(), postMessage: vi.fn(), start: vi.fn() }
  const before = {
    rejection: process.listeners('unhandledRejection'),
    uncaught: process.listeners('uncaughtException'),
  }
  Object.defineProperty(process, 'parentPort', { value: port, configurable: true, writable: true })
  try {
    await freshGraph(deps)
    await load()
  } finally {
    delete (process as unknown as Record<string, unknown>).parentPort
    for (const l of process.listeners('unhandledRejection')) if (!before.rejection.includes(l)) process.off('unhandledRejection', l)
    for (const l of process.listeners('uncaughtException')) if (!before.uncaught.includes(l)) process.off('uncaughtException', l)
  }
  return port
}

describe('dynamic: the real host modules, imported as forked children, call the fake os exactly once', () => {
  for (const host of HOSTS) {
    it(`${host.name}: one call, pid 0, below-normal`, async () => {
      const { os, calls } = fakeOs()
      const port = await importAsChild(host.load, { os, env: {} })
      expect(port.on).toHaveBeenCalled() // the fork-only block really ran (control: the import was not inert)
      expect(calls).toEqual([[0, BELOW_NORMAL]])
    }, 60_000)

    it(`${host.name} control: imported in the main process (no parentPort) it never changes any priority`, async () => {
      const { os, calls } = fakeOs()
      await freshGraph({ os, env: {} })
      await host.load()
      expect(calls).toEqual([])
    }, 60_000)

    it(`${host.name} kill switch: TERMPOLIS_NO_HOST_PRIORITY=1 makes no call even as a child`, async () => {
      const { os, calls } = fakeOs()
      await importAsChild(host.load, { os, env: { TERMPOLIS_NO_HOST_PRIORITY: '1' } })
      expect(calls).toEqual([])
    }, 60_000)

    it(`${host.name} kill switch for this host alone: TERMPOLIS_NO_HOST_PRIORITY=${host.host} makes no call as a child`, async () => {
      const { os, calls } = fakeOs()
      await importAsChild(host.load, { os, env: { TERMPOLIS_NO_HOST_PRIORITY: host.host } })
      expect(calls).toEqual([])
    }, 60_000)
  }

  for (const host of INTERACTIVE) {
    it(`EDR-2: ${host.name}, imported as a forked child, makes zero priority calls`, async () => {
      const { os, calls } = fakeOs()
      const port = await importAsChild(host.load, { os, env: {} })
      expect(port.on).toHaveBeenCalled() // control: the fork-only block really ran
      expect(calls).toEqual([])
    }, 60_000)
  }
})
