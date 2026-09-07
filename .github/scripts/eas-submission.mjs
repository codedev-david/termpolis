// Asks EAS what Apple actually said about a submission. `eas submit --wait`
// exiting 0 only means Apple ACCEPTED the upload; Apple then validates
// asynchronously, and a failure there produces no build and -- if the account's
// notification address is stale -- no email either. EAS records the outcome, so
// this reads it back rather than inferring it from silence.
const TOKEN = process.env.EXPO_TOKEN
const ID = process.env.SUBMISSION_ID

const r = await fetch('https://api.expo.dev/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    query: `query($submissionId: ID!) {
      submissions {
        byId(submissionId: $submissionId) {
          id status platform
          app { name slug ownerAccount { name } }
          iosConfig { ascAppIdentifier appleIdUsername }
          error { errorCode message }
          logFiles
        }
      }
    }`,
    variables: { submissionId: ID },
  }),
})

const body = await r.json()
if (body.errors) {
  console.log('GraphQL errors:', JSON.stringify(body.errors, null, 2))
  process.exit(0)
}
const s = body.data?.submissions?.byId
if (!s) {
  console.log('No submission found for', ID)
  process.exit(0)
}
console.log(`status        : ${s.status}`)
console.log(`app           : ${s.app?.name} (${s.app?.ownerAccount?.name})`)
console.log(`ascAppId      : ${s.iosConfig?.ascAppIdentifier}`)
console.log(`appleId used  : ${s.iosConfig?.appleIdUsername ?? '(API key, no Apple ID)'}`)
console.log(`error         : ${s.error ? `${s.error.errorCode}: ${s.error.message}` : '(none)'}`)
for (const f of s.logFiles ?? []) console.log(`log           : ${f}`)
