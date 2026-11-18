// The sensitive-path rules: which file paths hold secrets (.env, private keys, cloud and tool
// logins, browser stores). Pure path matching with no Electron, event bus or child process, so the
// world utility process can filter the files it indexes with the same rules the main process uses.
// sensitiveFileWatcher.ts re-exports these and applies them to agent tool calls.

import * as path from 'path'
import * as os from 'os'

export interface SensitiveMatch {
  /** Original path the agent reported reading */
  filePath: string
  /** Which rule matched (e.g. 'dotenv', 'aws-credentials') */
  rule: string
  /** Human-readable label (e.g. '.env file', 'AWS credentials') */
  label: string
  /** Tool name that triggered (Read, Bash, Edit, …) */
  tool: string
  /** Source heuristic: 'path' (direct file_path argument) or 'command' (parsed from shell command) */
  source: 'path' | 'command'
}

interface RuleDef {
  id: string
  label: string
  /** test the basename / full path; return true if it matches */
  match: (basename: string, fullPath: string) => boolean
}

// We test against the BASENAME first (cheap), then the FULL PATH (for
// rules anchored to ~/.ssh, ~/.aws, ~/.config, etc). Both tests get
// normalised to lower-case on Windows because filesystems there are
// case-insensitive — agents will sometimes report "C:\Users\…\.AWS\credentials"
// with mixed case.

const HOME = (() => {
  try { return os.homedir() } catch { return '' }
})()

function norm(p: string): string {
  if (!p) return ''
  let q = p.trim()
  // strip surrounding quotes the agent may have included
  if ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'"))) {
    q = q.slice(1, -1)
  }
  // expand ~ and ~/ to homedir for matching purposes
  if (q === '~' || q.startsWith('~/') || q.startsWith('~\\')) {
    q = path.join(HOME, q.slice(2))
  }
  // unify path sep on Windows for full-path checks
  return q.replace(/\\/g, '/')
}

const KEY_BASENAMES_CASE_SENSITIVE = new Set([
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'identity', 'authorized_keys',
])

export const RULES: RuleDef[] = [
  // --- .env family ---
  // Match .env, .env.local, .env.production, etc.
  // EXCLUDE .env.example, .env.sample, .env.template
  {
    id: 'dotenv',
    label: '.env file',
    match: (base) => {
      const b = base.toLowerCase()
      if (b === '.env') return true
      if (!b.startsWith('.env.')) return false
      const tail = b.slice(5)
      if (!tail) return false
      // Common safe-to-share suffixes
      if (['example', 'sample', 'template', 'dist', 'tpl'].includes(tail)) return false
      return true
    },
  },

  // --- Private keys (OpenSSH, OpenSSL, PGP) ---
  {
    id: 'private-key-pem',
    label: 'PEM-format private key',
    match: (base) => /\.(pem|key)$/i.test(base) && !/\.pub$/i.test(base),
  },
  {
    id: 'pkcs12',
    label: 'PKCS#12 keystore',
    match: (base) => /\.(p12|pfx)$/i.test(base),
  },
  {
    id: 'jks',
    label: 'Java keystore',
    match: (base) => /\.(jks|keystore)$/i.test(base),
  },
  {
    id: 'ssh-private-key',
    label: 'SSH private key',
    match: (base) => {
      // explicit names — id_rsa, id_ed25519, etc — but NOT *.pub
      if (/\.pub$/i.test(base)) return false
      const b = base
      if (KEY_BASENAMES_CASE_SENSITIVE.has(b)) return true
      // id_<algo>(_xxx) without .pub
      if (/^id_[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(b) && !/\.pub$/i.test(b)) return true
      return false
    },
  },

  // --- Cloud provider creds ---
  {
    id: 'aws-credentials',
    label: 'AWS credentials file',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b !== 'credentials' && b !== 'config') return false
      // Only flag when path includes `.aws`
      return /\/\.aws\//i.test(full) || /\\\.aws\\/i.test(full) || full.toLowerCase().includes('/.aws/')
    },
  },
  {
    id: 'gcp-service-account',
    label: 'GCP service-account key',
    match: (base) => {
      const b = base.toLowerCase()
      if (!b.endsWith('.json')) return false
      return (
        b === 'credentials.json' ||
        b === 'service-account.json' ||
        b === 'gcp-key.json' ||
        b.startsWith('service-account-') ||
        b.startsWith('gcp-key-') ||
        b.startsWith('google-credentials')
      )
    },
  },
  {
    id: 'azure-credentials',
    label: 'Azure credentials file',
    match: (base) => /^azure[-_]?(credentials|profile)\.(json|txt)$/i.test(base),
  },

  // --- SSH directory contents (anything under ~/.ssh except .pub and 'config' alone) ---
  {
    id: 'ssh-dir-content',
    label: 'file inside ~/.ssh',
    match: (base, full) => {
      if (!/\/\.ssh\//i.test(full) && !/\\\.ssh\\/i.test(full)) return false
      const b = base.toLowerCase()
      if (b === 'known_hosts' || b === 'known_hosts.old') return false
      if (b === 'config') return false
      if (b.endsWith('.pub')) return false
      // Avoid double-flagging items already caught by ssh-private-key
      return true
    },
  },

  // --- Auth tokens / configs in dotfiles ---
  { id: 'netrc',  label: '.netrc',  match: (base) => /^_?\.?netrc(\.gpg)?$/i.test(base) },
  { id: 'npmrc',  label: '.npmrc',  match: (base) => /^_?\.?npmrc$/i.test(base) },
  { id: 'pypirc', label: '.pypirc', match: (base) => /^_?\.?pypirc$/i.test(base) },
  {
    id: 'docker-config',
    label: 'docker config (registry creds)',
    match: (base, full) => base.toLowerCase() === 'config.json' && /\/\.docker\//i.test(full),
  },
  {
    id: 'kube-config',
    label: 'kubeconfig',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b === 'config' && /\/\.kube\//i.test(full)) return true
      if (b === 'kubeconfig' || b.endsWith('.kubeconfig')) return true
      return false
    },
  },

  // --- Generic secret-named files ---
  {
    id: 'secrets-file',
    label: 'secrets configuration file',
    match: (base) => /^secrets?\.(ya?ml|json|env|toml|ini)$/i.test(base),
  },
  {
    id: 'credentials-file',
    label: 'credentials configuration file',
    match: (base) => /^credentials?\.(ya?ml|json|env|toml|ini)$/i.test(base),
  },
  {
    id: 'database-url',
    label: 'database URL config',
    match: (base) => /^database(?:_|-)?(?:url|password)\.(?:env|txt|json)$/i.test(base),
  },

  // --- GnuPG / KeePass ---
  {
    id: 'gpg-private',
    label: 'GnuPG private key store',
    match: (base, full) => {
      const b = base.toLowerCase()
      // ONLY the PUBLIC keyrings are excluded. `secring.gpg` used to be listed here too, which
      // made this rule DEAD for the one file it exists to catch: the exclusion returned false
      // before the match below could ever return true, so an agent reading your PRIVATE GnuPG
      // keyring was never flagged. It had been grouped in with the pubring.* entries by mistake,
      // and the failure mode was SILENCE — the worst possible failure mode for a watcher.
      if (b === 'pubring.kbx' || b === 'pubring.gpg') return false
      if (/\.gnupg\//i.test(full) && (b === 'secring.gpg' || b.endsWith('.key'))) return true
      return false
    },
  },
  {
    id: 'keepass-db',
    label: 'KeePass database',
    match: (base) => /\.(kdbx|kdb)$/i.test(base),
  },

  // --- Browser cookies / session stores ---
  {
    id: 'browser-cookies',
    label: 'browser cookies database',
    match: (base, full) => {
      const b = base.toLowerCase()
      if (b !== 'cookies' && b !== 'cookies.sqlite' && b !== 'cookies.db') return false
      const f = full.toLowerCase()
      return /chrome|firefox|edge|safari|brave|chromium/.test(f)
    },
  },
]

export function matchSensitiveFile(filePath: string): SensitiveMatch | null {
  if (!filePath || typeof filePath !== 'string') return null
  const normalized = norm(filePath)
  if (!normalized) return null
  const base = path.basename(normalized)
  if (!base) return null
  // Skip URL-shaped strings (http://, file://, …) — agents sometimes pass URLs
  if (/^[a-z]+:\/\//i.test(filePath)) return null

  for (const rule of RULES) {
    try {
      if (rule.match(base, normalized)) {
        return {
          filePath,
          rule: rule.id,
          label: rule.label,
          tool: 'Read',
          source: 'path',
        }
      }
    } catch {
      // a rule throwing must never crash the watcher
    }
  }
  return null
}
