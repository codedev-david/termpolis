// Attaching a transcript watcher must NOT replay the transcript.
//
// tailFile opens at byte 0 by default and calls tick() SYNCHRONOUSLY at attach (baseWatcher.ts:129).
// The three watchers never passed `startAtEnd`, so opening an agent terminal replayed the ENTIRE
// session file through the event bus, on the main thread, right there in the attach call. On David's
// machine the largest Claude transcript for one cwd is 77 MB / 53,023 lines, and every replayed line
// cost an appendFileSync + a statSync (639 µs, measured) plus a webContents.send and a memoryWrite
// RPC. At the bus's own 500-events/sec limiter that is ~319 ms of dead main thread PER SECOND for
// about a minute — and the main thread is the one that echoes your keystrokes.
//
// That is the "typing lags for the first few minutes after opening an AI terminal, then warms up"
// complaint, precisely: "warms up" was the replay finally reaching EOF. The limiter also dropped the
// overflow, so the activity feed lost real events during the flood it was causing.
//
// History is not this path's job and never was: runConversationIngest (driven by startIndexer, in
// bounded 250-chunk bursts, explicitly "so a first index over months of history can't peg the main
// thread") owns the backfill, and it is idempotent.
//
// These tests are the guard. Every watcher suite in the repo passed BOTH with and without
// `startAtEnd`, so nothing stopped anyone deleting it and bringing the flood back in silence.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpHome: string
let origHome: string | undefined
let origUserProfile: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-noreplay-'))
  origHome = process.env.HOME
  origUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  vi.resetModules()
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  vi.resetModules()
})

/** A Claude transcript line that DOES publish an event. If this ever stops producing one, the
 *  no-replay assertions below would pass vacuously — so the first test proves it produces one. */
const claudeLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-07-14T12:00:00Z' })

/** The watcher and the bus must come from the SAME module registry — vi.resetModules() in
 *  beforeEach means a static import would hand us a different bus instance than the watcher writes
 *  to, and every assertion would read an empty ring and pass for the wrong reason. */
async function loadClaude() {
  const bus = await import('../../src/main/agentEventBus')
  const watcher = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
  bus._resetForTests()
  return { bus, watcher }
}

function seedClaudeSession(mangled: string, lines: string[]): string {
  const dir = path.join(tmpHome, '.claude', 'projects', mangled)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '')
  return file
}

describe('transcript watchers do not replay history on attach', () => {
  // Guards the guard. If a seeded line stopped producing an event, "no events after attach" would
  // be true no matter what the watcher did, and this whole file would be theatre.
  it('the seeded transcript line really does publish an event when processed', async () => {
    const { bus, watcher } = await loadClaude()
    watcher.processClaudeLine(claudeLine('hello there'), 't1')
    expect(bus.query({ kind: 'message' })).toHaveLength(1)
  })

  it('attaching to an EXISTING transcript publishes nothing — the history is not replayed', async () => {
    const { bus, watcher } = await loadClaude()
    const cwd = '/test-no-replay'
    seedClaudeSession(watcher.mangleCwd(cwd), [claudeLine('one'), claudeLine('two'), claudeLine('three')])

    const handle = watcher.attachClaudeCodeWatcher('t1', cwd)
    expect(handle).not.toBeNull()

    // tailFile ticks synchronously inside attach, so by here the replay would already have happened.
    expect(bus.query()).toHaveLength(0)
    handle?.stop()
  })

  it('still tails LIVE lines appended after attach — the fix must not deafen the watcher', async () => {
    const { bus, watcher } = await loadClaude()
    const cwd = '/test-live'
    const file = seedClaudeSession(watcher.mangleCwd(cwd), [claudeLine('old, must be ignored')])

    const handle = watcher.attachClaudeCodeWatcher('t1', cwd)
    expect(bus.query()).toHaveLength(0)          // the seeded line stays unread...

    fs.appendFileSync(file, claudeLine('brand new') + '\n')
    // fs.watch fires quickly; the 1500 ms poller is the backstop. Wait for the live event.
    await vi.waitFor(() => expect(bus.query({ kind: 'message' })).toHaveLength(1), { timeout: 5000, interval: 50 })

    const events = bus.query({ kind: 'message' })
    expect(events[0].summary).toContain('brand new')
    expect(events[0].summary).not.toContain('must be ignored')
    handle?.stop()
  })
})

describe('the codex and gemini watchers attach the same way', () => {
  it('codex does not replay its session file on attach', async () => {
    const bus = await import('../../src/main/agentEventBus')
    const { attachCodexWatcher } = await import('../../src/main/transcriptWatchers/codexWatcher')
    bus._resetForTests()

    const dir = path.join(tmpHome, '.codex', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'rollout-2026-07-14.jsonl'),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }) + '\n',
    )

    const handle = attachCodexWatcher('t1', '/x')
    expect(bus.query()).toHaveLength(0)
    handle?.stop()
  })

  it('gemini does not replay its session file on attach', async () => {
    const bus = await import('../../src/main/agentEventBus')
    const { attachGeminiWatcher } = await import('../../src/main/transcriptWatchers/geminiWatcher')
    bus._resetForTests()

    const dir = path.join(tmpHome, '.gemini', 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'logs.json'), JSON.stringify({ role: 'user', parts: [{ text: 'hi' }] }) + '\n')

    const handle = attachGeminiWatcher('t1', '/x')
    expect(bus.query()).toHaveLength(0)
    handle?.stop()
  })
})
