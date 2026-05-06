// AI Security Center — outbound prompt redaction + cloud-bound audit log.
//
// The premise: every AI agent that Termpolis launches reads from its terminal
// PTY. Any secret the user types is forwarded to the agent's network call.
// The provider's commercial-tier ToS already excludes API traffic from training,
// but a leaked AWS key or .env still got *transmitted*. Redaction + audit log
// give security-conscious teams a verifiable record (and, optionally, a way to
// detect well-shaped secrets in the prompt path).
//
// Storage: JSONL file in userData with size-bounded rotation. Settings are a
// small JSON file alongside it. Both are local-only — no network.

import { app } from 'electron'
import { promises as fs, existsSync, mkdirSync, statSync, renameSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'ai-security-settings.json'
const AUDIT_FILE = 'ai-security-audit.jsonl'
const AUDIT_PREV = 'ai-security-audit.prev.jsonl'
const MAX_AUDIT_BYTES = 10 * 1024 * 1024

export interface AiSecuritySettings {
  redactionEnabled: boolean
  auditEnabled: boolean
  strictGeminiPaidOnly: boolean
}

export interface AuditEntry {
  ts: string
  agent: string
  event: 'terminal_open' | 'terminal_close' | 'redaction_hit' | 'manual_scan'
  terminalId?: string
  byteCount?: number
  hitCount?: number
  notes?: string
}

interface RedactionRule {
  id: string
  label: string
  pattern: RegExp
}

// Patterns scoped to well-shaped, low-false-positive secrets. We deliberately
// avoid generic password regexes — those produce too many false hits and
// erode user trust. Real secret scanners on top of our pipeline (Gitleaks,
// truffleHog) can be added later, but for in-the-loop terminal use, the
// catch-rate of the rules below covers the highest-risk patterns.
const RULES: RedactionRule[] = [
  // === AWS ===
  { id: 'aws_access_key', label: 'AWS Access Key ID', pattern: /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g },
  { id: 'aws_secret', label: 'AWS Secret-shaped 40-char base64', pattern: /\b(?:aws_secret|secret_access_key|aws_secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { id: 'aws_session_token', label: 'AWS session token', pattern: /\b(?:aws_session_token|x-amz-security-token)\s*[:=]\s*["']?([A-Za-z0-9/+=]{100,})["']?/gi },
  // === GitHub ===
  { id: 'gh_pat', label: 'GitHub PAT (ghp/gho/ghu/ghs/ghr)', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'gh_fine_grained', label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // === GitLab / Bitbucket ===
  { id: 'gitlab_pat', label: 'GitLab PAT', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'gitlab_runner', label: 'GitLab Runner token', pattern: /\bglrt-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'bitbucket_app_pw', label: 'Bitbucket app password', pattern: /\bATBB[A-Za-z0-9]{32,}\b/g },
  // === AI providers ===
  { id: 'openai_key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic_key', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google_api', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'huggingface', label: 'HuggingFace token', pattern: /\bhf_[A-Za-z0-9]{34}\b/g },
  { id: 'cohere_key', label: 'Cohere API key', pattern: /\b(?:COHERE_API_KEY|cohere_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{40})["']?/g },
  { id: 'replicate_token', label: 'Replicate API token', pattern: /\br8_[A-Za-z0-9]{40}\b/g },
  // === Azure ===
  { id: 'azure_storage_key', label: 'Azure Storage AccountKey', pattern: /AccountKey\s*=\s*([A-Za-z0-9+/=]{86,90})/g },
  { id: 'azure_sas', label: 'Azure SAS signature', pattern: /[?&]sig=([A-Za-z0-9%]{40,})/g },
  { id: 'azure_conn_string', label: 'Azure connection string', pattern: /DefaultEndpointsProtocol=https?;[^;\s]*AccountName=[^;\s]+;[^\s]*AccountKey=[^;\s]+/g },
  { id: 'azure_devops_pat', label: 'Azure DevOps PAT', pattern: /\b(?:AZURE_DEVOPS_PAT|ADO_PAT|VSTS_PAT|SYSTEM_ACCESSTOKEN)\s*[:=]\s*["']?([a-z0-9]{52})["']?/gi },
  { id: 'azure_client_secret', label: 'Azure AD client secret (named)', pattern: /\b(?:AZURE_CLIENT_SECRET|ARM_CLIENT_SECRET|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9~_.-]{34,})["']?/gi },
  // === GCP ===
  { id: 'gcp_sa_json', label: 'GCP service-account JSON', pattern: /"type"\s*:\s*"service_account"/g },
  { id: 'gcp_oauth_client', label: 'GCP OAuth client ID', pattern: /\b[0-9]{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com\b/g },
  // === Slack / chat ===
  { id: 'slack_token', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack_webhook', label: 'Slack incoming webhook', pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}\b/g },
  { id: 'discord_bot', label: 'Discord bot token', pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}\b/g },
  { id: 'discord_webhook', label: 'Discord webhook', pattern: /\bhttps:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}\b/g },
  { id: 'telegram_bot', label: 'Telegram bot token', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // === Payments ===
  { id: 'stripe_secret', label: 'Stripe secret key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'stripe_pub', label: 'Stripe publishable key (info)', pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'paypal_braintree', label: 'PayPal Braintree access token', pattern: /\baccess_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}\b/g },
  { id: 'square_oauth', label: 'Square OAuth secret', pattern: /\bsq0(?:csp|atp|idp)-[A-Za-z0-9_-]{22,}\b/g },
  // === Comms / email ===
  { id: 'twilio_sid', label: 'Twilio Account SID', pattern: /\bAC[a-f0-9]{32}\b/g },
  { id: 'twilio_token', label: 'Twilio auth token (named)', pattern: /\b(?:TWILIO_AUTH_TOKEN|twilio_auth_token)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'sendgrid_key', label: 'SendGrid API key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'mailgun_key', label: 'Mailgun API key', pattern: /\bkey-[a-f0-9]{32}\b/g },
  { id: 'mailchimp_key', label: 'Mailchimp API key', pattern: /\b[a-f0-9]{32}-us\d{1,2}\b/g },
  { id: 'postmark_token', label: 'Postmark server token', pattern: /\b(?:POSTMARK_(?:SERVER|API)_TOKEN|postmark_token)\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']?/gi },
  // === Cloud / infra ===
  { id: 'cloudflare_api', label: 'Cloudflare API token', pattern: /\b(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\s*[:=]\s*["']?([A-Za-z0-9_-]{40})["']?/gi },
  { id: 'cloudflare_global', label: 'Cloudflare Global API key', pattern: /\b[a-f0-9]{37}\b(?=.*cloudflare|cloudflare.*)/gi },
  { id: 'digitalocean_pat', label: 'DigitalOcean PAT', pattern: /\bdo[opt]_v1_[a-f0-9]{64}\b/g },
  { id: 'heroku_api', label: 'Heroku API key (named)', pattern: /\b(?:HEROKU_API_KEY|heroku_api_key)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi },
  { id: 'netlify_token', label: 'Netlify token (named)', pattern: /\b(?:NETLIFY_AUTH_TOKEN|netlify_auth_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{40,})["']?/gi },
  { id: 'vercel_token', label: 'Vercel token (named)', pattern: /\b(?:VERCEL_TOKEN|vercel_token)\s*[:=]\s*["']?([A-Za-z0-9]{24})["']?/gi },
  { id: 'fly_api', label: 'Fly.io API token', pattern: /\bfo1_[A-Za-z0-9_-]{20,}\b/g },
  { id: 'render_api', label: 'Render API key', pattern: /\brnd_[A-Za-z0-9]{30,}\b/g },
  { id: 'pulumi_pat', label: 'Pulumi PAT', pattern: /\bpul-[a-f0-9]{40}\b/g },
  // === Project mgmt / dev tools ===
  { id: 'linear_api', label: 'Linear API key', pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{40,}\b/g },
  { id: 'notion_secret', label: 'Notion integration secret', pattern: /\bsecret_[A-Za-z0-9]{43}\b/g },
  { id: 'asana_pat', label: 'Asana PAT', pattern: /\b\d+\/[a-f0-9]{32}:[a-f0-9]{32}\b/g },
  { id: 'jira_token', label: 'Jira/Atlassian API token', pattern: /\b(?:JIRA_API_TOKEN|ATLASSIAN_API_TOKEN|jira_api_token)\s*[:=]\s*["']?([A-Za-z0-9]{24,})["']?/gi },
  { id: 'figma_pat', label: 'Figma PAT', pattern: /\bfigd_[A-Za-z0-9_-]{30,}\b/g },
  // === Package registries ===
  { id: 'npm_token', label: 'npm access token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'npm_authtoken_line', label: 'npm _authToken line', pattern: /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_-]+/g },
  { id: 'pypi_token', label: 'PyPI upload token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]+/g },
  { id: 'docker_pat', label: 'Docker Hub PAT', pattern: /\bdckr_pat_[A-Za-z0-9_-]{27,}\b/g },
  // === Monitoring / analytics ===
  { id: 'sentry_dsn', label: 'Sentry DSN', pattern: /\bhttps:\/\/[a-f0-9]{32}@[a-z0-9.-]+\/\d+\b/g },
  { id: 'datadog_api', label: 'Datadog API key (named)', pattern: /\b(?:DD_API_KEY|DATADOG_API_KEY|datadog_api_key)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'datadog_app', label: 'Datadog APP key (named)', pattern: /\b(?:DD_APP_KEY|DATADOG_APP_KEY|datadog_app_key)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'pagerduty', label: 'PagerDuty token (named)', pattern: /\b(?:PAGERDUTY_(?:API_)?TOKEN|pagerduty_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{20,})["']?/gi },
  { id: 'algolia_admin', label: 'Algolia admin key (named)', pattern: /\b(?:ALGOLIA_(?:ADMIN_)?API_KEY|algolia_admin_api_key)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'mapbox_secret', label: 'Mapbox secret token', pattern: /\bsk\.eyJ[A-Za-z0-9_-]{50,}\b/g },
  { id: 'okta_token', label: 'Okta API token (named)', pattern: /\b(?:OKTA_API_TOKEN|okta_api_token)\s*[:=]\s*["']?(00[A-Za-z0-9_-]{40})["']?/gi },
  { id: 'auth0_secret', label: 'Auth0 client secret (named)', pattern: /\b(?:AUTH0_CLIENT_SECRET|auth0_client_secret)\s*[:=]\s*["']?([A-Za-z0-9_-]{40,})["']?/gi },
  // === Database connection strings ===
  { id: 'postgres_url', label: 'Postgres URL with credentials', pattern: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+\/[^\s]+/g },
  { id: 'mysql_url', label: 'MySQL URL with credentials', pattern: /\bmysql:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+\/[^\s]+/g },
  { id: 'mongodb_url', label: 'MongoDB URL with credentials', pattern: /\bmongodb(?:\+srv)?:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+/g },
  { id: 'redis_url', label: 'Redis URL with credentials', pattern: /\bredis(?:s)?:\/\/[^:\s/]*:[^@\s/]+@[^/\s]+/g },
  { id: 'http_basic_auth', label: 'HTTP basic-auth URL', pattern: /\bhttps?:\/\/[^:\s/]+:[^@\s/]{6,}@[^\s]+/g },
  // === Secrets vaults / 1P / KMS ===
  { id: 'vault_token', label: 'HashiCorp Vault token', pattern: /\bhvs\.[A-Za-z0-9_-]{20,}\b/g },
  { id: 'vault_legacy', label: 'HashiCorp Vault legacy token (named)', pattern: /\b(?:VAULT_TOKEN|vault_token)\s*[:=]\s*["']?(s\.[A-Za-z0-9]{24,})["']?/gi },
  { id: 'tfcloud_token', label: 'Terraform Cloud token (named)', pattern: /\b(?:TFE_TOKEN|TF_CLOUD_TOKEN|TFC_TOKEN)\s*[:=]\s*["']?([A-Za-z0-9]+\.atlasv1\.[A-Za-z0-9]+)["']?/gi },
  { id: 'doppler_token', label: 'Doppler personal token', pattern: /\bdp\.pt\.[A-Za-z0-9]{40,}\b/g },
  { id: 'doppler_service', label: 'Doppler service token', pattern: /\bdp\.st\.[A-Za-z0-9]{40,}\b/g },
  { id: 'onepassword_secret', label: '1Password Connect secret', pattern: /\bops_[A-Za-z0-9_-]{30,}\b/g },
  // === GitHub additional ===
  { id: 'gh_oauth_secret', label: 'GitHub OAuth client secret (named)', pattern: /\b(?:GH_CLIENT_SECRET|GITHUB_CLIENT_SECRET)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'gh_app_jwt_named', label: 'GitHub App private key (named)', pattern: /\b(?:GITHUB_APP_PRIVATE_KEY|GH_APP_PRIVATE_KEY)\s*[:=]/gi },
  { id: 'gh_runner_token', label: 'GitHub Actions runner token', pattern: /\bA[A-Z2-7]{31}\b(?=.*runner|runner.*)/gi },
  // === CI/CD ===
  { id: 'circleci_pat', label: 'CircleCI PAT', pattern: /\bCCIPAT_[A-Za-z0-9_-]{30,}\b/g },
  { id: 'circleci_legacy', label: 'CircleCI legacy token (named)', pattern: /\b(?:CIRCLECI_API_TOKEN|circle_token)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'travis_token', label: 'Travis CI token (named)', pattern: /\b(?:TRAVIS_(?:API_)?TOKEN|travis_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{20,})["']?/gi },
  { id: 'codecov_token', label: 'Codecov upload token', pattern: /\b(?:CODECOV_TOKEN|codecov_token)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi },
  // === Observability ===
  { id: 'newrelic_license', label: 'New Relic license key (named)', pattern: /\b(?:NEW_RELIC_LICENSE_KEY|NR_LICENSE_KEY)\s*[:=]\s*["']?([A-Fa-f0-9]{40}|[A-Za-z0-9]{40}NRAL)["']?/gi },
  { id: 'rollbar_token', label: 'Rollbar access token (named)', pattern: /\b(?:ROLLBAR_(?:ACCESS_)?TOKEN|rollbar_token)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'honeycomb_key', label: 'Honeycomb API key (named)', pattern: /\b(?:HONEYCOMB_API_KEY|honeycomb_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{32})["']?/gi },
  { id: 'lightstep_token', label: 'Lightstep access token (named)', pattern: /\b(?:LIGHTSTEP_ACCESS_TOKEN|lightstep_token)\s*[:=]\s*["']?([A-Za-z0-9]{40,})["']?/gi },
  // === SSH / GPG ===
  { id: 'ssh_dsa_pubkey', label: 'SSH DSA private key block', pattern: /-----BEGIN DSA PRIVATE KEY-----/g },
  { id: 'gpg_block', label: 'GPG/PGP private key block', pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g },
  // === Auth tokens that show up in headers ===
  { id: 'bearer_token_named', label: 'Bearer token in named env (named)', pattern: /\b(?:AUTH_BEARER|AUTHORIZATION|BEARER_TOKEN)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._-]{40,})["']?/gi },
  // === Crypto / financial ===
  { id: 'coinbase_pat', label: 'Coinbase API key (named)', pattern: /\b(?:COINBASE_API_KEY|coinbase_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{32})["']?/gi },
  // === Generic high-confidence shapes ===
  { id: 'jwt', label: 'JWT (3-part base64url)', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'private_key', label: 'PEM private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // === .env-style — last because it's the loosest catch-all. ===
  { id: 'env_secret', label: '.env-style SECRET/TOKEN/KEY assignment', pattern: /\b(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|CREDENTIALS))\s*=\s*["']?[^\s"'#]{8,}["']?/g },
]

let userDataDir = ''
let settings: AiSecuritySettings = { redactionEnabled: false, auditEnabled: false, strictGeminiPaidOnly: false }
let initialized = false

function settingsPath(): string { return join(userDataDir, SETTINGS_FILE) }
function auditPath(): string { return join(userDataDir, AUDIT_FILE) }
function auditPrevPath(): string { return join(userDataDir, AUDIT_PREV) }

export function initAiSecurity(): void {
  if (initialized) return
  userDataDir = app.getPath('userData')
  if (!existsSync(userDataDir)) {
    try { mkdirSync(userDataDir, { recursive: true }) } catch {}
  }
  try {
    if (existsSync(settingsPath())) {
      const raw = require('fs').readFileSync(settingsPath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        settings = {
          redactionEnabled: parsed.redactionEnabled === true,
          auditEnabled: parsed.auditEnabled === true,
          strictGeminiPaidOnly: parsed.strictGeminiPaidOnly === true,
        }
      }
    }
  } catch {}
  initialized = true
}

function persist(): void {
  try { require('fs').writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)) } catch {}
}

export function getSettings(): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  return { ...settings }
}

export function setRedactionEnabled(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.redactionEnabled = value === true
  persist()
  return getSettings()
}

export function setAuditEnabled(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.auditEnabled = value === true
  persist()
  return getSettings()
}

export function setStrictGeminiPaidOnly(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.strictGeminiPaidOnly = value === true
  persist()
  return getSettings()
}

export interface ScanResult {
  hitCount: number
  hits: { rule: string; label: string; sample: string }[]
  redacted: string
}

// Result of staging an outbound terminal:write chunk through the scanner.
//   action: 'pass' — forward `data` as-is, no scan ran (gate off, non-AI term, mid-input)
//           'stage' — buffered into `newStaging`, no PTY write
//           'redact' — flush triggered with hits; forward `writeChunk` (the
//                      redacted tail) instead of the raw `data`
//           'flush'  — flush triggered, no hits; forward `data` as-is
export interface OutboundDecision {
  action: 'pass' | 'stage' | 'flush' | 'redact'
  writeChunk: string
  newStaging: string
  scan?: ScanResult
  isSubmit: boolean
  isPaste: boolean
}

export interface OutboundOptions {
  redactionEnabled: boolean
  isAiTerminal: boolean
  pasteThreshold?: number
  stageCap?: number
}

const DEFAULT_PASTE_THRESHOLD = 32
const DEFAULT_STAGE_CAP = 64 * 1024

export function processOutboundChunk(
  prevStaging: string,
  data: string,
  opts: OutboundOptions,
): OutboundDecision {
  const pasteThreshold = opts.pasteThreshold ?? DEFAULT_PASTE_THRESHOLD
  const stageCap = opts.stageCap ?? DEFAULT_STAGE_CAP
  if (typeof data !== 'string' || data.length === 0) {
    return { action: 'pass', writeChunk: data ?? '', newStaging: prevStaging, isSubmit: false, isPaste: false }
  }
  if (!opts.redactionEnabled || !opts.isAiTerminal) {
    return { action: 'pass', writeChunk: data, newStaging: '', isSubmit: false, isPaste: false }
  }
  let buf = (prevStaging || '') + data
  if (buf.length > stageCap) buf = buf.slice(-stageCap)
  const isSubmit = /[\r\n]/.test(data)
  const isPaste = data.length >= pasteThreshold
  if (!isSubmit && !isPaste) {
    return { action: 'stage', writeChunk: '', newStaging: buf, isSubmit, isPaste }
  }
  const scan = scanText(buf)
  if (scan.hitCount > 0) {
    const redactedTail = scan.redacted.slice((prevStaging || '').length)
    return {
      action: 'redact',
      writeChunk: redactedTail,
      newStaging: isSubmit ? '' : scan.redacted,
      scan,
      isSubmit,
      isPaste,
    }
  }
  return {
    action: 'flush',
    writeChunk: data,
    newStaging: isSubmit ? '' : buf,
    scan,
    isSubmit,
    isPaste,
  }
}

export function scanText(input: string): ScanResult {
  if (typeof input !== 'string' || !input) {
    return { hitCount: 0, hits: [], redacted: input ?? '' }
  }
  let redacted = input
  const hits: ScanResult['hits'] = []
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    while ((m = re.exec(input)) !== null) {
      const matched = m[0]
      const sample = matched.length <= 8 ? '****' : matched.slice(0, 4) + '…' + matched.slice(-2)
      hits.push({ rule: rule.id, label: rule.label, sample })
      redacted = redacted.split(matched).join('[REDACTED:' + rule.id + ']')
      if (re.flags.indexOf('g') === -1) break
    }
  }
  return { hitCount: hits.length, hits, redacted }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(auditPath())) return
    const sz = statSync(auditPath()).size
    if (sz < MAX_AUDIT_BYTES) return
    if (existsSync(auditPrevPath())) {
      try { require('fs').unlinkSync(auditPrevPath()) } catch {}
    }
    renameSync(auditPath(), auditPrevPath())
  } catch {}
}

export async function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  if (!initialized) initAiSecurity()
  if (!settings.auditEnabled) return
  rotateIfNeeded()
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry }
  try {
    await fs.appendFile(auditPath(), JSON.stringify(full) + '\n', 'utf8')
  } catch {}
}

export async function getRecentAudit(limit = 200): Promise<AuditEntry[]> {
  if (!initialized) initAiSecurity()
  if (!existsSync(auditPath())) return []
  try {
    const raw = await fs.readFile(auditPath(), 'utf8')
    const lines = raw.split(/\r?\n/).filter(Boolean)
    const tail = lines.slice(Math.max(0, lines.length - limit))
    const out: AuditEntry[] = []
    for (const line of tail) {
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out.reverse()
  } catch {
    return []
  }
}

export async function clearAudit(): Promise<void> {
  if (!initialized) initAiSecurity()
  try {
    if (existsSync(auditPath())) await fs.unlink(auditPath())
  } catch {}
  try {
    if (existsSync(auditPrevPath())) await fs.unlink(auditPrevPath())
  } catch {}
}

export function getAuditPath(): string {
  if (!initialized) initAiSecurity()
  return auditPath()
}

// Static facts surfaced in the security panel. These reflect the public,
// commercial-tier terms of service for each provider's API as of 2026-05-05.
// They're shipped as a JSON literal, not fetched, so the user can audit
// exactly what claims the panel is making. Update with each ToS change.
export interface AgentDataFact {
  agentId: string
  agentName: string
  trainingOptOut: 'default-off' | 'opt-out-required' | 'unknown'
  retentionDays: number | 'configurable' | 'unknown'
  privacyDocUrl: string
  consoleUrl: string
  notes: string
}

// Gemini account-mode detection. Gemini is the one mainstream agent where
// the *free* tier (OAuth-only login to a personal Google account) sends
// prompts to Google for product improvement — only paid surfaces (Vertex AI,
// Code Assist license, paid AI Studio API key) are contractually excluded
// from training. We can't *force* paid use, but we can tell the user, with
// evidence, which surface they're on.
export type GeminiMode =
  | 'paid-vertex'
  | 'paid-code-assist'
  | 'paid-api-key'
  | 'free-oauth'
  | 'unknown'

export interface GeminiAccountStatus {
  mode: GeminiMode
  safeForTraining: boolean
  evidence: string[]
  recommendation: string
}

export function detectGeminiAccount(env: NodeJS.ProcessEnv = process.env): GeminiAccountStatus {
  const evidence: string[] = []
  const has = (k: string) => typeof env[k] === 'string' && env[k]!.length > 0
  const truthy = (k: string) => has(k) && /^(1|true|yes)$/i.test(String(env[k]))

  if (has('GOOGLE_APPLICATION_CREDENTIALS') && has('GOOGLE_CLOUD_PROJECT')) {
    evidence.push('GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT set')
    return {
      mode: 'paid-vertex',
      safeForTraining: true,
      evidence,
      recommendation: 'Vertex AI / service-account credentials detected. Inputs/outputs are excluded from training under Google Cloud Customer Data terms.',
    }
  }
  if (truthy('GOOGLE_GENAI_USE_GCA')) {
    evidence.push('GOOGLE_GENAI_USE_GCA=true')
    return {
      mode: 'paid-code-assist',
      safeForTraining: true,
      evidence,
      recommendation: 'Gemini Code Assist license detected. Code and prompts are excluded from training per the Code Assist terms.',
    }
  }
  if (has('GEMINI_API_KEY') || has('GOOGLE_API_KEY')) {
    evidence.push((has('GEMINI_API_KEY') ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY') + ' set')
    return {
      mode: 'paid-api-key',
      safeForTraining: true,
      evidence,
      recommendation: 'Paid Gemini API key detected. Per Google AI Studio paid-tier terms, prompts on a billed key are not used to improve Google products.',
    }
  }
  return {
    mode: 'free-oauth',
    safeForTraining: false,
    evidence: ['No paid-tier env vars detected — Gemini CLI will fall back to personal Google OAuth.'],
    recommendation: 'WARNING: Free-tier OAuth login. Google may use your prompts and code to improve their products. To switch: set GEMINI_API_KEY (paid AI Studio), or GOOGLE_GENAI_USE_GCA=true (Code Assist license), or GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT (Vertex AI).',
  }
}

export const AGENT_FACTS: AgentDataFact[] = [
  {
    agentId: 'claude',
    agentName: 'Claude Code',
    trainingOptOut: 'default-off',
    retentionDays: 30,
    privacyDocUrl: 'https://www.anthropic.com/legal/commercial-terms',
    consoleUrl: 'https://console.anthropic.com/settings/privacy',
    notes: 'Anthropic Commercial Terms exclude API inputs/outputs from training by default. 30-day retention for abuse review unless zero-retention is enabled for eligible accounts.',
  },
  {
    agentId: 'codex',
    agentName: 'OpenAI Codex',
    trainingOptOut: 'default-off',
    retentionDays: 30,
    privacyDocUrl: 'https://openai.com/enterprise-privacy',
    consoleUrl: 'https://platform.openai.com/settings/organization/data-controls',
    notes: 'Since March 2023, API data is not used to train OpenAI models by default. 30-day retention for abuse monitoring; ZDR available for enterprise.',
  },
  {
    agentId: 'gemini',
    agentName: 'Gemini CLI',
    trainingOptOut: 'opt-out-required',
    retentionDays: 'configurable',
    privacyDocUrl: 'https://ai.google.dev/gemini-api/terms',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    notes: 'Free tier (AI Studio) WILL use prompts to improve Google products unless you switch to a paid Gemini API key. Paid Gemini API: prompts not used for training.',
  },
  {
    agentId: 'qwen-code',
    agentName: 'Qwen Code',
    trainingOptOut: 'default-off',
    retentionDays: 'configurable',
    privacyDocUrl: 'https://www.alibabacloud.com/help/en/model-studio/legal-agreement',
    consoleUrl: 'https://dashscope.console.aliyun.com/',
    notes: 'Paid DashScope tier: prompts not used for training per the Model Studio agreement. Local Ollama / vLLM mode (recommended in-product): zero data leaves the machine.',
  },
]
