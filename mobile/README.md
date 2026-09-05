# Termpolis Remote (phone client)

An Expo / React Native app for iOS and Android that talks to a **running**
Termpolis desktop. It is a pass-through: it reads terminal output and types
into terminals. It runs no agent, holds no memory, no embeddings and no model
credentials — those stay on the desktop, which is signed in the way it was
already signed in.

The desktop half lives in `../src/main/remoteBridge/`, the relay in
`../relay/`, and the format all three speak is specified in
[`../docs/remote-wire-format.md`](../docs/remote-wire-format.md).

## Running it

```bash
cd mobile
npm install
npx expo start
```

Then open the URL on a phone:

- **Expo Go** is enough for everything except the camera. You can pair by
  entering the QR payload by hand, browse terminals, read output and type.
- **A development build** (`npx expo run:ios` / `npx expo run:android`) is
  needed to scan the desktop's QR code, because `expo-camera` is a native
  module Expo Go does not carry.

Pairing needs the desktop in front of you: Termpolis shows a QR code, the phone
scans it, and both ends then display the same eight-word safety phrase. Compare
the words. If they differ, something is between you and the desktop, and the
right move is to unpair and try again — not to tap through.

## Pointing it at a relay

Nothing here is compiled in. The relay URL travels **inside the QR payload**,
so the phone connects wherever that desktop was configured to connect. Change
the relay on the desktop (Settings → Remote) and re-pair; there is no relay
field on the phone, and there should not be one — a URL the phone can be talked
into typing is a URL an attacker can supply.

## Gates

```bash
npm run typecheck       # tsc --noEmit
npm run typecheck:wire  # tsc --noEmit -p src/wire, on its own
npm test                # jest
npm run test:coverage   # jest --coverage, with floors
```

The same four run in CI (the `mobile` job in
`.github/workflows/test.yml`). Lint is not a separate script here: the root
`npm run lint` already covers `mobile/`, under the root `.eslintrc.cjs`.

Coverage floors are **100 on all four counters** — lines, functions, branches,
statements (`jest.config.js`). Not "just under the suite": this app holds the
private key that authorises a phone to type into the user's terminals, and an
untested line here is a line nobody has run. If a floor fails, backfill the
test — never lower a floor.

## `src/wire/` is pure by contract

Everything under `src/wire/` — hex and UTF-8, the safety-number wordlist, the
QR envelope, the key schedule, the sealed channel, the message parsers — must
import nothing from `react-native`, `expo`, or any other host. It may import
`@noble/*` and nothing else.

That is not tidiness. Those modules are a second implementation of
`docs/remote-wire-format.md`, and
[`../tests/electron/remoteMobileInterop.test.ts`](../tests/electron/remoteMobileInterop.test.ts)
imports them **into the desktop's Node test process**, side by side with
`src/main/remoteBridge/`, and makes each side open what the other sealed. Add
one React Native import to `src/wire/` and that test stops being able to load
the file at all: the root gate goes red, and the thing that proved the phone's
bytes and the desktop's bytes were the same bytes is gone.

That import is also why `src/wire/` carries its own `tsconfig.json` with no
`extends`. The root unit job installs the desktop's dependencies and nothing
else, so `mobile/node_modules` is not there, so `expo/tsconfig.base` cannot
resolve -- and esbuild loads the nearest tsconfig for every file it transforms.
With only the parent config in reach, the interop suite dies at
`[TSCONFIG_ERROR] Tsconfig not found` before a single assertion runs, on all
three platforms, while passing on any machine that happens to have run
`npm install` in `mobile/`. `npm run typecheck:wire` compiles the directory
through that standalone config so it cannot rot back into something only Expo
can load.

So: platform code goes in `src/net/`, `src/storage/`, `src/state/` or
`src/screens/`. `src/wire/` stays pure.

The interop test is also the reason there is no device in CI. Two
implementations of a wire format usually diverge in ways only a real phone
finds, months later, in someone's hand. Here they are checked against each
other on every push, on a Linux runner, in seconds.

## Layout

| Path | What it is |
| --- | --- |
| `src/wire/` | The wire format. Pure. No host imports. |
| `src/net/` | The relay socket, the pairing exchange, the session. |
| `src/storage/` | The identity and the pairing, in `expo-secure-store`. |
| `src/state/` | The zustand store the screens read. |
| `src/screens/` | Pair, terminal list, terminal, safety number, settings. |
| `src/navigation/` | Route names and their parameters. Types only. |
| `src/App.tsx` | The shell: boots the store, decides which screens exist. |
| `index.ts` | `registerRootComponent`. |

`index.ts` imports `react-native-get-random-values` **first**, before anything
else. `@noble` reads `globalThis.crypto.getRandomValues` at call time and React
Native does not provide one; importing the polyfill after any module that
generates a key means the key came from something that is not a CSPRNG. That
failure is silent and passes every test you would think to write, so the import
order is load-bearing. Leave it at the top.

## What the phone stores

Its own X25519 secret and the pairing record (the desktop's public key, the
session room id, the relay URL, a device id and a label), in
`expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Nothing else — no
transcript, no scrollback, no cache of what the desktop said. Output lives in
memory for as long as the app does.

The one-time pairing secret from the QR code is never written to storage at
all, not even briefly. Unpair drops the lot, and does so whether or not the
relay is reachable.

## Shipping it

Store submission material lives in [`store/`](store/): the privacy
disclosures both forms ask for, the listing copy with its character counts,
the screenshot sizes and capture commands, and what reviewers are told.
[`store/README.md`](store/README.md) is the runbook.

`app.json` and the dependency list are what those disclosures are *about*, so
[`__tests__/appConfig.test.ts`](__tests__/appConfig.test.ts) asserts them
exactly -- the bundle ids, the encryption declaration, the two Android
permissions, the blocked ones, and the full dependency set. Adding a
dependency fails that test on purpose: an analytics SDK arriving quietly is
how a truthful "collects no data" becomes a false one.
