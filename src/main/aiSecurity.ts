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
    // Linked machines (screenText): a credential taken out of a prompt or an answer on its way
    // between two computers, or a possible one left in. Rule ids and counts only, never values.
    | 'linked_secret_removed'
    | 'linked_secret_flagged'
  terminalId?: string
  byteCount?: number
  hitCount?: number
  notes?: string
}

interface RedactionRule {
  id: string
  label: string
  /** How sure a match is to be a live credential, which decides what screenText does with it.
   *  `high`: a token whose own shape names it (a vendor prefix or format that does not occur by
   *  accident, or a private-key block), removed wherever text crosses to another computer.
   *  `heuristic`: a match that leans on a variable name, a nearby word, or a generic URL or
   *  assignment shape, or a value meant to sit in code (a publishable key, a client id, a DSN).
   *  Those are as often examples, fixtures and test data, and removing them corrupts the code a
   *  delegated job came back with, so they are only reported. */
  precision: 'high' | 'heuristic'
  /** A `high` rule whose match holds a credential only when this matches inside it too: a
   *  private-key block is key material once it has a long body line or its END line. Its header
   *  alone is what a PEM parser or a test helper writes, so screenText reports that and leaves it. */
  keyMaterial?: RegExp
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
//
// Text another computer controls is scanned too (Linked machines, screenText), on the main
// thread, so no rule may take more than linear time on a crafted input. Every run that a match
// can start in many places is bounded: the lookaheads (cloudflare_global and gh_runner_token look
// 200 characters ahead, contextual_secret 64 into its value), the name around a password or secret
// keyword (64 characters before it, 48 after), a URL scheme (32), the stretch between an Azure
// account's name and its key (1,024), and a private-key block (400 lines after its BEGIN line).
// password_literal starts only where a name starts, and a JWT not right after a `-`: with either
// starting inside a run, `pwd.pwd.…` or `eyJ-eyJ-…` cost seconds per 20,000 characters.
// aiSecurityScreen.test.ts times every rule on such runs.
export const RULES: RedactionRule[] = [
  // === AWS ===
  { id: 'aws_access_key', label: 'AWS Access Key ID', precision: 'high', pattern: /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g },
  { id: 'aws_secret', label: 'AWS Secret-shaped 40-char base64', precision: 'heuristic', pattern: /\b(?:aws_secret|secret_access_key|aws_secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { id: 'aws_session_token', label: 'AWS session token', precision: 'heuristic', pattern: /\b(?:aws_session_token|x-amz-security-token)\s*[:=]\s*["']?([A-Za-z0-9/+=]{100,})["']?/gi },
  // === GitHub ===
  { id: 'gh_pat', label: 'GitHub PAT (ghp/gho/ghu/ghs/ghr)', precision: 'high', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'gh_fine_grained', label: 'GitHub fine-grained token', precision: 'high', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // === GitLab / Bitbucket ===
  { id: 'gitlab_pat', label: 'GitLab PAT', precision: 'high', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'gitlab_runner', label: 'GitLab Runner token', precision: 'high', pattern: /\bglrt-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'bitbucket_app_pw', label: 'Bitbucket app password', precision: 'high', pattern: /\bATBB[A-Za-z0-9]{32,}\b/g },
  // === AI providers ===
  { id: 'openai_key', label: 'OpenAI API key', precision: 'high', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic_key', label: 'Anthropic API key', precision: 'high', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google_api', label: 'Google API key', precision: 'high', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'huggingface', label: 'HuggingFace token', precision: 'high', pattern: /\bhf_[A-Za-z0-9]{34}\b/g },
  { id: 'cohere_key', label: 'Cohere API key', precision: 'heuristic', pattern: /\b(?:COHERE_API_KEY|cohere_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{40})["']?/g },
  { id: 'replicate_token', label: 'Replicate API token', precision: 'high', pattern: /\br8_[A-Za-z0-9]{40}\b/g },
  // === Azure ===
  { id: 'azure_storage_key', label: 'Azure Storage AccountKey', precision: 'heuristic', pattern: /AccountKey\s*=\s*([A-Za-z0-9+/=]{86,90})/g },
  { id: 'azure_sas', label: 'Azure SAS signature', precision: 'heuristic', pattern: /[?&]sig=([A-Za-z0-9%]{40,})/g },
  { id: 'azure_conn_string', label: 'Azure connection string', precision: 'heuristic', pattern: /DefaultEndpointsProtocol=https?;[^;\s]*AccountName=[^;\s]+;[^\s]{0,1024}AccountKey=[^;\s]+/g },
  { id: 'azure_devops_pat', label: 'Azure DevOps PAT', precision: 'heuristic', pattern: /\b(?:AZURE_DEVOPS_PAT|ADO_PAT|VSTS_PAT|SYSTEM_ACCESSTOKEN)\s*[:=]\s*["']?([a-z0-9]{52})["']?/gi },
  { id: 'azure_client_secret', label: 'Azure AD client secret (named)', precision: 'heuristic', pattern: /\b(?:AZURE_CLIENT_SECRET|ARM_CLIENT_SECRET|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9~_.-]{34,})["']?/gi },
  // === GCP ===
  { id: 'gcp_sa_json', label: 'GCP service-account JSON', precision: 'heuristic', pattern: /"type"\s*:\s*"service_account"/g },
  { id: 'gcp_oauth_client', label: 'GCP OAuth client ID', precision: 'heuristic', pattern: /\b[0-9]{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com\b/g },
  // === Slack / chat ===
  { id: 'slack_token', label: 'Slack token', precision: 'high', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack_webhook', label: 'Slack incoming webhook', precision: 'high', pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}\b/g },
  { id: 'discord_bot', label: 'Discord bot token', precision: 'heuristic', pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}\b/g },
  { id: 'discord_webhook', label: 'Discord webhook', precision: 'high', pattern: /\bhttps:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}\b/g },
  { id: 'telegram_bot', label: 'Telegram bot token', precision: 'heuristic', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // === Payments ===
  { id: 'stripe_secret', label: 'Stripe secret key', precision: 'high', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'stripe_pub', label: 'Stripe publishable key (info)', precision: 'heuristic', pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'paypal_braintree', label: 'PayPal Braintree access token', precision: 'high', pattern: /\baccess_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}\b/g },
  { id: 'square_oauth', label: 'Square OAuth secret', precision: 'high', pattern: /\bsq0(?:csp|atp|idp)-[A-Za-z0-9_-]{22,}\b/g },
  // === Comms / email ===
  { id: 'twilio_sid', label: 'Twilio Account SID', precision: 'heuristic', pattern: /\bAC[a-f0-9]{32}\b/g },
  { id: 'twilio_token', label: 'Twilio auth token (named)', precision: 'heuristic', pattern: /\b(?:TWILIO_AUTH_TOKEN|twilio_auth_token)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'sendgrid_key', label: 'SendGrid API key', precision: 'high', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'mailgun_key', label: 'Mailgun API key', precision: 'heuristic', pattern: /\bkey-[a-f0-9]{32}\b/g },
  { id: 'mailchimp_key', label: 'Mailchimp API key', precision: 'high', pattern: /\b[a-f0-9]{32}-us\d{1,2}\b/g },
  { id: 'postmark_token', label: 'Postmark server token', precision: 'heuristic', pattern: /\b(?:POSTMARK_(?:SERVER|API)_TOKEN|postmark_token)\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']?/gi },
  // === Cloud / infra ===
  { id: 'cloudflare_api', label: 'Cloudflare API token', precision: 'heuristic', pattern: /\b(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\s*[:=]\s*["']?([A-Za-z0-9_-]{40})["']?/gi },
  { id: 'cloudflare_global', label: 'Cloudflare Global API key', precision: 'heuristic', pattern: /\b[a-f0-9]{37}\b(?=.{0,200}cloudflare)/gi },
  { id: 'digitalocean_pat', label: 'DigitalOcean PAT', precision: 'high', pattern: /\bdo[opt]_v1_[a-f0-9]{64}\b/g },
  { id: 'heroku_api', label: 'Heroku API key (named)', precision: 'heuristic', pattern: /\b(?:HEROKU_API_KEY|heroku_api_key)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi },
  { id: 'netlify_token', label: 'Netlify token (named)', precision: 'heuristic', pattern: /\b(?:NETLIFY_AUTH_TOKEN|netlify_auth_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{40,})["']?/gi },
  { id: 'vercel_token', label: 'Vercel token (named)', precision: 'heuristic', pattern: /\b(?:VERCEL_TOKEN|vercel_token)\s*[:=]\s*["']?([A-Za-z0-9]{24})["']?/gi },
  { id: 'fly_api', label: 'Fly.io API token', precision: 'high', pattern: /\bfo1_[A-Za-z0-9_-]{20,}\b/g },
  { id: 'render_api', label: 'Render API key', precision: 'high', pattern: /\brnd_[A-Za-z0-9]{30,}\b/g },
  { id: 'pulumi_pat', label: 'Pulumi PAT', precision: 'high', pattern: /\bpul-[a-f0-9]{40}\b/g },
  // === Project mgmt / dev tools ===
  { id: 'linear_api', label: 'Linear API key', precision: 'high', pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{40,}\b/g },
  { id: 'notion_secret', label: 'Notion integration secret', precision: 'high', pattern: /\bsecret_[A-Za-z0-9]{43}\b/g },
  { id: 'asana_pat', label: 'Asana PAT', precision: 'high', pattern: /\b\d+\/[a-f0-9]{32}:[a-f0-9]{32}\b/g },
  { id: 'jira_token', label: 'Jira/Atlassian API token', precision: 'heuristic', pattern: /\b(?:JIRA_API_TOKEN|ATLASSIAN_API_TOKEN|jira_api_token)\s*[:=]\s*["']?([A-Za-z0-9]{24,})["']?/gi },
  { id: 'figma_pat', label: 'Figma PAT', precision: 'high', pattern: /\bfigd_[A-Za-z0-9_-]{30,}\b/g },
  // === Package registries ===
  { id: 'npm_token', label: 'npm access token', precision: 'high', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'npm_authtoken_line', label: 'npm _authToken line', precision: 'heuristic', pattern: /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_-]+/g },
  { id: 'pypi_token', label: 'PyPI upload token', precision: 'high', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]+/g },
  { id: 'docker_pat', label: 'Docker Hub PAT', precision: 'high', pattern: /\bdckr_pat_[A-Za-z0-9_-]{27,}\b/g },
  // === Monitoring / analytics ===
  { id: 'sentry_dsn', label: 'Sentry DSN', precision: 'heuristic', pattern: /\bhttps:\/\/[a-f0-9]{32}@[a-z0-9.-]+\/\d+\b/g },
  { id: 'datadog_api', label: 'Datadog API key (named)', precision: 'heuristic', pattern: /\b(?:DD_API_KEY|DATADOG_API_KEY|datadog_api_key)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'datadog_app', label: 'Datadog APP key (named)', precision: 'heuristic', pattern: /\b(?:DD_APP_KEY|DATADOG_APP_KEY|datadog_app_key)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'pagerduty', label: 'PagerDuty token (named)', precision: 'heuristic', pattern: /\b(?:PAGERDUTY_(?:API_)?TOKEN|pagerduty_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{20,})["']?/gi },
  { id: 'algolia_admin', label: 'Algolia admin key (named)', precision: 'heuristic', pattern: /\b(?:ALGOLIA_(?:ADMIN_)?API_KEY|algolia_admin_api_key)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'mapbox_secret', label: 'Mapbox secret token', precision: 'high', pattern: /\bsk\.eyJ[A-Za-z0-9_-]{50,}\b/g },
  { id: 'okta_token', label: 'Okta API token (named)', precision: 'heuristic', pattern: /\b(?:OKTA_API_TOKEN|okta_api_token)\s*[:=]\s*["']?(00[A-Za-z0-9_-]{40})["']?/gi },
  { id: 'auth0_secret', label: 'Auth0 client secret (named)', precision: 'heuristic', pattern: /\b(?:AUTH0_CLIENT_SECRET|auth0_client_secret)\s*[:=]\s*["']?([A-Za-z0-9_-]{40,})["']?/gi },
  // === Database connection strings ===
  { id: 'postgres_url', label: 'Postgres URL with credentials', precision: 'heuristic', pattern: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+\/[^\s]+/g },
  { id: 'mysql_url', label: 'MySQL URL with credentials', precision: 'heuristic', pattern: /\bmysql:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+\/[^\s]+/g },
  { id: 'mongodb_url', label: 'MongoDB URL with credentials', precision: 'heuristic', pattern: /\bmongodb(?:\+srv)?:\/\/[^:\s/]+:[^@\s/]+@[^/\s]+/g },
  { id: 'redis_url', label: 'Redis URL with credentials', precision: 'heuristic', pattern: /\bredis(?:s)?:\/\/[^:\s/]*:[^@\s/]+@[^/\s]+/g },
  { id: 'http_basic_auth', label: 'HTTP basic-auth URL', precision: 'heuristic', pattern: /\bhttps?:\/\/[^:\s/]+:[^@\s/]{6,}@[^\s]+/g },
  // === Secrets vaults / 1P / KMS ===
  { id: 'vault_token', label: 'HashiCorp Vault token', precision: 'high', pattern: /\bhvs\.[A-Za-z0-9_-]{20,}\b/g },
  { id: 'vault_legacy', label: 'HashiCorp Vault legacy token (named)', precision: 'heuristic', pattern: /\b(?:VAULT_TOKEN|vault_token)\s*[:=]\s*["']?(s\.[A-Za-z0-9]{24,})["']?/gi },
  { id: 'tfcloud_token', label: 'Terraform Cloud token (named)', precision: 'heuristic', pattern: /\b(?:TFE_TOKEN|TF_CLOUD_TOKEN|TFC_TOKEN)\s*[:=]\s*["']?([A-Za-z0-9]+\.atlasv1\.[A-Za-z0-9]+)["']?/gi },
  { id: 'doppler_token', label: 'Doppler personal token', precision: 'high', pattern: /\bdp\.pt\.[A-Za-z0-9]{40,}\b/g },
  { id: 'doppler_service', label: 'Doppler service token', precision: 'high', pattern: /\bdp\.st\.[A-Za-z0-9]{40,}\b/g },
  { id: 'onepassword_secret', label: '1Password Connect secret', precision: 'heuristic', pattern: /\bops_[A-Za-z0-9_-]{30,}\b/g },
  // === GitHub additional ===
  { id: 'gh_oauth_secret', label: 'GitHub OAuth client secret (named)', precision: 'heuristic', pattern: /\b(?:GH_CLIENT_SECRET|GITHUB_CLIENT_SECRET)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'gh_app_jwt_named', label: 'GitHub App private key (named)', precision: 'heuristic', pattern: /\b(?:GITHUB_APP_PRIVATE_KEY|GH_APP_PRIVATE_KEY)\s*[:=]/gi },
  { id: 'gh_runner_token', label: 'GitHub Actions runner token', precision: 'heuristic', pattern: /\bA[A-Z2-7]{31}\b(?=.{0,200}runner)/gi },
  // === CI/CD ===
  { id: 'circleci_pat', label: 'CircleCI PAT', precision: 'high', pattern: /\bCCIPAT_[A-Za-z0-9_-]{30,}\b/g },
  { id: 'circleci_legacy', label: 'CircleCI legacy token (named)', precision: 'heuristic', pattern: /\b(?:CIRCLECI_API_TOKEN|circle_token)\s*[:=]\s*["']?([a-f0-9]{40})["']?/gi },
  { id: 'travis_token', label: 'Travis CI token (named)', precision: 'heuristic', pattern: /\b(?:TRAVIS_(?:API_)?TOKEN|travis_token)\s*[:=]\s*["']?([A-Za-z0-9_-]{20,})["']?/gi },
  { id: 'codecov_token', label: 'Codecov upload token', precision: 'heuristic', pattern: /\b(?:CODECOV_TOKEN|codecov_token)\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?/gi },
  // === Observability ===
  { id: 'newrelic_license', label: 'New Relic license key (named)', precision: 'heuristic', pattern: /\b(?:NEW_RELIC_LICENSE_KEY|NR_LICENSE_KEY)\s*[:=]\s*["']?([A-Fa-f0-9]{40}|[A-Za-z0-9]{40}NRAL)["']?/gi },
  { id: 'rollbar_token', label: 'Rollbar access token (named)', precision: 'heuristic', pattern: /\b(?:ROLLBAR_(?:ACCESS_)?TOKEN|rollbar_token)\s*[:=]\s*["']?([a-f0-9]{32})["']?/gi },
  { id: 'honeycomb_key', label: 'Honeycomb API key (named)', precision: 'heuristic', pattern: /\b(?:HONEYCOMB_API_KEY|honeycomb_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{32})["']?/gi },
  { id: 'lightstep_token', label: 'Lightstep access token (named)', precision: 'heuristic', pattern: /\b(?:LIGHTSTEP_ACCESS_TOKEN|lightstep_token)\s*[:=]\s*["']?([A-Za-z0-9]{40,})["']?/gi },
  // === SSH / GPG ===
  { id: 'ssh_dsa_pubkey', label: 'SSH DSA private key block', precision: 'high', keyMaterial: /-----END |[A-Za-z0-9+/=]{40}/, pattern: /-----BEGIN DSA PRIVATE KEY-----(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)(?:[A-Za-z0-9+/=]*|[A-Za-z][A-Za-z-]*: [^\r\n\\]*)(?=\r?\n|\\(?:r\\)?n|["']|$)){0,400}(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)-----END DSA PRIVATE KEY-----)?/g },
  { id: 'gpg_block', label: 'GPG/PGP private key block', precision: 'high', keyMaterial: /-----END |[A-Za-z0-9+/=]{40}/, pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)(?:[A-Za-z0-9+/=]*|[A-Za-z][A-Za-z-]*: [^\r\n\\]*)(?=\r?\n|\\(?:r\\)?n|["']|$)){0,400}(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)-----END PGP PRIVATE KEY BLOCK-----)?/g },
  // === Auth tokens that show up in headers ===
  { id: 'bearer_token_named', label: 'Bearer token in named env (named)', precision: 'heuristic', pattern: /\b(?:AUTH_BEARER|AUTHORIZATION|BEARER_TOKEN)\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._-]{40,})["']?/gi },
  // === Crypto / financial ===
  { id: 'coinbase_pat', label: 'Coinbase API key (named)', precision: 'heuristic', pattern: /\b(?:COINBASE_API_KEY|coinbase_api_key)\s*[:=]\s*["']?([A-Za-z0-9]{32})["']?/gi },
  // === Generic high-confidence shapes ===
  { id: 'jwt', label: 'JWT (3-part base64url)', precision: 'heuristic', pattern: /\b(?<!-)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'private_key', label: 'PEM private key block', precision: 'high', keyMaterial: /-----END |[A-Za-z0-9+/=]{40}/, pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)(?:[A-Za-z0-9+/=]*|[A-Za-z][A-Za-z-]*: [^\r\n\\]*)(?=\r?\n|\\(?:r\\)?n|["']|$)){0,400}(?:(?:\r?\n[ \t]*|\\(?:r\\)?n)-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----)?/g },
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
  { id: 'env_secret', label: '.env-style SECRET/TOKEN/KEY assignment', precision: 'heuristic', nameGroup: 1, pattern: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|CREDENTIALS))\s*=\s*["']?[^\s"'#]{8,}["']?/g },
  { id: 'json_secret', label: 'Secret in a JSON config value (appsettings.json etc.)', precision: 'heuristic', nameGroup: 1, pattern: /"([A-Za-z0-9_.-]{0,64}?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|access[_-]?key|private[_-]?key|connection[_-]?string)[A-Za-z0-9_.-]{0,48})"\s*:\s*"([^"\\]{6,})"/gi },
  { id: 'password_literal', label: 'Password assigned to a literal', precision: 'heuristic', nameGroup: 1, pattern: /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:password|passwd|pwd)[A-Za-z0-9_.-]{0,48})\s*[:=]\s*["']([^"'\s]{6,})["']/gi },
  { id: 'yaml_secret', label: 'Secret in a YAML/INI value', precision: 'heuristic', nameGroup: 1, pattern: /^[ \t]*([A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key|apikey)[A-Za-z0-9_.-]{0,48})[ \t]*:[ \t]*["']?([^\s#"']{6,})["']?[ \t]*$/gim },
  { id: 'conn_string_password', label: 'Password in a connection string', precision: 'heuristic', nameGroup: 1, pattern: /\b(Password|Pwd)\s*=\s*([^;\s"']{4,})/gi },
  { id: 'basic_auth_url', label: 'Credentials embedded in a URL', precision: 'heuristic', nameGroup: 1, pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/:@]{1,64}):([^\s/:@]{3,})@/gi },
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
  { id: 'contextual_secret', label: 'Credential-shaped value next to the word key/token/password (heuristic)', precision: 'heuristic', nameGroup: 1, pattern: /\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|passwd|credentials?|access[\s_-]?keys?|private[\s_-]?keys?)\b[^\n]{0,40}?[\s:="'`]\s*["'`]?((?=[A-Za-z0-9_+/=.-]{0,63}\d)(?=[A-Za-z0-9_+/=.-]{0,63}[A-Za-z])[A-Za-z0-9_+/=.-]{12,})["'`]?/gi },
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

// A paste reaches the PTY the way any terminal sends one: each line break is \r (what Enter
// sends), and the whole paste is wrapped in bracketed-paste markers whenever the program asked
// for them — every agent TUI does, and so do bash and zsh. The markers are framing, not text.
// Every pattern here is written against plain lines, so it must look past them: a `^`-anchored
// rule cannot match the first line of a paste through ESC[200~, and an env dump that arrives as
// one marker-led, \r-separated line counts as zero variables.
const PASTE_MARKERS = /\x1b\[20[01]~/g
export function stripPasteMarkers(data: string): string {
  return data.replace(PASTE_MARKERS, '')
}

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

  // Scan the TEXT: framing stripped, every line break a plain \n (see stripPasteMarkers).
  const text = stripPasteMarkers(buf).replace(/\r\n?/g, '\n')
  const scan = scanText(text)
  const codeChunk = detectCodeChunk(text)
  const envDump = detectEnvDump(text)
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

/** Where the group opened at `open` in a pattern's source closes. */
function groupEnd(src: string, open: number): number {
  let depth = 0
  let inClass = false
  let i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) break
  }
  return i
}

/** A piece of text every match of `pattern` contains, lower-cased for a rule that ignores case, or
 *  null when none can be read off the pattern safely. It is the run of literal characters at the
 *  start of the pattern (after any leading \b and lookbehinds, which take no text), up to the first
 *  piece of regex syntax; a quantifier right after the run may drop its last character, so that
 *  goes. A pattern with an alternative outside every group has none: the run would belong to its
 *  first branch. */
export function requiredLiteral(pattern: RegExp): string | null {
  const src = pattern.source
  let depth = 0
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && depth === 0) return null
  }
  let run = ''
  let i = 0
  for (;;) {
    if (src.startsWith('\\b', i)) i += 2
    else if (src.startsWith('(?<!', i) || src.startsWith('(?<=', i)) i = groupEnd(src, i) + 1
    else break
  }
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      // An escaped letter or digit is a class or an anchor (\d, \s, \b, \1), not a character. A
      // source never ends in a lone backslash, so there is always a next one.
      const next = src[i + 1]
      if (!/^[!-/:-@[-`{-~]$/.test(next)) break
      run += next
      i++
    } else if ('[](){}*+?|^$.'.includes(c) || !/^[ -~]$/.test(c)) {
      break
    } else {
      run += c
    }
  }
  if ('*+?{'.includes(src[i] ?? '_')) run = run.slice(0, -1)
  if (!run) return null
  return pattern.flags.includes('i') ? run.toLowerCase() : run
}

/** Each rule's literal, worked out once. */
const LITERALS = new Map<RedactionRule, string | null>(RULES.map((rule) => [rule, requiredLiteral(rule.pattern)]))

/** Every match of every rule, rule by rule in table order. A rule whose literal (requiredLiteral)
 *  is missing from the text is not run: it cannot match. Most text carries none of the vendor
 *  prefixes, so most of the table is skipped by a substring search. */
function forEachMatch(input: string, visit: (rule: RedactionRule, m: RegExpExecArray) => void): void {
  let lower: string | undefined
  for (const rule of RULES) {
    const literal = LITERALS.get(rule)
    if (literal) {
      // Every literal is printable ASCII, which a case-insensitive pattern matches only as its
      // ASCII self or its other case: lower-casing the whole text loses no match.
      const hay = rule.pattern.flags.includes('i') ? (lower ??= input.toLowerCase()) : input
      if (!hay.includes(literal)) continue
    }
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
      visit(rule, m)
      if (re.flags.indexOf('g') === -1) break
    }
  }
}

export function scanText(input: string): ScanResult {
  if (typeof input !== 'string' || !input) {
    return { hitCount: 0, hits: [], redacted: input ?? '' }
  }
  let redacted = input
  const hits: ScanResult['hits'] = []
  forEachMatch(input, (rule, m) => {
    const matched = m[0]
    const sample = matched.length <= 8 ? '****' : matched.slice(0, 4) + '…' + matched.slice(-2)
    // The NAME (DB_PASSWORD, apiKey) is what makes the audit actionable — it tells you what
    // to rotate. The VALUE is never captured, never logged, never stored.
    const name = rule.nameGroup && m[rule.nameGroup] ? String(m[rule.nameGroup]) : undefined
    hits.push({ rule: rule.id, label: rule.label, sample, name })
    redacted = redacted.split(matched).join('[REDACTED:' + rule.id + ']')
  })
  return { hitCount: hits.length, hits, redacted }
}

/** What screenText found, by rule id: how many matches. */
export interface SecretScreen {
  /** The text with every high-precision match replaced by `[REDACTED:<rule>]`. Nothing else in it
   *  changes: a heuristic match is left exactly as it was. */
  text: string
  /** High-precision rules, and how many of their matches were taken out. */
  removed: Record<string, number>
  /** Heuristic rules, and a private-key header with no key under it, and how many matches were left
   *  in. One that overlaps a removed match isn't counted: the credential in it went with that. */
  flagged: Record<string, number>
}

interface Span {
  rule: string
  from: number
  to: number
}

/** Text that crosses to another computer (Linked machines), screened in two tiers by
 *  RedactionRule.precision. A credential whose own shape names it is removed; anything that only
 *  looks like one is reported and left alone, because the text is usually code and a removed
 *  fixture or example would corrupt it. Values are never returned: only rule ids and counts.
 *
 *  The other computer controls this text, so it runs in linear time: the output is built in one
 *  pass over the matches, where scanText rewrites the whole text once per match. Overlapping
 *  matches (an Anthropic key is an OpenAI-shaped one too) are taken once, under the first rule in
 *  table order. */
export function screenText(input: string): SecretScreen {
  const removed: Record<string, number> = {}
  const flagged: Record<string, number> = {}
  if (typeof input !== 'string' || !input) return { text: input ?? '', removed, flagged }
  const taken: Span[] = []
  const looks: Span[] = []
  forEachMatch(input, (rule, m) => {
    const span = { rule: rule.id, from: m.index, to: m.index + m[0].length }
    if (rule.precision === 'high' && (!rule.keyMaterial || rule.keyMaterial.test(m[0]))) taken.push(span)
    else looks.push(span)
  })
  // Sorted by start; a stable sort keeps table order among matches that start together.
  taken.sort((a, b) => a.from - b.from)
  const cuts: Span[] = []
  for (const t of taken) {
    const last = cuts[cuts.length - 1]
    if (last && t.from < last.to) last.to = Math.max(last.to, t.to)
    else cuts.push({ ...t })
  }
  let text = ''
  let at = 0
  for (const cut of cuts) {
    removed[cut.rule] = (removed[cut.rule] ?? 0) + 1
    text += `${input.slice(at, cut.from)}[REDACTED:${cut.rule}]`
    at = cut.to
  }
  text += input.slice(at)
  for (const look of looks) {
    if (overlapsCut(cuts, look)) continue
    // Text screened once already is screened again where it arrives, and `KEY=[REDACTED:gh_pat]`
    // looks like an assignment: a match around a marker is about a value that is gone.
    if (input.slice(look.from, look.to).includes('[REDACTED:')) continue
    flagged[look.rule] = (flagged[look.rule] ?? 0) + 1
  }
  return { text, removed, flagged }
}

/** Whether `span` overlaps one of `cuts`, which are sorted and disjoint: only the last cut that
 *  starts before the span ends can. */
function overlapsCut(cuts: Span[], span: Span): boolean {
  let lo = 0
  let hi = cuts.length - 1
  let last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cuts[mid].from < span.to) {
      last = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return last >= 0 && cuts[last].to > span.from
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
]
