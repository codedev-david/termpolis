import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

function channels(files: string[], re: RegExp): Map<string, string> {
  const found = new Map<string, string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], f.replace(/\\/g, '/').split('/src/')[1] ?? f)
    }
  }
  return found
}

// Any `<something>.webContents.send('channel'` in main, from any file — the emitter is not
// always index.ts (autoUpdater.ts sends updater:state), so scanning one file would miss senders
// and this guard would then cry wolf about perfectly good listeners.
const sent = channels(walk(join(SRC, 'main')), /webContents\.send\(\s*'([^']+)'/g)
const listened = channels(walk(join(SRC, 'preload')), /ipcRenderer\.on\(\s*'([^']+)'/g)

describe('IPC channel sync (main <-> preload)', () => {
  it('found channels on both sides (the extraction itself still works)', () => {
    // If a refactor changes how events are sent, both sets go empty and every assertion below
    // passes vacuously. Fail loudly instead of guarding nothing.
    expect(sent.size).toBeGreaterThan(5)
    expect(listened.size).toBeGreaterThan(5)
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
