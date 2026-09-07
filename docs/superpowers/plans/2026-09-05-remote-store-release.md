# Termpolis Remote — Store Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Termpolis Remote through App Store and Google Play review, with the
disclosures, the policy URL and the review access those reviews demand — and with
regression gates so the claims stay true after the submission.

**Architecture:** Sub-project 4 ships three kinds of artifact. A **live privacy policy
page** on termpolis.com, because both stores refuse an app without a reachable URL. A
set of **submission documents** under `mobile/store/`, each answer traceable to a fact
about the code rather than to a marketing instinct. And **tests** that fail when the
code stops matching those answers — the export-compliance flag, the permission set, and
the dependency list that makes "no data collected" true.

**Tech Stack:** Expo / EAS Build / EAS Submit, jest for the config gates, plain HTML on
termpolis-web (auto-deploys to termpolis.com on push to main).

**Spec:** `docs/superpowers/specs/2026-09-04-termpolis-remote-design.md` (§9,
"Known lead-time items for sub-project 4")

## Global Constraints

- Bundle id `com.termpolis.remote` on **both** platforms. Never change it after the
  first submission; it is not re-assignable.
- `ITSAppUsesNonExemptEncryption: true`. The pairing channel is X25519 + HKDF +
  ChaCha20-Poly1305. The exemption does not apply, and getting this wrong is the most
  commonly missed submission gate.
- The phone app collects **nothing**. No analytics SDK, no crash reporter, no
  advertising id, no account. Every disclosure follows from that, so any change to it
  invalidates the disclosures — which is why Task 2 gates the dependency list.
- Android permissions: `CAMERA` and `INTERNET` only. `RECORD_AUDIO` and external
  storage stay in `blockedPermissions`, because `expo-camera` merges them in otherwise
  and an app that scans one QR code has no business asking to record audio.
- The camera is used for pairing and nothing else. Frames are never stored, never
  uploaded, never sent anywhere.
- Commit directly to `main` in both repos. No branches, no PRs.
- Do not describe the product as "like Telegram". The model is Signal's: end-to-end
  encrypted by construction, with an untrusted relay.
- Screenshots and listing copy must not show a real terminal's contents. Use a scratch
  repo and a scripted session.
- Never paste an App Store Connect API key, a Play service-account JSON, or a
  Cloudflare token into the repo. They belong in EAS secrets and GitHub secrets.

---

## File Structure

| Path | Repo | Responsibility |
| --- | --- | --- |
| `mobile/__tests__/appConfig.test.ts` | termpolis | Gates the submission-critical fields of `app.json` and the dependency allowlist. |
| `mobile/store/README.md` | termpolis | The runbook: what to do, in what order, to submit. |
| `mobile/store/data-disclosures.md` | termpolis | Apple Privacy Nutrition + Google Play Data Safety answers, each with the fact that justifies it. |
| `mobile/store/listing.md` | termpolis | Name, subtitle, description, keywords, categories, age rating, URLs — both stores. |
| `mobile/store/review-notes.md` | termpolis | What App Review and Play review need in order to actually exercise a desktop companion. |
| `mobile/store/screenshots.md` | termpolis | Required sizes and the exact commands that produce them. |
| `privacy.html` | termpolis-web | The privacy policy both stores require a URL for. |
| `sitemap.xml`, `index.html`, `docs.html` | termpolis-web | Footer link + sitemap entry so the policy is reachable and indexed. |

Tasks 1 and 2 are unblocked today. Tasks 3–5 are unblocked but only *matter* once
Task 6's accounts exist. Task 6 needs David; it is the gate, and it is stated as a
task rather than a footnote so it does not get lost.

---

### Task 1: The privacy policy page

**Files:**
- Create: `../termpolis-web/privacy.html`
- Modify: `../termpolis-web/sitemap.xml`, `../termpolis-web/index.html` (footer), `../termpolis-web/docs.html` (footer)

**Interfaces:**
- Produces: the URL `https://termpolis.com/privacy.html`, consumed by Task 3's listing
  fields, Task 2's Play Data Safety form, and App Store Connect's app privacy section.

Both stores reject a submission whose privacy-policy URL 404s, and Play requires the
URL before the Data Safety form can be saved. The page is therefore the first
dependency, not the last piece of paperwork.

The policy covers the desktop app and the phone app together, because they are one
product and a reviewer following the URL from either store should not land on a page
that only describes the other half.

- [x] **Step 1: Read the site's shell**

The page must match the existing chrome. Read `index.html`'s `<head>`, header and
footer and reuse them verbatim — same `styles.css`, same nav, same favicon links.

```bash
sed -n '1,80p' ~/repos/termpolis-web/index.html
grep -n '<footer' -A 30 ~/repos/termpolis-web/index.html
```

- [x] **Step 2: Write `privacy.html`**

Sections, in this order: what the desktop stores locally and never uploads; what the
phone stores (its X25519 secret and the pairing record, in the OS keystore); what the
relay can see (ciphertext, a room id, a frame length — and that it keeps no logs and
persists no frames); the camera (pairing only); telemetry (desktop, opt-in, off by
default); what third parties receive (the model provider you signed in to, on the
desktop, under their terms — not us); children; changes; contact.

Every claim must be one you can point at code for. If you cannot, cut the claim.

- [x] **Step 3: Verify it renders and the links resolve**

```bash
cd ~/repos/termpolis-web && python -m http.server 8099 &
python -c "import urllib.request as u; print(u.urlopen('http://localhost:8099/privacy.html').status)"
```
Expected: `200`, and the page is styled — an unstyled page means the CSS path is wrong
relative to the site root.

- [x] **Step 4: Add the footer link and the sitemap entry**

Add `<a href="/privacy.html">Privacy</a>` to the footer of `index.html` and
`docs.html`, and a `<url>` block for `https://termpolis.com/privacy.html` in
`sitemap.xml` with `<priority>0.5</priority>`.

- [x] **Step 5: Commit and deploy** — pushed as `13ab9c2`; the "Deploy Website" Action succeeded (run 33955953921, 2m14s). Live URL verified: `https://termpolis.com/privacy.html` returns **200**, `text/html`, no redirect, `<title>Privacy Policy — Termpolis</title>`. Checked through an external fetcher, because this machine cannot reach the host at all — `termpolis.com` and `codedev.llc` both refuse on 80 and 443 here while the site serves 200 to the outside world. The host is `72.167.84.0`, and a `.0` last octet is dropped by plenty of local firewalls as a network address. That is a workstation networking quirk, not a site or deploy problem; verify from outside, not with `curl` on this box.

```bash
cd ~/repos/termpolis-web
git add privacy.html sitemap.xml index.html docs.html
git commit -m "docs: privacy policy, required for the App Store and Play submissions"
git push origin main
```

The "Deploy Website" Action publishes on push to main; it takes about two minutes.
Confirm afterwards:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://termpolis.com/privacy.html
```
Expected: `200`.

---

### Task 2: Gate the claims the store forms will make

**Files:**
- Create: `mobile/__tests__/appConfig.test.ts`
- Modify: `mobile/jest.config.js` (only if `app.json` needs adding to the module map)
- Test: the file above is the test

**Interfaces:**
- Consumes: `mobile/app.json` as written in `1114d38`.
- Produces: nothing importable. It produces the right to write "no data collected" on
  two store forms and still be telling the truth in six months.

A disclosure is a claim about code. `ITSAppUsesNonExemptEncryption` can be dropped by a
careless `app.json` edit, `blockedPermissions` can be lost when a plugin is added, and
"collects no data" stops being true the first time someone installs an analytics SDK —
in every case silently, months after the form was submitted. These are the cheapest
tests in the project and they guard the most expensive mistake.

The dependency assertion is deliberately an **exact-set** check, not a denylist. A
denylist only catches SDKs you thought of. An exact set forces whoever adds the next
dependency to look at this test, read why it exists, and decide consciously whether the
privacy answers still hold.

- [x] **Step 1: Write the failing test**

```ts
import appConfig from '../app.json'
import pkg from '../package.json'

describe('app.json -- the fields a store submission turns on', () => {
  it('declares non-exempt encryption', () => {
    // X25519 + HKDF + ChaCha20-Poly1305. Claiming exemption here is a false
    // statement on an export-compliance form, not a shortcut.
    expect(appConfig.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption).toBe(true)
  })

  it('keeps the bundle identifiers that were submitted', () => {
    expect(appConfig.expo.ios.bundleIdentifier).toBe('com.termpolis.remote')
    expect(appConfig.expo.android.package).toBe('com.termpolis.remote')
  })

  it('asks Android for the camera and the network, and nothing else', () => {
    expect(appConfig.expo.android.permissions).toEqual([
      'android.permission.CAMERA',
      'android.permission.INTERNET',
    ])
  })

  it('blocks the permissions expo-camera would otherwise merge in', () => {
    // An app that scans one QR code has no business asking to record audio.
    expect(appConfig.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.RECORD_AUDIO']),
    )
  })

  it('explains the camera in the words the permission prompt will use', () => {
    const [, camera] = appConfig.expo.plugins.find(
      (p: unknown): p is [string, { cameraPermission: string }] =>
        Array.isArray(p) && p[0] === 'expo-camera',
    )!
    expect(camera.cameraPermission).toMatch(/pairing code/i)
  })
})

describe('package.json -- what makes "collects no data" true', () => {
  it('carries exactly the reviewed dependencies', () => {
    // Exact, not a denylist. Adding anything here should send you to
    // mobile/store/data-disclosures.md before it sends you to the store.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@noble/ciphers',
      '@noble/curves',
      '@noble/hashes',
      '@react-navigation/native',
      '@react-navigation/native-stack',
      'expo',
      'expo-camera',
      'expo-constants',
      'expo-secure-store',
      'expo-splash-screen',
      'expo-status-bar',
      'react',
      'react-native',
      'react-native-get-random-values',
      'react-native-safe-area-context',
      'react-native-screens',
      'zustand',
    ])
  })
})
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
npm --prefix mobile test -- appConfig
```
Expected: FAIL — `Cannot find module '../app.json'` unless `resolveJsonModule` and
jest's transform allow JSON imports. If that is the failure, fix the config, not the
test.

- [x] **Step 3: Make it pass**

No production change should be needed: `1114d38` already sets every one of these. If a
field is genuinely missing, add it to `app.json` — do not soften the assertion.

- [x] **Step 4: Run the whole mobile gate**

```bash
npm --prefix mobile run typecheck && npm --prefix mobile run typecheck:wire && npm --prefix mobile run test:coverage
```
Expected: PASS, with coverage floors still met.

- [x] **Step 5: Commit**

```bash
git add mobile/__tests__/appConfig.test.ts mobile/jest.config.js
git commit -m "test(mobile): gate the app.json fields and dependency set the store forms assert"
```

---

### Task 3: The disclosure answer sheet

**Files:**
- Create: `mobile/store/data-disclosures.md`

**Interfaces:**
- Consumes: Task 1's policy URL; the dependency set Task 2 froze.
- Produces: the literal answers to type into App Store Connect's App Privacy section
  and Play Console's Data Safety form.

Both forms are long, both are answered under a truthfulness declaration, and both are
answered again at every future release by whoever is submitting that day. Writing the
answers down once, next to the reason each one is what it is, is the difference between
a consistent record and a form filled in from memory at 11pm.

- [x] **Step 1: Write the Apple section**

For every category Apple lists (Contact Info, Health, Financial, Location, Sensitive
Info, Contacts, User Content, Browsing History, Search History, Identifiers, Purchases,
Usage Data, Diagnostics, Other), record **Not Collected**, and state the fact behind it.
The overall answer is "Data Not Collected", which removes the tracking questions
entirely. Note the two things a reviewer may ask about anyway:

- The camera. Used to scan the pairing code. Frames are never persisted or transmitted;
  the decoded payload never leaves the device except as the pairing handshake.
- Terminal output. It reaches the phone end-to-end encrypted, lives in memory for as
  long as the app does, and is never written to disk. It is not "collected" by us in
  Apple's sense — it never reaches a server we can read — but say so plainly rather
  than leaving a reviewer to guess.

- [x] **Step 2: Write the Google section**

Play's form asks per data type whether it is *collected* (leaves the device to a server
you control) and whether it is *shared*. Answer **no** to both throughout, then fill the
security section: data is encrypted in transit (yes — the transport is TLS and the
payload is additionally sealed end to end), and there is a way to request deletion
(yes — unpairing on the phone or revoking on the desktop, both of which destroy the key
material; nothing of the user's is held server-side to delete).

Record explicitly that the relay is not a collector: it forwards ciphertext addressed by
a room id, keeps no logs, and persists no frames (`relay/src/pairingRoom.ts` stores only
an idle alarm).

- [x] **Step 3: Write the "what would change this" section**

List the changes that would invalidate the answers: adding any analytics or crash SDK,
adding push notifications, persisting scrollback, adding an account system, or the relay
beginning to log. Point at `mobile/__tests__/appConfig.test.ts` as the thing that will
notice the first of those.

- [x] **Step 4: Commit**

```bash
git add mobile/store/data-disclosures.md
git commit -m "docs(mobile): the App Store and Play data disclosures, with their reasons"
```

---

### Task 4: Listing copy and screenshots

**Files:**
- Create: `mobile/store/listing.md`, `mobile/store/screenshots.md`

**Interfaces:**
- Consumes: Task 1's policy URL.
- Produces: every text field both consoles require, and the commands that produce the
  image assets.

- [x] **Step 1: Write `listing.md`**

Fields, with the store's limit next to each: app name (30 chars, Apple), subtitle (30),
promotional text (170), description (4000), keywords (100, comma-separated, no spaces),
support URL, marketing URL, privacy policy URL, primary and secondary category
(Developer Tools / Utilities), age rating answers (all "None" — the app has no user
content, no web browsing, no ads), and Play's short description (80) and full
description (4000).

The description must lead with the constraint rather than bury it: this app does nothing
on its own. It talks to a Termpolis desktop that is running, on a machine you control,
signed in the way you already signed it in. Someone who installs it expecting a
standalone AI terminal will leave a one-star review, and the listing is the only place
that expectation gets set.

Say what it is: read what your agents are doing, answer a prompt that is waiting, start
a new agent terminal, from a phone. Say what it is not: no memory, no embeddings, no
model credentials on the phone, nothing stored, no account.

- [x] **Step 2: Write `screenshots.md`**

Required sets: iPhone 6.9" (1320×2868 or 1290×2796) and 6.5"; iPad 13" only if
`supportsTablet` stays true — it is true today, so either produce them or set it false
before submitting, and say which. Play needs a 512×512 icon, a 1024×500 feature graphic,
and at least two phone screenshots.

The five screens worth showing: pairing (QR framed on the desktop's screen), the safety
words side by side, the terminal list with live agent status, one terminal mid-answer,
and settings showing capabilities as facts.

Record the capture commands:

```bash
# iOS simulator, from a dev build
xcrun simctl list devices | grep -i "iPhone 16 Pro Max"
xcrun simctl boot "iPhone 16 Pro Max"
xcrun simctl io booted screenshot --type=png mobile/store/shots/ios-01-pair.png

# Android emulator
adb exec-out screencap -p > mobile/store/shots/android-01-pair.png
```

Two rules for the captures: pair against a scratch repo, never a real one, and never let
a real path, branch name or prompt into the frame. A screenshot is published forever.

- [x] **Step 3: Commit**

```bash
git add mobile/store/listing.md mobile/store/screenshots.md
git commit -m "docs(mobile): store listing copy and the screenshot capture procedure"
```

---

### Task 5: Review access — the real rejection risk

**Files:**
- Create: `mobile/store/review-notes.md`

**Interfaces:**
- Consumes: the phone's manual pairing-payload entry (the path that exists so Expo Go
  can pair without a camera).
- Produces: the App Review notes field, and the Play "app access" instructions.

This is the task most likely to cost a rejection, and it has nothing to do with
cryptography. App Review guideline 2.1 requires the reviewer be able to exercise the
app. A reviewer opening Termpolis Remote sees a pairing screen and has no Termpolis
desktop, so without preparation the app is untestable and gets rejected as incomplete.

> **Correction, recorded during execution.** This task was planned around
> handing the reviewer a pairing payload in the review notes. That cannot work:
> a pairing offer expires after **90 seconds** (`DEFAULT_TTL_MS`,
> `src/main/remoteBridge/pairing.ts:13`), so anything pasted into a static form
> is stale long before a reviewer reads it. A newly paired device is also
> granted **no capabilities at all** (`pairing.ts:217` seeds
> `{ ...NO_CAPABILITIES }`), so a reviewer who paired successfully would still
> see an empty app. `mobile/store/review-notes.md` as written instead walks the
> reviewer through installing the free, notarized desktop build from
> `releases/latest` and granting the two capabilities themselves, with a screen
> recording as the fallback. The "no demo mode" decision below stands.

The approach: **a real desktop, reachable during review.** Not a demo mode. A hidden
scripted fake would be a second code path that no one exercises, that can drift from the
real one, and that Apple treats with suspicion when it is discovered rather than
declared. A real desktop is also the honest answer — it is exactly what a user does.

- [x] **Step 1: Write the reviewer procedure**

A numbered, no-context-assumed procedure: install, tap "Enter code manually", paste the
payload from the review notes, compare the eight safety words against the screenshot
embedded in the notes, then read output and type into the running terminal.

State plainly that the app is a client for software the reviewer is not being asked to
install, that a desktop has been left running and paired-ready for the review window,
and give a contact for re-issuing the payload if the window lapses.

- [x] **Step 2: Write the operator procedure**

What David does before submitting: launch Termpolis on a machine that will stay awake,
enable Remote, grant `read` and `writeToTerminal` and nothing more, open a terminal in a
scratch repo, generate the pairing payload, and paste it into the review notes. What to
do if review takes longer than the payload's life: re-generate and update the notes via
App Store Connect, which does not require a new binary.

Note the capability choice and why: `createTerminal` and `closeTerminal` stay off. A
reviewer does not need them, and a spare pairing that can spawn processes on a machine
you own is not a thing to leave running for a week.

- [x] **Step 3: Record the fallback**

If leaving a desktop online for the review window is not workable, the fallback is a
screen recording of the full flow attached to the review notes, plus an offer to
demonstrate live. Weaker, sometimes accepted, and worth writing down now rather than
inventing under a rejection.

- [x] **Step 4: Commit**

```bash
git add mobile/store/review-notes.md
git commit -m "docs(mobile): App Review access procedure for a desktop companion app"
```

---

### Task 6: The submission runbook, and the accounts it waits on

**Files:**
- Create: `mobile/store/README.md`
- Modify: `mobile/eas.json` (replace the two placeholders), `mobile/README.md` (link to `store/`)

**Interfaces:**
- Consumes: everything above.
- Produces: a first submission.

`mobile/eas.json` carries `REPLACE_WITH_APP_STORE_CONNECT_APP_ID` and
`REPLACE_WITH_APPLE_TEAM_ID`. They cannot be filled from this repo — they come from
accounts. That is the gate, and it is a task rather than a footnote so that it is
visible in the plan rather than discovered at submission time.

**Needs David:**
- **Apple Developer Program** membership ($99/yr). Memory records Apple signing secrets
  already in CI for macOS notarization — check `gh secret list` and confirm whether that
  is full Program membership or only a Developer ID certificate. They are not the same,
  and only the former can create an App Store Connect record.
- An **App Store Connect app record** for `com.termpolis.remote`, which yields the
  numeric `ascAppId`; and the Apple **Team ID** from the membership page.
- **Google Play Console** registration ($25 one-time) and a service-account JSON for
  `eas submit`.

- [x] **Step 1: Write the runbook**

Order of operations, because several of these block each other: policy URL live →
app records created in both consoles → disclosures submitted → listing and screenshots
uploaded → build → internal testing track / TestFlight → review notes → submit.

- [x] **Step 2: Record the build and submit commands**

```bash
npm --prefix mobile run typecheck && npm --prefix mobile run typecheck:wire && npm --prefix mobile run test:coverage
npx eas-cli build --profile production --platform all
npx eas-cli submit --profile production --platform ios
npx eas-cli submit --profile production --platform android
```

`production` already sets `autoIncrement`, so the build number advances without editing
`app.json`. The Android track is `internal` with `releaseStatus: draft` — deliberate, so
the first upload cannot go public by accident.

- [x] **Step 3: Fill the placeholders** — superseded for the automated path, still open for the manual one. The placeholders stay in the committed `eas.json`; `.github/workflows/mobile-ios.yml` writes both values into its own checkout after the build and reverts them before the job ends, from the `ASC_APP_ID` variable and the existing `APPLE_TEAM_ID` secret. It cannot use env interpolation for them: `eas submit --non-interactive` requires `ascAppId` (`submit/ios/IosSubmitCommand.js:143`) and `ascAppId` is not in the iOS interpolation list, which is `ascApiKeyPath`/`ascApiKeyIssuerId`/`ascApiKeyId` only (`@expo/eas-json`, `submit/types.js`). Creating the App Store Connect record is still David's, because `eas submit` can only create one with an interactive Apple login (`submit/ios/AppProduce.js`). Documented in `mobile/store/README.md` §2 and "The hands-off path".

Once the app records exist:

```bash
grep -n "REPLACE_WITH" mobile/eas.json
```
Expected after the edit: no output. Neither value is a secret; both are safe to commit.

- [x] **Step 4: Commit**

```bash
git add mobile/store/README.md mobile/eas.json mobile/README.md
git commit -m "docs(mobile): store submission runbook"
```

---

## What is not in this plan

- **Relay deployment.** `relay.termpolis.com` needs a Cloudflare account and a hostname
  before any of this is usable by a real user. It belongs to sub-project 2 and is its
  own gate.
- **Push notifications.** The spec left the payload question open; the app ships without
  them, and adding them later changes the Play Data Safety answers. Task 3 records that.
- **iPad screenshots** if `supportsTablet` is set false first. Task 4 forces the choice.
