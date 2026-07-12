// Secret-detection rules — the DATA half of the AI Security scanner.
//
// WHY THIS FILE EXISTS, AND WHY IT IS .cjs
// The git hook (pre-commit / pre-push) must scan a diff in a plain `node` process: no
// Electron, no bundler, and — critically — with Termpolis possibly CLOSED. A hook that only
// works while the app is running is a hook that silently stops protecting you the moment you
// quit, which is worse than no hook, because you would still believe you had one.
//
// electron-builder already ships src/mcp-adapter/**/*.cjs into resources/mcp-adapter/, so
// putting the rules here means the installed app carries them for free.
//
// DRIFT IS IMPOSSIBLE, NOT MERELY DISCOURAGED: tests/electron/secretRulesSync.test.ts asserts
// this table is equivalent to RULES in src/main/aiSecurity.ts (same ids, labels, pattern
// sources and flags, same order). Add a rule to one and CI goes red. Do not "fix" that test
// by loosening it — regenerate this file instead.

module.exports = [
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
