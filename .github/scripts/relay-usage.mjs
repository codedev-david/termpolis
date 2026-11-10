// Read-only: how many phone-desktop pairings use the relay, and how many relay subscriptions are active.
//
// The repo is PUBLIC, so its Actions logs are too: this script writes the numbers to REPORT_PATH (mailed to the
// owner by the workflow) and logs only whether each source answered. Never print a count, an object id or the key.
//
// Relay: every pairing is one Durable Object (relay/src/index.ts: PAIRING_ROOM.idFromName(pairingId)), so distinct
// objects invoked on a day = pairings in use that day. Cloudflare's own analytics already count this; the relay logs
// nothing new (PRIVACY.md: it sees a room id and frame sizes, nothing else).
//
// Subscriptions: App Store Connect's daily SUBSCRIPTION summary report, which needs the vendor number
// (Payments and Financial Reports, top left), kept as the secret ASC_VENDOR_NUMBER.
import { createSign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const DAYS = Math.min(Math.max(Number(process.env.DAYS) || 30, 1), 31)
const out = []
const say = (line = '') => out.push(line)
const day = (d) => d.toISOString().slice(0, 10)

async function relay() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) return console.log('cloudflare: CLOUDFLARE_API_TOKEN not set'), say('Relay: no Cloudflare token.')
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  let account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!account) {
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=5', { headers: auth })
    const j = await r.json().catch(() => null)
    account = j?.result?.[0]?.id
    if (!account) return console.log(`cloudflare: could not list the account (HTTP ${r.status})`), say('Relay: the token cannot list its account.')
  }
  const end = new Date()
  const start = new Date(end.getTime() - (DAYS - 1) * 86_400_000)
  const query = `query($a: String!, $s: Date!, $e: Date!) { viewer { accounts(filter: {accountTag: $a}) {
    durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}) {
      sum { requests } dimensions { date objectId namespaceId } } } } }`
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: auth, body: JSON.stringify({ query, variables: { a: account, s: day(start), e: day(end) } }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || j?.errors?.length) {
    const why = (j?.errors ?? []).map((e) => e.message).join('; ').slice(0, 300) || `HTTP ${r.status}`
    console.log(`cloudflare: analytics refused: ${why}`)
    say('Relay: Cloudflare refused the analytics query.')
    say(`  ${why}`)
    say('  The deploy token likely lacks "Account Analytics: Read". Add it at dash.cloudflare.com/profile/api-tokens')
    say('  (edit the token, add Account > Account Analytics > Read) and run this workflow again.')
    return
  }
  const rows = j?.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? []
  console.log('cloudflare: ok')
  const byDay = new Map()
  const all = new Set()
  const namespaces = new Set()
  for (const row of rows) {
    const { date, objectId, namespaceId } = row.dimensions
    namespaces.add(namespaceId)
    all.add(objectId)
    const d = byDay.get(date) ?? { rooms: new Set(), requests: 0 }
    d.rooms.add(objectId)
    d.requests += row.sum.requests
    byDay.set(date, d)
  }
  say(`Relay, last ${DAYS} days: ${all.size} distinct pairings used it.`)
  if (namespaces.size > 1) say(`  (${namespaces.size} Durable Object namespaces on the account: counts include all of them.)`)
  say('  Each pairing is one phone + one desktop. Subtract the pairings you own yourself; anything left is someone else.')
  say()
  say('  date        pairings  requests')
  for (const [date, d] of [...byDay].sort(([a], [b]) => (a < b ? 1 : -1))) {
    say(`  ${date}  ${String(d.rooms.size).padStart(8)}  ${String(d.requests).padStart(8)}`)
  }
  if (byDay.size === 0) say('  (no relay traffic in this window)')
}

function ascToken() {
  const p8 = readFileSync(process.env.ASC_API_KEY_PATH, 'utf8')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })
  const body = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
  const s = createSign('SHA256')
  s.update(`${head}.${body}`)
  return `${head}.${body}.${s.sign({ key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function subscriptions() {
  const vendor = process.env.ASC_VENDOR_NUMBER
  if (!process.env.ASC_API_KEY_PATH) return console.log('asc: no key'), say('Subscriptions: no App Store Connect key.')
  if (!vendor) {
    console.log('asc: ASC_VENDOR_NUMBER not set')
    say('Subscriptions: not checked. Add your vendor number (App Store Connect > Payments and Financial Reports, top left):')
    say('  gh secret set ASC_VENDOR_NUMBER')
    return
  }
  const jwt = ascToken()
  // The newest daily report is usually two days old; walk back until one exists.
  for (let back = 1; back <= 6; back++) {
    const date = day(new Date(Date.now() - back * 86_400_000))
    const q = new URLSearchParams({
      'filter[frequency]': 'DAILY', 'filter[reportType]': 'SUBSCRIPTION', 'filter[reportSubType]': 'SUMMARY',
      'filter[vendorNumber]': vendor, 'filter[reportDate]': date, 'filter[version]': '1_4',
    })
    const r = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${q}`, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/a-gzip' } })
    if (r.status === 404) continue
    if (!r.ok) {
      const why = (await r.text()).slice(0, 300)
      console.log(`asc: HTTP ${r.status}`)
      say(`Subscriptions: App Store Connect refused the report (HTTP ${r.status}). The key needs the Admin, Finance or Sales role.`)
      say(`  ${why}`)
      return
    }
    console.log('asc: ok')
    const [header, ...lines] = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8').trim().split('\n')
    const cols = header.split('\t')
    const col = (name) => cols.indexOf(name)
    const sum = (name) => lines.reduce((n, l) => n + (Number(l.split('\t')[col(name)]) || 0), 0)
    say(`Subscriptions on ${date} (all subscription products of the account):`)
    say(`  active paid:          ${sum('Active Standard Price Subscriptions')}`)
    say(`  active free trial:    ${sum('Active Free Trial Introductory Offer Subscriptions')}`)
    say(`  billing retry/grace:  ${sum('Billing Retry') + sum('Grace Period')}`)
    say('  Your own subscription, if you bought one with your Apple ID, is in these numbers.')
    return
  }
  console.log('asc: no daily report in the last 6 days')
  say('Subscriptions: no daily report in the last 6 days (Apple publishes one only for days with subscription activity).')
}

say(`Termpolis Remote usage, ${day(new Date())}`)
say()
await relay().catch((e) => { console.log(`cloudflare: failed (${e.name})`); say(`Relay: query failed (${e.message}).`) })
say()
await subscriptions().catch((e) => { console.log(`asc: failed (${e.name})`); say(`Subscriptions: query failed (${e.message}).`) })
writeFileSync(process.env.REPORT_PATH, out.join('\n') + '\n')
