import { describe, expect, it } from 'vitest'
import { capText, edgeItems, edgeSummary, MAX_EDGE_TEXT } from '../../src/shared/world/edgeText'

describe('edgeItems', () => {
  it('lists the identifiers of a code-written label', () => {
    expect(edgeItems('env A, env B, ipc pty:data')).toEqual(['env A', 'env B', 'ipc pty:data'])
    expect(edgeItems('http-out https://x.test/a b')).toEqual(['http-out https://x.test/a b'])
  })

  it('is null for a model label, "imports", an empty label or an unknown kind', () => {
    expect(edgeItems('Sends terminal output')).toBeNull()
    expect(edgeItems('imports')).toBeNull()
    expect(edgeItems('')).toBeNull()
    expect(edgeItems('env A, carrier pigeon')).toBeNull()
    expect(edgeItems(' env A')).toBeNull()
    expect(edgeItems('toString x')).toBeNull()
  })
})

describe('capText', () => {
  it('keeps short text, on one line', () => {
    expect(capText('  reads   6\nsettings ')).toBe('reads 6 settings')
  })

  it('cuts long text at a word and ends it in an ellipsis', () => {
    const out = capText('Sends terminal output and resize events to the renderer')
    expect(out).toBe('Sends terminal output and…')
    expect(out.length).toBeLessThanOrEqual(MAX_EDGE_TEXT)
  })

  it('cuts a long word mid-way and drops trailing punctuation', () => {
    expect(capText('x'.repeat(50), 10)).toBe('xxxxxxxxx…')
    expect(capText('abcdefgh, ijklmnop', 10)).toBe('abcdefgh…')
  })
})

describe('edgeSummary', () => {
  it('says what one kind does and how many', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((v) => `env TERMPOLIS_${v}`).join(', ')
    expect(edgeSummary(six)).toBe('reads 6 settings')
    expect(edgeSummary('env A')).toBe('reads 1 setting')
    expect(edgeSummary('ipc a, ipc b')).toBe('uses 2 message channels')
    expect(edgeSummary('port 80')).toBe('connects on 1 port')
    expect(edgeSummary('worker w.js')).toBe('starts 1 worker')
    expect(edgeSummary('http-out a, http-out b')).toBe('calls 2 web addresses')
    expect(edgeSummary('http-listen /a')).toBe('serves 1 web route')
    expect(edgeSummary('mcp a, mcp b')).toBe('uses 2 tools')
    expect(edgeSummary('watch a')).toBe('watches 1 path')
  })

  it('counts fork and spawn together as programs', () => {
    expect(edgeSummary('fork a.js, spawn git')).toBe('starts 2 programs')
  })

  it('leads with the busiest kind and counts the rest', () => {
    expect(edgeSummary('ipc x, env A, env B, env C, watch p')).toBe('reads 3 settings +2 more')
    // A tie keeps the label's order.
    expect(edgeSummary('ipc x, env A')).toBe('uses 1 message channel +1 more')
  })

  it('keeps a model label and caps every summary', () => {
    expect(edgeSummary('Sends keystrokes')).toBe('Sends keystrokes')
    expect(edgeSummary('imports')).toBe('imports')
    const many = Array.from({ length: 120 }, (_, i) => `ipc c${i}`).concat(Array.from({ length: 30 }, (_, i) => `env E${i}`)).join(', ')
    const s = edgeSummary(many)
    expect(s).toBe('uses 120 message channels +30…')
    expect(s.length).toBeLessThanOrEqual(MAX_EDGE_TEXT)
  })
})
