// AC1 (e) — steady state: with the real main entry running, nothing a TIMER does makes a synchronous file call or
// a spawn on the main thread.
//
// Why. The hot-path file (mainThreadHotPaths.test.ts) counts what a person's actions cost. This one counts what
// the app does on its own while they type: every setInterval and every re-arming setTimeout the entry and its modules
// started (the 15 s trigger tick, the learning-signal poll, the transcript watchers' 1.5 s polls, the event bus's
// flush, the headroom and ledger writers, the session and history saves, the crash heartbeat...). A sync file call in
// any of them stalls every terminal for up to 1.5 s on a busy laptop with Defender; a spawn for 0.1-0.3 s.
//
// How. A fake CLOCK (setTimeout, setInterval and Date only: real I/O and setImmediate stay real) is installed BEFORE the
// entry is loaded, so every timer the app arms is the clock's. The clock then runs forty simulated minutes in small
// steps, yielding the real event loop between steps so the answers of the thread pool (fs.promises, the proc host
// fake) arrive and the continuations that follow them are inside the counting window. The counters are the same
// as in the hot-path file: Sync calls through the real fs and spawns through the real child_process, attributed by call
// stack to src/main (tests/helpers/mainThreadCounters.ts). No wall-clock assertion anywhere: every assertion is a count.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
// FIRST: it patches fs and child_process, and a module loaded before it keeps the original functions.
import { uninstall, arm, disarm, describeCounts, describeSites, type Counts } from '../helpers/mainThreadCounters'

// The real clock, kept before any fake one is installed: the test waits on it for the thread pool.
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-hot-'))
  const userData = path.join(root, 'userData')
  const home = path.join(root, 'home')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  // The real entry starts a lot of things that look in the user's home (agent configs, transcripts, caches).
  // They must look in a synthetic one: this test never reads or writes the real profile.
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries({ USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), TERMPOLIS_TEST_AGENT_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })) { saved[k] = process.env[k]; process.env[k] = v }
  return {
    root, home, userData, saved,
    ipcHandlers: new Map<string, (...a: any[]) => any>(),
    ipcOn: new Map<string, Array<(...a: any[]) => any>>(),
    appOn: new Map<string, (...a: any[]) => any>(),
    ptys: [] as any[],
    sent: [] as Array<{ channel: string; args: any[] }>,
    hostRequests: [] as any[],
    hostReply: ((_req: any): { ok: boolean; stdout: string; stderr: string; error?: any } => ({ ok: true, stdout: '', stderr: '' })) as (req: any) => { ok: boolean; stdout: string; stderr: string; error?: any },
  }
})

vi.mock('electron', () => {
  const webContents = {
    send: vi.fn((channel: string, ...args: any[]) => { H.sent.push({ channel, args }) }),
    executeJavaScript: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  }
  const win = {
    minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
    restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(), setIcon: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
    webContents,
  }
  function MockBrowserWindow() { return win }
  MockBrowserWindow.prototype = {}
  return {
    app: {
      getPath: vi.fn(() => H.userData), getVersion: vi.fn(() => '9.9.9'), whenReady: () => Promise.resolve(),
      requestSingleInstanceLock: () => true, setName: vi.fn(), setAppUserModelId: vi.fn(), disableHardwareAcceleration: vi.fn(),
      on: vi.fn((ev: string, h: any) => { H.appOn.set(ev, h) }), commandLine: { appendSwitch: vi.fn() }, isPackaged: false, quit: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: any) => { H.ipcHandlers.set(channel, handler) }),
      on: vi.fn((channel: string, handler: any) => { H.ipcOn.set(channel, [...(H.ipcOn.get(channel) ?? []), handler]) }),
    },
    BrowserWindow: MockBrowserWindow,
    clipboard: { writeText: vi.fn(), readText: vi.fn(() => ''), write: vi.fn() },
    dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
    nativeImage: { createFromPath: vi.fn(() => ({})), createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
    globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
    shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') },
    Notification: class { show() {} on() {} },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
  }
})

// The terminal's own shell: a fake pty that counts its creation.
vi.mock('node-pty', async () => {
  const { countSpawn: count } = await import('../helpers/mainThreadCounters')
  const spawn = vi.fn((file: string, args: string[], opts: any) => {
    count('pty.spawn')
    const listeners = { data: [] as Array<(d: string) => void>, exit: [] as Array<(e: { exitCode: number }) => void> }
    const pid = 40_000 + H.ptys.length
    // node-pty's WindowsTerminal: its kill() lists the console's programs by FORKING a helper. spawnTerminal must have
    // replaced that, per terminal, on Windows: a call of this original is a fork on the main thread, and it is counted.
    const agent = { innerPid: pid, _getConsoleProcessList: () => { count('fork(node-pty console list)'); return Promise.resolve([pid]) } }
    const p = {
      pid, cols: opts?.cols ?? 80, rows: opts?.rows ?? 24, file, args, opts,
      ...(process.platform === 'win32' ? { _agent: agent } : {}),
      onData: (cb: (d: string) => void) => { listeners.data.push(cb); return { dispose() {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { listeners.exit.push(cb); return { dispose() {} } },
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(() => { void (p as { _agent?: typeof agent })._agent?._getConsoleProcessList(); for (const cb of listeners.exit) cb({ exitCode: 0 }) }),
      emit: (d: string) => { for (const cb of listeners.data) cb(d) },
    }
    H.ptys.push(p)
    return p
  })
  return { spawn, default: { spawn } }
})

// The proc host: a fake that records what it is asked and answers from H.hostReply.
vi.mock('../../src/main/procHostTransport', () => ({
  createProcHostTransport: () => {
    let onMsg: ((m: any) => void) | null = null
    return {
      pid: 7777,
      postMessage(req: any) {
        H.hostRequests.push(req)
        const r = H.hostReply(req)
        queueMicrotask(() => onMsg?.({ kind: 'result', id: req.id, ...r }))
      },
      onMessage(cb: (m: any) => void) { onMsg = cb },
      onExit() {},
      kill() {},
    }
  },
}))

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: vi.fn(), stopMcpServer: vi.fn(), getMcpAuthToken: vi.fn(() => 'fake-token'), getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(), awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
}))
vi.mock('../../src/main/memoryClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The host is never started: its client answers from the in-process store, which this test does not touch.
  startMemoryHost: vi.fn(async () => 'host'),
  stopMemoryHost: vi.fn(),
  setMemoryHostSpawner: vi.fn(),
}))
vi.mock('../../src/main/headroomProxy/proxySupervisor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createProxyTransport: vi.fn(() => { throw new Error('no proxy process in this test') }),
}))
vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

function invoke(channel: string, args: unknown = {}): any {
  const h = H.ipcHandlers.get(channel)
  if (!h) throw new Error(`No handler for ${channel}`)
  return h({}, args)
}
function fire(channel: string, ...args: unknown[]): void {
  const list = H.ipcOn.get(channel)
  if (!list?.length) throw new Error(`No ipcMain.on handler for ${channel}`)
  list[list.length - 1]({}, ...args)
}

const realWait = (ms: number): Promise<void> => new Promise<void>((r) => realSetTimeout(r, ms))
/** Let everything that was started finish on the real clock (the thread pool, the host fake). */
const realSettle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await realWait(15) }

/** Run `totalMs` of simulated time in steps of `stepMs`, counting what src/main does on the main thread meanwhile. */
async function runClock(totalMs: number, stepMs: number, each?: (elapsedMs: number) => void | Promise<void>): Promise<Counts> {
  arm()
  try {
    for (let t = 0; t < totalMs; t += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs)
      await each?.(t + stepMs)
      await realWait(3) // the answers of the thread pool arrive on the real clock; their continuations count too
    }
    await realSettle()
  } finally {
    // disarm below
  }
  return disarm()
}

function expectNothing(c: Counts, allow: Record<string, number> = {}): void {
  const rest: Counts = { sync: { ...c.sync }, spawn: { ...c.spawn } }
  for (const [name, n] of Object.entries(allow)) {
    rest.spawn[name] = (rest.spawn[name] ?? 0) - n
    if (rest.spawn[name] === 0) delete rest.spawn[name]
  }
  expect(describeCounts(rest), `main thread did: ${describeCounts(c)} (${describeSites(c)})`).toBe('')
}

// Start-up work is allowed to be synchronous (the allowlist says so, line by line); the first firing of every periodic job
// that was armed at launch (the memory indexer's first pass is 10 s after launch, the first trigger tick 15 s) happens
// in the warm-up, and the warm-up ends when that first pass has FINISHED (a state, not a duration: the pass does real
// I/O and takes as long as it takes). After it, the claim is about steady state: 40 simulated minutes, which holds the
// indexer's 30-minute repeat and a few hundred repeats of everything shorter.
const WARM_UP = 2 * 60_000
const STEADY = 40 * 60_000

/** Run the warm-up: simulated time past every first firing, then wait (real clock) until no indexer pass is running. */
async function warmUp(): Promise<void> {
  const { isIndexing } = await import('../../src/main/memoryIndexer')
  await runClock(WARM_UP, 10_000)
  for (let i = 0; i < 2000 && isIndexing(); i++) await realWait(10) // a bound on the wait, not a claim about its length
  expect(isIndexing(), 'the first indexer pass has finished').toBe(false)
  await realSettle()
}

beforeAll(async () => {
  // The clock first: every timer the entry arms from here on belongs to it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.resetModules()
  await import('../../src/main/index')
  await vi.advanceTimersByTimeAsync(0)
  await realSettle()
}, 240_000)
afterAll(async () => {
  vi.useRealTimers()
  uninstall()
  for (const [k, v] of Object.entries(H.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const fs = await import('fs')
  fs.rmSync(H.root, { recursive: true, force: true })
})

describe('the counters see a timer tick of src/main (control)', () => {
  it('counts the synchronous calls a tick makes, under the fake clock', async () => {
    const { readTextFile } = await import('../../src/main/agentConfigIO')
    const id = setInterval(() => { readTextFile(__filename) }, 1000)
    arm()
    await vi.advanceTimersByTimeAsync(3000)
    const c = disarm()
    clearInterval(id)
    expect(c.sync.existsSync).toBe(3)
    expect(c.sync.readFileSync).toBe(3)
  })

  it('has loaded the real entry and left timers armed (a count of zero below is not an empty app)', () => {
    expect(H.ipcHandlers.has('terminal:create')).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3)
  })
})

describe('steady-state timers of the real main entry', () => {
  it('an app with nothing open: forty simulated minutes of timers, after the warm-up, make no sync call and no spawn', async () => {
    await warmUp() // un-judged: the first firing of the jobs armed at launch
    const before = vi.getTimerCount()
    const c = await runClock(STEADY, 10_000)
    expectNothing(c)
    // The timers are still there (they re-armed themselves; none was a one-shot that hid the work).
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(Math.min(before, 3))
  })

  it('a terminal, an attached transcript watcher and a growing transcript: forty more minutes, the same', async () => {
    const fs = await import('fs')
    const path = await import('path')
    // A synthetic Codex session in the synthetic home: the watcher tails it (fs.watch + a 1.5 s poll).
    const dir = path.join(H.home, '.codex', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-2026-11-03T00-00-00-timers.jsonl')
    const line = (text: string): string => JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }) + '\n'
    fs.writeFileSync(file, line('history that must not be replayed'))

    // Opening them is a hot path of its own (the other file counts it); what is counted here is the time after.
    let created: any
    const creating = invoke('terminal:create', { id: 'timers-term-1', shellType: 'bash', cwd: process.cwd(), extraPaths: [], claudeHeadroom: false })
    for (let i = 0; i < 40 && created === undefined; i++) {
      void Promise.resolve(creating).then((r) => { created = r })
      await vi.advanceTimersByTimeAsync(50)
      await realWait(5)
    }
    expect(created?.success, JSON.stringify(created)).toBe(true)
    let attached: any
    const attaching = invoke('agentWatcher:attach', { terminalId: 'timers-term-1', cwd: H.home, agentType: 'codex' })
    for (let i = 0; i < 40 && attached === undefined; i++) {
      void Promise.resolve(attaching).then((r) => { attached = r })
      await vi.advanceTimersByTimeAsync(50)
      await realWait(5)
    }
    expect(attached?.success, JSON.stringify(attached)).toBe(true)
    await realSettle()

    const bus = await import('../../src/main/agentEventBus')
    const eventsBefore = bus.query().length
    const pty = H.ptys[H.ptys.length - 1]
    let appended = 0
    await warmUp() // un-judged: the first passes of what was just opened
    const c = await runClock(STEADY, 10_000, (elapsed) => {
      // Every 10 s of simulated time the agent "writes" a transcript line and the shell prints a chunk.
      fs.appendFileSync(file, line('live line ' + elapsed))
      appended++
      pty.emit('output at ' + elapsed + '\r\n')
    })
    expectNothing(c)
    // Not vacuous: the transcript really was tailed (its lines reached the event bus) and the pty chunks went out.
    await realSettle()
    expect(bus.query().length - eventsBefore, 'transcript lines that reached the bus').toBeGreaterThan(0)
    expect(appended).toBeGreaterThan(200)
    expect(H.sent.filter((m) => m.channel === 'terminal:data').length, 'pty chunks delivered to the renderer').toBeGreaterThan(0)
  })
})
