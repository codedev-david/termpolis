// screenText: the two-tier screen for text crossing to another computer (Linked machines), and
// the parts of the rule engine it added -- the literal pre-check every scan now runs, the bounded
// lookaheads and whole private-key blocks. Fake keys only: 'a'.repeat(N)-style bodies pass the
// patterns without looking like a real secret to push protection.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

import { RULES, requiredLiteral, scanText, screenText } from '../../src/main/aiSecurity'

const ANTHROPIC = `sk-ant-${'a'.repeat(30)}`
const GH = `ghp_${'b'.repeat(36)}`
const AWS = `AKIA${'C'.repeat(16)}`
const SLACK = `xoxb-${'1'.repeat(12)}`
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA' + 'q'.repeat(48), 'r'.repeat(40) + '==', '-----END RSA PRIVATE KEY-----'].join('\n')

/** Test data a code-review or implement job hands back all the time: every one is a heuristic
 *  match, and removing any of them would corrupt the code. */
const FIXTURES = [
  "const token = 'abc123def456ghi'",
  'const password = "hunter2hunter2"',
  'DATABASE_URL=postgres://user:pass@localhost:5432/app_test',
  'db_password: devpassword1',
  'Server=db;Password=localdev1;',
  'API_KEY=example-not-real-123',
  '{"apiKey": "test-api-key-123"}',
  'curl https://admin:changeme@localhost:8080/health',
  'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXRlc3Q"',
].join('\n')

describe('precision', () => {
  it('splits the 97 rules into the vendor-shaped ones it removes and the rest it reports', () => {
    const high = RULES.filter((r) => r.precision === 'high').map((r) => r.id)
    expect(high).toHaveLength(40)
    expect(RULES.filter((r) => r.precision === 'heuristic')).toHaveLength(57)
    for (const id of ['anthropic_key', 'openai_key', 'gh_pat', 'gh_fine_grained', 'aws_access_key', 'slack_token', 'private_key', 'gpg_block', 'ssh_dsa_pubkey']) {
      expect(high).toContain(id)
    }
    // A name, a nearby word, a URL or a value meant to sit in code is not enough to remove it.
    for (const id of ['contextual_secret', 'password_literal', 'yaml_secret', 'conn_string_password', 'basic_auth_url', 'json_secret', 'env_secret', 'postgres_url', 'jwt', 'stripe_pub', 'aws_secret']) {
      expect(high).not.toContain(id)
    }
  })
})

describe('screenText', () => {
  it('removes a vendor-shaped credential wherever it is, and says which rule took it', () => {
    const r = screenText(`use ${ANTHROPIC} and ${GH}\nand ${AWS} then ${SLACK}`)
    // An Anthropic key is OpenAI-shaped too: taken once, under the rule that comes first.
    expect(r.text).toBe('use [REDACTED:openai_key] and [REDACTED:gh_pat]\nand [REDACTED:aws_access_key] then [REDACTED:slack_token]')
    expect(r.removed).toEqual({ openai_key: 1, gh_pat: 1, aws_access_key: 1, slack_token: 1 })
    expect(r.flagged).toEqual({})
  })

  it('takes a whole private-key block, not only its BEGIN line, and keeps what follows', () => {
    const r = screenText(`Here it is:\n${PEM}\nThen restart the service.`)
    expect(r.text).toBe('Here it is:\n[REDACTED:private_key]\nThen restart the service.')
    expect(r.removed).toEqual({ private_key: 1 })
  })

  it('leaves heuristic matches byte for byte, and reports each rule that matched', () => {
    const r = screenText(FIXTURES)
    expect(r.text).toBe(FIXTURES)
    expect(r.removed).toEqual({})
    expect(Object.keys(r.flagged).sort()).toEqual(
      ['basic_auth_url', 'conn_string_password', 'contextual_secret', 'env_secret', 'http_basic_auth', 'json_secret', 'jwt', 'password_literal', 'postgres_url', 'yaml_secret'].sort(),
    )
  })

  it('does not report a heuristic match whose credential it removed already', () => {
    const r = screenText(`ANTHROPIC_API_KEY=${ANTHROPIC}`)
    expect(r.text).toBe('ANTHROPIC_API_KEY=[REDACTED:openai_key]')
    expect(r.removed).toEqual({ openai_key: 1 })
    expect(r.flagged).toEqual({})
    // ...but one beside it, on its own, still is.
    const both = screenText(`KEY=${GH}\nconst password = "hunter2hunter2"`)
    expect(both.removed).toEqual({ gh_pat: 1 })
    expect(both.flagged).toEqual({ password_literal: 1, contextual_secret: 1 })
    // Ahead of a removed one, and between two.
    const around = screenText(`const password = "hunter2hunter2"\n${GH}\ndb_password: devpassword1\n${AWS}`)
    expect(around.text).toBe('const password = "hunter2hunter2"\n[REDACTED:gh_pat]\ndb_password: devpassword1\n[REDACTED:aws_access_key]')
    // `db_password` is one word, so only the YAML rule sees it.
    expect(around.flagged).toEqual({ password_literal: 1, contextual_secret: 1, yaml_secret: 1 })
  })

  it('screens its own output again to the same text, and finds nothing new in it', () => {
    const once = screenText(`OPENAI_API_KEY=${ANTHROPIC}\nGH=${GH}\nconst password = "hunter2hunter2"`)
    const twice = screenText(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.removed).toEqual({})
    // The look-alikes are still reported; the markers' assignments are not.
    expect(twice.flagged).toEqual(once.flagged)
    expect(twice.flagged).toEqual({ password_literal: 1, contextual_secret: 1 })
  })

  it('counts every occurrence, and returns empty text and nothing found for nothing', () => {
    expect(screenText(`${GH} ${GH}`)).toEqual({ text: '[REDACTED:gh_pat] [REDACTED:gh_pat]', removed: { gh_pat: 2 }, flagged: {} })
    expect(screenText('')).toEqual({ text: '', removed: {}, flagged: {} })
    expect(screenText('plain prose with nothing in it')).toEqual({ text: 'plain prose with nothing in it', removed: {}, flagged: {} })
    expect(screenText(undefined as unknown as string)).toEqual({ text: '', removed: {}, flagged: {} })
  })

  it('stays fast on a crafted 200 KB answer: thousands of tokens, near-miss lookaheads, open key blocks', () => {
    const tokens = Array.from({ length: 9_000 }, (_, i) => `xoxb-${String(i).padStart(12, '0')}`).join(' ')
    const hex = `${Array.from({ length: 5_000 }, () => 'a'.repeat(37)).join(' ')} cloudflare`
    const blocks = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n`.repeat(2_000)
    for (const text of [tokens, hex, blocks]) {
      const t = performance.now()
      screenText(text.slice(0, 200_000))
      // Generous for a loaded CI box; the unbounded patterns took seconds on the first input.
      expect(performance.now() - t).toBeLessThan(1_500)
    }
    expect(screenText(tokens).removed.slack_token).toBe(9_000)
  })
})

describe('every rule in linear time on text another computer wrote', () => {
  // Runs that made a rule start a match every few characters and rescan the rest of the run from
  // each start, before every such run was bounded. On 20,000 characters: password_literal took
  // minutes (a second on 3,000 of `pwd.`), contextual_secret a third of a second, and jwt and
  // basic_auth_url a tenth each. Every rule now takes a few milliseconds at most.
  const RUNS = [
    'pwd.', 'PWD-', 'pwdpwd.', `${'pwd.'.repeat(24)} `, '"pwd.', 'apikey.\n', 'eyJ-', 'a.', 'h.', 'token=', 'token ',
    'secret:', 'x:', 'https://a:', '1', 'a', '-', '=', ' ', '\\n', `${'A'.repeat(39)}\\n`,
    '-----BEGIN PRIVATE KEY-----\n', '-----BEGIN PRIVATE KEY-----\\n', 'DefaultEndpointsProtocol=https;AccountName=x;',
  ]
  const run = (unit: string, chars: number): string => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)

  /** The fastest of three scans, so a pause on a busy CI box doesn't count against a rule. */
  function bestOf3(scan: () => void): number {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      scan()
      best = Math.min(best, performance.now() - t)
    }
    return best
  }

  it('takes each rule under 50 ms on 20,000 characters of any of them (a prompt is at most 20,000)', () => {
    for (const rule of RULES) {
      for (const unit of RUNS) {
        const text = run(unit, 20_000)
        const ms = bestOf3(() => {
          const re = new RegExp(rule.pattern.source, rule.pattern.flags)
          // Every match, as forEachMatch takes them. No rule matches the empty string.
          while (re.exec(text) !== null) { /* next */ }
        })
        expect(ms, `${rule.id} on ${JSON.stringify(unit)}`).toBeLessThan(50)
      }
    }
  })

  it('screens 200,000 characters of any of them in well under a second (an answer is at most 200,000)', () => {
    for (const unit of RUNS) {
      const text = run(unit, 200_000)
      // A quadratic rule takes ten seconds here, which the test above can't always tell from noise.
      expect(bestOf3(() => screenText(text)), JSON.stringify(unit)).toBeLessThan(1_000)
    }
  })
})

describe('the rule changes every scan sees', () => {
  it('bounds the two lookahead rules to 200 characters on the same line', () => {
    const cf = `id ${'a'.repeat(37)} for cloudflare`
    expect(scanText(cf).hits.map((h) => h.rule)).toContain('cloudflare_global')
    expect(scanText(`${'a'.repeat(37)} ${'x'.repeat(250)} cloudflare`).hits.map((h) => h.rule)).not.toContain('cloudflare_global')
    expect(scanText(`${'a'.repeat(37)}\ncloudflare`).hits.map((h) => h.rule)).not.toContain('cloudflare_global')
    expect(scanText(`A${'B'.repeat(31)} is the runner token`).hits.map((h) => h.rule)).toContain('gh_runner_token')
  })

  it('takes PEM, OpenSSH and PGP key blocks whole, CRLF and encrypted headers included', () => {
    const ssh = '-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\n-----END OPENSSH PRIVATE KEY-----\r\nafter'
    expect(scanText(ssh).redacted).toBe('[REDACTED:private_key]\r\nafter')
    const legacy = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0011AABB\n\nMIIE\n-----END RSA PRIVATE KEY-----'
    expect(scanText(legacy).redacted).toBe('[REDACTED:private_key]')
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBF' + 'z'.repeat(60) + '\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----\nok'
    expect(scanText(pgp).redacted).toBe('[REDACTED:gpg_block]\nok')
    const dsa = '-----BEGIN DSA PRIVATE KEY-----\nMIIB\n-----END DSA PRIVATE KEY-----'
    expect(scanText(dsa).redacted).toBe('[REDACTED:ssh_dsa_pubkey]')
  })

  it('stops a key block with no END line at the first line that is not key text', () => {
    const cut = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nThen run the tests.'
    expect(scanText(cut).redacted).toBe('[REDACTED:private_key]\nThen run the tests.')
  })
})

describe('requiredLiteral', () => {
  it('reads the literal start of a pattern, after a leading word boundary', () => {
    expect(requiredLiteral(/-----BEGIN PGP-----/g)).toBe('-----BEGIN PGP-----')
    expect(requiredLiteral(/\bglpat-[A-Za-z0-9_-]{20,}\b/g)).toBe('glpat-')
    expect(requiredLiteral(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g)).toBe('sk-ant-')
    expect(requiredLiteral(/\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_-]+/g)).toBe('//registry.npmjs.org/:_authToken=')
    expect(requiredLiteral(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g)).toBe('-----BEGIN ')
    expect(requiredLiteral(/\baccess_token\$production\$[a-z0-9]{16}/g)).toBe('access_token$production$')
  })

  it('drops a last character a quantifier may remove, and lower-cases for a pattern that ignores case', () => {
    expect(requiredLiteral(/\bhttps?:\/\/x/g)).toBe('http')
    expect(requiredLiteral(/\bkeys*z/g)).toBe('key')
    expect(requiredLiteral(/\bab+c/g)).toBe('a')
    expect(requiredLiteral(/ab{2}/g)).toBe('a')
    expect(requiredLiteral(/foo\.?bar/g)).toBe('foo')
    expect(requiredLiteral(/\bA[A-Z2-7]{31}\b(?=.{0,200}runner)/gi)).toBe('a')
    expect(requiredLiteral(/"([a-z]*)"/gi)).toBe('"')
  })

  it('has none where it could be wrong: a class or group first, an anchor, an escape class, a top-level alternative, non-ASCII', () => {
    expect(requiredLiteral(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g)).toBeNull()
    expect(requiredLiteral(/[?&]sig=([A-Za-z0-9%]{40,})/g)).toBeNull()
    expect(requiredLiteral(/^[ \t]*password:/gim)).toBeNull()
    expect(requiredLiteral(/\d{8,10}:[A-Za-z0-9_-]{35}/g)).toBeNull()
    expect(requiredLiteral(/token|secret/g)).toBeNull()
    expect(requiredLiteral(/clé-[a-z]+/g)).toBe('cl')
    expect(requiredLiteral(/\Bx/g)).toBeNull()
    expect(requiredLiteral(/a?b/g)).toBeNull()
  })

  it('reads past lookbehinds at the start, which take no text, whatever is inside them', () => {
    expect(requiredLiteral(/\b(?<!-)eyJ[A-Za-z0-9_-]{10,}/g)).toBe('eyJ')
    expect(requiredLiteral(/(?<=[(\]])x-[a-z]+/g)).toBe('x-')
    expect(requiredLiteral(/(?<!\()(?<=(?:a|b))key-[a-z]+/g)).toBe('key-')
    // A capture group after it is the end of the literal, as anywhere else.
    expect(requiredLiteral(/(?<![A-Za-z0-9_.-])([a-z]{0,64}?pwd)/gi)).toBeNull()
  })

  it('ignores an alternative inside a group or a class', () => {
    expect(requiredLiteral(/\blin_(?:api|oauth)_[A-Za-z0-9]{40,}\b/g)).toBe('lin_')
    expect(requiredLiteral(/key-[|a-f0-9]{32}/g)).toBe('key-')
    expect(requiredLiteral(/key-[\]|]+/g)).toBe('key-')
  })

  it('is part of every match of every rule that has one', () => {
    // Positive samples for each rule that gets a literal; a literal not in its own match would
    // make the pre-check skip a real credential.
    const samples: Record<string, string> = {
      gh_pat: GH,
      gh_fine_grained: `github_pat_${'a'.repeat(82)}`,
      gitlab_pat: `glpat-${'a'.repeat(20)}`,
      gitlab_runner: `glrt-${'a'.repeat(20)}`,
      bitbucket_app_pw: `ATBB${'a'.repeat(32)}`,
      openai_key: `sk-proj-${'a'.repeat(30)}`,
      anthropic_key: ANTHROPIC,
      google_api: `AIza${'a'.repeat(35)}`,
      huggingface: `hf_${'a'.repeat(34)}`,
      replicate_token: `r8_${'a'.repeat(40)}`,
      azure_storage_key: `AccountKey=${'a'.repeat(88)}`,
      azure_conn_string: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=y',
      gcp_sa_json: '"type": "service_account"',
      slack_token: SLACK,
      slack_webhook: `https://hooks.slack.com/services/T1/B1/${'a'.repeat(24)}`,
      discord_webhook: `https://discord.com/api/webhooks/1/${'a'.repeat(40)}`,
      stripe_pub: `pk_test_${'a'.repeat(24)}`,
      paypal_braintree: `access_token$production$${'a'.repeat(16)}$${'b'.repeat(32)}`,
      square_oauth: `sq0csp-${'a'.repeat(22)}`,
      twilio_sid: `AC${'a'.repeat(32)}`,
      sendgrid_key: `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`,
      mailgun_key: `key-${'a'.repeat(32)}`,
      digitalocean_pat: `dop_v1_${'a'.repeat(64)}`,
      fly_api: `fo1_${'a'.repeat(20)}`,
      render_api: `rnd_${'a'.repeat(30)}`,
      pulumi_pat: `pul-${'a'.repeat(40)}`,
      linear_api: `lin_api_${'a'.repeat(40)}`,
      notion_secret: `secret_${'a'.repeat(43)}`,
      figma_pat: `figd_${'a'.repeat(30)}`,
      npm_token: `npm_${'a'.repeat(36)}`,
      npm_authtoken_line: '//registry.npmjs.org/:_authToken=abc',
      pypi_token: 'pypi-AgEIcHlwaS5vcmcabc',
      docker_pat: `dckr_pat_${'a'.repeat(27)}`,
      sentry_dsn: `https://${'a'.repeat(32)}@o1.ingest.sentry.io/1`,
      mapbox_secret: `sk.eyJ${'a'.repeat(50)}`,
      postgres_url: 'postgresql://u:p@h/db',
      mysql_url: 'mysql://u:p@h/db',
      mongodb_url: 'mongodb+srv://u:p@h',
      redis_url: 'rediss://u:p@h',
      http_basic_auth: 'https://user:secret1@h',
      vault_token: `hvs.${'a'.repeat(20)}`,
      doppler_token: `dp.pt.${'a'.repeat(40)}`,
      doppler_service: `dp.st.${'a'.repeat(40)}`,
      onepassword_secret: `ops_${'a'.repeat(30)}`,
      gh_runner_token: `A${'B'.repeat(31)} runner`,
      circleci_pat: `CCIPAT_${'a'.repeat(30)}`,
      ssh_dsa_pubkey: '-----BEGIN DSA PRIVATE KEY-----',
      gpg_block: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      jwt: `eyJ${'a'.repeat(10)}.eyJ${'b'.repeat(10)}.${'c'.repeat(10)}`,
      private_key: '-----BEGIN EC PRIVATE KEY-----',
      json_secret: '"password": "hunter2x"',
    }
    for (const rule of RULES) {
      const literal = requiredLiteral(rule.pattern)
      if (literal === null) continue
      const sample = samples[rule.id]
      expect(sample, `no sample for ${rule.id}`).toBeDefined()
      const m = new RegExp(rule.pattern.source, rule.pattern.flags).exec(sample)
      expect(m, `${rule.id} does not match its sample`).not.toBeNull()
      const match = rule.pattern.flags.includes('i') ? m![0].toLowerCase() : m![0]
      expect(match.includes(literal), `${rule.id}: ${literal}`).toBe(true)
    }
  })

  it('leaves scanText finding exactly what it found before the pre-check, rule by rule', () => {
    // The scan without the pre-check, as it ran before: every rule, every match.
    const unchecked = (text: string): string[] => {
      const out: string[] = []
      for (const rule of RULES) {
        const re = new RegExp(rule.pattern.source, rule.pattern.flags)
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) out.push(`${rule.id}:${m[0]}`)
      }
      return out
    }
    const corpus = [
      FIXTURES,
      `${ANTHROPIC} ${GH} ${AWS} ${SLACK}\n${PEM}`,
      `GITHUB_TOKEN=${GH.toUpperCase()}\nSecret_${'A'.repeat(43)} and HTTPS://user:pass12@host and Postgres://u:p@h/d`,
      'Key-' + 'a'.repeat(32) + ' KEY-' + 'b'.repeat(32) + ' sk-ANT-' + 'c'.repeat(20),
    ]
    for (const text of corpus) {
      expect(scanText(text).hits.map((h) => `${h.rule}:${h.sample}`).length).toBe(unchecked(text).length)
      expect(scanText(text).hits.map((h) => h.rule)).toEqual(unchecked(text).map((s) => s.slice(0, s.indexOf(':'))))
    }
  })
})
