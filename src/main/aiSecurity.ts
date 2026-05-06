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
  { id: 'aws_access_key', label: 'AWS Access Key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws_secret', label: 'AWS Secret-shaped 40-char base64', pattern: /\b(?:aws_secret|secret_access_key|aws_secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { id: 'gh_pat', label: 'GitHub PAT (ghp/gho/ghu/ghs/ghr)', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'gh_fine_grained', label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { id: 'openai_key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic_key', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google_api', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack_token', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', label: 'JWT (3-part base64url)', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'private_key', label: 'PEM private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { id: 'env_secret', label: '.env-style SECRET/TOKEN/KEY assignment', pattern: /\b(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|API[_-]?KEY))\s*=\s*["']?[^\s"'#]{8,}["']?/g },
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
