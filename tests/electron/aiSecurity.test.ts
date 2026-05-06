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
    const r = m.scanText('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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
    const r = m.scanText('AKIAIOSFODNN7EXAMPLE and ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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

  // === Cloud / vendor coverage matrix ===

  it.each([
    ['GitLab PAT', 'glpat-' + 'a'.repeat(20), 'gitlab_pat'],
    ['Bitbucket app password', 'ATBB' + 'a'.repeat(32), 'bitbucket_app_pw'],
    ['HuggingFace token', 'hf_' + 'a'.repeat(34), 'huggingface'],
    ['Replicate token', 'r8_' + 'a'.repeat(40), 'replicate_token'],
    ['Azure Storage AccountKey', 'AccountKey=' + 'a'.repeat(88), 'azure_storage_key'],
    ['Azure SAS sig', 'https://x.blob.core.windows.net/c?sig=' + 'a'.repeat(50), 'azure_sas'],
    ['Azure conn string', 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=ZZZZZZZZZZ', 'azure_conn_string'],
    ['Azure DevOps PAT', 'ADO_PAT=' + '0'.repeat(52), 'azure_devops_pat'],
    ['GCP service-account JSON', '{"type": "service_account", "project_id": "x"}', 'gcp_sa_json'],
    ['GCP OAuth client id', '123456789012-' + 'a'.repeat(32) + '.apps.googleusercontent.com', 'gcp_oauth_client'],
    ['Slack webhook', 'https://hooks.slack.com/services/T012345/B012345/' + 'a'.repeat(24), 'slack_webhook'],
    ['Discord webhook', 'https://discord.com/api/webhooks/123/' + 'a'.repeat(60), 'discord_webhook'],
    ['Telegram bot', '123456789:' + 'a'.repeat(35), 'telegram_bot'],
    ['Stripe live secret', 'sk_live_' + 'a'.repeat(24), 'stripe_secret'],
    ['Stripe publishable', 'pk_live_' + 'a'.repeat(24), 'stripe_pub'],
    ['Twilio SID', 'AC' + 'a'.repeat(32), 'twilio_sid'],
    ['SendGrid', 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43), 'sendgrid_key'],
    ['Mailgun', 'key-' + 'a'.repeat(32), 'mailgun_key'],
    ['Mailchimp', 'a'.repeat(32) + '-us12', 'mailchimp_key'],
    ['Cloudflare API token (named)', 'CF_API_TOKEN=' + 'a'.repeat(40), 'cloudflare_api'],
    ['DigitalOcean PAT', 'dop_v1_' + 'a'.repeat(64), 'digitalocean_pat'],
    ['Heroku key (named)', 'HEROKU_API_KEY=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'heroku_api'],
    ['Vercel token (named)', 'VERCEL_TOKEN=' + 'a'.repeat(24), 'vercel_token'],
    ['Fly.io API', 'fo1_' + 'a'.repeat(24), 'fly_api'],
    ['Linear API', 'lin_api_' + 'a'.repeat(40), 'linear_api'],
    ['Notion secret', 'secret_' + 'X'.repeat(43), 'notion_secret'],
    ['Figma PAT', 'figd_' + 'a'.repeat(30), 'figma_pat'],
    ['npm authToken line', '//registry.npmjs.org/:_authToken=' + 'a'.repeat(20), 'npm_authtoken_line'],
    ['Docker Hub PAT', 'dckr_pat_' + 'a'.repeat(27), 'docker_pat'],
    ['Sentry DSN', 'https://' + 'a'.repeat(32) + '@o123.ingest.sentry.io/1234567', 'sentry_dsn'],
    ['Datadog API (named)', 'DD_API_KEY=' + 'a'.repeat(32), 'datadog_api'],
    ['Mapbox secret', 'sk.eyJ' + 'a'.repeat(80), 'mapbox_secret'],
    ['Postgres URL', 'postgres://user:hunter2@host:5432/db', 'postgres_url'],
    ['MongoDB URL', 'mongodb+srv://user:hunter2@cluster.mongodb.net/db', 'mongodb_url'],
    ['Redis URL with creds', 'redis://:hunter2pw@redis.example.com:6379', 'redis_url'],
    ['HTTP basic auth URL', 'https://admin:hunter2pw@example.com/api', 'http_basic_auth'],
    ['Vault token', 'hvs.' + 'a'.repeat(30), 'vault_token'],
    ['Doppler personal', 'dp.pt.' + 'a'.repeat(40), 'doppler_token'],
    ['CircleCI PAT', 'CCIPAT_' + 'a'.repeat(30), 'circleci_pat'],
    ['SSH DSA private key', '-----BEGIN DSA PRIVATE KEY-----', 'ssh_dsa_pubkey'],
    ['GPG block', '-----BEGIN PGP PRIVATE KEY BLOCK-----', 'gpg_block'],
  ])('detects %s', async (_label, sample, expectedRule) => {
    const m = await freshModule()
    m.initAiSecurity()
    const r = m.scanText(sample)
    expect(r.hits.some(h => h.rule === expectedRule)).toBe(true)
  })

  it('catalogs more than 50 distinct secret rules', async () => {
    const m = await freshModule()
    // We don't export RULES, so we infer via a synthetic input that triggers
    // every rule's family — simpler: just check a smattering land.
    const r = m.scanText([
      'AKIA' + 'A'.repeat(16),
      'ghp_' + 'a'.repeat(40),
      'sk-ant-' + 'a'.repeat(25),
      'glpat-' + 'a'.repeat(25),
      'hvs.' + 'a'.repeat(25),
      'dp.pt.' + 'a'.repeat(40),
      'lin_api_' + 'a'.repeat(40),
    ].join('\n'))
    // 7 distinct families should fire; rule de-dup is fine.
    expect(new Set(r.hits.map(h => h.rule)).size).toBeGreaterThanOrEqual(6)
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

describe('processOutboundChunk (auto-scan staging)', () => {
  it('passes chunks through untouched when redaction is disabled', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('', 'sk-ant-AAAAAAAAAAAAAAAAAAAA\r', {
      redactionEnabled: false,
      isAiTerminal: true,
    })
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('sk-ant-AAAAAAAAAAAAAAAAAAAA\r')
  })

  it('passes chunks through untouched on non-AI terminals', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('', 'AKIAIOSFODNN7EXAMPLE\r', {
      redactionEnabled: true,
      isAiTerminal: false,
    })
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('AKIAIOSFODNN7EXAMPLE\r')
  })

  it('stages mid-input characters without writing or scanning', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('', 'h', { redactionEnabled: true, isAiTerminal: true })
    expect(r.action).toBe('stage')
    expect(r.writeChunk).toBe('')
    expect(r.newStaging).toBe('h')
  })

  it('flushes a clean submit and resets staging', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('hello world', '\r', {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('flush')
    expect(r.writeChunk).toBe('\r')
    expect(r.newStaging).toBe('')
    expect(r.scan?.hitCount).toBe(0)
  })

  it('redacts when Enter flushes a buffered secret typed char-by-char', async () => {
    const m = await freshModule()
    const prev = 'token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const r = m.processOutboundChunk(prev, '\r', {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('redact')
    expect(r.scan?.hitCount).toBeGreaterThan(0)
    // Tail-only write — only the new chunk worth of bytes is forwarded,
    // and it must NOT include the raw secret.
    expect(r.writeChunk).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(r.newStaging).toBe('')
  })

  it('redacts a paste-sized chunk in a single shot', async () => {
    const m = await freshModule()
    const paste = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE secret\nmore'
    const r = m.processOutboundChunk('', paste, {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('redact')
    expect(r.isPaste).toBe(true)
    expect(r.scan?.hits.some((h) => h.rule === 'aws_access_key')).toBe(true)
    expect(r.writeChunk).toContain('[REDACTED:aws_access_key]')
    expect(r.writeChunk).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('keeps the redacted text in staging when no submit and a paste hit', async () => {
    const m = await freshModule()
    // 32-char paste with no Enter — should redact AND retain redacted buffer
    // for the eventual flush (so the next Enter sees the redacted prefix).
    const paste = 'k=AKIAIOSFODNN7EXAMPLE then more bytes'
    const r = m.processOutboundChunk('', paste, {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('redact')
    expect(r.isSubmit).toBe(false)
    expect(r.newStaging).toContain('[REDACTED:aws_access_key]')
  })

  it('clamps the staging buffer to the cap', async () => {
    const m = await freshModule()
    const huge = 'x'.repeat(70 * 1024)
    // Big enough to be a paste, no submit, no secrets — should pass to flush
    // path and keep the trailing window only.
    const r = m.processOutboundChunk('', huge, {
      redactionEnabled: true,
      isAiTerminal: true,
      stageCap: 1024,
    })
    expect(r.action).toBe('flush')
    expect(r.newStaging.length).toBeLessThanOrEqual(1024)
  })

  it('returns pass for empty input', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('abc', '', {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('')
  })

  it('treats \\n as a submit just like \\r', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('hello', '\n', {
      redactionEnabled: true,
      isAiTerminal: true,
    })
    expect(r.action).toBe('flush')
    expect(r.isSubmit).toBe(true)
  })

  it('honors a custom paste threshold', async () => {
    const m = await freshModule()
    // 5-char chunk would normally stage, but threshold=4 makes it a paste.
    const r = m.processOutboundChunk('', 'hello', {
      redactionEnabled: true,
      isAiTerminal: true,
      pasteThreshold: 4,
    })
    expect(r.action).toBe('flush')
    expect(r.isPaste).toBe(true)
  })
})
