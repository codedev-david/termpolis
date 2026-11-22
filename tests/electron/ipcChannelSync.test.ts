import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ACCOUNTS_IPC } from '../../src/shared/agentAccounts'

/**
 * Anti-drift guard for the main <-> preload IPC seam.
 *
 * v1.25.2 shipped a bug this test exists to make impossible: main was changed to emit
 * `terminal:secret-observed`, but preload was left listening on the old
 * `terminal:secrets-redacted`. Nothing failed. TypeScript cannot see across the seam — channel
 * names are plain strings on both sides — and the runtime is perfectly happy to send an event
 * nobody hears. The only symptom was that the leak banner never appeared, i.e. the failure mode
 * was *silence in exactly the case the feature exists for*.
 *
 * So: every channel main sends must have a listener in preload, and every listener in preload
 * must have a sender in main. Both directions matter. A dead bridge means a feature that
 * silently never fires; a ghost listener means dead code that reads as if a feature is wired.
 */

const SRC = resolve(__dirname, '../../src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

// A source file's text with its line breaks as \n. A Windows checkout (core.autocrlf) gives the runner CRLF files, and
// the patterns below spell line breaks as \n: read raw, `\{\n` never matches `{\r\n` there and the guard reports a seam
// that is wired as broken. Every file this guard reads goes through here.
const lf = (text: string): string => text.replace(/\r\n?/g, '\n')
const source = (file: string): string => lf(readFileSync(file, 'utf8'))

function channels(files: string[], re: RegExp): Map<string, string> {
  const found = new Map<string, string>()
  for (const f of files) {
    const src = source(f)
    for (const m of src.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], f.replace(/\\/g, '/').split('/src/')[1] ?? f)
    }
  }
  return found
}

// Any `<something>.webContents.send('channel'` in main, from any file — the emitter is not
// always index.ts (autoUpdater.ts sends updater:state), so scanning one file would miss senders
// and this guard would then cry wolf about perfectly good listeners.
// postMessage too: the direct typing line's port goes that way (directTyping.ts).
const sent = channels(walk(join(SRC, 'main')), /webContents\.(?:send|postMessage)\(\s*'([^']+)'/g)
const listened = channels(walk(join(SRC, 'preload')), /ipcRenderer\.on\(\s*'([^']+)'/g)

// The accounts code sends its events under the channel names main and the renderer share
// (deps.send(ACCOUNTS_IPC.terminalAccount, …) in accountsIpc.ts), through the `send` index.ts
// gives registerAccountsIpc. Once that `send` is webContents.send, each counts as sent under the
// name it stands for.
const indexSource = source(join(SRC, 'main', 'index.ts'))
const accountsReach = (text: string): boolean => {
  const registration = /registerAccountsIpc\(ipcMain, \{([\s\S]*?)\n\}\)/.exec(lf(text))
  return !!registration && /\n\s*send: \(channel, payload\) => \{ mainWindow\?\.webContents\.send\(channel, payload\) \},/.test(registration[1])
}
const accountsSendReachesRenderer = accountsReach(indexSource)
if (accountsSendReachesRenderer) {
  for (const [key, file] of channels(walk(join(SRC, 'main')), /\bsend(?:\?\.)?\(\s*ACCOUNTS_IPC\.(\w+)/g)) {
    const channel = (ACCOUNTS_IPC as Record<string, string>)[key]
    if (channel && !sent.has(channel)) sent.set(channel, file)
  }
}

// The Lumopolis export sends its progress the same way (deps.send('world:export-progress', …) in world/exportIpc.ts),
// through the `send` index.ts gives registerWorldExportIpc: once that `send` is webContents.send on a live window,
// each channel exportIpc.ts sends counts as sent.
const exportReach = (text: string): boolean => {
  const registration = /registerWorldExportIpc\(ipcMain, \{([\s\S]*?)\n\}\)/.exec(lf(text))
  return !!registration &&
    /\n\s*send: \(channel, payload\) => \{\n\s*const win = mainWindow\n\s*if \(win && !win\.isDestroyed\(\)\) win\.webContents\.send\(channel, payload\)\n\s*\},/.test(registration[1])
}
const exportSendReachesRenderer = exportReach(indexSource)
if (exportSendReachesRenderer) {
  for (const [channel, file] of channels([join(SRC, 'main', 'world', 'exportIpc.ts')], /\bdeps\.send\(\s*'([^']+)'/g)) {
    if (!sent.has(channel)) sent.set(channel, file)
  }
}

describe('IPC channel sync (main <-> preload)', () => {
  it('found channels on both sides (the extraction itself still works)', () => {
    // If a refactor changes how events are sent, both sets go empty and every assertion below
    // passes vacuously. Fail loudly instead of guarding nothing.
    expect(sent.size).toBeGreaterThan(5)
    expect(listened.size).toBeGreaterThan(5)
  })

  it('sends the accounts events to the renderer: index.ts gives registerAccountsIpc webContents.send', () => {
    expect(accountsSendReachesRenderer).toBe(true)
    expect(sent.get(ACCOUNTS_IPC.terminalAccount)).toBe('main/accountsIpc.ts')
  })

  it('sends the export progress to the renderer: index.ts gives registerWorldExportIpc webContents.send', () => {
    expect(exportSendReachesRenderer).toBe(true)
    expect(sent.get('world:export-progress')).toBe('main/world/exportIpc.ts')
  })

  it('reads index.ts the same whatever its line breaks (a Windows checkout gives CRLF)', () => {
    const asCrlf = indexSource.replace(/\n/g, '\r\n')
    expect(asCrlf).toContain('\r\n') // the copy really is CRLF
    expect(exportReach(indexSource)).toBe(true)
    expect(exportReach(asCrlf)).toBe(true)
    expect(accountsReach(indexSource)).toBe(true)
    expect(accountsReach(asCrlf)).toBe(true)
  })

  it('every channel main sends has a listener in preload (no dead bridges)', () => {
    const dead = [...sent.keys()].filter((c) => !listened.has(c)).map((c) => `${c}  (sent from ${sent.get(c)})`)
    expect(dead).toEqual([])
  })

  it('every channel preload listens on is actually sent by main (no ghost listeners)', () => {
    const ghosts = [...listened.keys()]
      .filter((c) => !sent.has(c))
      .map((c) => `${c}  (listened in ${listened.get(c)})`)
    expect(ghosts).toEqual([])
  })

  it('the secret-sent channel specifically is wired end to end', () => {
    // The regression that motivated the file. Named explicitly so a failure points straight at
    // the feature rather than at a generic set-difference.
    expect(sent.has('terminal:secret-observed')).toBe(true)
    expect(listened.has('terminal:secret-observed')).toBe(true)
    expect(sent.has('terminal:secrets-redacted')).toBe(false)
    expect(listened.has('terminal:secrets-redacted')).toBe(false)
  })
})
