# Launch intro: Termpolis, City of Terminals, then Lumopolis, City of Enlightenment

Status: approved by David, 2026-11-20. This is the short design: a small change.

## Intent

David, 2026-11-20, verbatim:
- "whenever you launch Termpolis app to have the logo of Termpolis and the byline "City of Terminals" + Lumopolis and the byline "City of Enlightenment" show with the same text we used for Lumopolis word in the feature video. and then have that fade away."
- "can we have consistent logo and letters like we have in the video across all platforms and I think 2 seconds for max length is perfect ... only on when it first starts"

The intro is the 2.0 first impression. It introduces both names and covers the moment while startup finishes in the background. It never makes the app slower to use.

## Design

- **Sequence:**
  1. The Termpolis logo (`src/renderer/public/logo-termpolis.svg`), "TERMPOLIS" and "City of Terminals" (about 0.8 s).
  2. A crossfade.
  3. "LUMOPOLIS", letters revealing one by one as in the film, over the cyan → white → amber rule, with "City of Enlightenment" in italic serif.
  4. A fade to the app.
- **Look:** the film's title cards (`Documents\Work\Termpolis\Supporting files\Lumopolis film build\cards.html`). The wordmark is Segoe UI Variable Display at weight 300, widely tracked, with a soft cyan glow. The tagline is Georgia italic. The background is the dark film stage with a vignette.
- **Same on every platform** (David): the lettering ships as pre-rendered artwork, not live text. The wordmarks and bylines are rendered once from the film's own card styles, on Windows, as transparent high-DPI images (one per LUMOPOLIS letter, so the reveal can animate).
  - The images are committed under `src/renderer/src/assets/intro/` along with the small script that regenerates them. macOS and Linux therefore show exactly the film's letters.
  - The images are rendered output, not the font, so no font file is redistributed.
  - *My call.*
- **Timing:** the hard maximum is **2.0 s** from first paint to fully gone, including the fade. It never waits on startup work.
  - Terminals and the rest of startup start underneath immediately.
  - The intro is a non-interactive overlay above the app shell.
- **When it plays:** only when the app first starts, on the first window. It does not play on renderer reloads, extra windows, an update restart, or e2e runs unless a test asks for it.
- **Skipping:** any key or click ends it at once. The key still reaches the app; nothing typed is lost.
- **Settings:** a "Show launch intro" switch, on by default, sits with the other appearance settings.
- **Reduced motion:** with `prefers-reduced-motion`, there is no letter reveal or movement. Both cards show as plain fades within the same 2 s.

## Approaches considered

- **Live text using a bundled open-licence lookalike font:** rejected. It looks close to the film, not the same. David asked for the film's letters.
- **A video clip cut from the film:** rejected. It is heavier, and it is hard to make crisp at every window size and DPI.
- **Pre-rendered artwork animated with CSS:** **chosen.** It matches the film exactly, is crisp, light and the same everywhere.

## Testing

- **Unit tests:**
  - plays once per app start, first window only;
  - skipped on reload, a second window, an update restart and the setting off;
  - any key or click dismisses it and the key is passed through;
  - the total never exceeds 2.0 s;
  - reduced motion swaps the animation.
- **Real-app e2e:**
  - the intro shows on launch and is gone by 2.0 s;
  - a terminal is ready, and typing during the intro lands in it;
  - with the setting off, nothing shows.
  - Run on Windows, macOS and Linux CI.
- **Screenshot comparison** of the two cards against reference frames, on all three platforms. Identical artwork proves the "same on every platform" requirement.

## Left to the builder

- The exact split of the 2.0 s between the two cards and the fades.
- Image format and scale factors (for example WebP at 1x/2x/3x).
- Where the overlay mounts in the renderer.
