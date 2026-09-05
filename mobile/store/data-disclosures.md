# Data disclosures — App Store and Google Play

The answers to type into App Store Connect's **App Privacy** section and Play Console's
**Data safety** form, with the fact behind each one.

Both forms are answered under a truthfulness declaration, both are long, and both get
answered again by whoever is submitting on some future evening. Writing them down once,
next to their reasons, is the difference between a consistent record and a form filled
in from memory.

**The one-line answer for both stores: the app collects no data.** Everything below is
the working that supports it.

---

## Why the answer is "none"

| Claim | Where it is true in the code |
| --- | --- |
| No analytics, crash reporting or attribution SDK | `mobile/package.json` — the whole dependency list is 17 entries, frozen by `mobile/__tests__/appConfig.test.ts` |
| No account, no sign-in, no server of ours the app talks to | `mobile/src/net/` speaks only to the relay named in the pairing payload |
| No advertising identifier | Nothing imports one; iOS shows no ATT prompt because there is nothing to track |
| Nothing written to disk but the key and the pairing | `mobile/src/storage/identity.ts` — two `expo-secure-store` entries, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` |
| Terminal output is never persisted | It lives in the zustand store (`mobile/src/state/remoteStore.ts`) and dies with the process |
| The relay cannot read anything | `relay/src/pairingRoom.ts` forwards sealed frames by room id, stores only an idle alarm, logs nothing |
| The one-time pairing secret is never stored | Asserted directly: a test checks it never reaches SecureStore |

---

## Apple — App Privacy

Answer **"Data Not Collected"** for the app as a whole. That answer removes the
tracking questions entirely, so there is nothing further to fill in.

For the record, every category and its answer:

| Apple category | Answer |
| --- | --- |
| Contact Info | Not collected |
| Health & Fitness | Not collected |
| Financial Info | Not collected |
| Location | Not collected |
| Sensitive Info | Not collected |
| Contacts | Not collected |
| User Content | Not collected — see the note below |
| Browsing History | Not collected |
| Search History | Not collected |
| Identifiers | Not collected — the device id is generated locally and shared only with the paired desktop |
| Purchases | Not collected |
| Usage Data | Not collected |
| Diagnostics | Not collected — there is no crash reporter in this app |
| Other Data | Not collected |

### The two things a reviewer may ask about anyway

**The camera.** `expo-camera` is present and the app declares `NSCameraUsageDescription`
as "Termpolis Remote uses the camera only to scan the pairing code shown on your
desktop." Frames are decoded on device and discarded. No image is stored, uploaded, or
sent anywhere. The decoded payload becomes a pairing handshake and nothing else.

**Terminal output.** The app displays output from the user's own desktop. It arrives
end-to-end encrypted, is held in memory while the app is open, and is never written to
disk. It is not *collected* in Apple's sense — it never reaches a server anyone but the
user's own desktop can read — but say so plainly rather than leaving a reviewer to
infer it.

### Export compliance

`ITSAppUsesNonExemptEncryption` is **true**. The pairing channel uses X25519 key
agreement, HKDF-SHA256 and XChaCha20-Poly1305; that is not the "exempt" category, and
claiming otherwise would be a false statement on an export form rather than a shortcut.
Answer App Store Connect's follow-up questions as: encryption is used for
authentication and for protecting the user's own data in transit; the app is not
proprietary-encryption; it qualifies for the standard mass-market treatment. Expect to
supply a year-end self-classification report.

---

## Google Play — Data safety

The form asks, per data type, whether it is **collected** (sent off the device
to a server the developer controls) and whether it is **shared** (sent to a
third party). Both are **no**, everywhere. The declaration that follows:

| Play question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | Yes — nothing is collected, and the traffic that does exist is end-to-end encrypted over TLS |
| Do you provide a way for users to request that their data be deleted? | Yes — Unpair, in the app, erases everything the app holds |

Play offers no data category that fits "shows the user their own computer's
screen over an encrypted channel that our relay cannot read." That is the point:
there is no data type to declare because there is no collection.

### The account-deletion URL

Play requires a deletion route for apps with accounts. This app has no account,
so answer that it does not offer account creation. The privacy policy still
documents deletion (Unpair; uninstall) because a reviewer looks for it before
believing the checkbox.

### The data-safety declaration in prose

For the free-text and for anyone re-deriving these answers later:

> Termpolis Remote is a viewer and keyboard for a Termpolis desktop app the
> user already runs. It has no account and no backend of ours. It stores an
> encryption key and a pairing record in the Android Keystore, on the device.
> Terminal output travels end-to-end encrypted between the desktop and the
> phone; the relay that carries it holds only the ciphertext and cannot decrypt
> it. Nothing is written to disk beyond the key and the pairing, and nothing is
> sent to the developer.

### Permissions Play will ask about

| Permission | Why | Declared where |
| --- | --- | --- |
| `CAMERA` | Scanning the pairing QR code on the desktop. Nothing else uses it. | `app.json` → `android.permissions` |
| `INTERNET` | The relay socket. | Same |

`RECORD_AUDIO`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` are listed
in `android.blockedPermissions`. `expo-camera` merges them into the manifest by
default, and a manifest asking for the microphone is a Data safety form that has
to explain a microphone. The block list is asserted by a test so a future
`expo-camera` upgrade cannot quietly reintroduce them.

---

## What would change these answers

Any of the following makes the whole document wrong. Re-read it before shipping
one — the form is a declaration, and a stale declaration is a false one.

- **Any analytics, crash reporting or attribution SDK.** Sentry, Firebase,
  Amplitude, an ad network, a session recorder. Every one collects Diagnostics
  or Identifiers at minimum, and several collect them before the user has
  agreed to anything. `mobile/__tests__/appConfig.test.ts` asserts the
  dependency list exactly, so adding one fails a test — that failure is the
  reminder to come back here.
- **Push notifications.** A push token is an Identifier, held by a server.
- **An account, sign-in, or hosted sync.** Contact Info, and probably more.
- **Writing terminal output to disk** — a scrollback cache, an export, a
  "recent sessions" list. That turns User Content into stored data, with a
  retention story to tell.
- **Server-side logging in the relay.** Today `relay/src/` makes no logging
  call at all and persists nothing but an idle alarm. Logging room ids and
  frame lengths would still keep both forms at "not collected" — logging
  anything derived from frame *contents* would not, and is forbidden anyway.
- **iCloud or Android auto-backup picking up app storage.** The keychain items
  are `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which keeps the key off backups by
  construction. Changing that accessibility class changes where the key can
  travel.

## Where these facts live

| Claim | File |
| --- | --- |
| Dependency set, permissions, encryption flag | `mobile/app.json`, `mobile/package.json`, gated by `mobile/__tests__/appConfig.test.ts` |
| What is stored, and how | `mobile/src/storage/identity.ts` |
| What the relay can see | `relay/src/pairingRoom.ts`, `relay/src/wire.ts` |
| The cryptography | `docs/remote-wire-format.md` |
| The public statement of all of it | `https://termpolis.com/privacy.html` |
