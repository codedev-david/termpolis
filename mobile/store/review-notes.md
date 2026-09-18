# App Review notes

What to paste into App Store Connect's **App Review Information → Notes** and
Play Console's **App access** and **Testing instructions**, and what has to be
true on our side while a review is open.

## The problem this file solves

Termpolis Remote does nothing on its own. A reviewer who installs it, opens it,
and finds a pairing screen has seen the entire app, and "app has limited
functionality" (App Store guideline 2.1 / 4.2, and Play's broken-functionality
flag) is the single most likely rejection.

So the notes have one job: make the desktop half trivially available, and say
so in the first sentence.

Since 1.1 there is a second wall in front of the first. The app opens on a
purchase screen, and a reviewer who taps nothing has now seen even less than
before. The notes answer it the same way: tell them what to tap, in step 0,
before anything else.

### What the subscription needs to be true in App Store Connect

- **The subscription must be submitted with this app version.** A first in-app
  purchase cannot be reviewed on its own; it rides along with a binary. Attach
  it to the version in the "In-App Purchases and Subscriptions" section of the
  version page before submitting, or it is simply not reviewed and the live app
  has a paywall selling a product that does not exist.
- **The subscription needs its own review screenshot.** Subscription → Review
  Information → Screenshot. It is the paywall, and it is not shown to customers
  anywhere; it exists so a reviewer can see what was promised. Take it from the
  app.
- **Localization, price and the introductory offer must all be filled in**
  before the state leaves "Missing Metadata". The free week is an Introductory
  Offer on the subscription, created under the price — not a field on the
  subscription itself, which is where an evening goes looking for it.
- **The price and the trial are read from the store at runtime**, never printed
  from a constant (`mobile/src/state/subscriptionCatalog.ts`). Changing the
  price in App Store Connect changes the paywall with no app update, and an
  Apple ID that has used the trial is never shown one.

### Why there is no demo mode

The obvious shortcut -- a hidden build flag that fakes a paired desktop and
replays canned terminal output -- was considered and rejected. It is a second
code path that nobody exercises, it drifts from the real one, it must be
carried in the shipping binary forever, and if a reviewer finds it undeclared
it reads as exactly the thing Apple bans. The real desktop is free, open
source, and downloadable; handing over the real thing is both easier and
honest.

### The 90-second constraint

A pairing code is valid for **90 seconds** (`DEFAULT_TTL_MS` in
`src/main/remoteBridge/pairing.ts`). That is deliberate -- a pairing offer is a
one-time secret in the clear on a screen, and its window should be about as
long as it takes to point a phone at it.

It also means **a pairing payload cannot be pasted into the review notes**.
Anything written there is stale minutes later, let alone days. The reviewer has
to generate their own code, which is why the notes below walk them through
installing the desktop rather than handing them a credential.

---

## App Store Connect — Review Notes

Paste verbatim. It is written for someone with five minutes and no context.

```
Termpolis Remote is a companion app. It is a viewer and keyboard for terminals
running in the Termpolis desktop app; it runs nothing itself and has no
account, no sign-in and no backend of ours. To see it work you need the desktop
app, which is free, open source, and takes about two minutes to set up.

THE SUBSCRIPTION COMES FIRST. The app opens on the purchase screen and nothing
else is reachable until it is bought, so please start there:

0. On first launch the app shows "Relay access" -- an auto-renewable monthly
   subscription (product id 002) with a one-week
   introductory free trial. Tap "Start free week" and confirm with the sandbox
   Apple ID; nothing is charged in the sandbox. The app then goes straight to
   the pairing screen and step 1 below.

   If you have already run the app on this sandbox account, the trial is used
   up and the button reads "Subscribe" instead -- same result, still no charge.
   "Restore purchases" on the same screen re-checks the sandbox account, which
   is the path to use if the app reopens on the purchase screen unexpectedly.

   What the money is for: the phone reaches the desktop through a relay we run
   and pay for. The desktop app is free and always will be; the subscription
   covers the relay this app connects through, which is the only thing this app
   does. There is no free tier and nothing is withheld from subscribers.

1. Download Termpolis for macOS, Windows or Linux from https://termpolis.com
   (Downloads section). The macOS build is signed and notarized; the Windows
   build is signed.

2. Open it. It starts with one terminal already running -- no account,
   nothing to sign into.

3. Open Settings and choose the Remote tab. Tick "Allow phones to connect".
   Remote is off by default; this is the switch.

4. Under the "Pair a device" button, tick what this phone will be allowed to
   do. "Read terminal output" is already on; also turn on "Type into
   terminals". Leave "Start terminals" and "Close terminals" off -- they are
   not needed to review the app.

5. Press "Pair a device". A QR code appears and is valid for 90 seconds. If it
   expires, press the button again for a new one. The permissions ticked in
   step 4 are baked into that offer, so a phone is never paired-but-refusing.

6. On the phone, open Termpolis Remote and point it at the QR code. If you
   would rather not use the camera, use the "Paste the pairing code" field on
   the same screen, and paste the text the desktop shows in the box below the
   QR code -- it is the same payload, as JSON.

7. Both screens now show the same eight words. They are derived from the two
   devices' keys; matching words mean nothing intercepted the exchange. This
   is a verification step, not a login.

8. The phone now lists the desktop's terminals. Open one: you are reading that
   terminal's live output. Type "echo hello" and send it -- it runs on the
   computer, and the output comes back to the phone.

   The phone holds exactly the permissions ticked in step 4 and nothing else.
   They appear as switches beside the phone under "Paired devices" and can be
   changed at any time; every request is re-checked against them on the
   desktop, so the phone cannot grant itself anything.

9. Optional, and only if you have a second computer to hand: the phone can be
   paired with more than one desktop (up to 16). Tap the desktop name in the
   header of the terminal list to see the list of paired computers, and "Pair
   another desktop" to repeat steps 1-7 against a second machine. Each pairing
   has its own key, so the safety words in step 7 are shown again, and each
   desktop grants its own permissions. Switching between them is a tap; one is
   connected at a time. Nothing in the review depends on this step.

10. To end it, press "Revoke" beside the phone on the desktop. The phone goes
    offline immediately. If several desktops are paired, revoking on one leaves
    the phone's link to the others alone -- the same is true of "Unpair from
    this desktop" on the phone.

NO ACCOUNT IS NEEDED ANYWHERE. There is nothing to sign into on either half.
The subscription is bought with the Apple ID already on the phone; we never see
it, and there is no login of ours.

CAMERA: used only to read the pairing QR code in step 6. Frames are decoded on
the device and discarded; nothing is stored or uploaded. Step 6 also gives a
manual path that never opens the camera.

ENCRYPTION: the phone and the desktop derive a shared key (X25519 + HKDF-SHA256)
and seal every message with ChaCha20-Poly1305. The relay that carries the
traffic sees a room id and a byte count and cannot decrypt anything. These are
standard algorithms used to secure the app's own channel, so the app claims the
Category 5 Part 2 exemption -- declared in the binary as
ITSAppUsesNonExemptEncryption = false. The format is published:
https://github.com/codedev-david/termpolis/blob/main/docs/remote-wire-format.md

AGE RATING / UGC: the app renders output from one computer the user paired with
by hand. There is no browser, no feed, no content from other users, and no way
for users to reach each other.

If setting up the desktop is not practical, here is a screen recording of the
whole flow: <VIDEO URL>

Any questions: support@termpolis.com
```

One placeholder left: `<VIDEO URL>`. The contact address is settled --
`support@termpolis.com`. See "Before you submit" below.

### What actually went in with 1.1 (2026-09-18)

The submitted notes were a condensed variant of the block above: the same step
0 verbatim, then five pairing steps instead of ten, and the age-rating
questionnaire answers spelled out. Shorter is defensible -- a reviewer with
five minutes reads five steps and skims ten -- so this is recorded rather than
corrected.

The one thing that must survive any future shortening is **step 0**. It went in
LAST, after the submission was already open, because the 1.0 notes were reused
and nobody noticed they described an app with no paywall in front of it. A
reviewer following those notes installs the desktop, generates a pairing code,
opens the phone, and is looking at a purchase screen with no instruction to buy
anything -- which is guideline 2.1 ("unable to test") with extra steps.

So: **when the first screen changes, these notes change in the same commit.**
The notes describe a launch sequence, and a launch sequence with a new wall in
front of it is a different sequence.

### Demo account fields

Leave **"Sign-in required" unchecked**. There is no account. Checking it and
then leaving the credential fields empty is a guaranteed round trip.

---

## Play Console

### App access

Choose **"All functionality is available without special access"**. There is no
login and no region lock.

**And no paywall on Android**, which is not an oversight. There is no base plan
in Play Console, so the gate is iOS-only by construction: `boot()` in
`mobile/src/state/subscription.ts` grants entitlement outright when
`Platform.OS` is not `ios`. Gating a store that has nothing to sell would be a
locked door with no handle, and it would strand the closed test that Play's
production timeline depends on. When Android does get a product, this answer
and this paragraph both change.

### Testing instructions

Play gives a smaller box and no demo-video field. Use a condensed version of
the same text -- steps 1 through 7, with the macOS download line replaced by:

```
Download Termpolis for Windows, macOS or Linux:
https://github.com/codedev-david/termpolis/releases/latest
```

Keep the "no account is needed anywhere" line. Play reviewers hit the same
wall, and it is the sentence that stops them looking for one.

---

## The screen recording

Record it once, host it where it will still resolve in six months, and reuse
the URL for both stores. It replaces nothing above -- it is what a reviewer
watches when they decide not to install a desktop app.

Two to three minutes, no narration needed, captions optional:

0. Phone: the purchase screen on first launch, the price and the free week on
   it, and the tap that buys it. Sandbox, so the confirmation sheet says
   "Environment: Sandbox" — leave that visible rather than cutting it.
1. Desktop: Settings → Remote → "Allow phones to connect". (Show that it was
   off.)
2. Desktop: "Pair a device", QR appears.
3. Phone: scan. Both screens, side by side, showing the same eight words.
4. Desktop: the phone appears under "Paired devices" with everything off. Turn
   on "Read terminal output", then "Type into terminals".
5. Phone: terminal list, then one terminal, reading live output.
6. Phone: type `echo hello`, send, output arrives.
7. Desktop: press "Revoke" beside the phone. The phone goes offline.

Steps 4 and 7 matter more than they look. Together they show the desktop is in charge, which is
the answer to every "what can this app do to my computer" question a reviewer
might have.

Record against the scratch project from `screenshots.md`. The same rule holds:
no real paths, no real repositories, no real prompts.

---

## What has to be true while a review is open

A review can start days after submission and take a week. These are the things
that break silently in that window.

- **The relay must be deployed and reachable.** No relay, no pairing, and the
  reviewer sees an app that cannot connect. **Done as of 2026-09-08**:
  `wss://relay.termpolis.com` (`DEFAULT_RELAY_URL`, same constant in both
  trees) is live on Cloudflare and redeployed by the "Deploy relay" workflow on
  every push that touches `relay/`. Check it the cheap way -- a plain GET must
  answer **426 Upgrade Required**, which is a WebSocket endpoint saying it is
  healthy and you did not offer to upgrade:

  ```bash
  curl -s -o /dev/null -w '%{http_code}
'     'https://relay.termpolis.com/v1/pair/00000000000000000000000000000001?role=desktop'
  ```

  A 000/timeout means it is down and a review would fail; anything else means
  look at the worker. Note this is one of the few termpolis.com hostnames that
  answers a local curl at all -- it is on Cloudflare, not the GoDaddy shared IP
  that David's ISP drops (see [[reference_att_blocks_site_ip]]).
- **The download link must serve a current, notarized build.**
  `releases/latest` is a redirect, so it stays correct on its own -- but the
  build behind it must be one that opens on a clean Mac without a Gatekeeper
  warning, because a reviewer will not right-click-Open a strange binary.
- **`termpolis.com` and `termpolis.com/privacy.html` must be up.** They are
  both linked from the listing, and Apple checks them.
- **The video URL must resolve** without a login and without an ad interstitial.
- **The subscription must stay attached to the version.** Detaching it, or
  editing it into "Missing Metadata" mid-review, leaves the binary selling
  nothing. Do not touch it once the version is in review.

## Before you submit

- [ ] Record the video and replace `<VIDEO URL>` -- the ONLY placeholder left
      in this file
- [x] Attach the subscription to the version, and upload the paywall screenshot
      to Subscription → Review Information (2026-09-18, with 1.1).
      ⚠ A first subscription needs THREE items in one draft submission, not
      one: the subscription group, the subscription itself, and the app
      version. A draft holding only the group reports two errors that both
      read like a rule you have broken rather than a list you have not
      finished. Each is added from its own page's "Add for Review" button.
- [ ] Re-read these notes against the app's FIRST SCREEN, not against the
      diff. Reusing the previous version's notes is the easy mistake and it
      cost a near-miss on 1.1 -- see "What actually went in" above
- [ ] Buy it once yourself in the sandbox, from a sandbox Apple ID that has
      never had the trial, and then again from one that has -- the second is
      the "Subscribe" wording, and it is the one nobody tests
- [ ] Tap "Restore purchases" on a fresh install of the same sandbox account
      and confirm it lets you back in without paying again (3.1.1)
- [x] Contact email decided, placed, and **delivery confirmed** (2026-09-08).
      `support@termpolis.com` is in `listing.md`, published in `privacy.html`,
      and routed by Cloudflare Email Routing to a real inbox; a test message was
      sent and read. Apple mails this address, and a listing whose contact
      bounces is a rejection.
      ⚠ Testing it FROM the account it forwards TO proves nothing. Gmail
      deduplicates by Message-ID, so the forwarded copy collapses into the Sent
      thread and never reaches the inbox -- indistinguishable from a mailbox
      that does not work. Send from somewhere else, or read Email Routing →
      Activity Log, which records what happened to every inbound message.
      ⚠ Email Routing is forward-only. A reply leaves as the personal address,
      not `support@termpolis.com`.
- [x] Deploy the relay (see above)
- [ ] Confirm a real phone pairs over the deployed relay end to end
- [ ] Walk the steps yourself, on a computer you have not used for this
      before, from the released installer. If any step needs knowledge the
      notes do not contain, the notes are wrong, not the reviewer.
