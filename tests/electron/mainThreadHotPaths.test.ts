// AC1 — the typing hot paths of the REAL main entry (src/main/index.ts) make no spawn and no
// synchronous file call.
//
// Why. node-pty runs inside the Electron main process, so every keystroke and every echo passes
// through the main thread, and anything else that thread does delays typing. On David's laptop one
// synchronous file call stalls it for up to 1.5 s and one spawn for 0.1-0.3 s (Defender inspects
// each; its queue grows with the load). This test loads the real index.ts and its real modules with
// only Electron, node-pty, the memory host and the MCP server faked, drives the IPC handlers a person
// causes, and COUNTS what src/main did on the main thread while each ran: Sync calls through the real
// fs and spawns through the real child_process (tests/helpers/mainThreadCounters.ts, attributed by call
// stack). No clock: every assertion is a count.
//
// The terminal's own shell is created by node-pty in this process (one `pty.spawn`, counted by the
// fake); that is the terminal itself, allowed, and the one thing moving it needs is a PTY host
// process (perf155 P14). Nothing else may be counted.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
// FIRST: it patches fs and child_process, and a module loaded before it keeps the original functions.
import { uninstall, arm, disarm, snapshot, describeCounts, setAttribution, countSpawn, type Counts } from '../helpers/mainThreadCounters'

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
    const p = {
      pid: 40_000 + H.ptys.length, cols: opts?.cols ?? 80, rows: opts?.rows ?? 24, file, args, opts,
      onData: (cb: (d: string) => void) => { listeners.data.push(cb); return { dispose() {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { listeners.exit.push(cb); return { dispose() {} } },
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(() => { for (const cb of listeners.exit) cb({ exitCode: 0 }) }),
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
/** Let everything that was started finish, so a sync call that a timer or a promise defers still lands inside the window. */
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 15)) }

/** Count what src/main did, on the main thread, while `body` ran and settled. */
async function measure(body: () => unknown | Promise<unknown>): Promise<Counts> {
  arm()
  try {
    await body()
    await settle()
  } finally {
    // disarm below
  }
  return disarm()
}

/** What a hot path may do: nothing. `allow` lists the single thing it must (a terminal's own pty spawn). */
function expectNothing(c: Counts, allow: Record<string, number> = {}): void {
  const rest: Counts = { sync: { ...c.sync }, spawn: { ...c.spawn } }
  for (const [name, n] of Object.entries(allow)) {
    rest.spawn[name] = (rest.spawn[name] ?? 0) - n
    if (rest.spawn[name] === 0) delete rest.spawn[name]
  }
  expect(describeCounts(rest), `main thread did: ${describeCounts(c)}`).toBe('')
}

let ID = 'hot-term-1'

beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  await settle()
}, 240_000)
afterAll(async () => {
  uninstall()
  for (const [k, v] of Object.entries(H.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const fs = await import('fs')
  fs.rmSync(H.root, { recursive: true, force: true })
})

beforeEach(() => { H.sent.length = 0 })

describe('the counters see what src/main does (control)', () => {
  it('counts a synchronous call made by src/main code and a spawn from it', async () => {
    const { readTextFile } = await import('../../src/main/agentConfigIO')
    arm()
    readTextFile(__filename)
    const c = disarm()
    expect(c.sync.existsSync).toBe(1)
    expect(c.sync.readFileSync).toBe(1)
    // The test's own calls are not the hot path: they are not counted.
    arm()
    ;(await import('fs')).existsSync(__filename)
    expect(describeCounts(disarm())).toBe('')
    // ...unless the control says so.
    setAttribution(/mainThreadHotPaths\.test/)
    arm()
    ;(await import('fs')).existsSync(__filename)
    ;(await import('child_process')).execFileSync(process.execPath, ['-e', '0'])
    const own = disarm()
    setAttribution(null)
    expect(own.sync.existsSync).toBe(1)
    expect(own.spawn.execFileSync).toBe(1)
    arm()
    disarm()
    countSpawn('ignored-while-disarmed')
    expect(describeCounts(snapshot())).toBe('')
  })

  it('has loaded the real entry: its handlers are registered', () => {
    for (const ch of ['terminal:create', 'terminal:kill', 'terminal:shell-alone']) expect(H.ipcHandlers.has(ch), ch).toBe(true)
    expect(H.ipcOn.has('terminal:write')).toBe(true)
    expect(H.ipcOn.has('terminal:resize')).toBe(true)
  })
})

describe('typing hot paths of the real main entry', () => {
  it('(f) creating a terminal: the terminal\'s own pty and nothing else', async () => {
    let res: any
    const c = await measure(async () => {
      res = await invoke('terminal:create', { id: ID, shellType: 'bash', cwd: process.cwd(), extraPaths: [], claudeHeadroom: false })
    })
    expect(res?.success, JSON.stringify(res)).toBe(true)
    expect(H.ptys.length).toBe(1)
    expectNothing(c, { 'pty.spawn': 1 })
  })

  it('(a) typing: 300 keystrokes, a paste and Enter reach the pty and cost no sync call and no spawn', async () => {
    const pty = H.ptys[0]
    pty.write.mockClear()
    const c = await measure(() => {
      for (let i = 0; i < 300; i++) fire('terminal:write', { id: ID, data: String.fromCharCode(97 + (i % 26)) })
      fire('terminal:write', { id: ID, data: '\x1b[200~' + 'some text pasted into the shell '.repeat(4) + '\x1b[201~' })
      fire('terminal:write', { id: ID, data: '\r' })
    })
    expect(pty.write.mock.calls.length).toBe(302)
    expectNothing(c)
  })

  it('(a) typing the name of an agent, then pasting code and a secret into it, records audit lines without a sync call', async () => {
    const pty = H.ptys[0]
    pty.write.mockClear()
    const fakeKey = 'sk-ant-' + 'a'.repeat(40) // synthetic: the repeat trick, not a real key
    const code = 'function add(a, b) {\n  return a + b\n}\n'.repeat(12) + `const token = "${fakeKey}"\n`
    const c = await measure(() => {
      fire('terminal:write', { id: ID, data: 'claude\r' })
      fire('terminal:write', { id: ID, data: code })
      fire('terminal:write', { id: ID, data: '\r' })
    })
    expect(pty.write.mock.calls.length).toBe(3)
    expectNothing(c)
  })

  it('(c) output: 2,000 chunks from the pty, in bursts, cost no sync call and no spawn', async () => {
    const pty = H.ptys[0]
    const c = await measure(async () => {
      for (let i = 0; i < 2000; i++) {
        pty.emit(`line ${i} of some build output \x1b[32mok\x1b[0m\r\n`)
        if (i % 250 === 249) await new Promise<void>((r) => setTimeout(r, 12))
      }
    })
    expect(H.sent.filter((s) => s.channel === 'terminal:data').length).toBeGreaterThan(0)
    expectNothing(c)
  })

  it('a resize costs no sync call and no spawn', async () => {
    const c = await measure(() => { for (let i = 0; i < 50; i++) fire('terminal:resize', { id: ID, cols: 80 + i, rows: 24 }) })
    expect(H.ptys[0].resize.mock.calls.length).toBe(50)
    expectNothing(c)
  })

  it('(f) closing a terminal costs no sync call and no spawn (its audit record included)', async () => {
    const c = await measure(async () => { await invoke('terminal:kill', { id: ID }) })
    expect(H.ptys[0].kill).toHaveBeenCalled()
    expectNothing(c)
  })

  it('creating twenty more terminals, as a swarm does, costs only their own ptys', async () => {
    const before = H.ptys.length
    const c = await measure(async () => {
      for (let i = 0; i < 20; i++) await invoke('terminal:create', { id: `swarm-${i}`, shellType: 'bash', cwd: process.cwd(), extraPaths: [], claudeHeadroom: false })
    })
    expect(H.ptys.length - before).toBe(20)
    expectNothing(c, { 'pty.spawn': 20 })
  })
})
