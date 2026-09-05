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
| Google Play Console | $25 once | New accounts face a **14-day closed test with at least 12 testers** before production access. Start this first; it is the long pole. |
| Play service account JSON | -- | For `eas submit`. Google Cloud → service account → grant it Play Console access. |

### 2. Fill the two placeholders

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

### 3. Fill the two content placeholders

```bash
grep -rn '<VIDEO URL>\|<SUPPORT EMAIL>' mobile/store/
```

The support address is an open decision -- see the bottom of `listing.md`.
Whatever it becomes, it goes in three places at once: the App Store listing,
the Play listing, and `privacy.html` on termpolis.com.

### 4. Deploy the relay (blocking)

Nothing can be reviewed without it. `relay/` is written and tested but has
never been deployed; it needs a Cloudflare account, `wrangler login` or a
`CLOUDFLARE_API_TOKEN`, and `relay.termpolis.com` resolving. See [`relay/DEPLOY.md`](../../relay/DEPLOY.md).

Confirm with a real phone and a real desktop before anything is submitted. A
reviewer hitting a dead relay sees a broken app, and that rejection costs a
week.

### 5. Assets and copy

- Take the screenshots (`screenshots.md`). Scratch repository only.
- Build the 1024x500 Play feature graphic.
- Record the review video (`review-notes.md`) and host it somewhere stable.
- Paste the listing text from `listing.md`. Do not retype it -- the counts in
  that file were measured, and a form that silently truncates is a form that
  ships a half sentence.

### 6. Build

```bash
cd mobile
npx eas-cli build --platform ios     --profile production
npx eas-cli build --platform android --profile production
```

`production` in `eas.json` sets `autoIncrement`, so `buildNumber` and
`versionCode` advance on their own. `version` in `app.json` is the human one
and is bumped by hand.

### 7. Submit

```bash
npx eas-cli submit --platform ios     --profile production
npx eas-cli submit --platform android --profile production
```

Android's production profile submits to the **internal** track as a **draft**
on purpose. Promote it in the Play Console once it has been installed from the
store on a real device -- an app that works from a local build and fails from
the store is a class of bug that only that step finds.

### 8. Fill the forms

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
