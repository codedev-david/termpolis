import { describe, it, expect } from 'vitest'
import {
  MAX_APP_LOG_ENTRIES,
  MAX_APP_LOG_LINE_CHARS,
  formatLogArgs,
  formatLogLine,
  formatLogTime,
  normalizeLevel,
  pushLogEntry,
  redactSecrets,
  type AppLogEntry,
  type AppLogLevel,
  type AppLogSource,
} from '../../src/shared/appLog'

// Every fake credential below is BUILT with `.repeat()` instead of being typed out as a
// literal. GitHub push protection scans this repo and rejects a push containing anything
// that scores as a real secret, so a hand-written `sk-9f2c...` would block the commit even
// though it is invented. A run of one repeated character still satisfies the REDACTIONS
// patterns -- they are deliberately SHAPE-based, not entropy-based -- while failing every
// entropy heuristic a scanner uses. Do not "make these look more realistic".
const fake = (n: number): string => 'a'.repeat(n)

// Local-time constructor. `new Date(y, m, d, ...)` is local, and formatLogTime reads local
// getHours()/getMinutes(), so this is the only way to assert an exact clock string that
// holds on a CI box in any timezone. A literal epoch number would pass here and fail in CI.
const at = (h: number, mi: number, s: number, ms: number): number =>
  new Date(2026, 8, 4, h, mi, s, ms).getTime()

const makeEntry = (
  msg: string,
  level: AppLogLevel = 'log',
  source: AppLogSource = 'main',
  t = 0,
): AppLogEntry => ({ t, level, source, msg })

describe('normalizeLevel', () => {
  it('passes every declared level through unchanged', () => {
    // The five levels are the contract between main, preload and the viewer's filter
    // buttons. If one stopped surviving the trip its entries would silently re-bucket
    // into 'log' and disappear from a filtered view.
    expect(normalizeLevel('debug')).toBe('debug')
    expect(normalizeLevel('info')).toBe('info')
    expect(normalizeLevel('log')).toBe('log')
    expect(normalizeLevel('warn')).toBe('warn')
    expect(normalizeLevel('error')).toBe('error')
  })

  it('coerces an unrecognised level string to log', () => {
    // A renderer on an older build (or third-party code shimming console) can send a level
    // this build has never heard of. Dropping the line would lose the very output the user
    // opened the viewer to read, so it degrades to 'log' instead.
    expect(normalizeLevel('trace')).toBe('log')
    expect(normalizeLevel('WARN')).toBe('log') // case-sensitive on purpose: the wire format is lowercase
    expect(normalizeLevel('')).toBe('log')
  })

  it('coerces a number, null, undefined and an object to log', () => {
    // Everything here arrives over IPC, where the sender's type guarantees mean nothing.
    // A malformed log line must never be able to throw inside the thing it was logging about.
    expect(normalizeLevel(42)).toBe('log')
    expect(normalizeLevel(null)).toBe('log')
    expect(normalizeLevel(undefined)).toBe('log')
    expect(normalizeLevel({ level: 'error' })).toBe('log')
    expect(normalizeLevel(['error'])).toBe('log')
    expect(normalizeLevel(true)).toBe('log')
  })
})

describe('redactSecrets', () => {
  it('redacts provider API keys for every recognised prefix', () => {
    // sk-/gsk_/pk_/rk_ covers Anthropic, OpenAI, Groq and the publishable/restricted pairs
    // most SDKs print in their own error messages. The prefix is the whole signal -- the
    // key body is never inspected -- so each one needs its own proof.
    expect(redactSecrets(`sk-${fake(24)}`)).toBe('<redacted-key>')
    expect(redactSecrets(`gsk_${fake(32)}`)).toBe('<redacted-key>')
    expect(redactSecrets(`pk_${fake(20)}`)).toBe('<redacted-key>')
    expect(redactSecrets(`rk-${fake(20)}`)).toBe('<redacted-key>')
  })

  it('leaves a too-short key-shaped run alone', () => {
    // The 16-char floor is what keeps `sk-test` or `pk_dev` in a log message readable.
    // Without it the pattern would eat ordinary prose that happens to start with sk-.
    expect(redactSecrets(`sk-${fake(8)}`)).toBe(`sk-${fake(8)}`)
  })

  it('redacts GitHub tokens for every gh[pousr] prefix', () => {
    // ghp/gho/ghu/ghs/ghr are personal, OAuth, user-to-server, server-to-server and refresh.
    // `gh` CLI failures print these verbatim, and this log is meant to be pasted into an issue.
    expect(redactSecrets(`ghp_${fake(24)}`)).toBe('<redacted-token>')
    expect(redactSecrets(`gho_${fake(20)}`)).toBe('<redacted-token>')
    expect(redactSecrets(`ghu_${fake(20)} ghs_${fake(20)} ghr_${fake(20)}`)).toBe(
      '<redacted-token> <redacted-token> <redacted-token>',
    )
  })

  it('keeps the word Bearer and redacts only the token after it', () => {
    // The header NAME is diagnostic -- "we sent an Authorization: Bearer header" is often the
    // answer -- so the pattern captures and re-emits it. Losing the word would turn a useful
    // line into an unreadable one.
    expect(redactSecrets(`Bearer ${fake(32)}`)).toBe('Bearer <redacted-token>')
    expect(redactSecrets(`authorization: Bearer ${fake(32)}`)).toBe(
      'authorization: Bearer <redacted-token>',
    )
  })

  it('redacts key=value forms that name themselves a secret', () => {
    // The name-based arm is the backstop for the call site nobody thought about: a config
    // dump, an env echo, or a third-party library printing its own options object.
    expect(redactSecrets(`api_key=${fake(20)}`)).toBe('api_key=<redacted>')
    expect(redactSecrets(`api-key=${fake(20)}`)).toBe('api-key=<redacted>')
    expect(redactSecrets(`apikey=${fake(20)}`)).toBe('apikey=<redacted>')
    expect(redactSecrets(`secret: ${fake(12)}`)).toBe('secret: <redacted>')
    expect(redactSecrets(`password=${fake(12)}`)).toBe('password=<redacted>')
    expect(redactSecrets(`passwd=${fake(12)}`)).toBe('passwd=<redacted>')
    expect(redactSecrets(`token=${fake(12)}`)).toBe('token=<redacted>')
    expect(redactSecrets(`authorization: ${fake(12)}`)).toBe('authorization: <redacted>')
  })

  it('redacts a secret inside JSON quoting without eating the quotes', () => {
    // The commonest real shape is a stringified request body. The separator group has to give
    // the quotes back or the surviving line stops being valid JSON to read.
    expect(redactSecrets(`{"token":"${fake(12)}"}`)).toBe('{"token":"<redacted>"}')
  })

  it('redacts a bare 64+ char hex run', () => {
    // No key name, no prefix -- just a shape. A 64-hex blob in this app is a session id, a
    // relay room id or a raw key, and none of the three belong in a file a user will paste.
    expect(redactSecrets(`room ${fake(64)}`)).toBe('room <redacted-hex>')
    expect(redactSecrets(fake(80))).toBe('<redacted-hex>')
  })

  it('does not redact a hex run shorter than 64 chars', () => {
    // A 40-char SHA is the single most useful thing in a build log. The 64 floor exists
    // precisely so git hashes survive; dropping it below 40 would gut the log's value.
    const sha = fake(40)
    expect(redactSecrets(`commit ${sha} landed`)).toBe(`commit ${sha} landed`)
  })

  it('returns ordinary log text completely unchanged', () => {
    // Redaction runs on EVERY line before it is stored, so a false positive is not a cosmetic
    // problem -- it permanently destroys the line. Normal output must be byte-identical.
    const plain = 'spawned terminal 3 (pty pid 1234) in C:/repos/termpolis'
    expect(redactSecrets(plain)).toBe(plain)
    const wiring = 'mcp wiring ok: 22 tools registered, updater idle'
    expect(redactSecrets(wiring)).toBe(wiring)
    expect(redactSecrets('')).toBe('')
  })

  it('redacts every secret on a line, not just the first', () => {
    // One console.log can carry several. A non-global regex here would leak the second one.
    expect(redactSecrets(`ghp_${fake(24)} and sk-${fake(24)}`)).toBe(
      '<redacted-token> and <redacted-key>',
    )
    expect(redactSecrets(`sk-${fake(20)} then sk-${fake(20)}`)).toBe(
      '<redacted-key> then <redacted-key>',
    )
  })

  it('gives the same answer when called repeatedly on the same input', () => {
    // REDACTIONS is a module-level array of /g/ regexes shared by every call. If any code path
    // ever swapped .replace() for .test()/.exec(), a stale lastIndex would make the SECOND call
    // miss a secret it caught the first time -- a leak that only shows up under load.
    const line = `sk-${fake(24)} ghp_${fake(24)}`
    const first = redactSecrets(line)
    expect(redactSecrets(line)).toBe(first)
    expect(redactSecrets(line)).toBe('<redacted-key> <redacted-token>')
  })
})

describe('formatLogArgs', () => {
  it('passes a string argument straight through', () => {
    expect(formatLogArgs(['terminal 2 ready'])).toBe('terminal 2 ready')
  })

  it('keeps an Error stack, which is why anyone opens this viewer', () => {
    // The stack is the payload. Rendering an Error as "[object Error]" or "{}" (what
    // JSON.stringify does to one) would make the whole feature pointless.
    const err = new Error('spawn failed')
    const out = formatLogArgs([err])
    expect(out).toBe(err.stack)
    expect(out).toContain('spawn failed')
  })

  it('falls back to Name: message when an Error has no stack', () => {
    // An Error rebuilt on the far side of IPC (structured clone drops the stack) still has a
    // name and a message. Without the fallback that line renders as empty string.
    const err = new Error('no stack survived ipc')
    err.stack = ''
    expect(formatLogArgs([err])).toBe('Error: no stack survived ipc')
  })

  it('uses the subclass name in the stackless fallback', () => {
    // `name` is read off the instance, not hardcoded, so a custom error still identifies itself.
    const err = new Error('mcp handshake rejected')
    err.name = 'McpError'
    err.stack = ''
    expect(formatLogArgs([err])).toBe('McpError: mcp handshake rejected')
  })

  it('renders null and undefined explicitly instead of dropping them', () => {
    // `console.log('id', undefined)` printing just "id" hides the bug. The argument's absence
    // IS the information, so both have to survive as visible text.
    expect(formatLogArgs([null])).toBe('null')
    expect(formatLogArgs([undefined])).toBe('undefined')
    expect(formatLogArgs(['id', undefined])).toBe('id undefined')
  })

  it('serialises a plain object and an array as JSON', () => {
    expect(formatLogArgs([{ a: 1, b: 'two' }])).toBe('{"a":1,"b":"two"}')
    expect(formatLogArgs([[1, 2, 3]])).toBe('[1,2,3]')
  })

  it('degrades a circular object to String() instead of throwing', () => {
    // Electron objects and React state are routinely circular. A logger that throws while
    // logging takes down the caller -- the one failure mode this module must not have.
    const circular: Record<string, unknown> = { name: 'ring' }
    circular.self = circular
    expect(() => formatLogArgs([circular])).not.toThrow()
    expect(formatLogArgs([circular])).toBe('[object Object]')
  })

  it('degrades to <unprintable> when even String() throws', () => {
    // The last resort needs a last resort. An object whose toJSON AND toString both throw
    // gets past the JSON.stringify guard and blows up in String() -- and logToApp has call
    // sites (ipcMain.on('app-log:append')) with no try/catch of their own, so a throw here
    // would propagate out of a console.log. Rule 1 of this module: logging never breaks the
    // thing it logs.
    const hostile = {
      toJSON() { throw new Error('no json for you') },
      toString() { throw new Error('no string either') },
    }
    expect(() => formatLogArgs([hostile])).not.toThrow()
    expect(formatLogArgs([hostile])).toBe('<unprintable>')
    // And it still renders the arguments around it -- one bad value must not eat the line.
    expect(formatLogArgs(['pty exit', hostile, 'code 1'])).toBe('pty exit <unprintable> code 1')
  })

  it('renders numbers, booleans and symbols via String()', () => {
    // Symbols are the sharp edge: String(sym) works, but `${sym}` and JSON.stringify do not.
    expect(formatLogArgs([42])).toBe('42')
    expect(formatLogArgs([true, false])).toBe('true false')
    expect(formatLogArgs([Symbol('pty')])).toBe('Symbol(pty)')
    expect(formatLogArgs([0])).toBe('0')
  })

  it('joins multiple arguments with a single space, like a console would', () => {
    expect(formatLogArgs(['pty', 7, 'exited with', { code: 1 }])).toBe(
      'pty 7 exited with {"code":1}',
    )
    expect(formatLogArgs([])).toBe('')
  })

  it('redacts secrets before the line can reach the buffer', () => {
    // Redaction on WRITE, not on read: the secret must never exist in the ring or the file,
    // because the file outlives the session and gets attached to bug reports.
    const secret = `sk-${fake(24)}`
    expect(formatLogArgs(['auth header', secret])).toBe('auth header <redacted-key>')

    // ...including a secret that a library put inside an Error message.
    const err = new Error(`auth failed for sk-${fake(24)}`)
    const out = formatLogArgs([err])
    expect(out).toContain('<redacted-key>')
    expect(out).not.toContain(secret)
  })

  it('truncates past MAX_APP_LOG_LINE_CHARS with an exact remainder count', () => {
    // One console.log of a huge object must not be able to shove 2,000 useful lines out of
    // the ring. The suffix has to state the exact number dropped or the reader cannot tell
    // whether they are missing 10 characters or 10 megabytes.
    const out = formatLogArgs(['x'.repeat(MAX_APP_LOG_LINE_CHARS + 50)])
    expect(out.slice(0, MAX_APP_LOG_LINE_CHARS)).toBe('x'.repeat(MAX_APP_LOG_LINE_CHARS))
    expect(out.endsWith('… (50 more chars)')).toBe(true)
    expect(out).toHaveLength(MAX_APP_LOG_LINE_CHARS + '… (50 more chars)'.length)

    // The count is of the JOINED text, so the separating space is included in the overflow.
    const joined = formatLogArgs(['x'.repeat(MAX_APP_LOG_LINE_CHARS), 'y'.repeat(9)])
    expect(joined).toBe(`${'x'.repeat(MAX_APP_LOG_LINE_CHARS)}… (10 more chars)`)
  })

  it('does not truncate a line that lands exactly on the cap', () => {
    // Off-by-one guard: the check is `>`, so a line of exactly MAX chars keeps its last
    // character and gains no suffix.
    const exact = 'x'.repeat(MAX_APP_LOG_LINE_CHARS)
    const out = formatLogArgs([exact])
    expect(out).toBe(exact)
    expect(out).not.toContain('more chars')
  })

  it('measures the redacted length, not the raw length, when deciding to truncate', () => {
    // Order matters: redaction SHRINKS the line. A 4,045-char line carrying a 64-char hex blob
    // comes out at 3,995 and must arrive whole -- truncating on the pre-redaction length would
    // lop off 45 characters for no reason.
    const raw = `${'x'.repeat(3980)} ${fake(64)}`
    expect(raw.length).toBeGreaterThan(MAX_APP_LOG_LINE_CHARS)
    const out = formatLogArgs([raw])
    expect(out).toBe(`${'x'.repeat(3980)} <redacted-hex>`)
    expect(out).not.toContain('more chars')
  })
})

describe('pushLogEntry', () => {
  it('appends entries in arrival order', () => {
    const ring: AppLogEntry[] = []
    pushLogEntry(ring, makeEntry('first'), 10)
    pushLogEntry(ring, makeEntry('second'), 10)
    pushLogEntry(ring, makeEntry('third'), 10)
    expect(ring.map((e) => e.msg)).toEqual(['first', 'second', 'third'])
  })

  it('evicts the oldest entries once the cap is passed', () => {
    // The viewer shows the tail of a session; the interesting output is always the newest.
    const ring: AppLogEntry[] = []
    for (const msg of ['m1', 'm2', 'm3', 'm4', 'm5']) pushLogEntry(ring, makeEntry(msg), 3)
    expect(ring.map((e) => e.msg)).toEqual(['m3', 'm4', 'm5'])
  })

  it('mutates the caller array in place rather than returning a new one', () => {
    // The log store hands out ONE array reference and keeps it for the life of the app. If
    // eviction reassigned instead of splicing, every existing holder would freeze at the cap.
    const ring: AppLogEntry[] = []
    const held = ring
    expect(pushLogEntry(ring, makeEntry('a'), 2)).toBeUndefined()
    pushLogEntry(ring, makeEntry('b'), 2)
    pushLogEntry(ring, makeEntry('c'), 2) // forces the eviction path
    expect(held).toBe(ring)
    expect(held.map((e) => e.msg)).toEqual(['b', 'c'])
  })

  it('treats a cap of 0 as 1', () => {
    // A ring that drops everything silently disables the feature, which is far worse than a
    // ring that holds one line -- so 0 is clamped rather than honoured.
    const ring: AppLogEntry[] = []
    pushLogEntry(ring, makeEntry('a'), 0)
    pushLogEntry(ring, makeEntry('b'), 0)
    expect(ring.map((e) => e.msg)).toEqual(['b'])
  })

  it('treats a negative cap as 1', () => {
    // A negative limit would make `ring.length - limit` splice MORE than the array holds.
    const ring: AppLogEntry[] = []
    pushLogEntry(ring, makeEntry('a'), -5)
    pushLogEntry(ring, makeEntry('b'), -5)
    expect(ring.map((e) => e.msg)).toEqual(['b'])
  })

  it('treats a NaN cap as 1', () => {
    // NaN is what a cap read from a corrupt settings file looks like. Every comparison
    // against NaN is false, so an unguarded limit would disable eviction entirely.
    const ring: AppLogEntry[] = []
    pushLogEntry(ring, makeEntry('a'), Number.NaN)
    pushLogEntry(ring, makeEntry('b'), Number.NaN)
    expect(ring.map((e) => e.msg)).toEqual(['b'])
  })

  it('floors a fractional cap', () => {
    // A cap has to be a whole number of entries; 2.9 means 2, never "sometimes 3".
    const ring: AppLogEntry[] = []
    for (const msg of ['a', 'b', 'c']) pushLogEntry(ring, makeEntry(msg), 2.9)
    expect(ring.map((e) => e.msg)).toEqual(['b', 'c'])
  })

  it('defaults to MAX_APP_LOG_ENTRIES when no cap is given', () => {
    // Callers in main and the renderer both omit the third argument, so the default IS the
    // production cap -- an unbounded default would leak memory for a whole session.
    const ring: AppLogEntry[] = []
    for (let i = 1; i <= MAX_APP_LOG_ENTRIES + 1; i++) pushLogEntry(ring, makeEntry(`m${i}`))
    expect(ring).toHaveLength(MAX_APP_LOG_ENTRIES)
    expect(ring[0].msg).toBe('m2')
    expect(ring[ring.length - 1].msg).toBe(`m${MAX_APP_LOG_ENTRIES + 1}`)
  })
})

describe('formatLogTime', () => {
  it('zero-pads single-digit hours, minutes and seconds', () => {
    // Fixed-width timestamps are what make the viewer scannable; an unpadded 9:5:3 shifts
    // every following column and breaks eyeballed alignment against a second log.
    expect(formatLogTime(at(9, 5, 3, 1))).toBe('09:05:03.001')
    expect(formatLogTime(at(23, 59, 59, 500))).toBe('23:59:59.500')
    expect(formatLogTime(at(13, 45, 7, 42))).toBe('13:45:07.042')
  })

  it('pads milliseconds to three digits', () => {
    // Three separate arms (<10, <100, else). Sub-10ms is the one that matters most: startup
    // races are read in milliseconds, and ".1" vs ".001" is a 100x lie about the gap.
    expect(formatLogTime(at(10, 20, 30, 1))).toBe('10:20:30.001')
    expect(formatLogTime(at(10, 20, 30, 42))).toBe('10:20:30.042')
    expect(formatLogTime(at(10, 20, 30, 500))).toBe('10:20:30.500')
    expect(formatLogTime(at(10, 20, 30, 0))).toBe('10:20:30.000')
  })

  it('returns a placeholder for a timestamp that is not a real date', () => {
    // A missing `t` over IPC would otherwise render "NaN:NaN:NaN.NaN" and, worse, make the
    // line look corrupt rather than merely undated. The placeholder keeps the column width.
    expect(formatLogTime(Number.NaN)).toBe('--:--:--.---')
    expect(formatLogTime(Number.POSITIVE_INFINITY)).toBe('--:--:--.---')
    expect(formatLogTime(Number.NaN)).toHaveLength('00:00:00.000'.length)
  })
})

describe('formatLogLine', () => {
  it('renders the exact line shape with an upper-cased level', () => {
    // This exact string is both what lands in the file on disk and what the user copies out
    // of the viewer, so the shape is a contract with anything that greps the log.
    expect(formatLogLine(makeEntry('pty exited', 'warn', 'renderer', at(7, 8, 9, 12)))).toBe(
      '07:08:09.012 [WARN] [renderer] pty exited',
    )
    expect(formatLogLine(makeEntry('ipc handler threw', 'error', 'main', at(16, 0, 4, 7)))).toBe(
      '16:00:04.007 [ERROR] [main] ipc handler threw',
    )
    expect(formatLogLine(makeEntry('ready', 'debug', 'main', at(0, 0, 0, 0)))).toBe(
      '00:00:00.000 [DEBUG] [main] ready',
    )
  })

  it('carries the invalid-timestamp placeholder into the line', () => {
    // The rest of the line still has to be readable when only the timestamp is junk.
    expect(formatLogLine(makeEntry('undated', 'info', 'renderer', Number.NaN))).toBe(
      '--:--:--.--- [INFO] [renderer] undated',
    )
  })

  it('formats a line built by the rest of the module end to end', () => {
    // The realistic path: raw console args -> formatLogArgs -> ring -> one rendered line.
    // Proves the pieces compose, and that a secret redacted on write never reappears here.
    const ring: AppLogEntry[] = []
    const msg = formatLogArgs(['auth header', `Bearer ${fake(32)}`])
    pushLogEntry(ring, makeEntry(msg, normalizeLevel('warn'), 'main', at(11, 2, 3, 4)))
    expect(formatLogLine(ring[0])).toBe(
      '11:02:03.004 [WARN] [main] auth header Bearer <redacted-token>',
    )
  })
})

describe('app log budgets', () => {
  it('pins the ring and line budgets the viewer and log file are sized around', () => {
    // Both numbers are memory decisions, not style: 2,000 entries x 4,000 chars bounds the
    // in-memory log at a few MB worst case. A silent bump changes the app's footprint.
    expect(MAX_APP_LOG_ENTRIES).toBe(2_000)
    expect(MAX_APP_LOG_LINE_CHARS).toBe(4_000)
  })
})
