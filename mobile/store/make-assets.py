#!/usr/bin/env python3
"""Turn raw iPhone captures into App Store assets of exactly the right size.

Why this exists: an iPhone 14 screenshots at 1170x2532 and App Store Connect
will not accept that. It accepts 1242x2688 (the "6.5-inch" slot) and 1290x2796
(the "6.9-inch" slot). 1170x2532 and 1242x2688 are BOTH 19.5:9 to within a
rounding error, so the 6.5-inch conversion is a pure resample -- nothing is
cropped, nothing is padded, no content moves. That is why 6.5 is the default
here and 6.9 is opt-in: 6.9 is 1290x2796, very slightly taller than 19.5:9, so
it cannot be reached without either shaving pixels or adding bars.

Usage:
    python mobile/store/make-assets.py            # screenshots only
    python mobile/store/make-assets.py --video    # also build the App Preview

Drop the captures in mobile/store/raw/ and name them so they sort into the
order the listing wants:

    01-pair.png  02-safety.png  03-list.png  04-terminal.png  05-settings.png
    preview.mov  (or .mp4 -- any screen recording from the phone)

Both raw/ and out/ are gitignored. That is deliberate: a capture off a real
machine can carry a real path, a real branch name or a real prompt, and the
store rule is that none of those ever ship. Capture against a scratch
repository, not against this one.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE / "out"

# Apple's accepted iPhone portrait sizes. The tuple is (width, height).
SIZE_65 = (1242, 2688)
SIZE_69 = (1290, 2796)

# App Preview: 15-30 s, H.264, and the same frame size as the screenshot slot.
PREVIEW_MIN_S = 15.0
PREVIEW_MAX_S = 30.0

# What each numbered slot is meant to show, in listing order. Printed on every
# run so the shot list does not live only in someone's head.
SHOT_LIST = [
    ("01", "Pairing screen -- the QR scanner, before any device is paired"),
    ("02", "Safety number -- the eight words, matching the desktop's"),
    ("03", "Terminal list -- the sessions the desktop has granted"),
    ("04", "Terminal output -- scrollback from the SCRATCH repo only"),
    ("05", "Settings -- the permissions the desktop controls"),
]


def ffmpeg() -> str:
    """Find ffmpeg, including the winget shim that is not always on PATH."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    winget = (
        Path.home()
        / "AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe"
    )
    if winget.exists():
        return str(winget)
    sys.exit("ffmpeg not found. Install it: winget install --id Gyan.FFmpeg -e")


def convert_screenshots(size: tuple[int, int], label: str) -> int:
    shots = sorted(
        p for p in RAW.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg"}
    )
    if not shots:
        print(f"  no screenshots in {RAW}")
        return 0

    target_ratio = size[0] / size[1]
    written = 0
    for i, src in enumerate(shots, start=1):
        with Image.open(src) as im:
            im = im.convert("RGB")
            ratio = im.width / im.height
            # A phone screenshot is portrait 19.5:9. Anything else is either a
            # landscape grab (the app is portrait-locked, so that reads as a
            # screenshot of a different app) or a crop someone made by hand.
            if abs(ratio - target_ratio) > 0.01:
                print(
                    f"  !! {src.name}: {im.width}x{im.height} is {ratio:.4f}, "
                    f"target is {target_ratio:.4f} -- resizing WILL distort it. "
                    "Recapture rather than ship this."
                )
            resized = im.resize(size, Image.LANCZOS)
            dst = OUT / f"{label}-{i:02d}{src.suffix.lower()}"
            # PNG keeps text crisp; Apple accepts both, and a UI screenshot is
            # exactly the case where JPEG artefacts show up around glyphs.
            resized.save(dst.with_suffix(".png"), "PNG", optimize=True)
            print(f"  {src.name}  ->  {dst.with_suffix('.png').name}  {size[0]}x{size[1]}")
            written += 1
    return written


def probe_duration(exe: str, path: Path) -> float:
    out = subprocess.run(
        [exe, "-i", str(path), "-hide_banner"],
        capture_output=True, text=True,
    ).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            clock = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = clock.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def convert_preview(size: tuple[int, int], label: str) -> None:
    vids = sorted(
        p for p in RAW.iterdir()
        if p.suffix.lower() in {".mov", ".mp4", ".m4v"}
    )
    if not vids:
        print(f"  no screen recording in {RAW} (optional -- skipping)")
        return

    exe = ffmpeg()
    src = vids[0]
    seconds = probe_duration(exe, src)
    print(f"  {src.name}: {seconds:.1f}s")

    # Apple rejects an App Preview outside 15-30 s. Over-length is trimmed from
    # the front rather than the end, because a recording usually opens with the
    # tester finding the app and closes on the thing worth showing.
    trim: list[str] = []
    if seconds > PREVIEW_MAX_S:
        start = seconds - PREVIEW_MAX_S
        trim = ["-ss", f"{start:.2f}"]
        print(f"  trimming first {start:.1f}s to land at {PREVIEW_MAX_S:.0f}s")
    elif seconds < PREVIEW_MIN_S:
        print(
            f"  !! {seconds:.1f}s is under Apple's {PREVIEW_MIN_S:.0f}s minimum. "
            "Record a longer take -- this upload will be refused."
        )

    dst = OUT / f"{label}-preview.mp4"
    cmd = [
        exe, "-y", *trim, "-i", str(src),
        "-t", f"{PREVIEW_MAX_S:.0f}",
        "-vf", f"scale={size[0]}:{size[1]}:flags=lanczos,fps=30",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-b:v", "10M", "-maxrate", "12M", "-bufsize", "16M",
        # Apple accepts a silent preview. Stripping audio avoids shipping
        # whatever the room sounded like during the take.
        "-an",
        "-movflags", "+faststart",
        str(dst),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr[-1500:])
        sys.exit("ffmpeg failed")
    print(f"  {src.name}  ->  {dst.name}  {size[0]}x{size[1]}  H.264")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--size", choices=["6.5", "6.9"], default="6.5",
        help="6.5 (1242x2688) is a pure resample from an iPhone 14. "
             "6.9 (1290x2796) is not -- it distorts slightly.",
    )
    ap.add_argument("--video", action="store_true", help="also build the App Preview")
    args = ap.parse_args()

    size, label = (SIZE_65, "65") if args.size == "6.5" else (SIZE_69, "69")

    if not RAW.exists():
        RAW.mkdir(parents=True)
        print(f"created {RAW} -- put the captures there and run this again")
        print("\nShot list, in listing order:")
        for num, what in SHOT_LIST:
            print(f"  {num}  {what}")
        return

    OUT.mkdir(exist_ok=True)
    print(f"screenshots -> {args.size}\" ({size[0]}x{size[1]})")
    n = convert_screenshots(size, label)

    if args.video:
        print("\nApp Preview:")
        convert_preview(size, label)

    print(f"\n{n} screenshot(s) in {OUT}")
    print(
        "\nBefore uploading, look at every frame once more: no real repo path, "
        "no real branch name, no real shell prompt. That rule outranks the sizes."
    )


if __name__ == "__main__":
    main()
