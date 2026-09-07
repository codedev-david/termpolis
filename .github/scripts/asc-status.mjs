// Read-only App Store Connect probe. Answers one question: where did the build
// actually go? "TestFlight shows no builds" has three very different causes --
// still processing, uploaded into a DIFFERENT app record, or rejected by
// Apple's post-upload validation -- and they are indistinguishable from the
// console. The API tells all three apart in one call.
//
// Prints app names, bundle ids and build states. Never prints the key. The
// numeric app id is a GitHub secret so Actions masks it as ***; that is fine,
// the bundle id is what identifies the record to a human.
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const KEY_ID = process.env.ASC_KEY_ID
const ISSUER = process.env.ASC_ISSUER_ID
const APP_ID = process.env.ASC_APP_ID
const p8 = readFileSync(process.env.ASC_API_KEY_PATH, 'utf8')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

// ES256, and the signature must be JOSE r||s -- Node emits DER by default and
// Apple rejects that with a bare 401 that names nothing.
function token() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
  const body = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
  const s = createSign('SHA256')
  s.update(`${head}.${body}`)
  const sig = s.sign({ key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${head}.${body}.${sig}`
}

const JWT = token()
async function api(path) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${JWT}` },
  })
  const text = await r.text()
  if (!r.ok) {
    console.log(`  !! ${r.status} on ${path}`)
    console.log(`  ${text.slice(0, 600)}`)
    return null
  }
  return JSON.parse(text)
}

console.log('=== every app record this key can see ===')
const apps = await api('/v1/apps?limit=200&fields[apps]=name,bundleId,sku,primaryLocale')
if (apps) {
  for (const a of apps.data) {
    const mark = a.id === APP_ID ? '  <-- ASC_APP_ID points here' : ''
    console.log(`  ${a.id}  ${a.attributes.bundleId}  "${a.attributes.name}"${mark}`)
  }
  if (apps.data.length === 0) console.log('  (none)')
  if (APP_ID && !apps.data.some((a) => a.id === APP_ID)) {
    console.log(`  !! ASC_APP_ID is not in this list -- it names no app this key can see.`)
  }
}

console.log('')
console.log('=== builds, newest first, for every app above ===')
for (const a of apps?.data ?? []) {
  const builds = await api(
    `/v1/builds?filter[app]=${a.id}&limit=10&sort=-uploadedDate` +
      `&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption`
  )
  console.log(`  ${a.attributes.bundleId}:`)
  if (!builds || builds.data.length === 0) {
    console.log('    (no builds)')
    continue
  }
  for (const b of builds.data) {
    const t = b.attributes
    console.log(
      `    v${t.version}  ${t.processingState}  uploaded=${t.uploadedDate}` +
        `  expired=${t.expired}  nonExemptEncryption=${t.usesNonExemptEncryption}`
    )
  }
}
