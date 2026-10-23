// The usage-limit chooser's pure half (§8.2, §8.3), shared by the renderer's limit watch and its
// tests: a stop's key, when a limit lifts, what kind of limit it is, and which accounts are a way
// out. Nothing here reads a file or a screen; the screen's words come from the detector
// (agentStatusDetector.ts limitWords), the accounts from main's view (AccountsView).
//
// The CLIs' reset times, in their own forms (read from their program files):
//   Claude Code 2.1.309  "3pm", "3:30pm"; more than a day out "Aug 1, 4pm"; in another year
//                        "Jan 3, 2027, 4pm"; each with its time zone in brackets in a limit
//                        message: "3pm (America/New_York)".
//   Codex 0.153.4        "3:04 PM"; another day "Oct 24th, 2026 4:15 PM"; local time.
import { isProfileAgent } from './agentAccounts'
import type { AccountAgent, AccountLimit, AccountRowView } from './agentAccounts'

/** A stop, without when it lifts: a reset time the CLI redraws as a countdown is the same stop. */
export function stopKey(summary: string): string {
  return summary.replace(/ \(resets .*\)$/, '')
}

/** When the limit a detector summary names lifts, as the CLI put it ("3pm (America/New_York)"), or
 *  null when it names no time. */
export function resetTextOf(summary: string): string | null {
  const m = /^usage limit reached \(resets (.+)\)$/.exec(summary)
  return m ? m[1] : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_MS = 86_400_000
/** How far ahead a date with no year may be once rolled into the next year: a month's limit at most.
 *  Further, the date is a screen read after the limit lifted, and stays in the past. */
const NEXT_YEAR_WITHIN_MS = 35 * DAY_MS

/** Either CLI's reset: an optional date (month, day with Codex's st/nd/rd/th, an optional year), a
 *  twelve-hour time, and Claude Code's zone in brackets. */
const RESET = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (?:(\d{4}),? )?)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?(?:\s*\(([^()\s]+)\))?$/

interface Wall {
  year: number
  month: number
  day: number
}

/** The zone's calendar date and offset from UTC at `ms`; local time when `zone` is null. Throws a
 *  RangeError for a zone Intl doesn't know. */
function wallAt(ms: number, zone: string | null): Wall & { offset: number } {
  if (zone === null) {
    const d = new Date(ms)
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), offset: -d.getTimezoneOffset() * 60_000 }
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return { year: n('year'), month: n('month') - 1, day: n('day'), offset: asUtc - Math.floor(ms / 1000) * 1000 }
}

/** The instant a wall-clock time in `zone` names (local time when null), across a change of clocks:
 *  the zone's offset is read at the guess, then again at the answer. */
function instantOf(w: Wall, hour: number, minute: number, zone: string | null): number {
  if (zone === null) return new Date(w.year, w.month, w.day, hour, minute).getTime()
  const guess = Date.UTC(w.year, w.month, w.day, hour, minute)
  const first = guess - wallAt(guess, zone).offset
  return guess - wallAt(first, zone).offset
}

/**
 * When a limit lifts (epoch ms), from the CLI's reset text and when it was seen: a time of day is
 * the next such time after `seenAt` (tomorrow's once today's passed), a date is that date, in the
 * CLI's zone when it names one, else local time. A date with no year is this year's, or next year's
 * when this year's passed and next year's is within a month (a screen read across the new year).
 * null for anything else: the limit then lasts the agent's cooldown (accounts.sh's 5 hours), or a
 * week for a weekly limit (agentAccounts.ts limitEndsAt).
 */
export function parseResetsAt(text: string, seenAt: number): number | null {
  const m = RESET.exec(text.trim())
  if (!m) return null
  const [, mon, dayText, yearText, hourText, minuteText, ampm, zoneName] = m
  const hour12 = Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null
  const hour = (hour12 % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0)
  const zone = zoneName ?? null
  try {
    const now = wallAt(seenAt, zone)
    if (mon === undefined) {
      const today = instantOf(now, hour, minute, zone)
      return today > seenAt ? today : instantOf({ ...now, day: now.day + 1 }, hour, minute, zone)
    }
    const month = MONTHS.indexOf(mon.toLowerCase())
    const day = Number(dayText)
    if (month < 0 || day < 1 || day > 31) return null
    if (yearText !== undefined) return instantOf({ year: Number(yearText), month, day }, hour, minute, zone)
    const thisYear = instantOf({ year: now.year, month, day }, hour, minute, zone)
    if (thisYear >= seenAt) return thisYear
    const nextYear = instantOf({ year: now.year + 1, month, day }, hour, minute, zone)
    return nextYear - seenAt <= NEXT_YEAR_WITHIN_MS ? nextYear : thisYear
  } catch {
    return null
  }
}

/** What a limit is about (R15): the whole account for a while, or one model. */
export interface LimitKind {
  scope: AccountLimit['scope']
  window: NonNullable<AccountLimit['window']>
  /** The model a model-scoped limit names, as the CLI named it ("Opus", "gpt-5.6-sol"). */
  model?: string
}

/** Claude Code names its models' limits: "You've hit your Opus limit" (seven_day_opus and the like,
 *  weekly), "You've reached your Fable limit.", "Opus requires usage credits.". */
const CLAUDE_MODELS = 'Fable|Haiku|Mythos|Opus|Sonnet'

/**
 * The kind of limit the CLI's own words describe, as Claude Code itself tells them apart (its RP():
 * the session limit, the weekly limit, a model's limit). A model's limit leaves the account usable
 * on other models, so it is recorded as such and never benches the account. Anything else is the
 * account's, for a time the reset says ('other').
 */
export function limitKindOf(words: string): LimitKind {
  const w = words.replace(/’/g, "'")
  let m: RegExpExecArray | null
  if (/You've hit your session limit\b/.test(w)) return { scope: 'account', window: 'session' }
  if (/You've hit your weekly limit\b/.test(w)) return { scope: 'account', window: 'weekly' }
  if ((m = new RegExp(`You've hit your (${CLAUDE_MODELS}) limit\\b`).exec(w))) return { scope: 'model', window: 'weekly', model: m[1] }
  if ((m = /You've reached your (\w+) limit\./.exec(w))) return { scope: 'model', window: 'other', model: m[1] }
  if ((m = new RegExp(`\\b(${CLAUDE_MODELS})(?: [^·\\n]{1,40}?)? requires usage credits\\.`).exec(w))) return { scope: 'model', window: 'other', model: m[1] }
  if (/\bmonthly (?:spend|usage) limit\b/.test(w)) return { scope: 'account', window: 'monthly' }
  // Codex: "You've hit your usage limit for gpt-5.6-sol. Switch to another model now, ...".
  if ((m = /You've hit your usage limit for (\S+?)\.(?:\s|$)/.exec(w))) return { scope: 'model', window: 'other', model: m[1] }
  // agy: "You have exhausted your quota on this model."
  if (/exhausted your quota on this model\b/.test(w)) return { scope: 'model', window: 'other' }
  return { scope: 'account', window: 'other' }
}

/** The model to move a terminal to when a limit is one model's (R15), as Claude Code itself advises
 *  ("try /model sonnet" at Opus's limit, "try /model opus" at Fable's); null where it gives none. */
export function suggestedModel(agent: AccountAgent, kind: LimitKind): string | null {
  if (agent !== 'claude' || kind.scope !== 'model') return null
  if (kind.model === 'Opus') return 'sonnet'
  return kind.model === 'Fable' || kind.model === 'Sonnet' ? 'opus' : null
}

/** "until 3:00 PM" (a weekday too when it isn't within the day), in the user's locale; '' for no
 *  time or a past one. */
export function untilText(resetsAt: number | null, now: number, locale?: string): string {
  if (resetsAt === null || resetsAt <= now) return ''
  const d = new Date(resetsAt)
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  return resetsAt - now < DAY_MS && d.getDate() === new Date(now).getDate()
    ? `until ${time}`
    : `until ${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
}

// ── Which accounts are a way out (§8.3) ─────────────────────────────────────────────────

/** What the chooser asked an account's agent: signed in now, signed out, or couldn't tell
 *  (accountSwitchFlow.ts checkSignIn's answer). */
export type TargetCheck =
  | { kind: 'signed-in'; email: string | null; note?: string }
  | { kind: 'signed-out' }
  | { kind: 'unknown'; why: string }

export interface LimitTarget {
  row: AccountRowView
  /** 'this': the account that ran out. The others are a way out only when 'available'. */
  state: 'available' | 'limited' | 'same-sign-in' | 'signed-out' | 'unknown' | 'folder-missing' | 'this'
  /** What the chooser's row says about it. */
  text: string
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The email an account's profile is actually signed in to, as Termpolis last read it without
 *  starting anything; an agy account's is the address it was registered with. */
function actualEmail(r: AccountRowView): string | null {
  return isProfileAgent(r.agent) ? r.lastEmail : r.email ?? null
}

/**
 * The accounts the chooser lists when a terminal of `agent` ran out on `limited` (its account, and
 * the email its profile is signed in to: a limit belongs to the login, R23): the agent's accounts
 * offered automatically, in failover order from the one after the limited account round, each
 * with whether it is a way out (§8.3 rules 1-7), and the limited one last. An account not offered
 * automatically (work) is never listed (D14). `checks` are what the agent said when asked whether
 * each one is signed in now (rule 5), compared by email with the limited sign-in (rule 6).
 */
export function limitTargets(
  rows: readonly AccountRowView[],
  agent: AccountAgent,
  limited: { accountId: string | null; email: string | null },
  now: number,
  checks: Readonly<Record<string, TargetCheck>> = {},
): LimitTarget[] {
  const own = rows.filter((r) => r.agent === agent).sort((a, b) => a.order - b.order)
  const at = own.findIndex((r) => r.id === limited.accountId)
  const round = at < 0 ? own : [...own.slice(at + 1), ...own.slice(0, at)]
  // Sign-ins out of usage by Termpolis's records: an unexpired limit of the whole account.
  const outEmails = own.filter((r) => r.limit && r.limit.scope === 'account' && r.limit.email).map((r) => r.limit!.email!)
  const targets: LimitTarget[] = []
  for (const r of round) {
    if (!r.autoOffer) continue
    targets.push(targetOf(r, limited.email, outEmails, now, checks[r.id]))
  }
  if (at >= 0) targets.push({ row: own[at], state: 'this', text: 'this terminal\'s account' })
  return targets
}

function targetOf(r: AccountRowView, limitedEmail: string | null, outEmails: readonly string[], now: number, check: TargetCheck | undefined): LimitTarget {
  if (isProfileAgent(r.agent) && !r.folderExists) return { row: r, state: 'folder-missing', text: 'its profile folder doesn\'t exist' }
  const email = check?.kind === 'signed-in' && check.email ? check.email : actualEmail(r)
  if (r.limit && r.limit.scope === 'account') {
    const until = untilText(r.limit.resetsAt, now)
    return { row: r, state: 'limited', text: until ? `out of usage ${until}` : 'out of usage' }
  }
  if (r.limitedOutside !== undefined) return { row: r, state: 'limited', text: 'out of usage (seen by your failover hook)' }
  if (outEmails.some((e) => sameEmail(e, email))) return { row: r, state: 'limited', text: `out of usage (signed in to ${email}, which ran out)` }
  if (sameEmail(email, limitedEmail)) return { row: r, state: 'same-sign-in', text: `signed in to ${email}, the same account` }
  if (check?.kind === 'signed-out') return { row: r, state: 'signed-out', text: 'signed out' }
  if (check?.kind === 'unknown') return { row: r, state: 'unknown', text: `couldn't tell whether it is signed in: ${check.why}` }
  let text = !isProfileAgent(r.agent) ? r.email ?? 'no email given' : check?.kind === 'signed-in' ? (check.email ? `signed in as ${check.email}` : 'signed in') : 'available'
  // A model's limit leaves the account on offer, with the CLI's words.
  if (r.limit) text += ` · ${r.limit.text}`
  return { row: r, state: 'available', text }
}
