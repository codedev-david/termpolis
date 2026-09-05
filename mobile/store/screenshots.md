# Screenshots

What each store requires, what to photograph, and the commands that produce
files of the right size.

## The rule that outranks the sizes

**Nothing real may appear in a screenshot.** Not a repository name, not a
branch, not a file path, not a prompt someone actually typed, not a hostname,
not an API key echoed by a shell. Store screenshots are public forever, they
are scraped, and this app's entire subject matter is a terminal -- which is to
say, the one surface on a computer most likely to have a secret sitting on it.

Set up a scratch repository first and drive everything from there:

```bash
mkdir -p /tmp/demo-project && cd /tmp/demo-project
git init -q && git commit -q --allow-empty -m "initial commit"
printf 'export function greet(name) {\n  return `Hello, ${name}`\n}\n' > greet.js
```

Then open Termpolis on that directory, with a clean profile, and pair the
device you are about to photograph. The desktop's own window never appears in
a phone screenshot, but the terminal contents do.

## What to show, in this order

Five screenshots carry the whole story, and the first two are the ones that
answer "what is this and why does it need my camera."

| # | Screen | Why it is in the set |
| --- | --- | --- |
| 1 | Terminal list | The payoff, first. Two or three named terminals, one showing output. |
| 2 | Terminal | Reading and typing. Show the scratch project's output and the input bar. |
| 3 | Pair | Explains the camera before the permission prompt does. |
| 4 | Safety words | The eight words, on the phone. The security claim, made visible. |
| 5 | Settings | The capability list, showing that the desktop grants and this app reports. |

Portrait only -- `app.json` sets `"orientation": "portrait"`, and a landscape
screenshot of a portrait-locked app reads as a screenshot from another app.

Do not add caption overlays or device frames. Apple allows them; they age
badly, they need re-rendering at every size, and a plain screenshot of a dark,
legible UI is the honest version of what the buyer gets.

## Apple

Apple takes one set per display class and scales it down for the rest. With
`supportsTablet: true` in `app.json`, the iPad set is **not optional** -- an
app submitted as iPad-compatible with no iPad screenshots cannot be submitted.

| Display class | Pixel size (portrait) | Simulator that produces it |
| --- | --- | --- |
| iPhone 6.9" | 1320 × 2868 | iPhone 16 Pro Max |
| iPad 13" | 2064 × 2752 | iPad Pro 13-inch (M4) |

Up to 10 per set. Five is the right number here.

```bash
# List what is installed, then boot the exact device.
xcrun simctl list devices available | grep -E '16 Pro Max|iPad Pro 13'
xcrun simctl boot "iPhone 16 Pro Max"

# Build and install the app on it.
cd mobile && npx expo run:ios --device "iPhone 16 Pro Max"

# One file per screen. Take them in the order above.
mkdir -p store/shots/ios-6.9
xcrun simctl io booted screenshot store/shots/ios-6.9/1-terminals.png
```

`simctl io booted screenshot` writes the device's native resolution, so the
file is already the size App Store Connect wants. Verify rather than assume:

```bash
sips -g pixelWidth -g pixelHeight store/shots/ios-6.9/*.png
```

Repeat with `xcrun simctl boot "iPad Pro 13-inch (M4)"` into
`store/shots/ios-13/`.

**The simulator has no camera.** Screenshot 3 shows the Pair screen; take it
with the manual-entry field visible rather than a dead camera preview. On the
iPad set, or if you want the scanner viewfinder in the shot, use a real device
and `Cmd-Shift-4`-style capture off a screen mirror -- but a manual-entry Pair
screen is the more honest picture anyway, because it is the path a reviewer
will use.

## Google Play

| Asset | Requirement |
| --- | --- |
| Phone screenshots | 2 to 8. Each side 320-3840 px, aspect ratio no wider than 2:1 |
| 7" tablet | Required only if the listing offers tablets -- it should, the app supports them |
| 10" tablet | Same |
| Feature graphic | 1024 × 500, PNG or JPEG, **no alpha channel**, required |
| High-res icon | 512 × 512 PNG, 32-bit with alpha |

```bash
# Any booted emulator or attached device; -s selects one when several are up.
adb devices
mkdir -p mobile/store/shots/android-phone
adb exec-out screencap -p > mobile/store/shots/android-phone/1-terminals.png
```

`adb exec-out` matters: plain `adb shell screencap -p` corrupts PNGs on some
hosts by translating `\n` to `\r\n` on the way out. If a file will not open,
that is why.

Check the dimensions before uploading:

```bash
python -c "import struct,sys;d=open(sys.argv[1],'rb').read(24);print(struct.unpack('>II',d[16:24]))" \
  mobile/store/shots/android-phone/1-terminals.png
```

### The feature graphic

1024 × 500, and it is the banner at the top of the Play listing. It is not a
screenshot -- a downscaled phone screenshot in that box is unreadable. Make it
the app icon on the `#04080D` background the adaptive icon already uses, with
"Termpolis Remote" beside it and nothing else. No screenshots inside it, no
device frames, no marketing sentence: Play rejects feature graphics that read
as advertising, and text smaller than about 40 px is illegible on a phone.

The icon to build it from is `mobile/assets/icon.png`; the background colour is
in `app.json` under `android.adaptiveIcon.backgroundColor`.

## Where the files go

```
mobile/store/shots/
  ios-6.9/        1320 x 2868, five files
  ios-13/         2064 x 2752, five files
  android-phone/  five files
  android-tablet-7/
  android-tablet-10/
  feature-graphic.png   1024 x 500, no alpha
```

`mobile/store/shots/` is **not committed** -- it is binary, it is regenerated
per release, and a repository is not an asset pipeline. Add it to
`.gitignore` when the first set is taken, and keep the shipped copies wherever
the other release artefacts live.
