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

1. Download Termpolis for macOS:
   https://github.com/codedev-david/termpolis/releases/latest
   (Termpolis-<version>-arm64.dmg for Apple silicon, Termpolis-<version>.dmg
   for Intel. The app is signed and notarized.)

2. Open it. It starts with one terminal already running -- no account,
   nothing to sign into.

3. Open Settings and choose the Remote tab. Tick "Allow phones to connect".
   Remote is off by default; this is the switch.

4. Press "Pair a device". A QR code appears and is valid for 90 seconds. If it
   expires, press the button again for a new one.

5. On the phone, open Termpolis Remote and point it at the QR code. If you
   would rather not use the camera, use the "Paste the pairing code" field on
   the same screen, and paste the text the desktop shows in the box below the
   QR code -- it is the same payload, as JSON.

6. Both screens now show the same eight words. They are derived from the two
   devices' keys; matching words mean nothing intercepted the exchange. This
   is a verification step, not a login.

7. IMPORTANT -- a newly paired phone is granted nothing at all. Back on the
   desktop the phone appears under "Paired devices" with four switches. Turn
   on "Read terminal output" and "Type into terminals". Leave "Start new AI
   terminals" and "Close terminals" off; they are not needed to review the
   app. Every request is re-checked against these switches on the desktop, so
   the phone cannot grant itself anything.

8. The phone now lists the desktop's terminals. Open one: you are reading that
   terminal's live output. Type "echo hello" and send it -- it runs on the
   computer, and the output comes back to the phone.

9. To end it, press "Revoke" beside the phone on the desktop. The phone goes
   offline immediately.

NO ACCOUNT IS NEEDED ANYWHERE. There is nothing to sign into on either half.

CAMERA: used only to read the pairing QR code in step 5. Frames are decoded on
the device and discarded; nothing is stored or uploaded. Step 5 also gives a
manual path that never opens the camera.

ENCRYPTION: the phone and the desktop derive a shared key (X25519 + HKDF-SHA256)
and seal every message with ChaCha20-Poly1305. The relay that carries the
traffic sees a room id and a byte count and cannot decrypt anything. This is why
ITSAppUsesNonExemptEncryption is declared true. The format is published:
https://github.com/codedev-david/termpolis/blob/main/docs/remote-wire-format.md

AGE RATING / UGC: the app renders output from one computer the user paired with
by hand. There is no browser, no feed, no content from other users, and no way
for users to reach each other.

If setting up the desktop is not practical, here is a screen recording of the
whole flow: <VIDEO URL>

Any questions: <SUPPORT EMAIL>
```

Two placeholders, both filled before submission: `<VIDEO URL>` and
`<SUPPORT EMAIL>`. See "Before you submit" below.

### Demo account fields

Leave **"Sign-in required" unchecked**. There is no account. Checking it and
then leaving the credential fields empty is a guaranteed round trip.

---

## Play Console

### App access

Choose **"All functionality is available without special access"**. There is no
login, no region lock, no paywall.

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
  reviewer sees an app that cannot connect. This is currently a blocker: the
  relay in `relay/` has not been deployed, and the hostname the desktop points
  at by default has to resolve before either store can review anything.
- **The download link must serve a current, notarized build.**
  `releases/latest` is a redirect, so it stays correct on its own -- but the
  build behind it must be one that opens on a clean Mac without a Gatekeeper
  warning, because a reviewer will not right-click-Open a strange binary.
- **`termpolis.com` and `termpolis.com/privacy.html` must be up.** They are
  both linked from the listing, and Apple checks them.
- **The video URL must resolve** without a login and without an ad interstitial.

## Before you submit

- [ ] Record the video and replace `<VIDEO URL>`
- [ ] Choose the public support address and replace `<SUPPORT EMAIL>` (see the
      open question in `listing.md` -- the same address goes in `privacy.html`)
- [ ] Deploy the relay and confirm a real phone can pair over it
- [ ] Walk the seven steps yourself, on a Mac you have not used for this
      before, from the released `.dmg`. If any step needs knowledge the notes
      do not contain, the notes are wrong, not the reviewer.
