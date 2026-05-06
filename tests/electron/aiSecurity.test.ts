import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock electron's app.getPath('userData') to a tmp dir per test.
let tmpDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}))

async function freshModule() {
  vi.resetModules()
  return await import('../../src/main/aiSecurity')
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'termpolis-aisec-'))
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('aiSecurity.scanText', () => {
  it('detects an AWS access key', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(r.hitCount).toBeGreaterThan(0)
    expect(r.hits.some(h => h.rule === 'aws_access_key')).toBe(true)
    expect(r.redacted).toContain('[REDACTED:aws_access_key]')
  })

  it('detects a GitHub PAT', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')
    expect(r.hits.some(h => h.rule === 'gh_pat')).toBe(true)
  })

  it('detects an OpenAI key', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('OPENAI_API_KEY=sk-proj-abcdef0123456789xyz_-XYZ')
    expect(r.hits.some(h => h.rule === 'openai_key')).toBe(true)
  })

  it('detects an Anthropic key', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('ANTHROPIC_API_KEY=sk-ant-abcdef0123456789xyz_-XYZ')
    expect(r.hits.some(h => h.rule === 'anthropic_key')).toBe(true)
  })

  it('detects a Google API key', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('AIzaSy0123456789ABCDEFGHIJKLMNOPQRSTUVW')
    expect(r.hits.some(h => h.rule === 'google_api')).toBe(true)
  })

  it('detects a JWT', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signature123abc'
    const r = m.scanText(jwt)
    expect(r.hits.some(h => h.rule === 'jwt')).toBe(true)
  })

  it('detects PEM private key headers', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...')
    expect(r.hits.some(h => h.rule === 'private_key')).toBe(true)
  })

  it('detects .env-style SECRET assignments', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('DATABASE_PASSWORD=hunter2hunter2hunter2')
    expect(r.hits.some(h => h.rule === 'env_secret')).toBe(true)
  })

  it('returns no hits on benign code', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('console.log("hello world")')
    expect(r.hitCount).toBe(0)
    expect(r.hits).toEqual([])
  })

  it('returns the input unchanged when no hits', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('plain text')
    expect(r.redacted).toBe('plain text')
  })

  it('handles empty / non-string input', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    expect(m.scanText('').hitCount).toBe(0)
    // @ts-expect-error testing fallthrough
    expect(m.scanText(undefined).hitCount).toBe(0)
  })

  it('detects multiple secrets and redacts each', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')
    expect(r.hitCount).toBeGreaterThanOrEqual(2)
    expect(r.redacted).toContain('[REDACTED:aws_access_key]')
    expect(r.redacted).toContain('[REDACTED:gh_pat]')
  })

  it('produces a sample preview that does not leak full secret', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText('AKIAIOSFODNN7EXAMPLE')
    expect(r.hits[0].sample).not.toBe('AKIAIOSFODNN7EXAMPLE')
    expect(r.hits[0].sample).toContain('…')
  })
})

describe('aiSecurity settings persistence', () => {
  it('toggles redaction and persists across re-imports', async () => {
    const m1 = await freshModule()
    m1.initAiSecurity()
    expect(m1.getSettings().redactionEnabled).toBe(false)
    m1.setRedactionEnabled(true)
    expect(m1.getSettings().redactionEnabled).toBe(true)
    // Confirm a settings JSON file was written
    expect(existsSync(join(tmpDir, 'ai-security-settings.json'))).toBe(true)

    // Fresh module on same dir should observe persisted state
    const m2 = await freshModule()
    expect(m2.getSettings().redactionEnabled).toBe(true)
  })

  it('toggles audit and persists', async () => {
    const m1 = await freshModule()
    m1.setAuditEnabled(true)
    const m2 = await freshModule()
    expect(m2.getSettings().auditEnabled).toBe(true)
  })

  it('toggles strictGeminiPaidOnly and persists', async () => {
    const m1 = await freshModule()
    m1.initAiSecurity()
    expect(m1.getSettings().strictGeminiPaidOnly).toBe(false)
    m1.setStrictGeminiPaidOnly(true)
    expect(m1.getSettings().strictGeminiPaidOnly).toBe(true)
    const m2 = await freshModule()
    expect(m2.getSettings().strictGeminiPaidOnly).toBe(true)
  })

  it('strictGeminiPaidOnly defaults to false on missing settings', async () => {
    const m = await freshModule()
    expect(m.getSettings().strictGeminiPaidOnly).toBe(false)
  })

  it('survives a corrupted settings JSON gracefully', async () => {
    writeFileSync(join(tmpDir, 'ai-security-settings.json'), '{ this is not json }')
    const m = await freshModule()
    // Should fall back to defaults, not throw
    expect(() => m.initAiSecurity()).not.toThrow()
    expect(m.getSettings().redactionEnabled).toBe(false)
  })
})

describe('aiSecurity audit log', () => {
  it('writes JSONL entries when audit is enabled', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open', terminalId: 't1', byteCount: 8 })
    await m.appendAudit({ agent: 'codex', event: 'terminal_close', terminalId: 't1' })
    const recent = await m.getRecentAudit()
    expect(recent.length).toBe(2)
    // Most recent first
    expect(recent[0].agent).toBe('codex')
    expect(recent[1].agent).toBe('claude')
  })

  it('does not write when audit is disabled', async () => {
    const m = await freshModule()
    m.setAuditEnabled(false)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    const recent = await m.getRecentAudit()
    expect(recent.length).toBe(0)
  })

  it('clears the log on demand', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    expect((await m.getRecentAudit()).length).toBe(1)
    await m.clearAudit()
    expect((await m.getRecentAudit()).length).toBe(0)
  })

  it('respects the limit parameter', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    for (let i = 0; i < 5; i++) {
      await m.appendAudit({ agent: 'claude', event: 'terminal_open', byteCount: i })
    }
    const recent = await m.getRecentAudit(3)
    expect(recent.length).toBe(3)
  })

  it('returns an empty array when audit file does not exist', async () => {
    const m = await freshModule()
    expect(await m.getRecentAudit()).toEqual([])
  })

  it('skips malformed lines without throwing', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    // Append a bad line directly
    const path = m.getAuditPath()
    const raw = readFileSync(path, 'utf8') + 'this is not json\n'
    writeFileSync(path, raw)
    const recent = await m.getRecentAudit()
    expect(recent.length).toBe(1)
  })

  it('rotates the log when it grows beyond the size cap, replacing any prior rotation', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    const path = m.getAuditPath()
    const prev = path.replace(/\.jsonl$/, '.prev.jsonl')
    // Pre-seed a previous rotation so we exercise the unlink branch (lines 155-158).
    writeFileSync(prev, '{"ts":"old"}\n')
    // Pad current audit beyond 10 MB so rotateIfNeeded triggers.
    const padding = 'x'.repeat(11 * 1024 * 1024)
    writeFileSync(path, padding)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    expect(existsSync(prev)).toBe(true)
    // The fresh audit file should contain only the new entry, not the padding.
    const after = readFileSync(path, 'utf8')
    expect(after.length).toBeLessThan(1024)
    expect(after).toContain('terminal_open')
  })

  it('returns [] when reading the audit file throws', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    await m.appendAudit({ agent: 'claude', event: 'terminal_open' })
    // Replace the audit file with a directory of the same name so readFile rejects (EISDIR).
    const path = m.getAuditPath()
    rmSync(path, { force: true })
    mkdirSync(path)
    expect(await m.getRecentAudit()).toEqual([])
  })
})

describe('detectGeminiAccount', () => {
  it('returns paid-vertex when service-account creds + project are present', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/sa.json',
      GOOGLE_CLOUD_PROJECT: 'my-proj',
    } as any)
    expect(r.mode).toBe('paid-vertex')
    expect(r.safeForTraining).toBe(true)
    expect(r.evidence.length).toBeGreaterThan(0)
  })

  it('returns paid-code-assist when GOOGLE_GENAI_USE_GCA is true', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({ GOOGLE_GENAI_USE_GCA: 'true' } as any)
    expect(r.mode).toBe('paid-code-assist')
    expect(r.safeForTraining).toBe(true)
  })

  it('accepts truthy variants for GOOGLE_GENAI_USE_GCA', async () => {
    const m = await freshModule()
    expect(m.detectGeminiAccount({ GOOGLE_GENAI_USE_GCA: '1' } as any).mode).toBe('paid-code-assist')
    expect(m.detectGeminiAccount({ GOOGLE_GENAI_USE_GCA: 'YES' } as any).mode).toBe('paid-code-assist')
    expect(m.detectGeminiAccount({ GOOGLE_GENAI_USE_GCA: 'false' } as any).mode).toBe('free-oauth')
  })

  it('returns paid-api-key when GEMINI_API_KEY is set', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({ GEMINI_API_KEY: 'xyz' } as any)
    expect(r.mode).toBe('paid-api-key')
    expect(r.safeForTraining).toBe(true)
    expect(r.evidence[0]).toMatch(/GEMINI_API_KEY/)
  })

  it('returns paid-api-key when only GOOGLE_API_KEY is set', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({ GOOGLE_API_KEY: 'xyz' } as any)
    expect(r.mode).toBe('paid-api-key')
    expect(r.evidence[0]).toMatch(/GOOGLE_API_KEY/)
  })

  it('returns free-oauth and warns when no env hints are present', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({} as any)
    expect(r.mode).toBe('free-oauth')
    expect(r.safeForTraining).toBe(false)
    expect(r.recommendation).toMatch(/WARNING/)
  })

  it('Vertex takes precedence over GENAI_USE_GCA when both are set', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/sa.json',
      GOOGLE_CLOUD_PROJECT: 'my-proj',
      GOOGLE_GENAI_USE_GCA: 'true',
      GEMINI_API_KEY: 'xyz',
    } as any)
    expect(r.mode).toBe('paid-vertex')
  })

  it('GENAI_USE_GCA takes precedence over GEMINI_API_KEY', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({
      GOOGLE_GENAI_USE_GCA: 'true',
      GEMINI_API_KEY: 'xyz',
    } as any)
    expect(r.mode).toBe('paid-code-assist')
  })

  it('treats empty-string env values as missing', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({ GEMINI_API_KEY: '' } as any)
    expect(r.mode).toBe('free-oauth')
  })

  it('GOOGLE_APPLICATION_CREDENTIALS without project falls through to free-oauth', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount({ GOOGLE_APPLICATION_CREDENTIALS: '/etc/sa.json' } as any)
    expect(r.mode).toBe('free-oauth')
  })

  it('uses process.env when no argument is passed', async () => {
    const m = await freshModule()
    const r = m.detectGeminiAccount()
    expect(['paid-vertex','paid-code-assist','paid-api-key','free-oauth','unknown']).toContain(r.mode)
  })
})

describe('AGENT_FACTS catalog', () => {
  it('includes all 4 supported agents', async () => {
    const m = await freshModule()
    const ids = m.AGENT_FACTS.map(f => f.agentId).sort()
    expect(ids).toEqual(['claude', 'codex', 'gemini', 'qwen-code'])
  })

  it('every fact has a privacy URL and a console URL', async () => {
    const m = await freshModule()
    for (const f of m.AGENT_FACTS) {
      expect(f.privacyDocUrl).toMatch(/^https:\/\//)
      expect(f.consoleUrl).toMatch(/^https:\/\//)
      expect(f.notes.length).toBeGreaterThan(20)
    }
  })

  it('flags Gemini free tier as opt-out-required', async () => {
    const m = await freshModule()
    const gemini = m.AGENT_FACTS.find(f => f.agentId === 'gemini')!
    expect(gemini.trainingOptOut).toBe('opt-out-required')
  })
})
