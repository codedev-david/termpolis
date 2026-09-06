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

## Order of operations

Roughly two weeks of calendar time, most of it waiting on other people.

### 1. Accounts (blocking, and only David can do these)

| What | Cost | Notes |
| --- | --- | --- |
| Apple Developer Program | $99/yr | **Already active.** `release.yml` notarizes the desktop app with `secrets.APPLE_TEAM_ID` and an Apple Developer ID certificate, and notarization is impossible without a live Program membership. |
| App Store Connect app record | -- | Create an iOS app with bundle id `com.termpolis.remote`. This mints the numeric App ID that `eas.json` needs. |
| Google Play Console | $25 once | **Registered.** Whether it needs a 14-day closed test before production depends on the account type -- see below. |
| Play service account JSON | -- | For `eas submit`. Google Cloud → service account → grant it Play Console access -- see below. |
| Expo account | free | EAS runs the builds. `expo.dev` → sign up. The Apple and Google credentials are stored here, not in this repo. |

#### Play: find out which timeline you are on, first

Google requires **personal** developer accounts registered since late 2023 to
run a closed test -- at least 12 testers, opted in, continuously for 14 days --
before they may apply for production access. **Organization** accounts are not
subject to it. Termpolis has an LLC behind it (codedev.llc), so which one was
selected at registration decides whether the Android launch is two weeks out or
days out.

Check it rather than assume: Play Console → **Settings → Developer account →
Account details**, and Play Console → **Release → Production**, which states
the outstanding requirement directly. The Console is authoritative; this policy
has moved before and will again.

If the closed test does apply, **it reorders everything below.** The 14-day
clock does not start when the account is created -- it starts when a build is
live on a closed track with testers opted in. So on the Android side, run
steps 2, 3 and 7 (link EAS, fill placeholders, build) as early as they will go,
push that build to a closed track, and do the screenshots, feature graphic,
listing copy and forms *during* the fortnight rather than before it. None of
that work gates the clock, and doing it first simply adds its duration to the
wait.

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

Neither is a secret and both belong in the committed file. **The two that are
credentials -- the App Store Connect API key (`.p8`) and the Play service
account JSON -- never go in the repo.** They go in EAS:

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
