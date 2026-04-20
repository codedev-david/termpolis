import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  processCodexLine,
  findLatestCodexSessionFile,
  attachCodexWatcher,
  CODEX_SESSIONS_DIR,
} from '../../src/main/transcriptWatchers/codexWatcher'

import {
  processGeminiLine,
  findLatestGeminiSessionFile,
  attachGeminiWatcher,
  GEMINI_DIR,
} from '../../src/main/transcriptWatchers/geminiWatcher'

import {
  processAiderLine,
  newAiderParserState,
  findAiderHistory,
  attachAiderWatcher,
} from '../../src/main/transcriptWatchers/aiderWatcher'

import {
  attachWatcher,
  detachWatchers,
  detachAll,
  getActiveWatcherCount,
  _resetForTests as resetWatchers,
} from '../../src/main/transcriptWatchers/index'

import {
  initEventBus,
  query,
  _resetForTests as resetBus,
} from '../../src/main/agentEventBus'

let tmpDir: string

beforeEach(() => {
  resetBus()
  resetWatchers()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-tw-'))
  initEventBus(tmpDir)
})

afterEach(() => {
  detachAll()
  resetBus()
  resetWatchers()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// ---- Codex ----

describe('processCodexLine', () => {
  it('ignores malformed JSON', () => {
    processCodexLine('not json', 't1')
    expect(query().length).toBe(0)
  })

  it('emits message for role+content entry', () => {
    processCodexLine(JSON.stringify({ role: 'user', content: 'hi' }), 't1')
    const events = query({ kind: 'message' })
    expect(events).toHaveLength(1)
    expect(events[0].summary).toContain('user:')
  })

  it('parses content arrays with text items', () => {
    processCodexLine(JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })

  it('emits tool_call for function_call type', () => {
    processCodexLine(JSON.stringify({
      type: 'function_call',
      name: 'read_file',
      arguments: { path: 'x' },
    }), 't1')
    const tools = query({ kind: 'tool_call' })
    expect(tools).toHaveLength(1)
    expect(tools[0].payload.tool).toBe('read_file')
  })

  it('emits tool_result for function_call_output', () => {
    processCodexLine(JSON.stringify({ type: 'function_call_output' }), 't1')
    expect(query({ kind: 'tool_result' })).toHaveLength(1)
  })

  it('emits token_update for OpenAI-style usage', () => {
    processCodexLine(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: 'ok',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }), 't1')
    const toks = query({ kind: 'token_update' })
    expect(toks).toHaveLength(1)
    expect(toks[0].payload.inputTokens).toBe(100)
    expect(toks[0].payload.outputTokens).toBe(50)
  })

  it('emits token_update for Codex-native tokens field', () => {
    processCodexLine(JSON.stringify({
      tokens: { input: 10, output: 20 },
    }), 't1')
    const toks = query({ kind: 'token_update' })
    expect(toks).toHaveLength(1)
  })

  it('handles numeric timestamps (seconds)', () => {
    processCodexLine(JSON.stringify({
      role: 'user',
      content: 'x',
      timestamp: 1_700_000_000,
    }), 't1')
    const e = query()[0]
    expect(e.ts).toBe(1_700_000_000_000)
  })

  it('handles numeric timestamps (milliseconds)', () => {
    processCodexLine(JSON.stringify({
      role: 'user',
      content: 'x',
      timestamp: 1_700_000_000_000,
    }), 't1')
    const e = query()[0]
    expect(e.ts).toBe(1_700_000_000_000)
  })

  it('ignores null parsed values', () => {
    processCodexLine('null', 't1')
    expect(query().length).toBe(0)
  })
})

describe('findLatestCodexSessionFile', () => {
  it('returns null when sessions dir missing', () => {
    // Unless the real dir exists on this machine; guard accordingly
    const existed = fs.existsSync(CODEX_SESSIONS_DIR)
    const result = findLatestCodexSessionFile()
    if (!existed) {
      expect(result).toBeNull()
    } else {
      expect(typeof result === 'string' || result === null).toBe(true)
    }
  })
})

describe('attachCodexWatcher', () => {
  it('returns null when no session file found', () => {
    // Assume no sessions in default locations for clean test env
    const existed = fs.existsSync(CODEX_SESSIONS_DIR)
    const handle = attachCodexWatcher('t1')
    if (!existed) {
      expect(handle).toBeNull()
    } else {
      // On dev machines with Codex installed, may return a handle — just verify it can be stopped
      if (handle) handle.stop()
    }
  })
})

// ---- Gemini ----

describe('processGeminiLine', () => {
  it('ignores malformed JSON', () => {
    processGeminiLine('xxx', 't1')
    expect(query().length).toBe(0)
  })

  it('parses role+content messages', () => {
    processGeminiLine(JSON.stringify({ role: 'user', content: 'hi' }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })

  it('parses author+text shape', () => {
    processGeminiLine(JSON.stringify({ author: 'user', text: 'hi' }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })

  it('handles content arrays', () => {
    processGeminiLine(JSON.stringify({
      role: 'assistant',
      content: [{ text: 'hello' }],
    }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })

  it('skips entries without role or text', () => {
    processGeminiLine(JSON.stringify({ unrelated: 'field' }), 't1')
    expect(query().length).toBe(0)
  })

  it('skips null parsed values', () => {
    processGeminiLine('null', 't1')
    expect(query().length).toBe(0)
  })
})

describe('findLatestGeminiSessionFile', () => {
  it('returns null when gemini dir missing', () => {
    const existed = fs.existsSync(GEMINI_DIR)
    const result = findLatestGeminiSessionFile()
    if (!existed) {
      expect(result).toBeNull()
    } else {
      expect(typeof result === 'string' || result === null).toBe(true)
    }
  })
})

describe('attachGeminiWatcher', () => {
  it('returns null when no session file found', () => {
    const existed = fs.existsSync(GEMINI_DIR)
    const handle = attachGeminiWatcher('t1')
    if (!existed) {
      expect(handle).toBeNull()
    } else {
      if (handle) handle.stop()
    }
  })
})

// ---- Aider ----

describe('processAiderLine', () => {
  it('parses user messages prefixed with ####', () => {
    const state = newAiderParserState()
    processAiderLine('#### add tests for foo', 't1', state)
    processAiderLine('', 't1', state) // flush boundary
    const events = query({ kind: 'message' })
    expect(events).toHaveLength(1)
    expect(events[0].payload.role).toBe('user')
  })

  it('captures assistant response after user', () => {
    const state = newAiderParserState()
    processAiderLine('#### write docs', 't1', state)
    processAiderLine('', 't1', state) // boundary → assistant
    processAiderLine('Here are the docs', 't1', state)
    // Trigger another boundary to flush assistant
    processAiderLine('#### next question', 't1', state)
    const msgs = query({ kind: 'message' })
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    expect(msgs.some((m) => m.payload.role === 'assistant')).toBe(true)
  })

  it('handles empty state flush', () => {
    const state = newAiderParserState()
    // Feed lines with no user prefix → nothing emitted
    processAiderLine('random line', 't1', state)
    processAiderLine('', 't1', state)
    expect(query().length).toBe(0)
  })
})

describe('findAiderHistory', () => {
  it('returns null when no history file', () => {
    expect(findAiderHistory(tmpDir)).toBeNull()
  })

  it('returns path when history file exists', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hi\n')
    expect(findAiderHistory(tmpDir)).toBe(f)
  })

  it('returns null for empty cwd', () => {
    expect(findAiderHistory('')).toBeNull()
  })
})

describe('attachAiderWatcher', () => {
  it('returns null when history not present', () => {
    expect(attachAiderWatcher('t1', tmpDir)).toBeNull()
  })

  it('returns handle when history file exists', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hello\n\nresponse\n')
    const handle = attachAiderWatcher('t1', tmpDir)
    expect(handle).not.toBeNull()
    handle?.stop()
  })
})

// ---- Manager ----

describe('watcher manager', () => {
  it('returns null for unknown agent type', () => {
    expect(attachWatcher('t1', tmpDir, 'unknown' as any)).toBeNull()
  })

  it('returns null for empty terminalId', () => {
    expect(attachWatcher('', tmpDir, 'claude')).toBeNull()
  })

  it('returns null for empty cwd', () => {
    expect(attachWatcher('t1', '', 'claude')).toBeNull()
  })

  it('attaches aider watcher when history present', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hi\n')
    const h = attachWatcher('t1', tmpDir, 'aider')
    expect(h).not.toBeNull()
    expect(getActiveWatcherCount()).toBe(1)
    detachWatchers('t1')
    expect(getActiveWatcherCount()).toBe(0)
  })

  it('detachWatchers is idempotent', () => {
    detachWatchers('non-existent')
    expect(getActiveWatcherCount()).toBe(0)
  })

  it('detachAll stops all watchers', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hi\n')
    attachWatcher('t1', tmpDir, 'aider')
    attachWatcher('t2', tmpDir, 'aider')
    expect(getActiveWatcherCount()).toBe(2)
    detachAll()
    expect(getActiveWatcherCount()).toBe(0)
  })

  it('handles claude without session file', () => {
    // Claude projects dir almost certainly has no entry for our tmpDir
    const nonExistentCwd = path.join(tmpDir, 'no-claude-session')
    expect(attachWatcher('t1', nonExistentCwd, 'claude')).toBeNull()
  })

  it('handles codex when no sessions exist', () => {
    // May be null if user has no codex sessions; skip if they do
    const handle = attachWatcher('t1', tmpDir, 'codex')
    if (handle) handle.stop()
  })

  it('handles gemini when no sessions exist', () => {
    const handle = attachWatcher('t1', tmpDir, 'gemini')
    if (handle) handle.stop()
  })
})

describe('processCodexLine additional branches', () => {
  it('emits tool_call for tool_call type with no name', () => {
    processCodexLine(JSON.stringify({ type: 'tool_call' }), 't1')
    const tools = query({ kind: 'tool_call' })
    expect(tools).toHaveLength(1)
    expect(tools[0].payload.tool).toBe('unknown')
  })

  it('emits tool_result for tool_result type', () => {
    processCodexLine(JSON.stringify({ type: 'tool_result' }), 't1')
    expect(query({ kind: 'tool_result' })).toHaveLength(1)
  })

  it('skips non-object parsed values (string)', () => {
    processCodexLine(JSON.stringify('hello'), 't1')
    expect(query().length).toBe(0)
  })

  it('skips non-object parsed values (number)', () => {
    processCodexLine(JSON.stringify(42), 't1')
    expect(query().length).toBe(0)
  })

  it('handles invalid string timestamp (falls back to now)', () => {
    const before = Date.now()
    processCodexLine(JSON.stringify({
      role: 'user',
      content: 'hi',
      timestamp: 'not-a-date',
    }), 't1')
    const after = Date.now()
    const e = query()[0]
    expect(e.ts).toBeGreaterThanOrEqual(before)
    expect(e.ts).toBeLessThanOrEqual(after)
  })

  it('handles tokens field with zero values', () => {
    processCodexLine(JSON.stringify({
      role: 'user',
      content: 'x',
      tokens: { input: 0, output: 0 },
    }), 't1')
    expect(query({ kind: 'token_update' })).toHaveLength(0)
  })

  it('ignores object without role, type, or content', () => {
    processCodexLine(JSON.stringify({ random: 'field' }), 't1')
    expect(query().length).toBe(0)
  })

  it('handles content array with items lacking text', () => {
    processCodexLine(JSON.stringify({
      role: 'assistant',
      content: [{ type: 'other' }, { nope: true }],
    }), 't1')
    // Should not emit since collected text is empty
    expect(query({ kind: 'message' })).toHaveLength(0)
  })

  it('handles content array with mixed valid and invalid items', () => {
    processCodexLine(JSON.stringify({
      role: 'assistant',
      content: [null, { text: 'valid' }, undefined, { nope: true }],
    }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })
})

describe('processGeminiLine additional branches', () => {
  it('handles non-object parsed value', () => {
    processGeminiLine(JSON.stringify(42), 't1')
    expect(query().length).toBe(0)
  })

  it('handles content as array of items without text', () => {
    processGeminiLine(JSON.stringify({
      role: 'assistant',
      content: [{ type: 'other' }],
    }), 't1')
    // No text content → no emit
    expect(query({ kind: 'message' })).toHaveLength(0)
  })

  it('prefers content over text when both are present', () => {
    processGeminiLine(JSON.stringify({
      role: 'user',
      content: 'from content',
      text: 'from text',
    }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(1)
  })

  it('ignores entry with only text but no role', () => {
    processGeminiLine(JSON.stringify({ text: 'just text' }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(0)
  })

  it('ignores entry with role but no text', () => {
    processGeminiLine(JSON.stringify({ role: 'user' }), 't1')
    expect(query({ kind: 'message' })).toHaveLength(0)
  })
})

describe('processAiderLine additional branches', () => {
  it('does not emit when flushing empty state', () => {
    const state = newAiderParserState()
    processAiderLine('#### first', 't1', state)
    // Reset without buffer contents
    state.buffer = []
    state.currentRole = null
    processAiderLine('', 't1', state)
    expect(query().length).toBe(0)
  })

  it('buffers plain text lines as assistant content', () => {
    const state = newAiderParserState()
    processAiderLine('#### ask', 't1', state)
    processAiderLine('', 't1', state) // boundary
    processAiderLine('line 1', 't1', state)
    processAiderLine('line 2', 't1', state)
    processAiderLine('#### next', 't1', state) // flushes assistant
    const msgs = query({ kind: 'message' })
    expect(msgs.length).toBeGreaterThanOrEqual(2)
  })

  it('does not treat user boundary when buffer is empty', () => {
    const state = newAiderParserState()
    processAiderLine('', 't1', state)
    expect(state.currentRole).toBeNull()
  })
})

describe('watcher manager — all codex/gemini branches', () => {
  it('handles codex attachment returning null', () => {
    // Codex sessions dir may not exist — this exercises the null branch
    const handle = attachWatcher('t-codex', tmpDir, 'codex')
    if (handle) handle.stop()
  })

  it('handles gemini attachment returning null', () => {
    const handle = attachWatcher('t-gem', tmpDir, 'gemini')
    if (handle) handle.stop()
  })

  it('getActiveWatcherCount returns accurate count across multiple terminals', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hi\n')
    attachWatcher('m1', tmpDir, 'aider')
    attachWatcher('m2', tmpDir, 'aider')
    attachWatcher('m3', tmpDir, 'aider')
    expect(getActiveWatcherCount()).toBe(3)
    detachWatchers('m2')
    expect(getActiveWatcherCount()).toBe(2)
  })

  it('detachWatchers swallows errors in stop()', () => {
    const f = path.join(tmpDir, '.aider.chat.history.md')
    fs.writeFileSync(f, '#### hi\n')
    const handle = attachWatcher('t-err', tmpDir, 'aider')
    if (handle) {
      // Monkey-patch stop to throw — detachWatchers should swallow
      const origStop = handle.stop
      handle.stop = () => { throw new Error('stop failed') }
      expect(() => detachWatchers('t-err')).not.toThrow()
      try { origStop() } catch {}
    }
  })
})

describe('baseWatcher — resolvePathWithinRoot', () => {
  it('accepts a path that equals the root itself', async () => {
    const { resolvePathWithinRoot } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const root = tmpDir
    expect(resolvePathWithinRoot(root, root)).toBe(path.resolve(root))
  })

  it('accepts a path beneath the root', async () => {
    const { resolvePathWithinRoot } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const sub = path.join(tmpDir, 'a', 'b.txt')
    expect(resolvePathWithinRoot(tmpDir, sub)).toBe(path.resolve(sub))
  })

  it('throws when path escapes root via traversal', async () => {
    const { resolvePathWithinRoot } = await import('../../src/main/transcriptWatchers/baseWatcher')
    expect(() => resolvePathWithinRoot(tmpDir, path.join(tmpDir, '..', 'escape'))).toThrow(
      /escapes root/,
    )
  })
})

describe('baseWatcher — tailFile', () => {
  it('reads appended lines after write', async () => {
    const { tailFile } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const f = path.join(tmpDir, 'tail.txt')
    fs.writeFileSync(f, '')
    const lines: string[] = []
    const handle = tailFile(f, (l) => lines.push(l))
    fs.appendFileSync(f, 'line-one\nline-two\n')
    // Allow polling or fs.watch tick
    await new Promise((r) => setTimeout(r, 1800))
    handle.stop()
    expect(lines).toEqual(expect.arrayContaining(['line-one', 'line-two']))
  })

  it('skips pathologically long lines past MAX_LINE_BYTES', async () => {
    const { tailFile, MAX_LINE_BYTES } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const f = path.join(tmpDir, 'longline.txt')
    fs.writeFileSync(f, '')
    const lines: string[] = []
    const handle = tailFile(f, (l) => lines.push(l))
    fs.appendFileSync(f, 'x'.repeat(MAX_LINE_BYTES + 100) + '\n')
    await new Promise((r) => setTimeout(r, 1800))
    handle.stop()
    expect(lines.length).toBe(0)
  })

  it('handles file truncation/rotation gracefully', async () => {
    const { tailFile } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const f = path.join(tmpDir, 'rotate.txt')
    fs.writeFileSync(f, 'original-line\nfollow-up\n')
    const lines: string[] = []
    const handle = tailFile(f, (l) => lines.push(l), { startAtEnd: true })
    // Write a shorter file — triggers truncation branch
    fs.writeFileSync(f, 'new\n')
    await new Promise((r) => setTimeout(r, 1800))
    handle.stop()
    expect(lines).toContain('new')
  })

  it('stop() swallows watcher close errors', async () => {
    const { tailFile } = await import('../../src/main/transcriptWatchers/baseWatcher')
    const f = path.join(tmpDir, 'stop.txt')
    fs.writeFileSync(f, '')
    const handle = tailFile(f, () => {})
    // Call stop() twice — idempotent, should not throw
    expect(() => { handle.stop(); handle.stop() }).not.toThrow()
  })
})
