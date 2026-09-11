# Reply to Guideline 2.1 — Information Needed (new-account review)

Apple asked for six things after the first submission. This is the verbatim
reply, plus what has to be true before sending it.

**This is not a bug report.** 2.1 "Information Needed" is the standard request
Apple sends an account with no review history. Nothing in the letter says the
app failed; it says the reviewer could not establish enough about it to finish.
Five of the six items are writing. One needs a phone.

Apple asks for this **twice** — once as a Resolution Center reply, once pasted
into **App Review Information → Notes**. Same text both places, so the next
submission starts with it already answered.

---

## Before sending: the video

This is the only item that is not already written, and it gates the reply.

Apple's wording is specific and differs from the storyboard we had:

> The recording must **begin with launching the app** and show the typical user
> flow.

Our storyboard opened on the desktop. That order now has to change — the
recording starts on the phone, cold, with a tap on the app icon. The desktop
setup comes after, as the thing the app asks you for.

Requirements from the letter: **a physical device**, **the latest OS**. Not a
simulator, not a stale build.

Revised beat sheet — 2 to 3 minutes, narration optional, captions fine:

1. **Phone, cold launch.** Tap the icon from the home screen. Show the app
   opening to the Pair screen with nothing paired. This is the "begin with
   launching the app" beat and it must be first.
2. **Desktop: Settings → Remote → "Allow phones to connect".** Show that it was
   off. This establishes the companion relationship the letter is really asking
   about.
3. **Desktop: tick the permissions**, then "Pair a device". QR appears.
4. **Phone: scan it.** Both screens side by side showing the same eight words.
5. **Phone: the terminal list**, then one terminal, reading live output.
6. **Phone: type `echo hello`, send.** Output arrives.
7. **Desktop: "Revoke"** beside the phone. The phone goes offline.

Beats 3 and 7 carry more weight than they look: together they show the desktop
is in charge, which answers every "what can this app do to my computer"
question a reviewer has.

Record against the scratch project in `screenshots.md` — no real paths, no real
repositories, no real prompts. Store and review assets are public forever.

**Attach the file to the Resolution Center reply** rather than linking it.
A URL can rot, can hit an ad interstitial, and can sit behind a consent wall in
a region we did not test. An attachment cannot. Keep a hosted copy as well and
put that URL in the Notes field, which takes text only — and it must resolve
with no login and no interstitial.

---

## The reply — paste verbatim

```
Thank you for the review. Answers to all six items follow.

1. SCREEN RECORDING

Attached: a recording made on a physical iPhone running the current version of
iOS. It begins with launching the app from the home screen and follows the
typical user flow end to end: cold launch to the pairing screen, turning Remote
on in the desktop app, granting permissions, scanning the pairing code,
verifying the eight safety words, opening a terminal, reading its live output,
typing a command and seeing the result, and finally revoking the phone from the
desktop.

The three flows you asked us to include if present are not present in this app:

- Account registration, login, account deletion: THE APP HAS NO ACCOUNTS. There
  is no sign-in, no registration and no server-side identity in either the phone
  app or the desktop app, so there is nothing to delete and no credentials to
  supply. "Sign-in required" is correctly unchecked.
- User-generated content: NONE SHARED BETWEEN USERS. The app renders output from
  one computer the user paired with by hand. Nothing typed on one pairing is
  visible to any other user. There is no feed, no browser, no public content and
  no way for users to reach one another, so content reporting and blocking
  mechanisms do not apply.
- Paid content or features: NONE. The app is free in full. No in-app purchases,
  no subscriptions, no paid tier, no advertising.

2. PURPOSE AND TARGET AUDIENCE

Termpolis Remote is a companion app for Termpolis, a free and open-source
desktop terminal application for macOS, Windows and Linux.

Target audience: professional software developers, 18 and over. Category:
Developer Tools.

The problem it solves. Developers start long-running work in terminals on a
desktop computer -- builds, test suites, deployments, data jobs, coding agents.
That work runs for minutes or hours. Until now the only way to see how it was
going, or to answer a prompt it is waiting on, was to go back to that computer.

The value it provides. Termpolis Remote lets the developer read the live output
of terminals already running on their own computer, and type into them, from
their phone. The work does not move. It stays on the machine where the files,
the repositories, the credentials and the tools already are, signed in the way
it was already signed in. The phone is a viewer and a keyboard: nothing executes
on the phone, and closing the app interrupts nothing.

The app has no standalone function, by design. It is a companion to software the
user installs on their own computer. This is stated in the first line of the
store description and in the app's own pairing screen.

3. SETTING UP AND ACCESSING THE MAIN FEATURES

NO CREDENTIALS ARE NEEDED OR CAN BE PROVIDED. There is no account, no sign-in
and no server-side identity anywhere in either app. There is no demo account to
issue because there are no accounts at all.

There is also no sample file to provide: the app displays whatever terminals are
running on the computer it is paired with.

To exercise the app end to end:

1. Download Termpolis for macOS from
   https://github.com/codedev-david/termpolis/releases/latest
   (Termpolis-<version>-arm64.dmg for Apple silicon, Termpolis-<version>.dmg for
   Intel. The app is signed and notarized, and opens without a Gatekeeper
   warning.) Windows and Linux builds are on the same page.

2. Open it. It starts with one terminal already running. There is nothing to
   sign into.

3. Open Settings and choose the Remote tab. Tick "Allow phones to connect".
   Remote is off by default; this is the switch.

4. Under the "Pair a device" button, tick what this phone will be allowed to do.
   "Read terminal output" is already on; also turn on "Type into terminals".
   Leave "Start terminals" and "Close terminals" off -- they are not needed to
   review the app.

5. Press "Pair a device". A QR code appears, with the same payload in text
   underneath it.

6. On the phone, open Termpolis Remote and point it at the QR code. If you would
   rather not grant camera access, decline the prompt: a "Paste the pairing
   code" field appears in its place and the text payload from step 5 pairs the
   same way.

7. Both screens now show the same eight words. They are derived from the two
   devices' keys; matching words mean nothing intercepted the exchange. This is
   a verification step, not a login.

8. The phone now lists that desktop's terminals. Open one to read its live
   output. Type "echo hello" and send it: it runs on the computer and the output
   comes back to the phone.

9. To end it, press "Revoke" beside the phone on the desktop. The phone goes
   offline immediately.

WHY NO PAIRING CODE IS INCLUDED IN THESE NOTES. A pairing offer is valid for 90
seconds. That is deliberate: the offer is a one-time secret displayed in the
clear on a screen, and its lifetime should be about as long as it takes to point
a phone at it. Any code written here would be dead long before it was read, so
the steps above set up a fresh one instead.

4. EXTERNAL SERVICES, TOOLS AND PLATFORMS

Pairing relay -- Cloudflare Workers with Durable Objects, at
wss://relay.termpolis.com, operated by us. It carries already-sealed messages
between a phone and a desktop that cannot reach each other directly. It sees a
room identifier, a message size and a timestamp. It cannot decrypt any message
and it stores nothing. This is the only network service the app contacts.

Encryption -- the phone and the desktop derive a shared key using X25519 key
agreement with HKDF-SHA256 and seal every message with ChaCha20-Poly1305. These
are standard published algorithms used only to secure the app's own channel, so
the app claims the Category 5 Part 2 exemption, declared in the binary as
ITSAppUsesNonExemptEncryption = false. The wire format is published in full at
https://github.com/codedev-david/termpolis/blob/main/docs/remote-wire-format.md

AI services -- THE APP CONTACTS NO AI SERVICE. It holds no API key, no model
credential and no AI provider SDK, and it sends nothing to any AI provider. What
it displays is text output from programs running on the user's own computer.
Those programs may include AI coding tools that the user has installed on that
computer and signed into under their own accounts. Any traffic between such a
tool and its provider is between the user's computer and that provider: it does
not pass through this app, and it does not pass through our relay.

Authentication services: none -- there are no accounts.
Payment processors: none -- the app is free with no in-app purchases.
Data providers: none.
Analytics, crash reporting, attribution and advertising SDKs: none in this app.
Termpolis Remote collects no data of any kind, which is why our App Privacy
declaration is Data Not Collected. (The desktop application offers opt-in crash
reporting, off by default and disclosed in its own privacy policy. That is
separate software, not distributed through the App Store, and it reports nothing
about the phone.)

Build tooling, not runtime services: the app is built with Expo and Apple's
toolchain via EAS Build. Neither is contacted by the shipped app at runtime.

5. REGIONAL DIFFERENCES

There are none. The app functions identically in every region. There are no
geo-restricted features, no region-specific content, no regional pricing (the
app is free everywhere with no in-app purchases), and no region lock. The relay
is a globally routed Cloudflare service and behaves the same from any region.
The app ships one English localization, used everywhere.

6. REGULATED INDUSTRY OR PROTECTED THIRD-PARTY MATERIAL

Neither applies.

The app operates in no regulated industry. It is a developer tool: no health or
medical data, no financial services, no gambling, no lending, no regulated
professional advice.

It contains no protected third-party material. The Termpolis desktop app it
pairs with is our own software, published open source under the Apache 2.0
licence at https://github.com/codedev-david/termpolis, and so is the phone app's
wire format. The app bundles no third-party content and redistributes no
third-party software. Programs running on the user's computer are installed and
authenticated by the user, under their own agreements with whoever provides
them; the app displays their text output and provides no access to them that the
user does not already have on their own machine.

Contact for anything further: support@termpolis.com
```

---

## After the reply is sent

- **Paste the same text into App Review Information → Notes**, as the letter
  asks. It is well inside the 4000-character limit. Notes takes text only, so
  the video goes in as a URL there and as an attachment on the reply.
- **Leave "Sign-in required" unchecked.** Checking it with empty credential
  fields is a guaranteed round trip, and there is genuinely no account.
- **The relay must stay up for the whole review window.** A plain GET must
  answer 426 Upgrade Required:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' \
    'https://relay.termpolis.com/v1/pair/00000000000000000000000000000001?role=desktop'
  ```

  000 or a timeout means a reviewer would meet a dead relay, which costs a week.
- **`releases/latest` must serve a current notarized build** that opens on a
  clean Mac with no Gatekeeper warning. A reviewer will not right-click-Open a
  strange binary.
- **`termpolis.com`, `/mobile/` and `/privacy.html` must be up.** Apple checks
  them, and a support URL that 404s is a rejection on its own. Do not test these
  with a local curl from David's network -- AT&T drops the GoDaddy shared IP, so
  a local failure proves nothing about the site.

## What this file does not cover

Apple's "Prevent Common Issues" footer is boilerplate attached to every 2.1
letter, not a list of findings against this build. The one line in it worth
acting on regardless: the app is reviewed on physical hardware, so anything
known-broken on a real handset should be fixed before resubmitting rather than
explained in a reply.
