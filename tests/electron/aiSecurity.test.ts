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

  it('catalogs exactly 97 secret rules, each with a unique id', async () => {
    // RULES is exported, so the count is a fact we can pin rather than infer. It is also
    // load-bearing: secretRulesSync proves the standalone git-hook table matches this one,
    // so a rule added here without adding it there is a rule the commit shield cannot see.
    const m = await freshModule()
    expect(m.RULES.length).toBe(97)
    expect(new Set(m.RULES.map((r) => r.id)).size).toBe(97)
  })

  it('fires many independent rule families over one blob', async () => {
    const m = await freshModule()
    const r = m.scanText([
      'AKIA' + 'A'.repeat(16),
      'ghp_' + 'a'.repeat(40),
      'sk-ant-' + 'a'.repeat(25),
      'glpat-' + 'a'.repeat(25),
      'hvs.' + 'a'.repeat(25),
      'dp.pt.' + 'a'.repeat(40),
      'lin_api_' + 'a'.repeat(40),
    ].join('\n'))
    expect(new Set(r.hits.map(h => h.rule)).size).toBeGreaterThanOrEqual(6)
  })
})

// ===========================================================================================
// The NAMED rules: what leaked, by name, so you know what to rotate.
//
// The old rule table refused generic password patterns because a false positive REWROTE THE
// USER'S PROMPT — destructive. Now that a hit only ever writes a line to a log, the trade
// flipped: a false positive costs a log line, a miss costs a credential. Hence these six.
// ===========================================================================================
describe('aiSecurity.scanText — named secrets capture the NAME, never the value', () => {
  it.each([
    ['env_secret', 'DB_PASSWORD=hunter2hunter2', 'DB_PASSWORD'],
    ['json_secret', '{"apiKey": "' + 'a'.repeat(12) + '"}', 'apiKey'],
    ['password_literal', 'const password = "' + 'a'.repeat(8) + '"', 'password'],
    ['yaml_secret', 'db_password: ' + 'a'.repeat(8), 'db_password'],
    ['conn_string_password', 'Server=db;Password=' + 'a'.repeat(8) + ';', 'Password'],
    ['basic_auth_url', 'https://admin:' + 'a'.repeat(8) + '@example.com', 'admin'],
  ])('%s captures the identifier %s', async (rule, sample, expectedName) => {
    const m = await freshModule()
    const hit = m.scanText(sample).hits.find((h) => h.rule === rule)
    expect(hit).toBeDefined()
    expect(hit!.name).toBe(expectedName)
  })

  it('records the identifier but NEVER the secret value', async () => {
    const m = await freshModule()
    const hit = m.scanText('DB_PASSWORD=hunter2hunter2').hits.find((h) => h.rule === 'env_secret')!
    expect(hit.name).toBe('DB_PASSWORD')
    // The whole point: the name tells you what to rotate; the value is never captured.
    expect(hit.name).not.toContain('hunter2')
    expect(JSON.stringify({ rule: hit.rule, label: hit.label, name: hit.name })).not.toContain('hunter2')
  })

  it('leaves `name` undefined for rules that match a bare token (nothing to name)', async () => {
    const m = await freshModule()
    const hit = m.scanText('AKIA' + 'A'.repeat(16)).hits.find((h) => h.rule === 'aws_access_key')!
    expect(hit.name).toBeUndefined()
  })

  it('every named rule in the table declares a nameGroup, and no other rule does', async () => {
    const m = await freshModule()
    const named = m.RULES.filter((r) => r.nameGroup !== undefined).map((r) => r.id).sort()
    expect(named).toEqual([
      'basic_auth_url', 'conn_string_password', 'contextual_secret', 'env_secret',
      'json_secret', 'password_literal', 'yaml_secret',
    ])
  })
})

// contextual_secret is the only rule that catches a SHAPELESS secret — one with no vendor
// prefix and no `NAME=value` structure, introduced only by the words around it. That power is
// also its danger, so the false-positive guard (>=12 chars, AND a digit, AND a letter) matters
// as much as the catch does: a rule that fires on "rotate the api key" is a rule users mute.
describe('aiSecurity.scanText — contextual_secret (the shapeless-secret heuristic)', () => {
  it('catches a bare credential introduced by the words around it', async () => {
    const m = await freshModule()
    const prompt = 'here is the api key for this code: ' + 'a1' + 'a'.repeat(14)
    const hit = m.scanText(prompt).hits.find((h) => h.rule === 'contextual_secret')
    expect(hit).toBeDefined()
    expect(hit!.name).toBe('api key') // the trigger word is what we can name; there is no identifier
  })

  it.each([
    ['ordinary talk about rotating a key', 'please rotate the api key in production'],
    ['a question about a password reset', 'how do I reset the password for the admin account'],
    ['a code reference, not a value', 'const key = process.env.API_KEY'],
  ])('does NOT fire on %s', async (_label, prompt) => {
    const m = await freshModule()
    expect(m.scanText(prompt).hits.some((h) => h.rule === 'contextual_secret')).toBe(false)
  })
})

describe('aiSecurity settings persistence', () => {
  // `redactionEnabled` / `setRedactionEnabled()` are GONE, and the tests that drove them are
  // deleted rather than stubbed. The setting promised something it could not deliver — see the
  // processOutboundChunk suite below. What replaces it is not a different toggle: it is an
  // always-on watch with no off switch, so there is nothing left to persist.
  it('no longer carries a redaction setting — the key is absent, not merely false', async () => {
    const m = await freshModule()
    m.initAiSecurity()
    expect('redactionEnabled' in m.getSettings()).toBe(false)
    expect((m as Record<string, unknown>).setRedactionEnabled).toBeUndefined()
  })

  it('toggles audit and persists', async () => {
    const m1 = await freshModule()
    m1.setAuditEnabled(true)
    expect(existsSync(join(tmpDir, 'ai-security-settings.json'))).toBe(true)
    const m2 = await freshModule()
    expect(m2.getSettings().auditEnabled).toBe(true)
  })

  it('keeps the security gates ON when their key is absent (upgrades stay protected)', async () => {
    // An absent key means "never configured" — it must NOT read as "off", or every existing
    // install would silently lose the gate the moment it upgraded.
    writeFileSync(join(tmpDir, 'ai-security-settings.json'), JSON.stringify({ strictGeminiPaidOnly: true }))
    const m = await freshModule()
    const s = m.getSettings()
    expect(s.auditEnabled).toBe(true)
    expect(s.commitShield).toBe(true)
    expect(s.egressGuard).toBe(true)
    expect(s.memoryScrub).toBe(true)
    expect(s.strictGeminiPaidOnly).toBe(true)
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

  it('survives a corrupted settings JSON gracefully, and fails SECURE', async () => {
    writeFileSync(join(tmpDir, 'ai-security-settings.json'), '{ this is not json }')
    const m = await freshModule()
    // Should fall back to defaults, not throw — and a broken file must not disarm the gates.
    expect(() => m.initAiSecurity()).not.toThrow()
    const s = m.getSettings()
    expect(s.auditEnabled).toBe(true)
    expect(s.commitShield).toBe(true)
    expect(s.strictGeminiPaidOnly).toBe(false)
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
    expect(ids).toEqual(['claude', 'codex', 'gemini'])
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

// ===========================================================================================
// processOutboundChunk — WATCH, BUT DO NOT TOUCH.
//
// The old contract staged keystrokes ('stage'), withheld them from the PTY, and rewrote them
// on submit ('redact'). It was broken twice over, and both breakages are now pinned as tests:
//
//   1. 'stage' returned writeChunk: '' and the handler never wrote the buffer back, so typing
//      "hello" + Enter delivered only "\r". The user's text was eaten. See the "delivers every
//      byte" test — it fails against the old design and passes against this one.
//   2. It could not have worked anyway: a TUI agent already holds the line in ITS OWN buffer by
//      the time you press Enter, so writing a "redacted" copy to the PTY would APPEND, not
//      replace. You cannot un-send what the agent is already holding.
//
// So the actions are now only 'pass' and 'observed', and `writeChunk` is ALWAYS `data`.
// Detection, not prevention — and honest about which it is.
// ===========================================================================================
describe('processOutboundChunk — the "don\'t touch" contract', () => {
  const AI = { isAiTerminal: true }
  const AWS = 'AKIA' + 'A'.repeat(16)
  const GH_PAT = 'ghp_' + 'a'.repeat(36)

  it('THE INVARIANT: writeChunk is ALWAYS exactly `data` — never withheld, never rewritten', async () => {
    const m = await freshModule()
    const cases: [string, string, Parameters<typeof m.processOutboundChunk>[2]][] = [
      ['', 'h', AI], // mid-typing
      ['hello', '\r', AI], // clean submit
      ['token=' + GH_PAT, '\r', AI], // submit carrying a secret
      ['', `AWS_ACCESS_KEY_ID=${AWS} and then some`, AI], // paste carrying a secret
      ['', 'x'.repeat(70 * 1024), { ...AI, stageCap: 1024 }], // oversized paste
      ['', AWS + '\r', { isAiTerminal: false }], // non-AI terminal
      ['abc', '', AI], // empty chunk
    ]
    for (const [prev, data, opts] of cases) {
      const r = m.processOutboundChunk(prev, data, opts)
      expect(r.writeChunk).toBe(data)
      expect(r.writeChunk).not.toContain('[REDACTED:')
    }
  })

  it('delivers EVERY byte of a typed prompt — "hello\\r" arrives as "hello\\r", not "\\r"', async () => {
    // This is the regression the rewrite exists to kill. Under the old 'stage' design the
    // handler wrote nothing until submit and then wrote only the newest chunk, so this loop
    // delivered '\r' and the user watched their typing vanish.
    const m = await freshModule()
    let staging = ''
    let delivered = ''
    for (const ch of ['h', 'e', 'l', 'l', 'o', '\r']) {
      const r = m.processOutboundChunk(staging, ch, AI)
      delivered += r.writeChunk
      staging = r.newStaging
    }
    expect(delivered).toBe('hello\r')
    expect(staging).toBe('') // submit resets the shadow buffer
  })

  it('only ever returns pass or observed — stage / flush / redact are gone', async () => {
    const m = await freshModule()
    const seen = [
      m.processOutboundChunk('', 'h', AI),
      m.processOutboundChunk('hello', '\r', AI),
      m.processOutboundChunk('t=' + GH_PAT, '\r', AI),
      m.processOutboundChunk('', 'x'.repeat(40), AI),
      m.processOutboundChunk('', AWS, { isAiTerminal: false }),
    ].map((r) => r.action)
    for (const action of seen) expect(['pass', 'observed']).toContain(action)
  })

  it('mid-typing: passes the keystroke straight through and only shadows it (no scan)', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('', 'h', AI)
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('h') // forwarded IMMEDIATELY — the old code returned ''
    expect(r.newStaging).toBe('h')
    expect(r.scan).toBeUndefined() // never scanned per keystroke
    expect(r.isSubmit).toBe(false)
    expect(r.isPaste).toBe(false)
  })

  it('does not scan per keystroke — a secret is only reported once it is SUBMITTED', async () => {
    const m = await freshModule()
    let staging = ''
    let delivered = ''
    for (const ch of ('token=' + GH_PAT).split('')) {
      const r = m.processOutboundChunk(staging, ch, AI)
      expect(r.action).toBe('pass') // mid-typing is never reported...
      expect(r.scan).toBeUndefined() // ...and never even scanned
      expect(r.writeChunk).toBe(ch) // but every byte still goes out
      delivered += r.writeChunk
      staging = r.newStaging
    }
    const submit = m.processOutboundChunk(staging, '\r', AI)
    expect(submit.action).toBe('observed') // only NOW do we look
    expect(submit.scan!.hits.some((h) => h.rule === 'gh_pat')).toBe(true)
    // And the honest part: the secret was already delivered, character by character.
    expect(delivered).toBe('token=' + GH_PAT)
  })

  it('clean submit: pass, staging reset, scan ran and found nothing', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('hello world', '\r', AI)
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('\r')
    expect(r.newStaging).toBe('')
    expect(r.isSubmit).toBe(true)
    expect(r.scan?.hitCount).toBe(0)
  })

  it('a submitted secret is OBSERVED — recorded, never rewritten, and already gone', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('token=' + GH_PAT, '\r', AI)
    expect(r.action).toBe('observed')
    expect(r.scan!.hitCount).toBeGreaterThan(0)
    expect(r.scan!.hits.some((h) => h.rule === 'gh_pat')).toBe(true)
    // We do NOT claim to have stopped anything. The chunk goes out exactly as typed; the
    // preceding keystrokes already carried the secret to the agent.
    expect(r.writeChunk).toBe('\r')
    expect(r.newStaging).toBe('')
  })

  it('a pasted secret is OBSERVED in one shot and forwarded VERBATIM', async () => {
    const m = await freshModule()
    const paste = `AWS_ACCESS_KEY_ID=${AWS} secret\nmore`
    const r = m.processOutboundChunk('', paste, AI)
    expect(r.action).toBe('observed')
    expect(r.isPaste).toBe(true)
    expect(r.scan!.hits.some((h) => h.rule === 'aws_access_key')).toBe(true)
    // The strong claim, replacing the old "it was redacted": the raw key reached the agent
    // unmodified, and all we did was write down that it happened.
    expect(r.writeChunk).toBe(paste)
    expect(r.writeChunk).toContain(AWS)
    expect(r.writeChunk).not.toContain('[REDACTED:aws_access_key]')
  })

  it('a paste with no submit keeps the RAW text shadowed — never a redacted copy', async () => {
    const m = await freshModule()
    const paste = `k=${AWS} then more bytes`
    const r = m.processOutboundChunk('', paste, AI)
    expect(r.action).toBe('observed')
    expect(r.isSubmit).toBe(false)
    expect(r.writeChunk).toBe(paste)
    expect(r.newStaging).toBe(paste) // the shadow buffer mirrors what really went out
    expect(r.newStaging).not.toContain('[REDACTED:')
  })

  it('non-AI terminal: passes through, never scans, and holds no shadow buffer', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('leftover', AWS + '\r', { isAiTerminal: false })
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe(AWS + '\r')
    expect(r.scan).toBeUndefined()
    expect(r.newStaging).toBe('') // nothing is retained for a shell we are not watching
  })

  it('clamps the shadow buffer to the cap while still forwarding the whole chunk', async () => {
    const m = await freshModule()
    const huge = 'x'.repeat(70 * 1024)
    const r = m.processOutboundChunk('', huge, { ...AI, stageCap: 1024 })
    expect(r.action).toBe('pass')
    expect(r.newStaging.length).toBeLessThanOrEqual(1024) // only the buffer is bounded...
    expect(r.writeChunk).toBe(huge) // ...never the data
  })

  it('returns pass for empty input', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('abc', '', AI)
    expect(r.action).toBe('pass')
    expect(r.writeChunk).toBe('')
    expect(r.newStaging).toBe('abc') // an empty chunk changes nothing
  })

  it('treats \\n as a submit just like \\r', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('hello', '\n', AI)
    expect(r.action).toBe('pass')
    expect(r.isSubmit).toBe(true)
    expect(r.writeChunk).toBe('\n')
  })

  it('honors a custom paste threshold', async () => {
    const m = await freshModule()
    // 5 chars would normally be mid-typing; threshold=4 makes it a paste, so it gets scanned.
    const r = m.processOutboundChunk('', 'hello', { ...AI, pasteThreshold: 4 })
    expect(r.action).toBe('pass')
    expect(r.isPaste).toBe(true)
    expect(r.scan).toBeDefined() // a paste IS scanned, even without a newline
    expect(r.writeChunk).toBe('hello')
  })
})

describe('aiSecurity.detectCodeChunk', () => {
  it('returns isCode=false for short text', async () => {
    const m = await freshModule()
    const r = m.detectCodeChunk('hi there')
    expect(r.isCode).toBe(false)
    expect(r.byteSize).toBeGreaterThan(0)
  })

  it('flags a >2 KB JS-shaped paste with multiple signals', async () => {
    const m = await freshModule()
    const code = Array.from({ length: 80 }, (_, i) =>
      `  function thing${i}(arg) {\n    const x = arg + 1;\n    return x;\n  }`,
    ).join('\n')
    const r = m.detectCodeChunk(code)
    expect(r.byteSize).toBeGreaterThan(2048)
    expect(r.isCode).toBe(true)
    expect(r.signals.length).toBeGreaterThanOrEqual(2)
    expect(r.signals).toContain('keywords')
  })

  it('does NOT flag a >2 KB plain prose paste', async () => {
    const m = await freshModule()
    // Long lorem-ipsum without indentation, braces, or code keywords.
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(80)
    const r = m.detectCodeChunk(prose)
    expect(r.byteSize).toBeGreaterThan(2048)
    expect(r.isCode).toBe(false)
  })

  it('detects a Python-style paste', async () => {
    const m = await freshModule()
    const code =
      'import os\nfrom typing import List\n\n' +
      Array.from({ length: 50 }, (_, i) =>
        `def fn${i}(x):\n    if x > 0:\n        return x * 2\n    return 0`,
      ).join('\n\n')
    const r = m.detectCodeChunk(code)
    expect(r.isCode).toBe(true)
    expect(r.signals).toContain('module-decl')
  })

  it('honors a custom byte threshold', async () => {
    const m = await freshModule()
    const code = '  function f() { return 1; }\n'.repeat(20)
    const small = m.detectCodeChunk(code, 10_000)
    expect(small.isCode).toBe(false)
    const big = m.detectCodeChunk(code, 100)
    expect(big.isCode).toBe(true)
  })
})

describe('aiSecurity.detectEnvDump', () => {
  it('returns isEnvDump=false for empty input', async () => {
    const m = await freshModule()
    const r = m.detectEnvDump('')
    expect(r.isEnvDump).toBe(false)
    expect(r.varCount).toBe(0)
  })

  it('flags a 5+ line env dump', async () => {
    const m = await freshModule()
    const env = [
      'DATABASE_URL=postgres://x',
      'API_KEY=abc',
      'SECRET_KEY=def',
      'NODE_ENV=production',
      'PORT=3000',
      'REDIS_URL=redis://x',
    ].join('\n')
    const r = m.detectEnvDump(env)
    expect(r.isEnvDump).toBe(true)
    expect(r.varCount).toBe(6)
    expect(r.variableNames).toContain('DATABASE_URL')
  })

  it('handles "export FOO=bar" prefix', async () => {
    const m = await freshModule()
    const env = Array.from({ length: 6 }, (_, i) => `export VAR_${i}=value${i}`).join('\n')
    const r = m.detectEnvDump(env)
    expect(r.isEnvDump).toBe(true)
    expect(r.varCount).toBe(6)
  })

  it('does NOT flag a single export FOO=bar line', async () => {
    const m = await freshModule()
    const r = m.detectEnvDump('export FOO=bar\nexport BAZ=qux')
    expect(r.isEnvDump).toBe(false)
  })

  it('caps stored variable names at 20 to avoid runaway memory', async () => {
    const m = await freshModule()
    const env = Array.from({ length: 50 }, (_, i) => `VAR_${i}=value${i}`).join('\n')
    const r = m.detectEnvDump(env)
    expect(r.varCount).toBe(50)
    expect(r.variableNames.length).toBe(20)
  })
})

describe('aiSecurity.processOutboundChunk — code/env hints', () => {
  const AI = { isAiTerminal: true }

  it('attaches codeChunk on submit when the prompt looks like code — and still forwards it', async () => {
    const m = await freshModule()
    const code = Array.from({ length: 80 }, (_, i) =>
      `  function thing${i}(a) {\n    const x = a + 1;\n    return x;\n  }`,
    ).join('\n')
    const r = m.processOutboundChunk('', code + '\r', AI)
    expect(r.action).toBe('pass') // a big code paste is a HINT, never a block
    expect(r.codeChunk?.isCode).toBe(true)
    expect(r.writeChunk).toBe(code + '\r')
  })

  it('attaches envDump on submit when the prompt looks like a .env paste', async () => {
    const m = await freshModule()
    const env =
      ['DATABASE_URL=p://x', 'API_KEY=a', 'SECRET_KEY=s', 'NODE_ENV=p', 'PORT=3000', 'REDIS_URL=r://x'].join('\n') +
      '\r'
    const r = m.processOutboundChunk('', env, AI)
    expect(r.action).toBe('pass')
    expect(r.envDump?.isEnvDump).toBe(true)
    expect(r.writeChunk).toBe(env)
  })

  it('omits codeChunk/envDump when prompt is plain prose', async () => {
    const m = await freshModule()
    const r = m.processOutboundChunk('', 'hello world this is a normal prompt\r', AI)
    expect(r.action).toBe('pass')
    expect(r.codeChunk).toBeUndefined()
    expect(r.envDump).toBeUndefined()
  })

  it('reports a real .env paste as OBSERVED *and* an env dump, and forwards it intact', async () => {
    const m = await freshModule()
    const env = [
      'DATABASE_URL=postgres://u:pw@h/db',
      'DB_PASSWORD=hunter2hunter2',
      'STRIPE_SECRET=' + 'a'.repeat(20),
      'NODE_ENV=production',
      'PORT=3000',
      'REDIS_URL=redis://h',
    ].join('\n') + '\r'
    const r = m.processOutboundChunk('', env, AI)
    expect(r.action).toBe('observed')
    expect(r.envDump?.isEnvDump).toBe(true)
    expect(r.scan!.hits.some((h) => h.name === 'DB_PASSWORD')).toBe(true)
    expect(r.writeChunk).toBe(env) // the .env still went to the model, whole
  })
})

// The audit log is now the ONLY record that a secret was sent, so the three events that say
// so have to survive a round-trip. `redaction_hit` is legacy: read-only, never written again.
describe('aiSecurity audit — the events that record what was SENT', () => {
  it.each(['prompt_secret_sent', 'code_chunk_sent', 'env_dump_sent'] as const)(
    'round-trips a %s entry',
    async (event) => {
      const m = await freshModule()
      m.setAuditEnabled(true)
      await m.appendAudit({ agent: 'claude', event, terminalId: 't1', hitCount: 2, notes: 'DB_PASSWORD (env_secret)' })
      const [entry] = await m.getRecentAudit()
      expect(entry.event).toBe(event)
      expect(entry.agent).toBe('claude')
      expect(entry.ts).toBeTruthy()
    },
  )

  it('records the NAME of what leaked, so you know what to rotate — never the value', async () => {
    const m = await freshModule()
    m.setAuditEnabled(true)
    const scan = m.scanText('DB_PASSWORD=hunter2hunter2')
    await m.appendAudit({
      agent: 'claude',
      event: 'prompt_secret_sent',
      hitCount: scan.hitCount,
      notes: [...new Set(scan.hits.map((h) => (h.name ? `${h.name} (${h.rule})` : h.rule)))].join(', '),
    })
    const [entry] = await m.getRecentAudit()
    expect(entry.notes).toContain('DB_PASSWORD')
    expect(entry.notes).not.toContain('hunter2') // the value never reaches the log
  })
})
