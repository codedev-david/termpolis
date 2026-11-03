// AC1 guard: no NEW synchronous file call and no NEW process creation can slip into src/main.
//
// Typing in Termpolis lags when the Electron main thread is busy, because node-pty runs inside it and
// so does every keystroke and every echo. A synchronous file call there has been measured at up to
// 1.5 s and a spawn at 0.1-0.3 s on a busy Windows laptop (Defender inspects each one and its queue
// grows with the load), and a burst freezes every terminal for seconds. So this test scans src/main
// with the TypeScript parser (tests/helpers/mainThreadScan.ts), groups every
//   * `*Sync(` call (readFileSync, existsSync, execSync, a project function named flushHistorySync...)
//   * child-process creation (spawn, exec, execFile, fork and their Sync forms; electron's
//     utilityProcess.fork; node-pty's spawn)
// by (file, enclosing function), and compares the groups with tests/electron/main-thread-allowlist.json:
//   * a group that is not on the list FAILS (move the work off the main thread, or, only for start-up,
//     shutdown or a click, add a line with a tag and a one-line reason);
//   * a listed group that is gone, or has fewer calls than listed, FAILS (so the list only shrinks by
//     fixing, and an edit that removes a call must say so);
//   * a tag outside the fixed set, or a missing reason, FAILS.
// Everything here is a COUNT of call sites. No clock, no wall-clock ratio.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanMainThreadSites, scanFile, groupSites, type Site } from '../helpers/mainThreadScan'

const ROOT = join(__dirname, '..', '..')

interface Entry { site: string; calls: Record<string, number>; tag: string; reason: string }
interface Allowlist { tags: Record<string, string>; sites: Entry[] }

const allowlist: Allowlist = JSON.parse(readFileSync(join(__dirname, 'main-thread-allowlist.json'), 'utf8'))

const callsLabel = (calls: Record<string, number>): string =>
  Object.entries(calls).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}${v > 1 ? ` x${v}` : ''}`).join(', ')

/** The line to paste into the allowlist for a group that is not on it. */
function lineFor(key: string, calls: Record<string, number>): string {
  const sorted: Record<string, number> = {}
  for (const k of Object.keys(calls).sort()) sorted[k] = calls[k]
  return JSON.stringify({ site: key, calls: sorted, tag: '<startup|shutdown|user-action|...>', reason: '<one line: why a click or start-up, never typing>' })
}

function scanSource(source: string, file = 'x.ts'): Site[] {
  const dir = mkdtempSync(join(tmpdir(), 'mtscan-'))
  try {
    writeFileSync(join(dir, file), source)
    return scanFile(join(dir, file), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const callNames = (sites: Site[]): string[] => sites.map((s) => `${s.kind}:${s.call}`)

describe('the scanner itself (synthetic sources)', () => {
  it('finds *Sync calls however fs was imported', () => {
    const sites = scanSource(`
      import { existsSync, readFileSync as rf } from 'fs'
      import * as fs from 'fs'
      import fsDefault from 'node:fs'
      const lazy = require('fs')
      const { readdirSync: ls } = require('node:fs')
      export function a() { existsSync('x'); rf('y'); fs.statSync('z'); fsDefault.mkdirSync('d'); lazy.writeFileSync('f', 'g'); require('fs').unlinkSync('u'); ls('.') }
    `)
    expect(callNames(sites).sort()).toEqual(['sync:existsSync', 'sync:mkdirSync', 'sync:readFileSync', 'sync:readdirSync', 'sync:statSync', 'sync:unlinkSync', 'sync:writeFileSync'].sort())
  })

  it('counts a project function named like a Sync call, and nothing that merely contains the word', () => {
    const sites = scanSource(`
      function flushHistorySync() {}
      export function a() { flushHistorySync(); const async1 = 1; syncing(); Sync() }
    `)
    expect(callNames(sites)).toEqual(['sync:flushHistorySync'])
  })

  it('finds a child process however child_process was bound, and ignores a RegExp exec', () => {
    const sites = scanSource(`
      import { spawn, execFile as ef } from 'child_process'
      import * as cp from 'node:child_process'
      import { promisify } from 'util'
      const { execSync } = require('child_process')
      const run = promisify(ef)
      export function a() { spawn('a'); cp.exec('b'); execSync('c'); cp.fork('d'); run('e'); require('child_process').spawnSync('f') }
      export function b() { /x/.exec('y'); const re = /z/g; re.exec('w'); 'abc'.match(re) }
    `)
    // execSync and spawnSync end in Sync, so they are listed as synchronous calls; execFile is seen twice:
    // passed to promisify as a value, and called through its alias `run`.
    expect(callNames(sites).sort()).toEqual(['spawn:exec', 'spawn:execFile', 'spawn:execFile(ref)', 'spawn:fork', 'spawn:spawn', 'sync:execSync', 'sync:spawnSync'].sort())
    expect(sites.some((s) => s.fn === 'b')).toBe(false) // the RegExp exec in b() is not a process
  })

  it('finds electron utilityProcess.fork, node-pty spawn, and a spawn function passed as a value', () => {
    const sites = scanSource(`
      import { utilityProcess } from 'electron'
      import * as pty from 'node-pty'
      import { spawn } from 'child_process'
      export function a() { utilityProcess.fork('x'); pty.spawn('sh', [], {}) }
      export function b(opts: { spawnImpl: typeof spawn } = { spawnImpl: spawn }) { return opts }
    `)
    expect(callNames(sites).sort()).toEqual(['spawn:pty.spawn', 'spawn:spawn(ref)', 'spawn:utilityProcess.fork'].sort())
  })

  it('does not mistake a method called fork or spawn on something else for a process', () => {
    const sites = scanSource(`
      const thing = { fork() {}, spawn() {} }
      export function a() { thing.fork(); thing.spawn(); [1].map(x => x) }
    `)
    expect(sites).toEqual([])
  })

  it('names a callback after the call it is passed to, so moving code does not move the entry', () => {
    const sites = scanSource(`
      import { existsSync } from 'fs'
      declare const ipcMain: any
      export function setup() {
        ipcMain.handle('terminal:write', () => { existsSync('a') })
        ipcMain.handle('terminal:kill', () => { existsSync('b') })
        setInterval(() => { existsSync('c') }, 1)
      }
    `)
    expect(sites.map((s) => s.fn)).toEqual([
      "setup > handle('terminal:write')",
      "setup > handle('terminal:kill')",
      'setup > setInterval',
    ])
  })
})

describe('src/main against the allowlist', () => {
  const sites = scanMainThreadSites(ROOT)
  const groups = groupSites(sites)
  const listed = new Map<string, Entry>()
  for (const e of allowlist.sites) listed.set(e.site, e)

  it('reads the whole main-process source tree', () => {
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThan(30)
    expect(sites.some((s) => s.file === 'src/main/terminalManager.ts' && s.call === 'pty.spawn')).toBe(true)
    expect(sites.some((s) => s.file === 'src/main/procHost.ts' && s.call === 'execFile')).toBe(true)
  })

  it('has no duplicate lines', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const e of allowlist.sites) { if (seen.has(e.site)) dupes.push(e.site); seen.add(e.site) }
    expect(dupes).toEqual([])
  })

  it('lists every site: a new synchronous file call or process creation fails here', () => {
    const missing: string[] = []
    for (const [key, g] of groups) {
      const e = listed.get(key)
      if (!e) { missing.push(`NEW  ${key}  [${callsLabel(g.calls)}]  lines ${Object.values(g.lines).flat().sort((a, b) => a - b).join(',')}\n       add: ${lineFor(key, g.calls)}`); continue }
      for (const [call, n] of Object.entries(g.calls)) {
        const allowed = e.calls[call] ?? 0
        if (n > allowed) missing.push(`MORE ${key}: ${call} x${n}, allowlist says x${allowed}  (lines ${g.lines[call].join(',')})`)
      }
    }
    expect(missing, 'Do not add a synchronous call or a spawn to the Electron main thread: it freezes every terminal. Use the proc host (procClient), a worker, or src/main/offMainFiles.ts. Only start-up, shutdown and a click may be listed.').toEqual([])
  })

  it('lists nothing that is gone: a fixed site must leave the list', () => {
    const stale: string[] = []
    for (const e of allowlist.sites) {
      const g = groups.get(e.site)
      if (!g) { stale.push(`GONE ${e.site}  (remove its line)`); continue }
      for (const [call, n] of Object.entries(e.calls)) {
        const have = g.calls[call] ?? 0
        if (have < n) stale.push(`FEWER ${e.site}: ${call} x${have}, allowlist says x${n}  (lower or remove it)`)
      }
    }
    expect(stale).toEqual([])
  })

  it('gives every line a known tag and a one-line reason', () => {
    const problems: string[] = []
    for (const e of allowlist.sites) {
      if (!(e.tag in allowlist.tags)) problems.push(`${e.site}: unknown tag "${e.tag}"`)
      if (typeof e.reason !== 'string' || e.reason.trim().length < 12) problems.push(`${e.site}: reason is missing or too short`)
      else if (/[\r\n]/.test(e.reason)) problems.push(`${e.site}: reason must be one line`)
      if (!e.calls || Object.keys(e.calls).length === 0) problems.push(`${e.site}: no calls listed`)
    }
    expect(problems).toEqual([])
  })

  it('keeps the lines sorted, so two branches that edit it merge cleanly', () => {
    const keys = allowlist.sites.map((e) => e.site)
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })
})
