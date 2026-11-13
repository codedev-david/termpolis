// Main's side of the terminal process host (ptyHost.ts): ptys that look like node-pty's to terminalManager and the
// sign-in sessions, but live in a utilityProcess, so starting one never blocks the thread that echoes keystrokes.
//
// Fail open, always to the old way:
//  - Until the host says it is ready (about 1.3 s after start-up on a busy laptop), terminals open in main as before.
//  - If the host dies, every terminal in it ends (with a line saying why) and every later one opens in main for the
//    rest of the session. No restart: a host that crashed once, on a box like this, is not worth a crash loop.
//  - TERMPOLIS_NO_PTY_HOST=1 never starts it.
//
// The transport is injected (ptyHostTransport.ts forks the real one), so everything here runs in the unit suite.

import type { DirectSpawn, PtyHostReply, PtyHostRequest, PtyHostSpawnOptions } from './ptyHost'

export const NO_PTY_HOST_ENV = 'TERMPOLIS_NO_PTY_HOST'

export function ptyHostDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[NO_PTY_HOST_ENV] ?? '').trim() === '1'
}

export interface PtyHostTransport {
  postMessage(msg: PtyHostRequest): void
  onMessage(cb: (msg: PtyHostReply) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
  /** Hand the host its end of the renderer's direct line (1.61.0). Absent: there is no direct line. */
  postPort?(port: unknown): void
}

/** A write the host handed main: `typed` it already wrote (main only watches); `via-main` main must write itself. */
export interface PtyHostInput {
  kind: 'typed' | 'via-main'
  /** The spawn's key, or null when the host holds no terminal under `id`. */
  key: number | null
  id: string
  data: string
}

/** Shown in a terminal whose shell lived in the host when the host went away. */
export const HOST_LOST_NOTE = '\r\n[Termpolis: the terminal process stopped, so this terminal closed. New terminals open as before.]\r\n'

/** How long the host may take to say it is ready before main stops waiting and keeps terminals to itself. */
export const READY_TIMEOUT_MS = 20_000

type Listener<T> = (v: T) => void

/** A pty in the host, shaped like node-pty's IPty for the parts Termpolis uses. */
export interface HostPty {
  /** 0 until the host says the shell started. */
  readonly pid: number
  /** Resolves with the pid once the shell started; rejects with the spawn's own error message. */
  readonly spawned: Promise<number>
  onData(cb: Listener<string>): { dispose(): void }
  onExit(cb: Listener<{ exitCode: number }>): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  /** consolePids: what runs on the shell's console, to end with it (Windows); without, the shell alone. */
  kill(consolePids?: number[] | null): void
  /** Marks a HostPty apart from node-pty's own. */
  readonly hosted: true
}

interface Live {
  pty: HostPtyImpl
}

class HostPtyImpl implements HostPty {
  readonly hosted = true as const
  pid = 0
  readonly spawned: Promise<number>
  private resolveSpawned!: (pid: number) => void
  private rejectSpawned!: (e: Error) => void
  private dataListeners: Array<Listener<string>> = []
  private exitListeners: Array<Listener<{ exitCode: number }>> = []
  private exited = false

  constructor(readonly key: number, private readonly send: (msg: PtyHostRequest) => void, private readonly exitOnSpawnError = false) {
    this.spawned = new Promise<number>((resolve, reject) => {
      this.resolveSpawned = resolve
      this.rejectSpawned = reject
    })
    // Handled here so a caller that never awaits it can't raise an unhandled rejection; awaiting it still rejects.
    this.spawned.catch(() => {})
  }

  onData(cb: Listener<string>): { dispose(): void } {
    this.dataListeners.push(cb)
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb) } }
  }

  onExit(cb: Listener<{ exitCode: number }>): { dispose(): void } {
    this.exitListeners.push(cb)
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb) } }
  }

  write(data: string): void {
    if (!this.exited) this.send({ kind: 'write', key: this.key, data })
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.send({ kind: 'resize', key: this.key, cols, rows })
  }

  kill(consolePids?: number[] | null): void {
    if (!this.exited) this.send({ kind: 'kill', key: this.key, consolePids: consolePids ?? null })
  }

  /** Until when a write typed straight to the host must go through main instead (a relaunch's hold); 0 lifts it. */
  gate(until: number): void {
    if (!this.exited) this.send({ kind: 'gate', key: this.key, until })
  }

  /** @internal */ _spawned(pid: number): void {
    this.pid = pid
    this.resolveSpawned(pid)
  }

  /** @internal */ _spawnFailed(message: string): void {
    if (this.exited) return
    this.rejectSpawned(new Error(message))
    if (!this.exitOnSpawnError) { this.exited = true; return }
    // For a caller written for node-pty's throw that cannot wait for this promise: the error is the
    // terminal's only output, then it exits.
    this._data(`${message}\r\n`)
    this._exit(-1)
  }

  /** @internal */ _data(data: string): void {
    for (const l of [...this.dataListeners]) {
      try { l(data) } catch (e) { console.error('[pty host] data listener threw:', e) }
    }
  }

  /** @internal */ _exit(code: number): void {
    if (this.exited) return
    this.exited = true
    for (const l of [...this.exitListeners]) {
      try { l({ exitCode: code }) } catch (e) { console.error('[pty host] exit listener threw:', e) }
    }
  }
}

let spawner: (() => PtyHostTransport) | null = null
let transport: PtyHostTransport | null = null
let ready = false
let dead = false
let readyTimer: ReturnType<typeof setTimeout> | null = null
let nextKey = 1
const live = new Map<number, Live>()
const inputListeners: Array<Listener<PtyHostInput>> = []
const readyListeners: Array<() => void> = []
const downListeners: Array<() => void> = []

/** Writes the host hands main (see PtyHostInput). */
export function onPtyHostInput(cb: Listener<PtyHostInput>): void {
  inputListeners.push(cb)
}

/** The host became ready: a direct line can be made now. */
export function onPtyHostReady(cb: () => void): void {
  readyListeners.push(cb)
}

/** The host went away for the session: any direct line to it is gone. */
export function onPtyHostDown(cb: () => void): void {
  downListeners.push(cb)
}

function fire<T>(list: Array<Listener<T>>, v: T, what: string): void {
  for (const l of [...list]) {
    try { l(v) } catch (e) { console.error(`[pty host] ${what} listener threw:`, e) }
  }
}

function post(msg: PtyHostRequest): void {
  const t = transport
  if (!t) return
  try { t.postMessage(msg) } catch (e) { console.error('[pty host] post failed:', e) }
}

/** Main finished a write the host handed it with this key: the host may write the next one. */
export function ptyHostRouted(key: number): void {
  post({ kind: 'routed', key })
}

/** Main has written the renderer's writes to `id` up to its mark `n`. */
export function ptyHostSync(id: string, n: number): void {
  post({ kind: 'sync', id, n })
}

/** Hand the host its end of a renderer's direct line. False when it cannot take one (not ready, gone, no support). */
export function connectRendererPort(port: unknown): boolean {
  const t = transport
  if (!t || !ready || dead || typeof t.postPort !== 'function') return false
  try {
    t.postPort(port)
    return true
  } catch (e) {
    console.error('[pty host] could not hand over the direct line:', e)
    return false
  }
}

/** The relaunch hold on a pty, when it lives in the host; a pty in main has no direct line to hold. */
export function gateHostPty(p: unknown, until: number): void {
  if (isHostPty(p)) (p as HostPtyImpl).gate(until)
}

/** Wired by the app at start-up (Windows); tests inject their own. */
export function setPtyHostSpawner(fn: (() => PtyHostTransport) | null): void {
  spawner = fn
}

/** Start the host now, so it is ready before the first terminal; a no-op when disabled, started, or down. */
export function startPtyHost(env: NodeJS.ProcessEnv = process.env): void {
  if (transport || dead || !spawner || ptyHostDisabledByEnv(env)) return
  let t: PtyHostTransport
  try {
    t = spawner()
  } catch (e) {
    console.error('[pty host] could not start; terminals stay in the main process:', e)
    dead = true
    return
  }
  transport = t
  t.onMessage((m) => onReply(t, m))
  t.onExit((code) => onHostExit(t, code))
  readyTimer = setTimeout(() => {
    readyTimer = null
    if (ready || transport !== t) return
    console.error(`[pty host] not ready after ${READY_TIMEOUT_MS} ms; terminals stay in the main process`)
    goDown(t)
  }, READY_TIMEOUT_MS)
  readyTimer.unref?.()
}

/** Whether a new terminal can open in the host now. */
export function ptyHostReady(): boolean {
  return ready && !dead && transport !== null
}

/** How many terminals live in the host. For diagnostics. */
export function ptyHostTerminalCount(): number {
  return live.size
}

/** Start a pty in the host. Only call when ptyHostReady(). exitOnSpawnError: a spawn the host could not make also
 *  reaches onData (its message) and onExit (-1), besides rejecting `spawned`. */
export function spawnInPtyHost(file: string, args: string[] | string, opts: PtyHostSpawnOptions, { exitOnSpawnError = false, direct }: { exitOnSpawnError?: boolean; direct?: DirectSpawn } = {}): HostPty {
  const t = transport
  if (!t || !ready || dead) throw new Error('pty host not ready')
  const key = nextKey++
  const send = (msg: PtyHostRequest): void => {
    if (transport !== t) return
    try { t.postMessage(msg) } catch (e) { console.error('[pty host] post failed:', e) }
  }
  const p = new HostPtyImpl(key, send, exitOnSpawnError)
  live.set(key, { pty: p })
  send(direct ? { kind: 'spawn', key, file, args, opts, direct } : { kind: 'spawn', key, file, args, opts })
  return p
}

export function isHostPty(p: unknown): p is HostPty {
  return !!p && (p as { hosted?: unknown }).hosted === true
}

function onReply(t: PtyHostTransport, m: PtyHostReply): void {
  if (transport !== t || !m || typeof m !== 'object') return
  if (m.kind === 'ready') {
    ready = true
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
    for (const l of [...readyListeners]) { try { l() } catch (e) { console.error('[pty host] ready listener threw:', e) } }
    return
  }
  if (m.kind === 'typed' || m.kind === 'via-main') {
    if (typeof m.id !== 'string' || typeof m.data !== 'string') return
    fire(inputListeners, { kind: m.kind, key: typeof m.key === 'number' ? m.key : null, id: m.id, data: m.data }, 'input')
    return
  }
  const entry = live.get(m.key)
  if (!entry) return
  switch (m.kind) {
    case 'spawned': entry.pty._spawned(m.pid); return
    case 'spawn-error': live.delete(m.key); entry.pty._spawnFailed(m.message); return
    case 'data': entry.pty._data(m.data); return
    case 'exit': live.delete(m.key); entry.pty._exit(m.code); return
  }
}

function onHostExit(t: PtyHostTransport, code: number): void {
  if (transport !== t) return
  console.error(`[pty host] exited (code ${code}); ${live.size} terminal(s) closed, new ones open in the main process`)
  goDown(t, { kill: false })
}

/** The host is gone for this session: its terminals end, and every later one opens in main. */
function goDown(t: PtyHostTransport, { kill = true, note = true }: { kill?: boolean; note?: boolean } = {}): void {
  dead = true
  ready = false
  transport = null
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
  if (kill) { try { t.kill() } catch { /* already gone */ } }
  for (const l of [...downListeners]) { try { l() } catch (e) { console.error('[pty host] down listener threw:', e) } }
  const ended = [...live.values()]
  live.clear()
  for (const { pty } of ended) {
    if (pty.pid === 0) { pty._spawnFailed('the terminal process stopped'); continue }
    if (note) pty._data(HOST_LOST_NOTE)
    pty._exit(-1)
  }
}

/** On the way out: no new terminal opens in the host, and the host goes with the app (its shells with it, quietly). */
export function shutdownPtyHost(): void {
  const t = transport
  if (!t) { dead = true; return }
  goDown(t, { note: false })
}

/** @internal test-only */
export function _resetPtyHostClientForTests(): void {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
  try { transport?.kill() } catch { /* already gone */ }
  transport = null
  spawner = null
  ready = false
  dead = false
  nextKey = 1
  live.clear()
  inputListeners.length = 0
  readyListeners.length = 0
  downListeners.length = 0
}
