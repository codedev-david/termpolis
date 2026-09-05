# Store listing copy

Every text field both stores ask for, written to their limits, with the count
next to each one. Copy from here rather than composing in the web form: the
forms have no history, no diff and no review, and the App Store fields are
locked for the duration of a review once submitted.

**House rules for everything in this file**

- Never claim the app runs an AI, holds a conversation, or works on its own.
  It is a viewer and a keyboard for a desktop that is already running. A store
  listing that overstates this is a listing a reviewer will test and reject.
- Never say "like Telegram". Telegram is not end-to-end encrypted by default;
  the model here is Signal's. Describe the property, not a brand.
- Say **requires the Termpolis desktop app** early and plainly. An app that
  looks broken without a companion is the most common cause of a 4.2 /
  "Design — minimum functionality" rejection, and the fix is disclosure, not
  argument.
- No superlatives that cannot be checked. "Encrypted end to end" can be
  checked. "The most secure remote terminal" cannot.

---

## App Store Connect

### App Name — 30 max

```
Termpolis Remote
```
16 characters.

### Subtitle — 30 max

```
Encrypted remote for Termpolis
```
30 characters.

### Promotional text — 170 max, editable without a new review

```
Pair once by scanning the code on your desktop, then read and type in your terminals from anywhere. End-to-end encrypted. Requires the Termpolis desktop app.
```
157 characters.

### Description — 4000 max

```
Termpolis Remote is a companion for the Termpolis desktop app. It lets you check on the terminals already running on your computer, read what they have printed, and type into them, from your phone.

It is a viewer and a keyboard. Nothing runs here. The work happens on your desktop, signed in the way it was already signed in, on the machine where your files, your repositories and your tools already are. Close this app and the work carries on without it.

REQUIRES THE TERMPOLIS DESKTOP APP
Termpolis Remote does nothing on its own. You need Termpolis running on a Mac, Windows or Linux computer, with Remote turned on in Settings. Termpolis is free and open source: github.com/codedev-david/termpolis

PAIRING TAKES ONE SCAN
Your desktop shows a code. You scan it. Both screens then show the same eight words -- if they match, the two devices agreed on a key nothing in between can derive. If they do not match, something is in between, and the right move is to unpair.

END TO END, NOT JUST IN TRANSIT
Every message between your phone and your desktop is sealed with a key the two of them derived together, using X25519 key agreement and ChaCha20-Poly1305. The relay that carries the traffic sees a room id, a size and a time. It cannot read a single byte of what passes through it, and it keeps nothing.

YOUR DESKTOP DECIDES WHAT THIS PHONE CAN DO
Reading output, starting terminals, typing, closing terminals -- each is granted on the desktop, in Settings, and each is checked again on the desktop for every request. This app can report what it has been allowed. It cannot grant itself anything.

WHAT IT STORES
One encryption key and one pairing record, in the iOS keychain, on this device only. No transcript, no scrollback, no cache of what your desktop said. Unpair erases both, and works whether or not the desktop is reachable.

WHAT IT DOES NOT DO
No account. No sign-in. No analytics, no crash reporting, no advertising identifier, no tracking of any kind. There is no server of ours that your terminal output ever reaches, because there is nowhere for it to go.

CAMERA
Used for one thing: reading the pairing code on your desktop screen. Frames are decoded on the phone and thrown away. If you would rather not, the pairing code can be typed in by hand.

Termpolis is open source under the Apache 2.0 licence, and the wire format this app speaks is published in full. Privacy policy: termpolis.com/privacy.html
```
2,428 characters.

### Keywords — 100 max, comma-separated, no spaces

```
terminal,shell,console,cli,developer,coding,devtools,remote,ssh,pairing,encrypted,e2ee,session,tmux
```
99 characters.

No competitor or third-party trademarks. Apple rejects keyword fields that
carry another company's marks, and the model names those would be are not ours
to trade on. Do not repeat words already in the name or subtitle -- Apple
indexes those anyway, and the field is small.

### URLs

| Field | Value |
| --- | --- |
| Support URL | `https://github.com/codedev-david/termpolis/issues` |
| Marketing URL | `https://termpolis.com` |
| Privacy Policy URL | `https://termpolis.com/privacy.html` |

Both hosts must be reachable at submission. A support URL that 404s is a
rejection on its own.

### Category and rating

| Field | Value |
| --- | --- |
| Primary category | Developer Tools |
| Secondary category | Utilities |
| Age rating | 4+ |

The rating questionnaire will ask about unrestricted web access and about
user-generated content. Both answers are no: the app renders output from one
computer the user paired with by hand, there is no browser, and there is
nothing shared between users. Say so in the review notes rather than leaving
the questionnaire to imply it.

### What's New — 4000 max, first release

```
First release. Pair with your Termpolis desktop by scanning the code it shows, then read and type in your running terminals from your phone, end to end encrypted.
```
162 characters.

---

## Google Play

### App name — 30 max

```
Termpolis Remote
```
16 characters.

### Short description — 80 max

```
Read and type in your Termpolis desktop's terminals. End-to-end encrypted.
```
74 characters.

### Full description — 4000 max

Use the App Store description above, with two changes Play requires and Apple
does not:

- Replace "in the iOS keychain" with "in the Android Keystore".
- Google's metadata policy is stricter about ALL-CAPS headings than Apple's is.
  Write the section headings in sentence case: "Requires the Termpolis desktop
  app", "Pairing takes one scan", and so on.

Keep the "REQUIRES..." disclosure as the first section either way. Play's
equivalent of a 4.2 rejection is a "broken functionality" flag from a reviewer
who installed the app with no desktop to pair to.

### Store settings

| Field | Value |
| --- | --- |
| App category | Tools |
| Tags | Developer tools |
| Contact email | Required and shown publicly -- see the open question below |
| Contact website | `https://termpolis.com` |
| Privacy policy | `https://termpolis.com/privacy.html` |
| Content rating | Everyone (IARC questionnaire: no violence, no user interaction, no data collection) |
| Ads | No |
| In-app purchases | No |
| Target audience | 18+ -- a developer tool, and declaring an under-13 audience pulls in Families policy obligations that do not fit |

---

## Open question for David

**Both stores require a public contact email.** Play prints it on the listing;
Apple requires one on the App Information page and uses it for review
correspondence. No published contact address exists for Termpolis today --
`privacy.html` deliberately routes to GitHub issues rather than invent one.

Pick one before submitting. A forwarding alias on the termpolis.com domain
(`support@termpolis.com`) is the ordinary answer and keeps a personal inbox off
a public store page. Whatever it is, add it to `privacy.html` at the same time
so the two agree -- a privacy policy with no contact route and a store listing
with one is a discrepancy a reviewer can see.
