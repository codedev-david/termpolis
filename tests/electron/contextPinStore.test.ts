import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  initContextPinStore,
  addPin,
  removePin,
  updatePin,
  listPins,
  clearPins,
  cwdKey,
  MAX_PINS_PER_PROJECT,
  MAX_BODY_BYTES,
  MAX_LABEL_BYTES,
  _resetForTests,
} from '../../src/main/contextPinStore'

let tmp: string

beforeEach(() => {
  _resetForTests()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-pins-'))
  initContextPinStore(tmp)
})

afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
})

describe('initContextPinStore', () => {
  it('creates store subdirectory', () => {
    const sub = path.join(tmp, 'context-pins')
    expect(fs.existsSync(sub)).toBe(true)
  })

  it('requires absolute path', () => {
    _resetForTests()
    expect(() => initContextPinStore('relative')).toThrow()
  })

  it('requires non-empty string', () => {
    _resetForTests()
    // @ts-expect-error — runtime guard
    expect(() => initContextPinStore(null)).toThrow()
  })
})

describe('cwdKey', () => {
  it('is stable', () => {
    expect(cwdKey('/foo')).toBe(cwdKey('/foo'))
  })

  it('differs for different cwds', () => {
    expect(cwdKey('/foo')).not.toBe(cwdKey('/bar'))
  })

  it('throws on empty', () => {
    expect(() => cwdKey('')).toThrow()
  })
})

describe('addPin', () => {
  it('creates a pin and persists it', () => {
    const cwd = '/cwd1'
    const p = addPin(cwd, { label: 'pin A', body: 'body A' })
    expect(p.id).toBeTruthy()
    expect(p.createdAt).toBeGreaterThan(0)
    const listed = listPins(cwd)
    expect(listed).toHaveLength(1)
    expect(listed[0].label).toBe('pin A')
  })

  it('requires label', () => {
    expect(() => addPin('/cwd', { label: '', body: 'x' })).toThrow(/label/)
  })

  it('requires body', () => {
    expect(() => addPin('/cwd', { label: 'l', body: '' })).toThrow(/body/)
  })

  it('caps label size', () => {
    const long = 'x'.repeat(MAX_LABEL_BYTES + 500)
    const p = addPin('/cwd', { label: long, body: 'b' })
    expect(p.label.length).toBeLessThanOrEqual(MAX_LABEL_BYTES)
  })

  it('caps body size', () => {
    const long = 'x'.repeat(MAX_BODY_BYTES + 1000)
    const p = addPin('/cwd', { label: 'l', body: long })
    expect(p.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES)
  })

  it('stores optional source and tags', () => {
    const p = addPin('/cwd', { label: 'l', body: 'b', source: 'claude', tags: ['api', 'auth'] })
    expect(p.source).toBe('claude')
    expect(p.tags).toEqual(['api', 'auth'])
  })

  it('caps number of tags', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`)
    const p = addPin('/cwd', { label: 'l', body: 'b', tags: many })
    expect((p.tags ?? []).length).toBeLessThanOrEqual(20)
  })

  it('rejects beyond per-project limit', () => {
    const cwd = '/big'
    for (let i = 0; i < MAX_PINS_PER_PROJECT; i++) {
      addPin(cwd, { label: `${i}`, body: `b${i}` })
    }
    expect(() => addPin(cwd, { label: 'over', body: 'b' })).toThrow(/limit/)
  })

  it('isolates pins per cwd', () => {
    addPin('/a', { label: 'a', body: 'a' })
    addPin('/b', { label: 'b', body: 'b' })
    expect(listPins('/a')).toHaveLength(1)
    expect(listPins('/b')).toHaveLength(1)
  })

  it('requires cwd', () => {
    expect(() => addPin('', { label: 'l', body: 'b' })).toThrow()
  })

  it('requires input object', () => {
    // @ts-expect-error — runtime guard
    expect(() => addPin('/cwd', null)).toThrow()
  })
})

describe('removePin', () => {
  it('removes a pin', () => {
    const cwd = '/rm'
    const p = addPin(cwd, { label: 'x', body: 'y' })
    expect(removePin(cwd, p.id)).toBe(true)
    expect(listPins(cwd)).toHaveLength(0)
  })

  it('returns false for unknown id', () => {
    expect(removePin('/rm', 'nope')).toBe(false)
  })

  it('returns false for empty cwd/id', () => {
    expect(removePin('', 'x')).toBe(false)
    expect(removePin('/rm', '')).toBe(false)
  })
})

describe('updatePin', () => {
  it('applies label patch', () => {
    const cwd = '/up'
    const p = addPin(cwd, { label: 'l1', body: 'b1' })
    const u = updatePin(cwd, p.id, { label: 'l2' })
    expect(u?.label).toBe('l2')
    expect(u?.body).toBe('b1')
  })

  it('applies body patch with cap', () => {
    const cwd = '/up'
    const p = addPin(cwd, { label: 'l', body: 'b' })
    const u = updatePin(cwd, p.id, { body: 'x'.repeat(MAX_BODY_BYTES + 200) })
    expect(u?.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES)
  })

  it('applies source + tags', () => {
    const cwd = '/up'
    const p = addPin(cwd, { label: 'l', body: 'b' })
    const u = updatePin(cwd, p.id, { source: 'codex', tags: ['a'] })
    expect(u?.source).toBe('codex')
    expect(u?.tags).toEqual(['a'])
  })

  it('returns null for unknown pin', () => {
    expect(updatePin('/up', 'none', { label: 'x' })).toBeNull()
  })

  it('returns null for empty cwd/id', () => {
    expect(updatePin('', 'x', {})).toBeNull()
    expect(updatePin('/c', '', {})).toBeNull()
  })
})

describe('clearPins', () => {
  it('removes all pins for a cwd', () => {
    const cwd = '/clr'
    addPin(cwd, { label: 'a', body: 'a' })
    addPin(cwd, { label: 'b', body: 'b' })
    clearPins(cwd)
    expect(listPins(cwd)).toHaveLength(0)
  })

  it('tolerates empty cwd', () => {
    expect(() => clearPins('')).not.toThrow()
  })

  it('does not affect other cwds', () => {
    addPin('/one', { label: 'a', body: 'a' })
    addPin('/two', { label: 'b', body: 'b' })
    clearPins('/one')
    expect(listPins('/two')).toHaveLength(1)
  })
})

describe('listPins tolerance', () => {
  it('returns [] when file is corrupt', () => {
    const cwd = '/corrupt'
    addPin(cwd, { label: 'x', body: 'y' })
    const file = path.join(tmp, 'context-pins', cwdKey(cwd) + '.json')
    fs.writeFileSync(file, 'not json')
    expect(listPins(cwd)).toEqual([])
  })

  it('returns [] when store not initialized', () => {
    _resetForTests()
    expect(listPins('/x')).toEqual([])
  })

  it('filters malformed entries on disk', () => {
    const cwd = '/weird'
    const file = path.join(tmp, 'context-pins', cwdKey(cwd) + '.json')
    fs.writeFileSync(file, JSON.stringify([
      { id: 'ok', label: 'a', body: 'b' },
      { nope: true },
      null,
    ]))
    expect(listPins(cwd)).toHaveLength(1)
  })
})
