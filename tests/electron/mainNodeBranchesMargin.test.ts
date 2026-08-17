// Branch-coverage margin for five main-process modules whose remaining gaps are
// all DEFENSIVE arms the happy path never takes:
//
//   src/main/workspaceTrust.ts                      — the lazy `if (!loaded) init()` self-heal on
//                                                     every public entry point, the non-string cwd
//                                                     guards, a store whose `paths` key is not an
//                                                     array, and save() with no store path at all.
//   src/main/metricsLedger.ts                       — the `|| 0` / `|| 'unknown'` field fallbacks a
//                                                     partially-written event hits, an unknown
//                                                     recall path, the reject arm of recordMetric,
//                                                     and both MAX_EVENTS trims.
//   src/main/terminalManager.ts                     — getTerminalCwdAsync end to end (Windows
//                                                     short-circuit, dead pid, probe error, blank
//                                                     probe output, real answer).
//   src/main/transcriptWatchers/claudeCodeWatcher.ts — malformed transcript lines: an unparseable
//                                                     timestamp, non-array / non-object content,
//                                                     a non-string `text`, nameless tool_use,
//                                                     tool_result with no id, and an unknown
//                                                     system subtype.
//   src/main/headroomProxy/wireCompress.ts          — the HTML pre-pass that does NOT shrink, the
//                                                     web-reduced-but-not-elided path, a
//                                                     tool_result whose content is neither string
//                                                     nor array, unknown content-block types, and
//                                                     an image block with no media_type.
//
// Mocking notes: `child_process` is stubbed because terminalManager's cwd probe must not shell out
// on a CI box (and secureFile's icacls call is additionally disabled with TERMPOLIS_SKIP_ACL);
// `node-pty` is stubbed so spawnTerminal can register a pid without a real shell. Everything else
// — fs, os, crypto — is REAL, because the ledger/transcript/trust stores under test are file
// stores and the point is what they do with real bytes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// ---------------------------------------------------------------------------
// Shared module mocks (hoisted)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const ptyProc = {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 9182,
  }
  // Mutable so a workspaceTrust test can point userData at its own temp dir — or make
  // resolving it blow up entirely. Set by that suite's beforeEach; nothing else reads it.
  const userDataDir: { value: string | null } = { value: '' }
  return {
    ptyProc,
    spawn: vi.fn(() => ptyProc),
    userDataDir,
    getPath: vi.fn((_name: string) => {
      if (userDataDir.value === null) throw new Error('userData unavailable')
      return userDataDir.value
    }),
    showMessageBox: vi.fn(),
    exec: vi.fn(),
    execSync: vi.fn(() => Buffer.from('')),
    execFileSync: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: { getPath: h.getPath, isPackaged: false },
  BrowserWindow: class {},
  dialog: { showMessageBox: h.showMessageBox },
}))
vi.mock('node-pty', () => ({ spawn: h.spawn }))
vi.mock('child_process', () => ({
  exec: h.exec,
  execSync: h.execSync,
  execFileSync: h.execFileSync,
  default: { exec: h.exec, execSync: h.execSync, execFileSync: h.execFileSync },
}))

// ---------------------------------------------------------------------------
// src/main/workspaceTrust.ts
// ---------------------------------------------------------------------------

type TrustModule = typeof import('../../src/main/workspaceTrust')

async function freshTrust(): Promise<TrustModule> {
  vi.resetModules()
  return await import('../../src/main/workspaceTrust')
}

describe('workspaceTrust — lazy init and input guards', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-trust-margin-'))
    h.userDataDir.value = dir
    h.getPath.mockClear()
    process.env.TERMPOLIS_SKIP_ACL = '1'
  })

  afterEach(() => {
    h.userDataDir.value = ''
    delete process.env.TERMPOLIS_SKIP_ACL
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('treats a store whose "paths" key is not an array as empty', async () => {
    writeFileSync(join(dir, 'trusted-workspaces.json'), JSON.stringify({ paths: { a: 1 } }))
    const m = await freshTrust()
    m.initWorkspaceTrust(dir)
    expect(m.listTrustedWorkspaces()).toEqual([])
  })

  it('treats a store that parses to null as empty', async () => {
    writeFileSync(join(dir, 'trusted-workspaces.json'), 'null')
    const m = await freshTrust()
    m.initWorkspaceTrust(dir)
    expect(m.listTrustedWorkspaces()).toEqual([])
  })

  it('isWorkspaceTrusted self-initialises from userData when never initialised', async () => {
    const m = await freshTrust()
    expect(m.isWorkspaceTrusted(join(dir, 'never-seen'))).toBe(false)
    expect(h.getPath).toHaveBeenCalledWith('userData')
  })

  it('listTrustedWorkspaces self-initialises and reads the on-disk store', async () => {
    const seeded = join(dir, 'seeded-project')
    writeFileSync(join(dir, 'trusted-workspaces.json'), JSON.stringify({ paths: [seeded] }))
    const m = await freshTrust()
    // No initWorkspaceTrust() call — the getter must load the store itself.
    expect(m.listTrustedWorkspaces()).toEqual([resolve(seeded)])
  })

  it('trustWorkspace self-initialises and persists without an explicit init', async () => {
    const p = join(dir, 'lazy-trusted')
    const m = await freshTrust()
    m.trustWorkspace(p)
    expect(m.isWorkspaceTrusted(p)).toBe(true)
    expect(existsSync(join(dir, 'trusted-workspaces.json'))).toBe(true)
  })

  it('revokeWorkspaceTrust self-initialises and drops a path loaded from disk', async () => {
    const p = join(dir, 'seeded-then-revoked')
    writeFileSync(join(dir, 'trusted-workspaces.json'), JSON.stringify({ paths: [p] }))
    const m = await freshTrust()
    // No initWorkspaceTrust() call — revoke must load the store, then remove.
    m.revokeWorkspaceTrust(p)
    expect(m.listTrustedWorkspaces()).toEqual([])
  })

  it('ignores empty / non-string cwds on trust and revoke', async () => {
    const m = await freshTrust()
    m.initWorkspaceTrust(dir)
    const keep = join(dir, 'keep-me')
    m.trustWorkspace(keep)

    m.trustWorkspace('')
    m.trustWorkspace(undefined as unknown as string)
    m.trustWorkspace(42 as unknown as string)
    m.revokeWorkspaceTrust('')
    m.revokeWorkspaceTrust(null as unknown as string)
    m.revokeWorkspaceTrust(7 as unknown as string)

    expect(m.listTrustedWorkspaces()).toEqual([resolve(keep)])
  })

  it('keeps trust in memory when the store path could never be resolved', async () => {
    const m = await freshTrust()
    h.userDataDir.value = null // app.getPath('userData') now throws
    expect(() => m.initWorkspaceTrust()).toThrow(/userData unavailable/)
    h.userDataDir.value = dir

    // init() marked itself loaded in its `finally`, so no second attempt happens and
    // save() has no path to write to — trust must still work for this session.
    const p = join(dir, 'memory-only')
    m.trustWorkspace(p)
    expect(m.isWorkspaceTrusted(p)).toBe(true)
    expect(existsSync(join(dir, 'trusted-workspaces.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// src/main/metricsLedger.ts
// ---------------------------------------------------------------------------

import {
  summarizeMetrics,
  initMetrics,
  recordMetric,
  metricsSummary,
  metricsEventCount,
  _resetMetricsForTests,
  type MetricEvent,
} from '../../src/main/metricsLedger'

const MAX_EVENTS = 20_000

describe('metricsLedger — missing-field fallbacks and the hot-window cap', () => {
  let dir: string

  beforeEach(() => {
    _resetMetricsForTests()
    dir = mkdtempSync(join(tmpdir(), 'tp-metrics-margin-'))
  })

  afterEach(() => {
    _resetMetricsForTests()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('counts a zeroed recall without charging latency, and ignores an unknown path', () => {
    const s = summarizeMetrics(
      [{ t: 'recall', ts: 1, hits: 0, topScore: 0, ms: 0, path: 'graph' as unknown as 'vector' }],
      100,
    )
    expect(s.recalls).toBe(1)
    expect(s.avgLatencyMs).toBe(0)
    expect(s.avgHits).toBe(0)
    expect(s.byPath).toEqual({ vector: 0, keyword: 0, cache: 0 })
  })

  it('counts an inject that carried no tokens and a reflect that learned nothing', () => {
    const s = summarizeMetrics(
      [
        { t: 'inject', ts: 1, tokens: 0 },
        { t: 'reflect', ts: 2, lessons: 0 },
      ],
      100,
    )
    expect(s.injects).toBe(1)
    expect(s.tokensInjected).toBe(0)
    expect(s.lessonsLearned).toBe(0)
  })

  it('files a cross_recall with blank author/reader under "unknown" and scores no teaching', () => {
    const s = summarizeMetrics(
      [{ t: 'cross_recall', ts: 1, author: '', reader: '' }],
      100,
    )
    expect(s.teachingMatrix).toEqual({ unknown: { unknown: 1 } })
    expect(s.crossAgentRecalls).toBe(0)
  })

  it('rejects a null event and an event with an unknown kind', () => {
    initMetrics(dir)
    expect(metricsEventCount()).toBe(0)
    recordMetric(null as unknown as MetricEvent)
    recordMetric({ t: 'not-a-kind', ts: 1 } as unknown as MetricEvent)
    expect(metricsEventCount()).toBe(0)
    recordMetric({ t: 'write', ts: 1, ok: true })
    expect(metricsEventCount()).toBe(1)
  })

  it('trims an oversized ledger on load and evicts the oldest event on the next record', () => {
    const line = JSON.stringify({ t: 'inject', ts: 1, tokens: 1 })
    writeFileSync(
      join(dir, 'memory-metrics.jsonl'),
      `${Array.from({ length: MAX_EVENTS + 1 }, () => line).join('\n')}\n`,
    )

    initMetrics(dir)
    expect(metricsEventCount()).toBe(MAX_EVENTS)
    expect(metricsSummary(100).injects).toBe(MAX_EVENTS)

    recordMetric({ t: 'write', ts: 2, ok: true })
    // Still capped: the new write pushed the oldest inject out of the hot window.
    expect(metricsEventCount()).toBe(MAX_EVENTS)
    const s = metricsSummary(100)
    expect(s.writes).toBe(1)
    expect(s.injects).toBe(MAX_EVENTS - 1)
  })
})

// ---------------------------------------------------------------------------
// src/main/terminalManager.ts
// ---------------------------------------------------------------------------

import {
  spawnTerminal,
  killTerminal,
  getTerminalCwdAsync,
} from '../../src/main/terminalManager'

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void

describe('terminalManager — async cwd probe', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    h.exec.mockReset()
    h.spawn.mockClear()
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
  }

  function openTerminal(id: string): void {
    spawnTerminal(id, '/bin/bash', tmpdir(), () => {})
  }

  it('returns null on Windows without probing at all', async () => {
    setPlatform('win32')
    await expect(getTerminalCwdAsync('anything')).resolves.toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('returns null for a terminal that was never opened', async () => {
    setPlatform('linux')
    await expect(getTerminalCwdAsync('no-such-terminal')).resolves.toBeNull()
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('resolves the probed directory for a live terminal', async () => {
    setPlatform('linux')
    h.exec.mockImplementation((_cmd: string, _opts: unknown, cb: ExecCallback) => {
      cb(null, '/home/testuser/repo\n', '')
    })
    openTerminal('t-live')
    try {
      await expect(getTerminalCwdAsync('t-live')).resolves.toBe('/home/testuser/repo')
      const cmd = String(h.exec.mock.calls[0][0])
      expect(cmd).toContain(String(h.ptyProc.pid))
    } finally {
      killTerminal('t-live')
    }
  })

  it('resolves null when the probe command errors', async () => {
    setPlatform('linux')
    h.exec.mockImplementation((_cmd: string, _opts: unknown, cb: ExecCallback) => {
      cb(new Error('lsof: not found'), 'ignored output', '')
    })
    openTerminal('t-err')
    try {
      await expect(getTerminalCwdAsync('t-err')).resolves.toBeNull()
    } finally {
      killTerminal('t-err')
    }
  })

  it('resolves null when the probe prints only whitespace', async () => {
    setPlatform('linux')
    h.exec.mockImplementation((_cmd: string, _opts: unknown, cb: ExecCallback) => {
      cb(null, '   \n', '')
    })
    openTerminal('t-blank')
    try {
      await expect(getTerminalCwdAsync('t-blank')).resolves.toBeNull()
    } finally {
      killTerminal('t-blank')
    }
  })
})

// ---------------------------------------------------------------------------
// src/main/transcriptWatchers/claudeCodeWatcher.ts
// ---------------------------------------------------------------------------

import { processClaudeLine } from '../../src/main/transcriptWatchers/claudeCodeWatcher'
import {
  initEventBus,
  query,
  _resetForTests as resetEventBus,
} from '../../src/main/agentEventBus'

describe('claudeCodeWatcher — malformed transcript entries', () => {
  let dir: string

  beforeEach(() => {
    resetEventBus()
    dir = mkdtempSync(join(tmpdir(), 'tp-ccw-margin-'))
    initEventBus(dir)
  })

  afterEach(() => {
    resetEventBus()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('falls back to wall-clock time when the timestamp is unparseable', () => {
    const before = Date.now()
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: 'yesterday-ish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
      }),
      'term-ts',
    )
    const evs = query({ terminalId: 'term-ts' })
    expect(evs).toHaveLength(1)
    expect(evs[0].ts).toBeGreaterThanOrEqual(before)
    expect(evs[0].ts).toBeLessThanOrEqual(Date.now())
  })

  it('publishes nothing when message content is an object rather than an array', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: { text: 'not an array' } },
      }),
      'term-obj',
    )
    expect(query({ terminalId: 'term-obj' })).toHaveLength(0)
  })

  it('publishes nothing when the only text block carries a non-string text', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 12345 }] },
      }),
      'term-nonstr',
    )
    expect(query({ terminalId: 'term-nonstr' })).toHaveLength(0)
  })

  it('skips null and primitive content blocks and still reads the good one', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [null, 'a bare string', 7, { type: 'text', text: 'the real text' }],
        },
      }),
      'term-mixed',
    )
    const evs = query({ terminalId: 'term-mixed' })
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('message')
    expect(evs[0].summary).toBe('assistant: the real text')
  })

  it('labels a nameless tool_use "unknown" and a tool_result with no id as empty', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', input: { a: 1 } },
            { type: 'tool_result', is_error: true },
          ],
        },
      }),
      'term-tools',
    )
    const evs = query({ terminalId: 'term-tools' })
    const call = evs.find((e) => e.kind === 'tool_call')
    const result = evs.find((e) => e.kind === 'tool_result')
    expect(call?.summary).toBe('unknown')
    expect((call?.payload as { tool: string }).tool).toBe('unknown')
    expect(result?.summary).toBe('tool error')
    expect((result?.payload as { toolUseId: string }).toolUseId).toBe('')
  })

  it('labels a successful tool_result "tool result"', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }],
        },
      }),
      'term-okresult',
    )
    const evs = query({ terminalId: 'term-okresult' })
    expect(evs).toHaveLength(1)
    expect(evs[0].summary).toBe('tool result')
  })

  it('omits the cache figure from the token summary when nothing was read from cache', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 0 },
        },
      }),
      'term-nocache',
    )
    const evs = query({ terminalId: 'term-nocache' })
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('token_update')
    expect(evs[0].summary).toBe('in:11 out:3')
  })

  it('includes the cache figure when the turn did read from cache', () => {
    processClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 900 },
        },
      }),
      'term-cache',
    )
    const evs = query({ terminalId: 'term-cache' })
    expect(evs).toHaveLength(1)
    expect(evs[0].summary).toBe('in:11 out:3 cache:900')
  })

  it('ignores a system entry whose subtype is not a compact boundary', () => {
    processClaudeLine(
      JSON.stringify({ type: 'system', subtype: 'some_other_notice' }),
      'term-sys',
    )
    expect(query({ terminalId: 'term-sys' })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// src/main/headroomProxy/wireCompress.ts
// ---------------------------------------------------------------------------

import {
  compactToolText,
  rewriteMessagesBody,
  windowForMode,
  type ImageCompressor,
} from '../../src/main/headroomProxy/wireCompress'

/** The default (aggressive) compaction floor — a block has to clear it to reach the pre-pass. */
const FLOOR = windowForMode('aggressive')!.floorChars

/** A body that round-trips byte-identically through JSON — rewriteMessagesBody requires it. */
function messagesBody(content: unknown[]): string {
  return JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content }] })
}

describe('wireCompress — HTML pre-pass and odd content blocks', () => {
  it('forwards markup-looking text unchanged when the HTML pre-pass cannot shrink it', () => {
    // 120 unclosed "<div …" tokens: looksLikeHtml says yes, but there is not a single ">" for
    // compactWeb to strip and no whitespace to collapse, so the reduction is a no-op.
    const text = Array.from({ length: 120 }, (_, i) => `<div data-row-${i}`).join(' ')
    expect(text.length).toBeGreaterThan(FLOOR)

    const res = compactToolText(text)
    expect(res.text).toBe(text)
    expect(res.stash).toBeUndefined()
  })

  it('stashes the original when HTML was reduced even though nothing was elided', () => {
    const text =
      '<!doctype html><html><head><title>Docs</title></head><body>' +
      // Long paragraphs rather than many: the block has to clear the floor without handing the
      // head/tail window more than 18 lines, or it would elide and stop testing the !elided arm.
      // Markup-DENSE on purpose. compactToolText refuses to hand back a block bigger than it was
      // given, and the retrieve_full notice costs ~110 chars, so a fixture whose only markup is
      // a bare <p> saves less than the notice and is legitimately returned untouched — which
      // would test the opposite branch from the one this case is named for.
      Array.from(
        { length: 12 },
        (_, i) => `<div class="doc-section"><p><span class="lead">Paragraph number ${i}</span>` +
          ' with several readable words in it, padded out far' +
          ' enough that the whole document clears the compaction floor on its own.</p></div>',
      ).join('') +
      '</body></html>'
    expect(text.length).toBeGreaterThan(FLOOR)

    const res = compactToolText(text)
    expect(res.text.length).toBeLessThan(text.length)
    expect(res.text).toContain('Paragraph number 0')
    expect(res.text).not.toContain('<p>')
    // Content was hidden (the markup), so a retrieve token must be offered.
    expect(res.text).toContain('retrieve_full')
    expect(res.stash?.original).toBe(text)
    expect(res.text).toContain(res.stash!.token)
  })

  it('returns the original untouched when the retrieve notice would cost more than the pre-pass saved', () => {
    // Markup-light: twelve bare <p> wrappers strip to roughly what the ~110-char retrieve_full
    // notice costs. Handing back the "compressed" block anyway would put a LARGER block into the
    // cached prefix and re-read it at that size every later turn — a pure loss, and the exact
    // inverse of what this layer is for. Shrink-only has to hold after the notice, not before.
    const text =
      '<!doctype html><html><head><title>Docs</title></head><body>' +
      Array.from(
        { length: 12 },
        (_, i) => `<p>Paragraph number ${i} with several readable words in it, padded out far` +
          ' enough that the whole document clears the compaction floor on its own.</p>',
      ).join('') +
      '</body></html>'
    expect(text.length).toBeGreaterThan(FLOOR)

    const res = compactToolText(text)
    expect(res.text).toBe(text)
    expect(res.stash).toBeUndefined()
  })

  it('leaves a tool_result whose content is neither string nor array untouched', () => {
    const raw = messagesBody([{ type: 'tool_result', tool_use_id: 'tu_1', content: 42 }])
    const res = rewriteMessagesBody(raw)
    expect(res.changed).toBe(false)
    expect(res.body).toBe(raw)
    expect(res.stats.trBlocks).toBe(0)
  })

  it('ignores content blocks it does not understand', () => {
    const raw = messagesBody([
      { type: 'thinking', thinking: 'x'.repeat(600) },
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [null, { type: 'redacted_thinking', data: 'y'.repeat(600) }],
      },
    ])
    const res = rewriteMessagesBody(raw)
    expect(res.changed).toBe(false)
    expect(res.body).toBe(raw)
  })

  it('defaults an image block with no media_type to image/png', () => {
    const data = 'A'.repeat(200)
    const compressImage = vi.fn(() => ({ data: 'B'.repeat(50), mediaType: 'image/webp', changed: true })) as ImageCompressor
    const raw = messagesBody([{ type: 'image', source: { type: 'base64', data } }])

    const res = rewriteMessagesBody(raw, { compressImage })
    expect(compressImage).toHaveBeenCalledWith(data, 'image/png')
    expect(res.changed).toBe(true)
    expect(res.stats.images).toBe(1)
    const out = JSON.parse(res.body) as { messages: Array<{ content: Array<{ source: { data: string; media_type: string } }> }> }
    expect(out.messages[0].content[0].source.data).toBe('B'.repeat(50))
    expect(out.messages[0].content[0].source.media_type).toBe('image/webp')
  })

  it('keeps an earlier text change when a nested image block refuses to compress', () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i} of a long tool result`).join('\n')
    const compressImage = vi.fn(() => ({ data: '', mediaType: '', changed: false })) as ImageCompressor
    const raw = messagesBody([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [
          { type: 'text', text: long },
          // Not base64 — compressImageBlock bails before ever calling the compressor.
          { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
        ],
      },
    ])

    const res = rewriteMessagesBody(raw, { compressImage })
    expect(res.changed).toBe(true)
    expect(res.stats.images).toBe(0)
    expect(compressImage).not.toHaveBeenCalled()
    const out = JSON.parse(res.body) as { messages: Array<{ content: Array<{ content: Array<{ text?: string }> }> }> }
    expect(out.messages[0].content[0].content[0].text).toContain('lines elided')
  })
})
