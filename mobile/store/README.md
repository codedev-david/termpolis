# Shipping Termpolis Remote

Everything the App Store and Play Store ask for, and the order to do it in.

| File | What it is |
| --- | --- |
| [`data-disclosures.md`](data-disclosures.md) | Every answer on Apple's App Privacy and Play's Data safety forms, with the code fact behind it |
| [`listing.md`](listing.md) | Name, subtitle, description, keywords, URLs -- written to each field's limit, counts verified |
| [`screenshots.md`](screenshots.md) | Required sizes per store, what to photograph, and the capture commands |
| [`review-notes.md`](review-notes.md) | What reviewers are told, and why there is no demo mode |

Nothing here is generated. If the app changes, these change by hand -- which is
the point: a store form is a declaration, and a declaration nobody re-read is a
declaration nobody checked.

---

## Two timelines, not one

The App Store and Play Store no longer share a schedule here, and conflating
them is what makes this look like a fortnight of work.

| | What gates it | Realistic |
| --- | --- | --- |
| **iPhone, on David's own device** | Nothing but Apple account setup and a build | Same day |
| **iPhone, public on the App Store** | Screenshots, listing, App Review | ~1 week |
| **Android, public on Play** | 14-day closed test with 12 testers, or an org conversion | 2-4 weeks |

Android is parked. Everything under "The iPhone fast path" is independent of
it -- do not read the Play sections as prerequisites.

---

## The iPhone fast path (TestFlight, no review)

**The goal here is the app running on David's iPhone, not a store listing.**
Those are different products with different gates, and only the second one is
slow.

TestFlight **internal** testing needs an active Apple Developer membership, an
App Store Connect app record, and one uploaded build. It needs **no
screenshots, no listing copy, no privacy questionnaire, and no App Review** --
internal testers (up to 100, all of them people on the Apple team account) get
the build as soon as it finishes processing. Nothing below is skipped by doing
this; it just moves the reviewable work off the critical path.

No Mac is required at any point. EAS builds iOS in the cloud.

**1. Link the Expo project** (this is section 2 below, and it is the one step
that will hard-fail everything after it if skipped):

```bash
cd mobile
npx eas-cli login
npx eas-cli init          # writes owner + extra.eas.projectId into app.json
```

**2. Create the App Store Connect record.** appstoreconnect.apple.com → Apps →
**+** → New App → iOS, name **Termpolis Remote**, bundle id
`com.termpolis.remote`, SKU anything. The bundle id is permanent from the first
upload.

**3. Build.** EAS will offer to create the distribution certificate and
provisioning profile -- say yes, and let it manage them:

```bash
npx eas-cli build --platform ios --profile production
```

**4. Upload to TestFlight.** The `testflight` submit profile exists precisely so
this does not wait on the numeric App ID; `eas submit` resolves the record from
the bundle identifier and will prompt for the Apple ID interactively, so no
App Store Connect API key is needed for the first run either:

```bash
npx eas-cli submit --platform ios --profile testflight
```

**5. Answer export compliance -- and answer it the right way.** The build will
land in App Store Connect marked **Missing Compliance**, because
`ITSAppUsesNonExemptEncryption` is `true` in `app.json`. That is correct and
deliberate (`data-disclosures.md`), but the follow-up answer decides whether
this costs thirty seconds or a fortnight:

- "Does your app use encryption?" → **Yes**
- "Does it qualify for any of the exemptions?" → **Yes** -- standard published
  algorithms (X25519, HKDF-SHA256, ChaCha20-Poly1305) in a mass-market app.

Answering **no exemption** puts the build into Apple's export-documentation
review, where it sits until a human approves it and TestFlight stays blocked
the whole time. It is the same form either way; only the answer differs.

**6. Install it.** TestFlight → Internal Testing → add yourself as a tester →
install the TestFlight app on the iPhone → install the build. Then pair against
a running desktop: Settings → Remote → "Allow phones to connect" → "Pair a
device". Pairing offers expire after 90 seconds, so have the phone in hand.

Everything from section 6 onward (screenshots, listing, forms) is what turns
this into a public App Store listing. It can now happen while the app is
already in daily use.

## The hands-off path (GitHub Actions)

The manual path above is written out because it is the one to use when something
is wrong and you need to see each step fail on its own. For a normal build,
`.github/workflows/mobile-ios.yml` ("Publish iOS") does sections 2, 6 and 8
without a machine, an Apple login, or a 2FA prompt: it runs the same gates
`test.yml` runs, links the EAS project and commits the id, builds on EAS, and
uploads to App Store Connect.

It needs four secrets and one variable, and nothing else:

| Name | Kind | Where it comes from |
| --- | --- | --- |
| `EXPO_TOKEN` | secret | expo.dev → account settings → Access tokens → Create |
| `ASC_KEY_ID` | secret | App Store Connect → Users and Access → Integrations → App Store Connect API → the key's own row |
| `ASC_ISSUER_ID` | secret | the same page, above the table |
| `ASC_KEY_P8` | secret | the `.p8` file that key downloads — **once**, and never again |
| `ASC_APP_ID` | variable | the digits in the App Store Connect URL for the app (section 1 creates the record) |

```bash
gh secret   set EXPO_TOKEN     --body '<token>'
gh secret   set ASC_KEY_ID     --body '<key id>'
gh secret   set ASC_ISSUER_ID  --body '<issuer id>'
gh secret   set ASC_KEY_P8     < AuthKey_XXXXXXXXXX.p8
gh variable set ASC_APP_ID     --body '<digits>'
```

`APPLE_TEAM_ID` is already set in this repository, from the desktop signing work.

**The App Store Connect API key must have the Admin role.** App Manager is the
role that looks correct and is not: it can upload a build but cannot create a
signing certificate, so the submit would work and the *build* would fail — and
the build is the step that runs first and costs forty minutes.

Why an API key rather than an Apple ID: eas-cli can mint the distribution
certificate and the provisioning profile from one, with no interactive login
(`credentials/ios/actions/CreateProvisioningProfile.js:27` names the three
`EXPO_ASC_*` environment variables as the non-interactive alternative). An Apple
ID would need a `FASTLANE_SESSION` cookie that expires about a month after
someone pastes it, which is a pipeline that breaks on a schedule.

Run it with **dry_run** checked first: that runs the gates, resolves the
credentials and links the project, then stops before spending a build.

Two things it deliberately does not do. It does not answer **export
compliance** — the build arrives marked *Missing Compliance* because
`ITSAppUsesNonExemptEncryption` is `true`, and the answer is *Yes, it uses
encryption* → *Yes, it qualifies for an exemption*. And it does not promote
anything to the public store; that still needs the screenshots and listing in
sections 6 and 9.

---

## Order of operations

### 1. Accounts (blocking, and only David can do these)

| What | Cost | Notes |
| --- | --- | --- |
| Apple Developer Program | $99/yr | **Already active.** `release.yml` notarizes the desktop app with `secrets.APPLE_TEAM_ID` and an Apple Developer ID certificate, and notarization is impossible without a live Program membership. |
| App Store Connect app record | -- | Create an iOS app with bundle id `com.termpolis.remote`. This mints the numeric App ID that `eas.json` needs. |
| Google Play Console | $25 once | **Registered.** Whether it needs a 14-day closed test before production depends on the account type -- see below. |
| Play service account JSON | -- | For `eas submit`. Google Cloud → service account → grant it Play Console access -- see below. |
| Expo account | free | EAS runs the builds. `expo.dev` → sign up. The Apple and Google credentials are stored here, not in this repo. |

#### Play: find out which timeline you are on, first

The account is **personal**, so the closed test applies: at least 12 testers,
opted in, continuously for 14 days, before production access can even be
applied for. Organization accounts are exempt; this one is not.

Play Console → **Release → Production** states the outstanding requirement
directly, and is authoritative over anything written here -- the policy has
moved before and will again.

**What the fortnight does and does not let you defer.** The clock starts when a
build is live on a *closed* track with testers opted in -- not when the account
was created. But Play will not publish to a closed track until App content and
the main store listing are complete, so the Android assets and disclosure forms
are *not* deferrable: they gate the start of the clock. The work that genuinely
parallelises is **iOS** -- the App Store Connect record, `ascAppId`, the iOS
build and its screenshots all proceed while Android's fourteen days run.

So the Android critical path is: link EAS → app record → App content + listing
(steps 4, 6 and 9 below, using the answers already written in
`data-disclosures.md` and `listing.md`) → build → submit to the closed track →
recruit testers. Everything after that is waiting, and iOS fills it.

Two mistakes here cost a fortnight each and report nothing at the time they are
made:

- **Internal testing is not closed testing.** They are separate tracks and only
  the closed one counts. `eas.json` therefore has a dedicated `closedtest`
  submit profile on the `alpha` track; the `production` profile targets
  `internal` and will not advance the clock.
- **A draft release is not installable**, so nobody can opt in to it. The
  `closedtest` profile sets `releaseStatus: "completed"` for that reason.

`mobile/__tests__/appConfig.test.ts` asserts both, because neither is visible in
the Console until the two weeks have already been lost.

```bash
npx eas-cli submit --platform android --profile closedtest
```

The 12 testers must be 12 distinct Google accounts, added by email or through a
Google Group. Do not pad the count with accounts you control -- Google screens
for it, and the penalty lands on the developer account rather than the release.

#### Play: the app record and the service account

The Play app record takes `com.termpolis.remote` -- **permanent from the first
upload.** It cannot be renamed, and a typo means a new app record, a new
listing, and a new URL.

`eas submit` authenticates as a service account, not as you:

1. Play Console → **Setup → API access** → create or link a Google Cloud project.
2. In Google Cloud, create a service account, then create a **JSON** key for it.
3. Back in Play Console → **Users and permissions**, invite that service
   account's address and grant it release permissions for this app.
4. Hand the JSON to EAS. It never enters this repository:

```bash
eas secret:create --scope project --name GOOGLE_SERVICE_ACCOUNT_KEY --type file --value ./play-service-account.json
```

Then delete the local copy. It is a credential that can publish to the store
under your name.

The permission grant in step 3 propagates on Google's schedule, not yours -- a
`eas submit` run minutes after granting can still fail on permissions. Retry
before assuming the key is wrong.

### 2. Link the app to an EAS project

`app.json` ships with no `owner` and no `extra.eas.projectId`, because a project
id is minted per Expo account and this repository does not have one baked in.
Until it is linked, **step 6 fails before it builds anything** -- `eas build`
has no project to build for.

```bash
cd mobile
npx eas-cli login
npx eas-cli init          # writes owner + extra.eas.projectId into app.json
```

Commit the result. Neither value is a credential: the project id is a public
identifier and the owner is an account slug. The credential is the Expo access
token, and that only ever lives in `eas credentials` or a GitHub secret named
`EXPO_TOKEN`.

Verify before moving on -- this is the check that step 6 assumes passed:

```bash
node -e "const e=require('./app.json').expo; if(!e.extra?.eas?.projectId) { console.error('not linked'); process.exit(1) } console.log('linked:', e.owner, e.extra.eas.projectId)"
```

### 3. Fill the two placeholders

`mobile/eas.json` ships with them deliberately visible:

```bash
grep -n REPLACE_WITH mobile/eas.json
```

| Placeholder | Where the value comes from |
| --- | --- |
| `REPLACE_WITH_APP_STORE_CONNECT_APP_ID` | App Store Connect → the app → App Information → "Apple ID" (a 10-digit number, not the email) |
| `REPLACE_WITH_APPLE_TEAM_ID` | The same 10-character value already stored in this repo's `APPLE_TEAM_ID` secret. It is not a credential -- it is embedded in every signed build -- but it cannot be read back out of GitHub, so copy it from the Apple Developer account page. |

Neither is a secret and both belong in the committed file.

Only for the manual path, though. **"Publish iOS" does not need this section
done** — it writes both values into its own checkout after the build and reverts
them before the job ends, from the `ASC_APP_ID` variable and the `APPLE_TEAM_ID`
secret. It has to: `eas submit --non-interactive` refuses to run without
`ascAppId` (`submit/ios/IosSubmitCommand.js:143`), and `ascAppId` is one of the
fields eas.json will *not* interpolate an environment variable into — the iOS
list is `ascApiKeyPath`, `ascApiKeyIssuerId`, `ascApiKeyId` and nothing else
(`@expo/eas-json`, `submit/types.js`). Writing `"$ASC_APP_ID"` in the file would
send Apple that literal string.

**The two that are credentials -- the App Store Connect API key (`.p8`) and the
Play service account JSON -- never go in the repo.** They go in EAS:

```bash
eas credentials              # interactive, stores the .p8 with Expo
eas secret:create --scope project --name GOOGLE_SERVICE_ACCOUNT_KEY --type file --value ./play-service-account.json
```

### 4. Fill the two content placeholders

```bash
grep -rn '<VIDEO URL>\|<SUPPORT EMAIL>' mobile/store/
```

The support address is an open decision -- see the bottom of `listing.md`.
Whatever it becomes, it goes in three places at once: the App Store listing,
the Play listing, and `privacy.html` on termpolis.com.

### 5. Deploy the relay (done)

Nothing can be reviewed without it. **This is done** -- the Worker is live on
`relay.termpolis.com` and the `Deploy relay` workflow is green end to end. A
redeploy is `gh workflow run "Deploy Relay" -f dry_run=false`; see
[`relay/DEPLOY.md`](../../relay/DEPLOY.md).

The smoke test asserts the deploy bound `relay.termpolis.com` specifically, not
merely that *something* answered. Both clients hardcode `wss://relay.termpolis.com`
as their default, so a deploy that bound only a `workers.dev` name would leave
every phone unable to pair while the check went green.

Still confirm with a real phone and a real desktop before anything is
submitted. A reviewer hitting a dead relay sees a broken app, and that
rejection costs a week.

### 6. Assets and copy

- Take the screenshots (`screenshots.md`). Scratch repository only.
- Build the 1024x500 Play feature graphic.
- Record the review video (`review-notes.md`) and host it somewhere stable.
- Paste the listing text from `listing.md`. Do not retype it -- the counts in
  that file were measured, and a form that silently truncates is a form that
  ships a half sentence.

### 7. Build

```bash
cd mobile
npx eas-cli build --platform ios     --profile production
npx eas-cli build --platform android --profile production
```

`production` in `eas.json` sets `autoIncrement`, so `buildNumber` and
`versionCode` advance on their own. `version` in `app.json` is the human one
and is bumped by hand.

### 8. Submit

```bash
npx eas-cli submit --platform ios     --profile production
npx eas-cli submit --platform android --profile production
```

There are three submit profiles and they are not interchangeable:

| Profile | Goes to | Use it for |
| --- | --- | --- |
| `testflight` | TestFlight, iOS only | Getting the build onto a real iPhone today. No App ID needed. |
| `closedtest` | Play `alpha`, released live | The only Android track that advances the 14-day clock. |
| `production` | App Store / Play `internal` draft | The public release. |

Android's production profile submits to the **internal** track as a **draft**
on purpose. Promote it in the Play Console once it has been installed from the
store on a real device -- an app that works from a local build and fails from
the store is a class of bug that only that step finds.

### 9. Fill the forms

- Apple: App Privacy → **Data Not Collected** (see `data-disclosures.md`),
  then the export-compliance questions, then Review Notes from
  `review-notes.md`.
- Play: Data safety → **no collection, no sharing**, App access → **all
  functionality available**, content rating questionnaire, target audience 18+.

---

## After the first submission

Some things are permanent from the moment Apple or Google accepts a build.

- **The bundle identifiers.** `com.termpolis.remote`, both stores. Changing one
  means a new app, a new listing, and no upgrade path for anyone who installed
  the old one. `mobile/__tests__/appConfig.test.ts` asserts both so an edit
  fails a test rather than a release.
- **The app name**, effectively. It can be changed, but it is how people find
  the app again.
- **`ITSAppUsesNonExemptEncryption`.** Also test-asserted. Flipping it to false
  would be a false statement on an export declaration.
- **Removing a permission is free; adding one is a review.** The `CAMERA` and
  `INTERNET` pair is what the current listing describes.

## When the app changes

Re-read `data-disclosures.md` before shipping any of these -- each one makes
part of the current declaration untrue:

- a new dependency (the exact dependency list is asserted by a test, so this
  announces itself)
- push notifications, an account, or any hosted sync
- writing terminal output to disk
- analytics or crash reporting of any kind

## Where the pieces live

| Piece | Path |
| --- | --- |
| The phone app | `mobile/` |
| Build and submit profiles | `mobile/eas.json` |
| Icons and splash | `mobile/assets/` |
| The desktop half | `src/main/remoteBridge/` |
| The relay | `relay/` |
| The wire format | `docs/remote-wire-format.md` |
| The public privacy policy | `https://termpolis.com/privacy.html` (source: `termpolis-website/privacy.html`) |
