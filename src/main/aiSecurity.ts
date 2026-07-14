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

// v1.26 — NAMESPACE import, deliberately, NOT `import { app } from 'electron'`.
//
// swarmMemory -> memoryAudit -> this module, and swarmMemory now runs in a utilityProcess. That
// child's `electron` exports ONLY { default, net, systemPreferences } — no `app`. Under CJS a missing
// export is just `undefined`; under ESM (this app is "type": "module") a missing NAMED export is a
// link-time SyntaxError that kills the child before a line of it runs. The memory host would then die
// on every launch and fall back to the main thread forever — silently, which is the worst kind.
//
// A namespace import LINKS in both processes (verified against a real Electron 30.5.1 fork): main
// gets a working `electron.app`, the child gets `undefined` — and that is fine, because the only use
// is inside initAiSecurity(), which main calls and the child never does. Only scanText (a pure regex
// function) is reachable from the memory graph. A DEFAULT import would also link, but it would break
// the ~40 suites that mock electron as `vi.mock('electron', () => ({ app: … }))` with no `default`.
// Guarded by tests/electron/memoryHostImportGraph.test.ts.
import * as electron from 'electron'
import { promises as fs, existsSync, mkdirSync, statSync, renameSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'ai-security-settings.json'
const AUDIT_FILE = 'ai-security-audit.jsonl'
const AUDIT_PREV = 'ai-security-audit.prev.jsonl'
const MAX_AUDIT_BYTES = 10 * 1024 * 1024

export interface AiSecuritySettings {
  // NOTE: `redactionEnabled` is gone. It tried to REDACT a prompt before it reached the PTY,
  // which meant withholding keystrokes — and the handler then never wrote them, so typing
  // "hello<CR>" delivered only "\r". It also could not have worked: against a TUI agent the
  // text is already in the agent's own line buffer by the time you hit Enter. Replaced by
  // always-on WATCH: forward every byte untouched, and record what went out.
  auditEnabled: boolean
  strictGeminiPaidOnly: boolean
  /** Block `git commit` / `git push` when the staged diff or unpushed patch carries a secret. */
  commitShield: boolean
  /** Flag agent network traffic to hosts outside the known AI-provider allowlist. */
  egressGuard: boolean
  /** Redact secrets out of a memory BEFORE it is persisted to the brain. */
  memoryScrub: boolean
}

export interface AuditEntry {
  ts: string
  agent: string
  event:
    | 'terminal_open'
    | 'terminal_close'
    | 'redaction_hit' // legacy: only ever appears in logs written before v1.25.2
    | 'prompt_secret_sent' // a secret WAS sent to a model. Names + rule ids only, never values.
    | 'code_chunk_sent'
    | 'env_dump_sent'
    | 'manual_scan'
    | 'sensitive_file_read'
    | 'commit_scan'
    | 'commit_blocked'
    | 'push_blocked'
    // The shield tried to scan and COULD NOT. Recorded because a security control whose failure is
    // indistinguishable from success is the worst kind of control: you go on believing you are
    // protected. Fail-open stays (git must never wedge) — but it stops being silent.
    | 'shield_scan_failed'
    | 'egress_violation'
    | 'import_scan'
    | 'import_blocked'
    | 'memory_scrub'
  terminalId?: string
  byteCount?: number
  hitCount?: number
  notes?: string
}

interface RedactionRule {
  id: string
  label: string
  pattern: RegExp
  /** Capture group holding the secret's NAME (e.g. `DB_PASSWORD`, `apiKey`). We log the name
   *  and never the value — that is what tells you what to rotate, without us storing it. */
  nameGroup?: number
}

// Patterns scoped to well-shaped, low-false-positive secrets. We deliberately
// avoid generic password regexes — those produce too many false hits and
// erode user trust. Real secret scanners on top of our pipeline (Gitleaks,
// truffleHog) can be added later, but for in-the-loop terminal use, the
// catch-rate of the rules below covers the highest-risk patterns.
// Exported ONLY so tests/electron/secretRulesSync.test.ts can prove that the standalone
// git-hook rule table (src/mcp-adapter/secretRules.cjs) has not drifted from this one.
// The hook scans in a plain node process with Termpolis possibly closed, so it cannot
// import this module — it carries its own copy, and that test is what keeps them identical.
export const RULES: RedactionRule[] = [
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
  // === Named secrets — the ones you can actually ACT on =================================
  //
  // These capture the secret's NAME (group 1), so the audit can say "DB_PASSWORD was sent to
  // Claude, 3 times" — which tells you exactly what to rotate. The VALUE is never captured.
  //
  // These are deliberately broader than the token rules above. The old code refused generic
  // password patterns because "too many false hits erode user trust" — but that was written
  // when a hit REWROTE YOUR PROMPT. A false positive was destructive. Now that we only ever
  // watch and log, a false positive costs one line in a log nobody is forced to read, while a
  // miss costs a leaked credential. The trade flipped, so the rules can.
  { id: 'env_secret', label: '.env-style SECRET/TOKEN/KEY assignment', nameGroup: 1, pattern: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|CREDENTIALS))\s*=\s*["']?[^\s"'#]{8,}["']?/g },
  { id: 'json_secret', label: 'Secret in a JSON config value (appsettings.json etc.)', nameGroup: 1, pattern: /"([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|access[_-]?key|private[_-]?key|connection[_-]?string)[A-Za-z0-9_.-]*)"\s*:\s*"([^"\\]{6,})"/gi },
  { id: 'password_literal', label: 'Password assigned to a literal', nameGroup: 1, pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*)\s*[:=]\s*["']([^"'\s]{6,})["']/gi },
  { id: 'yaml_secret', label: 'Secret in a YAML/INI value', nameGroup: 1, pattern: /^[ \t]*([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey)[A-Za-z0-9_.-]*)[ \t]*:[ \t]*["']?([^\s#"']{6,})["']?[ \t]*$/gim },
  { id: 'conn_string_password', label: 'Password in a connection string', nameGroup: 1, pattern: /\b(Password|Pwd)\s*=\s*([^;\s"']{4,})/gi },
  { id: 'basic_auth_url', label: 'Credentials embedded in a URL', nameGroup: 1, pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]{1,64}):([^\s/:@]{3,})@/gi },
  // The shapeless secret. Every rule above matches either a KNOWN TOKEN SHAPE (AKIA…, ghp_…,
  // sk-ant-…) or a NAMED assignment. Neither fires on the most human thing in the world:
  //
  //     "here is the api key for this code, please add it to line 42: 8f3a9b2c4d5e6f7a…"
  //
  // A bare hex blob, an internal corporate token, a plain password — no prefix, no `=`, no
  // shape. Entropy alone can't save us (it flags hashes, UUIDs, git SHAs, base64 images).
  // But the giveaway isn't the blob — it's the WORDS AROUND IT. So: anchor on the word, and
  // require the nearby value to actually look like a credential (>=12 chars AND containing
  // both a digit and a letter), which is what keeps "rotate the api key in production" from
  // matching on "production". Heuristic, and named as one — but in watch-only mode a false
  // positive is one line in a log, while a miss is a leaked credential.
  { id: 'contextual_secret', label: 'Credential-shaped value next to the word key/token/password (heuristic)', nameGroup: 1, pattern: /\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|passwd|credentials?|access[\s_-]?keys?|private[\s_-]?keys?)\b[^\n]{0,40}?[\s:="'`]\s*["'`]?((?=[A-Za-z0-9_+/=.-]*\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])[A-Za-z0-9_+/=.-]{12,})["'`]?/gi },
]

let userDataDir = ''
let settings: AiSecuritySettings = {
  auditEnabled: true,
  strictGeminiPaidOnly: false,
  commitShield: true,
  egressGuard: true,
  memoryScrub: true,
}
let initialized = false

function settingsPath(): string { return join(userDataDir, SETTINGS_FILE) }
function auditPath(): string { return join(userDataDir, AUDIT_FILE) }
function auditPrevPath(): string { return join(userDataDir, AUDIT_PREV) }

export function initAiSecurity(): void {
  if (initialized) return
  // Main-process only — see the default-import note at the top of this file. Never reached from the
  // memory utilityProcess, which imports this module solely for scanText.
  userDataDir = electron.app.getPath('userData')
  if (!existsSync(userDataDir)) {
    try { mkdirSync(userDataDir, { recursive: true }) } catch {}
  }
  try {
    if (existsSync(settingsPath())) {
      const raw = require('fs').readFileSync(settingsPath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        settings = {
          strictGeminiPaidOnly: parsed.strictGeminiPaidOnly === true,
          // Default-ON gates. An ABSENT key means "never configured", so it keeps the
          // secure default — existing installs get the protection on upgrade. Only an
          // explicit `false` (the user turned it off) opts out.
          auditEnabled: parsed.auditEnabled !== false,
          commitShield: parsed.commitShield !== false,
          egressGuard: parsed.egressGuard !== false,
          memoryScrub: parsed.memoryScrub !== false,
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

export function setCommitShield(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.commitShield = value === true
  persist()
  return getSettings()
}

export function setEgressGuard(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.egressGuard = value === true
  persist()
  return getSettings()
}

export function setMemoryScrub(value: boolean): AiSecuritySettings {
  if (!initialized) initAiSecurity()
  settings.memoryScrub = value === true
  persist()
  return getSettings()
}

export interface ScanResult {
  hitCount: number
  /** `name` is the IDENTIFIER that leaked (`DB_PASSWORD`, `apiKey`) — never the value.
   *  `sample` is a redacted fragment (`AKIA…Q2`) purely so a human can recognise which one. */
  hits: { rule: string; label: string; sample: string; name?: string }[]
  redacted: string
}

// WATCH, BUT DO NOT TOUCH.
//
// This used to try to REDACT a prompt before it reached the PTY, which meant withholding
// keystrokes ('stage') until submit. That was broken twice over:
//
//   1. The handler returned on 'stage' WITHOUT writing to the PTY, and 'flush' only ever
//      wrote the newest chunk — so typing "hello<CR>" delivered just "\r". Your text was
//      silently eaten and never echoed. (Invisible only because the toggle defaulted off.)
//   2. It cannot work anyway. Against a TUI agent like Claude Code the text lives in the
//      AGENT'S OWN line buffer by the time you press Enter; writing a "redacted" version to
//      the PTY would APPEND to it, not replace it. You cannot un-send what the agent holds.
//
// So we no longer pretend. Every byte is forwarded IMMEDIATELY and UNMODIFIED — the
// `writeChunk === data` invariant below is the entire "don't touch" contract, and it is
// pinned by tests. We scan a shadow copy on submit/paste purely to RECORD what went out.
// Detection, not prevention — and honest about which it is.
//
// Cost: the scan never runs per keystroke, only on Enter or paste. ~0.05 ms for a typical
// prompt (0.3% of a 60fps frame); 2.8 ms for a 100 KB paste. The WASM embedder that once
// caused typing lag was 100-300 ms — three orders of magnitude more.
//
//   action: 'pass'     — nothing to report (mid-typing, non-AI terminal, or a clean submit)
//           'observed' — a secret was found in what was just sent. Already forwarded.
export interface OutboundDecision {
  action: 'pass' | 'observed'
  /** ALWAYS identical to `data`. Never withheld, never rewritten. This is the contract. */
  writeChunk: string
  newStaging: string
  scan?: ScanResult
  codeChunk?: CodeChunkSignals
  envDump?: EnvDumpSignals
  isSubmit: boolean
  isPaste: boolean
}

export interface OutboundOptions {
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
  if (!opts.isAiTerminal) {
    return { action: 'pass', writeChunk: data, newStaging: '', isSubmit: false, isPaste: false }
  }
  let buf = (prevStaging || '') + data
  if (buf.length > stageCap) buf = buf.slice(-stageCap)
  const isSubmit = /[\r\n]/.test(data)
  const isPaste = data.length >= pasteThreshold

  // Mid-typing: forward the keystroke straight through and keep a shadow copy for context.
  // We do NOT scan per keystroke — only what is actually submitted or pasted.
  if (!isSubmit && !isPaste) {
    return { action: 'pass', writeChunk: data, newStaging: buf, isSubmit, isPaste }
  }

  const scan = scanText(buf)
  const codeChunk = detectCodeChunk(buf)
  const envDump = detectEnvDump(buf)
  const newStaging = isSubmit ? '' : buf

  if (scan.hitCount > 0) {
    return {
      action: 'observed',
      writeChunk: data, // unmodified — it has already gone to the agent; we only record it
      newStaging,
      scan,
      codeChunk: codeChunk.isCode ? codeChunk : undefined,
      envDump: envDump.isEnvDump ? envDump : undefined,
      isSubmit,
      isPaste,
    }
  }
  return {
    action: 'pass',
    writeChunk: data,
    newStaging,
    scan,
    codeChunk: codeChunk.isCode ? codeChunk : undefined,
    envDump: envDump.isEnvDump ? envDump : undefined,
    isSubmit,
    isPaste,
  }
}

// Result of inspecting an outbound prompt for code-shaped or env-shaped content.
// We surface this *as a hint* — never as a hard block — because legitimate
// "explain this snippet" prompts are exactly the workflow Termpolis exists to
// support. The renderer is expected to show a one-time confirm UI when this
// fires, log the user's choice, and proceed. Defaults are conservative
// (>2 KB AND multiple structural signals) to avoid alert fatigue.
export interface CodeChunkSignals {
  isCode: boolean
  byteSize: number
  lineCount: number
  signals: string[]
}

const CODE_KEYWORDS = [
  'function', 'class', 'import', 'export', 'const ', 'let ', 'var ',
  'def ', 'return', 'public ', 'private ', 'package ', 'interface ',
  'struct ', 'fn ', 'async ', 'await ', '=>', '<?php', '#include',
]

export function detectCodeChunk(text: string, byteThreshold = 2048): CodeChunkSignals {
  const out: CodeChunkSignals = { isCode: false, byteSize: 0, lineCount: 0, signals: [] }
  if (typeof text !== 'string' || !text) return out
  out.byteSize = Buffer.byteLength(text, 'utf8')
  const lines = text.split(/\r?\n/)
  out.lineCount = lines.length
  if (out.byteSize < byteThreshold) return out
  const indented = lines.filter((l) => /^[ \t]{2,}\S/.test(l)).length
  if (indented >= 5 && indented / Math.max(lines.length, 1) >= 0.2) out.signals.push('indentation')
  const braces = (text.match(/[{}();]/g) || []).length
  if (braces / Math.max(text.length, 1) >= 0.02) out.signals.push('punctuation')
  const lower = text.toLowerCase()
  const kwHits = CODE_KEYWORDS.reduce((n, kw) => (lower.includes(kw) ? n + 1 : n), 0)
  if (kwHits >= 3) out.signals.push('keywords')
  if (/^\s*(import|from|using|package|#include)\b/m.test(text)) out.signals.push('module-decl')
  out.isCode = out.signals.length >= 2
  return out
}

// Detect a shell-style env dump (KEY=VALUE lines) — the catch-all for "user
// pasted their .env into the prompt". Per-line regex hits aren't enough alone;
// require N+ lines of UPPER_SNAKE=value to fire so unrelated `export FOO=1`
// snippets don't trip it.
export interface EnvDumpSignals {
  isEnvDump: boolean
  varCount: number
  variableNames: string[]
}

export function detectEnvDump(text: string, threshold = 5): EnvDumpSignals {
  const out: EnvDumpSignals = { isEnvDump: false, varCount: 0, variableNames: [] }
  if (typeof text !== 'string' || !text) return out
  const lines = text.split(/\r?\n/)
  const re = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*\S/
  for (const ln of lines) {
    const m = re.exec(ln)
    if (m) {
      out.varCount++
      if (out.variableNames.length < 20) out.variableNames.push(m[1])
    }
  }
  out.isEnvDump = out.varCount >= threshold
  return out
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
      // The NAME (DB_PASSWORD, apiKey) is what makes the audit actionable — it tells you what
      // to rotate. The VALUE is never captured, never logged, never stored.
      const name = rule.nameGroup && m[rule.nameGroup] ? String(m[rule.nameGroup]) : undefined
      hits.push({ rule: rule.id, label: rule.label, sample, name })
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
