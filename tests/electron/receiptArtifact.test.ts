import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  costSplit,
  sharePct,
  canonicalJson,
  buildPayload,
  signReceipt,
  verifyReceipt,
  renderReceiptMarkdown,
  renderReceiptJson,
  W_CACHE_READ,
  W_CACHE_WRITE,
  W_INPUT,
  W_OUTPUT,
  RECEIPT_VERSION,
  type SignedReceipt,
} from '../../src/main/headroom/receiptArtifact'
import {
  initReceiptIdentity,
  installHash,
  issueReceipt,
  checkReceipt,
  resetReceiptIdentity,
} from '../../src/main/headroom/receiptStore'
import type { UnifiedTotals } from '../../src/main/headroom/unifiedReceipt'
import { isoFromEpochMs } from '../../src/main/isoTime'

function totals(over: Partial<UnifiedTotals> = {}): UnifiedTotals {
  return {
    requests: 100,
    wireOrigTokens: 900_000,
    wireSavedTokens: 400_000,
    images: 0,
    imageOrigBytes: 0,
    imageSavedBytes: 0,
    toolOrigTokens: 100_000,
    toolSavedTokens: 60_000,
    toolEvents: 20,
    byTool: {},
    retrieves: 5,
    givebackTokens: 10_000,
    grossSavedTokens: 460_000,
    netSavedTokens: 450_000,
    savedPct: 45,
    cacheReadTokens: 2_000_000,
    cacheCreationTokens: 100_000,
    inputTokens: 50_000,
    outputTokens: 40_000,
    toolUseOrigTokens: 0,
    toolUseSavedTokens: 0,
    worstSavedPct: 12.5,
    ...over,
  }
}

describe('receiptArtifact/costSplit', () => {
  it('weights each bucket by its published billing multiplier', () => {
    const s = costSplit({ cacheReadTokens: 10, cacheCreationTokens: 10, inputTokens: 10, outputTokens: 10 })
    expect(s).toEqual({
      cacheRead: 10 * W_CACHE_READ,
      cacheWrite: 10 * W_CACHE_WRITE,
      input: 10 * W_INPUT,
      output: 10 * W_OUTPUT,
      total: 10 * (W_CACHE_READ + W_CACHE_WRITE + W_INPUT + W_OUTPUT),
    })
  })

  it('shows output dominating the bill at equal token counts — the ceiling on input compression', () => {
    const s = costSplit({ cacheReadTokens: 100, cacheCreationTokens: 100, inputTokens: 100, outputTokens: 100 })
    const share = sharePct(s)
    expect(share.output).toBeGreaterThan(share.cacheRead + share.cacheWrite + share.input)
  })

  it('reports zero shares rather than dividing by zero on an empty ledger', () => {
    expect(sharePct(costSplit({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 })))
      .toEqual({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 })
  })

  it('rounds shares to a tenth of a percent', () => {
    const share = sharePct(costSplit({ cacheReadTokens: 3, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 1 }))
    expect(share.cacheRead + share.output).toBeCloseTo(100, 1)
  })
})

describe('receiptArtifact/canonicalJson', () => {
  it('is stable under key reordering, so a struct edit cannot break old signatures', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested keys too', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}')
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles primitives and null', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(5)).toBe('5')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('receiptArtifact/buildPayload', () => {
  it('carries the raw counters plus everything derivable from them', () => {
    const p = buildPayload(totals(), { installHash: 'abc123', now: 1_700_000_000_000 })
    expect(p.version).toBe(RECEIPT_VERSION)
    expect(p.issuedAt).toBe(1_700_000_000_000)
    expect(p.installHash).toBe('abc123')
    expect(p.origTokens).toBe(1_000_000)
    expect(p.retrieveRate).toBe(0.05)
    expect(p.worstSavedPct).toBe(12.5)
    expect(p.split.total).toBeGreaterThan(0)
  })

  it('carries the injected clock through verbatim — the receipt never reads one itself', () => {
    // `now` is REQUIRED, not defaulted. src/main/headroom/ is swept for clock reads by
    // noNondeterministicCompression.test.ts, so the instant is supplied at the edge.
    expect(buildPayload(totals(), { installHash: 'x', now: 42 }).issuedAt).toBe(42)
  })

  it('reports a zero retrieve rate on a ledger with no requests', () => {
    expect(buildPayload(totals({ requests: 0 }), { installHash: 'x', now: 1 }).retrieveRate).toBe(0)
  })
})

describe('receiptArtifact/verifyReceipt', () => {
  const receipt = (over: Partial<UnifiedTotals> = {}): SignedReceipt =>
    signReceipt(buildPayload(totals(over), { installHash: 'abc', now: 1 }), 'k')

  it('verifies a freshly signed receipt as both intact and consistent', () => {
    const v = verifyReceipt(receipt(), 'k')
    expect(v).toMatchObject({ intact: true, consistent: true, problems: [] })
    expect(v.scope).toContain('Self-signed')
  })

  it('reports intact:false without a key, and says so in scope rather than claiming tampering', () => {
    const v = verifyReceipt(receipt())
    expect(v.intact).toBe(false)
    // The key-free check is the one a third party can actually run, and it still passes.
    expect(v.consistent).toBe(true)
    expect(v.problems).toEqual([])
  })

  it('catches a re-signed but doctored headline, because the arithmetic no longer follows', () => {
    const r = receipt()
    r.payload.savedPct = 94
    const resigned = signReceipt(r.payload, 'k')
    const v = verifyReceipt(resigned, 'k')
    expect(v.intact).toBe(true) // a forger CAN re-sign
    expect(v.consistent).toBe(false) // but the numbers stop adding up
    expect(v.problems.join(' ')).toContain('savedPct 94')
  })

  it('catches an edit that was not re-signed', () => {
    const r = receipt()
    r.payload.netSavedTokens = 999_999
    const v = verifyReceipt(r, 'k')
    expect(v.intact).toBe(false)
    expect(v.problems).toContain('signature does not match payload')
  })

  it('catches a cost split that does not follow from the usage counters', () => {
    const r = receipt()
    r.payload.split.total += 1_000_000
    expect(verifyReceipt(r).problems.join(' ')).toContain('cost split does not follow')
  })

  it('catches net saving claimed above gross', () => {
    const v = verifyReceipt(receipt({ netSavedTokens: 500_000, savedPct: 50 }))
    expect(v.problems).toContain('net saving exceeds gross saving')
  })

  it('catches a doctored retrieve rate — the fidelity evidence', () => {
    const r = receipt()
    r.payload.retrieveRate = 0
    expect(verifyReceipt(r).problems.join(' ')).toContain('retrieve rate does not follow')
  })

  it('accepts an empty ledger without inventing problems', () => {
    const empty = totals({ requests: 0, wireOrigTokens: 0, toolOrigTokens: 0, retrieves: 0, grossSavedTokens: 0, netSavedTokens: 0, savedPct: 0, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0, outputTokens: 0 })
    expect(verifyReceipt(signReceipt(buildPayload(empty, { installHash: 'x', now: 1 }), 'k'), 'k').consistent).toBe(true)
  })

  it('survives a truncated signature instead of throwing on a length mismatch', () => {
    const r = receipt()
    r.signature = 'ab'
    expect(() => verifyReceipt(r, 'k')).not.toThrow()
    expect(verifyReceipt(r, 'k').intact).toBe(false)
  })
})

describe('receiptArtifact rendering', () => {
  const r = signReceipt(buildPayload(totals(), { installHash: 'abcdef0123456789', now: 1_700_000_000_000 }), 'k')

  it('renders a pasteable markdown receipt that states its own limits', () => {
    const md = renderReceiptMarkdown(r)
    expect(md).toContain('# Termpolis Token Headroom — savings receipt')
    expect(md).toContain('install `abcdef012345`')
    expect(md).toContain('Arithmetic self-consistent: **yes**')
    expect(md).toContain('Self-signed')
    expect(md).toContain('termpolis-cli receipt --verify')
    expect(md).toContain('450,000')
  })

  it('states the failure in the document rather than rendering a clean-looking lie', () => {
    const bad = signReceipt({ ...r.payload, savedPct: 99 }, 'k')
    expect(renderReceiptMarkdown(bad)).toContain('Arithmetic self-consistent: **NO —')
  })

  it('round-trips through JSON and still verifies', () => {
    const parsed = JSON.parse(renderReceiptJson(r)) as SignedReceipt
    expect(verifyReceipt(parsed, 'k')).toMatchObject({ intact: true, consistent: true })
  })
})

describe('receiptStore', () => {
  let tmp: string

  beforeEach(() => {
    resetReceiptIdentity()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-receipt-'))
    initReceiptIdentity(tmp)
  })

  afterEach(() => {
    resetReceiptIdentity()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* windows lock */ }
  })

  it('rejects an empty userData path rather than writing the identity somewhere arbitrary', () => {
    expect(() => initReceiptIdentity('')).toThrow('userDataPath required')
  })

  it('persists one identity and reuses it across launches', () => {
    const first = installHash()
    expect(fs.existsSync(path.join(tmp, 'headroom', 'receipt-identity.json'))).toBe(true)
    resetReceiptIdentity()
    initReceiptIdentity(tmp)
    expect(installHash()).toBe(first)
  })

  it('does not derive the install id from the machine — a receipt is meant to be pasted out', () => {
    const first = installHash()
    resetReceiptIdentity()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-receipt-'))
    initReceiptIdentity(other)
    expect(installHash()).not.toBe(first)
    try { fs.rmSync(other, { recursive: true, force: true }) } catch { /* windows lock */ }
  })

  it('publishes a salted hash, never the salt itself', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'headroom', 'receipt-identity.json'), 'utf8')) as { salt: string; key: string }
    const h = installHash()
    expect(h).toHaveLength(16)
    expect(h).not.toBe(raw.salt)
    expect(raw.key).not.toContain(h)
  })

  it('regenerates rather than crashing on a corrupt identity file', () => {
    fs.writeFileSync(path.join(tmp, 'headroom', 'receipt-identity.json'), '{ not json', 'utf8')
    resetReceiptIdentity()
    expect(() => initReceiptIdentity(tmp)).not.toThrow()
    expect(installHash()).toHaveLength(16)
  })

  it('regenerates when the stored identity is structurally wrong', () => {
    fs.writeFileSync(path.join(tmp, 'headroom', 'receipt-identity.json'), JSON.stringify({ salt: 42 }), 'utf8')
    resetReceiptIdentity()
    initReceiptIdentity(tmp)
    expect(installHash()).toHaveLength(16)
  })

  it('still signs without an init, so a receipt is never unavailable', () => {
    resetReceiptIdentity()
    const r = issueReceipt(totals(), 1)
    expect(checkReceipt(r)).toMatchObject({ intact: true, consistent: true })
  })

  it('issues a receipt stamped with this install and verifies it with the key', () => {
    const r = issueReceipt(totals(), 1_700_000_000_000)
    expect(r.payload.installHash).toBe(installHash())
    expect(r.payload.issuedAt).toBe(1_700_000_000_000)
    expect(checkReceipt(r)).toMatchObject({ intact: true, consistent: true })
  })

  it('verifies a foreign receipt key-free rather than reporting a false tamper', () => {
    const foreign = signReceipt(buildPayload(totals(), { installHash: 'someoneelse', now: 1 }), 'their-key')
    const v = checkReceipt(foreign)
    expect(v.intact).toBe(false)
    expect(v.consistent).toBe(true)
    expect(v.problems).toEqual([])
  })

  it('honours an explicit sameInstall:false, dropping to the key-free check', () => {
    const r = issueReceipt(totals(), 1)
    expect(checkReceipt(r, false).intact).toBe(false)
    expect(checkReceipt(r, false).consistent).toBe(true)
  })
})

describe('isoTime', () => {
  // Lives outside src/main/headroom/ on purpose: formatting an instant that was passed in
  // is pure, but the cache-safety sweep bans the literal `new Date(` from the compression
  // dirs and cannot tell a format from a clock READ. Keeping it here keeps that ban absolute.
  it('formats an epoch-ms instant as UTC ISO-8601', () => {
    expect(isoFromEpochMs(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('is pure — same input, same output, no clock', () => {
    expect(isoFromEpochMs(0)).toBe(isoFromEpochMs(0))
    expect(isoFromEpochMs(0)).toBe('1970-01-01T00:00:00.000Z')
  })
})
