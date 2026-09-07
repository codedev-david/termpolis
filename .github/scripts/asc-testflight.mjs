// Who can actually install the TestFlight build, and add someone who cannot.
//
// "TestFlight asks me for an invite code" means TestFlight does not recognise
// the signed-in Apple ID as a tester for any build. That has two causes and
// they look identical on the phone: the ID is not in a beta group at all, or
// the phone is signed into a DIFFERENT Apple ID than the one that was invited.
// The first is fixable from here; the second is not, and knowing which is
// which is the whole point of listing the testers before adding one.
//
// A group created by `eas submit` (Team (Expo)) exists and has access to all
// builds, but creating a group does not put anybody in it. An internal tester
// must also be a user on the account -- Apple will not accept an internal
// invite for an address that has no App Store Connect user record.
//
// Read-only unless ADD_TESTER_EMAIL is set.

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const KEY_PATH = process.env.ASC_API_KEY_PATH
const KEY_ID = process.env.ASC_KEY_ID
const ISSUER = process.env.ASC_ISSUER_ID
const APP_ID = process.env.ASC_APP_ID
const ADD_EMAIL = (process.env.ADD_TESTER_EMAIL || '').trim()

if (!KEY_PATH || !KEY_ID || !ISSUER || !APP_ID) {
  console.error('Need ASC_API_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, ASC_APP_ID')
  process.exit(1)
}

const p8 = readFileSync(KEY_PATH, 'utf8')

function token() {
  const head = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }),
  ).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      iat: now,
      exp: now + 600,
      aud: 'appstoreconnect-v1',
    }),
  ).toString('base64url')
  const s = createSign('SHA256')
  s.update(`${head}.${body}`)
  // Apple wants the raw R||S pair. Node signs DER by default, and a DER
  // signature comes back as a bare 401 with no hint that the shape is wrong.
  const sig = s.sign({ key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${head}.${body}.${sig}`
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const detail = (json.errors || [])
      .map((e) => `${e.title}: ${e.detail}`)
      .join('\n    ')
    throw new Error(`${res.status} ${path}\n    ${detail || text.slice(0, 400)}`)
  }
  return json
}

const groups = await api(`/v1/apps/${APP_ID}/betaGroups?limit=50`)

console.log('=== beta groups on this app ===')
if (!groups.data.length) console.log('  (none)')
for (const g of groups.data) {
  const a = g.attributes
  console.log(
    `  "${a.name}"  id=${g.id}  internal=${a.isInternalGroup}  ` +
      `allBuilds=${a.hasAccessToAllBuilds}  publicLink=${a.publicLinkEnabled}`,
  )
}

console.log('\n=== testers in each group ===')
for (const g of groups.data) {
  const testers = await api(`/v1/betaGroups/${g.id}/betaTesters?limit=100`)
  console.log(`  "${g.attributes.name}":`)
  if (!testers.data.length) {
    // This is the state that produces "enter an invite code" on the phone.
    console.log('    (nobody -- creating a group does not add anyone to it)')
  }
  for (const t of testers.data) {
    const a = t.attributes
    console.log(`    ${a.email}  ${a.firstName || ''} ${a.lastName || ''}`.trimEnd())
  }
}

console.log('\n=== App Store Connect users (eligible to be INTERNAL testers) ===')
const users = await api('/v1/users?limit=50')
for (const u of users.data) {
  console.log(`  ${u.attributes.username}  roles=${u.attributes.roles}`)
}

if (!ADD_EMAIL) {
  console.log('\nRead-only. Set ADD_TESTER_EMAIL to add someone to the internal group.')
} else {
  const internal = groups.data.find((g) => g.attributes.isInternalGroup)
  if (!internal) {
    console.error('\nNo internal group exists. Nothing to add to.')
    process.exit(1)
  }
  console.log(`\n=== adding ${ADD_EMAIL} to "${internal.attributes.name}" ===`)
  try {
    const created = await api('/v1/betaTesters', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'betaTesters',
          attributes: { email: ADD_EMAIL, firstName: 'David', lastName: 'Engelhart' },
          relationships: {
            betaGroups: { data: [{ type: 'betaGroups', id: internal.id }] },
          },
        },
      }),
    })
    console.log(`  added, tester id=${created.data.id}`)
    console.log('  Apple emails the invite. On the phone, TestFlight must be')
    console.log('  signed into THAT address or it will keep asking for a code.')
  } catch (err) {
    // Already-a-tester is the common, harmless case: it means the phone is
    // signed into some other Apple ID, which no API call here can change.
    console.log(`  ${err.message}`)
    console.log('  If this says the tester already exists, the address is')
    console.log('  already invited -- check which Apple ID the phone uses.')
  }
}
