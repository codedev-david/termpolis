# Lumopolis Holotable Look: Design Spec (WP-LOOK)

**Status:** design, for David's review. **Date:** 2026-11-24. **Plan:** `docs/superpowers/plans/2026-11-24-wp-look-holotable.md`.

**Parent spec:** `docs/superpowers/specs/2026-11-15-world-view-design.md` (the 2.0 spec). This doc changes how Lumopolis looks and how it keeps its frame rate. It does not change the world grammar (2.0 spec §5.1): every rule there still holds, and §4 below says how each one is drawn in the new look.

**Visual target:** the look test `OneDrive - MSI\Documents\Work\AI Tools\Termpolis 2.0 Launch\Look test\Lumopolis - Look test Holotable - 2026-11-24.html` and its `Supporting files/` (`src/v1.js`, `parts.js`, `core.js`, `v1.css`, `perf.json`, `screenshots/`, `clips/`). We port the ideas from it, not the code. The spike is a throwaway page: it has no picking, semantic zoom, context-loss handling, export path or tests, and it uses MSAA, which the product must not.

---

## 1. Intent

David chose the Holotable look (2026-11-24) as Lumopolis's 2.0 face: "super professional like in the movie Iron Man". It is an **original** holographic style: a projector table that throws a city of light into the air. Nothing is copied from any film, game or product: no film logos, typefaces, interface layouts or colour schemes. The style is built from generic holographic ideas (additive light, scan lines, a projector disc and fresnel edges), and every mark in it tells the user something about the codebase.

The look must earn its place in three ways:
1. It reads as more professional than today's neon city at first sight. A first-run impression is the 2.0 goal ("correct, not fast").
2. It runs at 60 fps on ordinary laptops, falls back gracefully on weak and software GPUs, and never shows a blank or white map.
3. It stays honest. Every mark maps to data (2.0 spec rule #12), and nothing decorative can be mistaken for data.

## 2. Goals, non-goals

**Goals**
- The Holotable visual language described in §3 and §4, in the app pane and in exported worlds alike.
- Three quality tiers (High, Low, Flat) with an automatic drop when frames miss, hysteresis so a tier never flaps, and a user override.
- A frame-time sampler built into the app, and a CI perf soak on Linux, Windows and macOS.
- The 4K blank-canvas fix (deferral-audit #30) closed before any look work lands.
- Four data fixes the look test exposed (§9), plus the two engine items parked for WP-LOOK: VISFLAKE Minor 2 and WP2 M-a.

**Non-goals**
- New world grammar, new layers or new interactions. Hover, click, explode, tours, bookmarks, Ask and the 2D map behave as they do now.
- Real-time shadows, ray-marched volumes and MSAA. MSAA stays off at every tier (RESP).
- Web fonts or any network fetch. The renderer makes no network calls (#132), and exports work offline.

## 3. Visual language

### 3.1 Palette (theme `holotable`)

| Token | Value | Used for |
|---|---|---|
| `background` | `#010409` | clear colour, pane and canvas host background, export page body |
| `holo` | `#3fd0ff` | the cyan family: plates, slab edges, disc, conduit base glow |
| `ink` | `#d6f3ff` | label text, card text |
| `muted` | `rgba(150,205,230,.55)` | secondary text |
| `attention` | `#ffae42` | amber: built parts with no tests (grammar), hot links, the travelling pulse head, the user's focus ring |
| `orb` | `#7fdcff` | outside orbs |
| `heat` | `HEAT_COLOR #ff6a2b` (unchanged) | live latency (heat) |
| `seal` | `#4ade80` (unchanged) | the verified ring |
| `select` | see §10, decision D1 | the selection mark |

District hues fold into the blue family: `hue = 186 + ((h * 0.37) % 38)` degrees, saturation 0.9, lightness 0.56, where `h` is the district's existing hue from `sceneModel`. The brightness of a district's plate is multiplied by `min(1, 2.2 / sqrt(members))`, so a district with many buildings does not outshine the rest. Each district keeps its own hue, so neighbours stay tellable apart. Cargo colours (`doc.cargo[*].color`) are **not** folded: they are data, and the legend shows them as they are.

Blueprint and Glass stay as palettes on the new materials. What happens to Neon is decision D2 (§10).

### 3.2 Materials

Every Holotable material is an additive `ShaderMaterial` with `depthWrite: false`, except the opaque pick proxies, which never draw. Shaders are plain GLSL strings in one module, `holoShaders.ts`. They run under WebGL2 through three's `ShaderMaterial`, so `fwidth` needs no extension. Uniforms are built by pure functions that can be unit-tested.

- **Hologram slab** (a floor or a block, instanced through the existing `batching.ts` pools): a fresnel fill, edge lines from `fwidth`, scan lines `sin(worldY * 6.5 - t * 2.2)`, a slow vertical sweep band and a brighter roof. Per-instance state uses the spike's encoding: selected ≥ 1.5, hovered ≥ 0.75, related 0.25 to 0.75, dimmed ≤ -0.5. Gain is `1 + 0.8 hover + 0.35 related + 0.9 selected`, and dimmed parts are multiplied by 0.14. The spike's per-slab flicker is **dropped** (§7, photosensitivity).
- **District plate** (a hex SDF on one quad per district): rim, inner rim, a 5-unit grid, a halo and a faint wall. The expanding wave runs only on a change animation (`animateChanges` rise) or when a district is focused, never idly. Focus eases at `easeShare` by time, not 0.15 a frame: lit is 0.5 to 0.7, dimmed is -0.5.
- **Conduit ribbon**: a screen-space-width ribbon on the existing quadratic curve, with the control point raised by `d * 0.22 + 4`. All conduits are merged into two draw calls, one solid and one dashed, with per-vertex edge index and state attributes. Width is `conduitStyle().width` mapped to pixels (1.5 × pixel ratio at the reference width, 3.0 when focused). Colour is the cargo colour, with additive glow. Lit lines are 4× brighter, dimmed lines × 0.08.
- **Orb**: instanced spheres with fresnel and a scrolling latitude/longitude grid. The selected orb is × 2.2. Heat mixes toward `heat`.
- **Stage** (§4.3): the projector disc shader, light shafts, dust points and the outside-ring track.

Picking does not change. Buildings pick through their existing per-part objects and `toleratedPick`. Lines pick through their CPU curves (`linePoints`, `screenPoint`). The ribbons only draw.

### 3.3 Glow and bloom budget

- Post chain in High: RenderPass, then UnrealBloomPass (strength 0.6, radius 0.5, threshold 0.3), then a grade pass (vignette 0.5, grain 0.03), then OutputPass. ACESFilmic tone mapping, exposure 0.95.
- Low: the same chain, with the bloom pass at half size (a quarter of the pixels) and no grain.
- Flat: no composer. The scene renders straight to the canvas with emissive gains raised to make up for the missing bloom.
- **White-out budget.** `world-visual` keeps `MAX_WHITE_FRACTION = 0.005`: no more than 0.5% of the canvas may be saturated white, at the overview, the building close-up and the line close-up. The spike breaks this: its selected tower burns white. The product holds it in three ways:
  - each additive material clamps its own output;
  - the slab fill alpha falls with the slab count along a view ray (the instance's `stack` attribute, the number of floors above it, scales the fill by `1 / (1 + 0.12 * stack)`);
  - the selection column's alpha is at most 0.35.
  The threshold is never raised to make the look fit.
- Bloom applies to the canvas only. CSS2D labels never bloom.

### 3.4 Scan lines and grid

- Scan lines are a fixed material texture, the same on every slab. They carry no data, so they move at one speed everywhere.
- The plate grid has a fixed 5-unit pitch in world units, so it gives a sense of scale.
- The disc's ticks and rings are stage marks (§4.3).
- Under reduced motion, every scan line, sweep and grid scroll is frozen at t = 0.

### 3.5 Selection, hover and pulse

- **Hover** lights the part (state 0.75 or above), its conduits (lit) and its neighbours (related), and dims the rest. The rules are today's `RenderFocus`; only the drawing changes.
- **Selection** draws three marks on the selected part:
  - a ring at the base, which rotates and pulses its scale by 4%;
  - a hex outer ring;
  - a light column up the part.
  The colour is decision D1. The shape alone tells selection apart from every data mark: no data state draws a column.
- **Pulse** (`pulse(edgeIds)`, the conversation playing an answer): a pulse head in `attention` amber travels the ribbon once per call. It never runs idly. Flowing marks on a solid conduit are packets, whose shape and colour come from the cargo. They are never dashes, because a dash means a guess or a planned line (grammar).

### 3.6 Labels

Labels stay CSS2D DOM, placed by today's `placeLabels` and decluttered by it, so the no-overlap guarantees in `world-visual` hold. Only their styling changes.

| Label | Style | Data |
|---|---|---|
| District | display font, weight 300, uppercase, letter-spacing .38em, cyan glow; a mono subtitle line | name, then "N parts · M files" |
| Building | display font 11px, a 1px cyan left rule, ink colour | building label (the jobs or tech layer) |
| Floor tag (exploded) | mono 10px on a dark plate with an amber left rule | `NN name count`: floor index, floor name, file count |
| Orb | mono 10px, ink colour | host or agent name |
| Line label | today's line label, restyled to the panel look | edge label |

- **Font stacks.** No web fonts are loaded. Display: `Bahnschrift, "DIN Alternate", "Roboto Condensed", "Segoe UI", system-ui, sans-serif`. Mono: `"Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`. Label widths differ by OS, so placement keeps measuring the real DOM boxes, as it does today.
- **Contrast.** Every label has a dark text halo (`0 0 1px #000` plus a 2px shadow in the background colour), so it keeps 4.5:1 against a lit slab behind it. Floor tags sit on an opaque plate.

### 3.7 Chrome: card, legend and toolbar

The chrome takes the panel look: a dark gradient, a 1px cyan border, an amber 2px left rule on the card, and mono overlines.

- **Software or Flat tier:** the card and legend are opaque, with no `backdrop-filter`. This is ASKFLAKE's rule and it stands. Blur is used only at High on hardware.
- The legend keeps its shapes and cargo colours as they are (#30), and gains one row that explains the selection mark.

### 3.8 Arrival

On the first open in a session, the world arrives in about 1.6 s:
1. the disc draws;
2. the buildings grow per district;
3. the conduits draw along their length;
4. the orbs fade in.

The spike's arrival took 3.6 s; this one is shorter. The arrival animates uniforms only: every object stands at its final position from frame one, so picking, `screenPoint` and the e2e checks work during it. A click or key press finishes it at once. It is skipped under reduced motion, at the Flat tier and on a restore after a context loss. `drawn().arrival` reports `'running' | 'done'`.

## 4. What maps to what data

The 2.0 spec's rule #12 says every Look and conduit property derives from a doc field. WP-LOOK extends it to every **mark**. A mark is one of two kinds:
- a **data mark**, which varies with doc fields and nothing else;
- a **stage mark**, from the closed list in §4.3, which varies only with the world's layout extent (its radius) and with time.

The conformance test (plan Task 10) pins both: `holoMarks(scene)` is the same for two docs that differ only in `generatedAt`, and every stage mark is the same for two docs with the same layout extent.

### 4.1 Data marks

| Mark | Data it shows |
|---|---|
| District plate (position, radius, hue) | district; `SceneDistrict.pos`, `radius`, `hue` (folded, §3.1) |
| Plate brightness | member count (`min(1, 2.2/sqrt(n))`) and focus |
| Plate wave | a change animation (`animateChanges.rise`) in that district |
| Slab stack (floors, height) | `SceneBuilding.floors`, `height`; floor order from `floorOrder` |
| Slab look | `Look`: solid = hologram; `wire` (proposed) = a pulsing wireframe with no fill; `amber` (gap: built, no tests) = amber edges; `fog` = fog; `fading` = fading |
| Verified ring | `ring` (status verified), drawn in `seal` green and rotating |
| Changed outline | `outline` |
| Process shell | `processShell` (the processes layer) |
| Slab and orb heat | `heat` (from `layers.live` latency) |
| Floor tag | floor index, floor name, member count |
| Conduit path, width, colour | from/to; `conduitStyle().width` (rate); cargo colour |
| Conduit dashes | `dashed` (planned or guessed) |
| Packets | cargo shape and colour, flow on solid conduits |
| Pulse head | `pulse()` calls (an answer being read) |
| Orb | external (`orbs`), its `fog`, its kind (agent: a ringed glyph; service: the latitude/longitude sphere) |
| District slab signals (far zoom) | `slabSignals` (heat, outline, fading, fog), as today |

### 4.2 Interaction marks

The selection mark, the hover light and dimming, and the focus ring come from the user, not the doc. They are tested by interaction, not by #12.

### 4.3 Stage marks (closed list)

| Stage mark | What it may vary with |
|---|---|
| Projector disc: rings, ticks, spokes, the slow amber arcs | layout extent (radius); time |
| Disc sweep | runs only while a compile or an Ask is in progress (the world is "working"); still otherwise |
| Outside-ring track (a 256-segment loop) | the orb ring radius; drawn only when there are orbs |
| Beams from the disc to each plate | one per district: the plate positions (data-derived positions, no data of their own) |
| Light shafts (2 in High, 1 in Low, 0 in Flat) | none |
| Dust (1800 in High, 600 in Low, 0 in Flat) and stars (existing) | none |
| Vignette and grain | tier |

The legend's "How to read this" note lists the stage marks as "the table", so no one reads them as data.

## 5. Quality tiers

| | High | Low | Flat |
|---|---|---|---|
| Pixel ratio | `min(dpr, 2)`, then the tier pixel budget | `min(dpr, 1) * 0.75` | `min(dpr, 1)` |
| Pixel budget (drawing buffer) | 8.3 MP (3840x2160) | 2.07 MP (1920x1080) | 2.07 MP |
| Composer | bloom full, grade with grain | bloom half size, no grain | none |
| Stage | disc, 2 shafts, 1800 dust, track, beams | disc, 1 shaft, 600 dust, track, beams | disc (static), track; no shafts, dust or beams |
| Scan lines and sweep | animated | animated | static |
| Card and legend | blur allowed on hardware | opaque | opaque |
| Draw-call budget (Termpolis repo, overview) | ≤ 80 | ≤ 55 | ≤ 40 |

- Software renderers (`softwareRenderer()`: SwiftShader, llvmpipe, WARP "basic render" and the like) start at **Flat** and keep today's RESP rules: the 1920x1080 pixel budget, one frame in flight, the fence, and the deferred first frame.
- The budget limits every render target, not only the canvas. The composer's targets and the bloom mip chain count toward it at their own sizes.
- `bufferCap` (MAX_RENDERBUFFER/TEXTURE/VIEWPORT) still caps everything, and `fitBuffer`'s order is kept.

### 5.1 Auto-drop rule and hysteresis

A pure `qualityGovernor` reads the frame sampler (§6) and decides the tier.
- **Samples.** Only frames the loop actually drew count, and only back-to-back ones: the gap from the previous frame counts only if that frame was drawn too. The first 5 frames after any wake, resize, tier change or context restore are skipped. Hidden-pane time never counts.
- **Window.** 120 counted frames, or 2 s, whichever comes first, with at least 30 frames.
- **Drop.** High drops to Low when two windows in a row have a p95 above 18.5 ms (the 16.7 ms budget plus a 10% margin). Low drops to Flat when two windows in a row have a p95 above 33 ms.
- **Rise.** A tier rises one step only after 10 s of windows whose p95 is under 60% of the higher tier's budget (10 ms to rise to High). It rises at most once per session.
- **No flapping.** A tier dropped from twice in a session is locked out of auto mode for the rest of the session.
- **User override.** Toolbar ▸ Quality: Auto (the default), High, Low or Flat. A chosen tier is never changed by the governor. The choice is kept in the world settings.
- **Context loss.** The first loss restores one tier lower than before. The second loss goes to the 2D map, as today. `forgetWebGL()` still runs on every loss, and the `hasWebGL()` cache is kept.

### 5.2 First frame

- **First painted frame:** the first frame drawn after `load(doc)`.
  - Hardware: ≤ 400 ms at 1080p on the reference iGPU.
  - Software: ≤ 3 s at the budget.
- Shaders compile with `renderer.compileAsync` (KHR_parallel_shader_compile) before the first full frame. Until then the frame draws the background and the static disc.
- `drawn().firstFrameMs` reports it.

### 5.3 No blank map (4K fix, plan Task 0)

The Linux CI incident drew a white canvas for 8 to 13 minutes at 3840x2160, with the DOM labels drawn over it. Some fixes have landed since:
- the context-loss handling (first loss, then the 2D map after a second);
- the size cap (`bufferCap`, `fitBuffer`);
- the software pixel budget, no MSAA, the fence, and the deferred first software frame.

WP2's rereview (M4) said the cap is not the white-map fix. WP-LOOK closes the rest:
1. **Never white.** The canvas, the canvas host and the label layer get `background: var(--world-bg)` (the theme background) in CSS. An undrawn or dropped canvas then shows the theme's dark background, never white or the window behind it.
2. **A budget at every tier**, not only in software (§5 table). A drawing buffer the browser silently shrinks (`gl.drawingBufferWidth < canvas.width`, which Chromium does when an allocation fails) counts as over budget. The pixel ratio steps down until the buffer matches.
3. **A first-frame watchdog** in `createWorldViewer`. It fires if no frame is presented within 4 s on hardware or 15 s in software, if `gl.isContextLost()` is true with no loss event, or if the shrunken-buffer check fails twice. It then drops one tier and retries. At Flat it shows the 2D map with the notice "Lumopolis switched to the 2D map because this graphics card could not draw the 3D view." (`graphics('flat')`).
4. **e2e** at 3840x2160 and 5120x2880, 0 retries, on all three OSes. The canvas, with its overlays hidden, must have a lit fraction above `MIN_LIT_FRACTION`, a white fraction below `MAX_WHITE_FRACTION`, and its corner pixels within 8 levels of the theme background.

## 6. Performance measurement

- **Release bar:** at 1080p on integrated graphics in High, the frame-time p95 is at most 16.7 ms (60 fps). Low holds 60 fps on a weak GPU. The software floor is documented. The first frame is fast. A perf soak runs in CI on three OSes.
- **The spike's only measurement:** Intel Arc, 1080p, headless: High 81.9 fps (p95 14.3 ms), Low 146.6 fps (p95 7.2 ms). That is one GPU. A low-end proof is still owed (decision D3).

### 6.1 In-app sampler

`frameSampler.ts` is pure, with no WebGL:
- a ring buffer of the last 600 counted frame gaps;
- p50, p95, p99 and worst, by nearest rank (as `e2e/world-view.spec.ts` does);
- per-tier counts of frames and drops.

The renderer feeds it each drawn frame's rAF gap. `drawnCounts().perf` exposes `{ tier, auto, p50, p95, p99, worst, frames, drops, firstFrameMs, resizeWorstMs }`. With the probe flag on, a test hook `__worldPerf.begin()/end()` gives the e2e harness a window, the same API as the spike's `__lt.perfBegin/perfEnd`. Settings ▸ Lumopolis ▸ "Show frame rate" puts a small readout in the pane corner (`88 fps · 11.4 ms · high`). It is off by default.

### 6.2 CI perf soak

`e2e/world-perf.spec.ts` runs two scripted 10 s orbits at 1920x1080, one on the Termpolis repo fixture and one on the 168-file generated world, on ubuntu-24.04, windows-latest and macos-latest. Each run writes `test-results/world-perf/<os>-<fixture>-<tier>.json`, which the soak uploads.

CI runners have no real GPU: Linux runs SwiftShader, Windows usually WARP, and macOS a paravirtual GPU. So the **blocking** assertions test behaviour, and have wide margins:
- **Auto-drop works on real slow frames.** Force High in software at 1080p. The governor must reach Flat within 8 s, through Low, with no rise during the run.
- **Software floor.** At Flat in software, the 1080p interaction frames (the orbit) have a p95 at or under the floor written in this spec. Task 2 measures the baseline (3 runs of 3 copies on ubuntu-24.04). The floor is set at 1.5 × that median and recorded here, filled in by Task 2: `SOFTWARE_FLOOR_P95_MS = ____`.
- **First frame:** `firstFrameMs` ≤ 3 s in software.
- **No blank map**, as in §5.3.

Absolute fps on CI hardware is **reported, not asserted**. Real-GPU proof comes from a hardware run (`npm run perf:world`: Playwright on the built app with the GPU on). The JSON is committed under `docs/perf/lumopolis/`. Three runs are needed: David's laptop (Intel Arc), david-linux (a linked machine), and the low-end device in D3.

## 7. Accessibility

- **Reduced motion** (`prefers-reduced-motion` or the app setting):
  - the arrival, the scan lines, the sweep, the disc arcs, dust drift, the plate waves, the ring rotation, the selection pulse and the pulse-head travel all freeze at their resting state;
  - the camera flights stay instant, as today;
  - `drawn().visual` proves the freeze (the existing #45 test, extended).
- **Photosensitivity:** no flicker, and nothing flashes faster than 3 Hz. The spike's slab flicker is dropped. The selection pulse is 0.5 Hz at 4% scale.
- **Contrast:**
  - label text is 4.5:1 or better against the background and against the brightest lit slab behind it (text halo, §3.6);
  - the focus ring and the selection mark are 3:1 or better against both;
  - checked by `contrast.test.ts` on the palette tokens of all three palettes.
- **Not by colour alone:**
  - selection uses a column and rings;
  - verified uses a rotating ring;
  - a gap uses amber edges and its card status;
  - guesses use dashes;
  - cargo uses shape plus colour.
  The cyan-versus-green confusion for deuteranopes is covered because the ring is a shape.
- **Keyboard:** unchanged. The canvas's `aria-description` (`CANVAS_DESCRIPTION`) still points to the 2D map, the keyboard route through the parts. The 2D map takes the Holotable palette and keeps its keyboard focus order. The focus ring is `attention` amber, 2px.
- **Forced colours** (Windows High Contrast): the chrome falls back to system colours, and the 3D canvas keeps its own colours. The 2D map is the accessible route.

## 8. Fallbacks and export parity

- **Ladder:** High, then Low, then Flat, then the 2D map.
  - The 2D map appears: with no WebGL (`hasWebGL()` false); after a second context loss; or when the first-frame watchdog fails at Flat.
  - `forgetWebGL()` runs on every loss, and the per-page cache of the probe is kept.
- **Export:** `vite.world.config.ts` builds the same engine, so the exported page draws the same look with the same governor, watchdog and ladder.
  - `dist-world/world-viewer.js` (ESM), `world-validate.js` and `world-export.js` (IIFE) stay one chunk each.
  - `checkWorldExportBundle.cjs` and `checkWorldStandalone.cjs` gain checks: the Holotable shader marker (`HOLO_SLAB`) is present, there are no `http(s)://` font or asset URLs, and there is no dynamic `import(`.
  - The export page's `body` and `showMessage` panel take the palette's background and ink.
  - `world-export.spec.ts` asserts the exported page paints a non-blank canvas in the Holotable background. It also asserts that with WebGL disabled the page shows the 2D map in the same palette.

## 9. Data fixes

The look test drew the Termpolis repo honestly, and that showed four compiler bugs. They ship with WP-LOOK because the new look makes each one obvious.

1. **`.superpowers` became a district.** Top-level dot-folders are tooling (`.superpowers`, `.claude`, `.github`, `.husky`, `.vscode`, `.idea` and the like). They are left out of the world's districts and buildings. Their files are not parts, and their imports are not conduits. This applies to the world compiler only (`src/main/world`), not to the repo file list or to memory ingest.
2. **Test-fixture hosts became outside orbs** (`relay.test`, `t.example.com`, `h.io`). An `http-out` host becomes an orb only if at least one of its boundaries is in a non-test file (`TEST_FILE`, or under `tests/`, `test/`, `e2e/`, `__tests__/` or `fixtures/`). Reserved names never become orbs: the `.test`, `.example`, `.invalid` and `.localhost` TLDs, and `example.com`, `example.net` and `example.org` with their subdomains (RFC 2606 and RFC 6761).
3. **A 32-file "other" floor.** `fallbackFloors` put every member past the 11th into one floor called `other`. Now:
   - members are grouped by sub-folder, then by shared file-stem prefix;
   - the smallest adjacent groups are merged until there are at most 12 floors;
   - each floor is named after its group (`memory/`, `rerank*`);
   - no floor is called `other`;
   - no floor holds more than `ceil(n / 12) * 2` files when the folder structure allows it.
4. **A "TCP" tag on ptyHost.** `parentPort.postMessage(` and `MessageChannel` are message ports, not TCP. `KIND_WORD.port` becomes `Message port`, with the glossary line "Messages passed over a channel between two parts of the app". An older world's `TCP` tech word on a port boundary is renamed when it loads.

## 10. Decisions that are David's

- **D1: selection colour.** In the spike the selection is amber. The grammar (§5.1, decided) uses amber edges for "built but no tests". Options:
  - (a) Keep the amber selection and accept that two meanings share one hue, told apart by shape.
  - (b) **Recommended:** the selection is ice-white (`#eafaff` core, cyan rim), and amber means "needs attention" only (gaps, hot links, the pulse head).
- **D2: Neon.**
  - (a) **Recommended:** Holotable replaces Neon as the default theme. Blueprint and Glass stay as palettes on the Holotable materials, and a saved `neon` choice maps to `holotable`.
  - (b) Keep Neon as a fourth palette.
- **D3: the low-end proof device.** Which machine counts as "a weak GPU" for the Low ≥ 60 fps release bar? For example, an Intel UHD 620 class laptop, or david-linux if its GPU is weak. Without one, the bar can only be shown on the software floor and on the Arc laptop.

Everything else in this doc is a builder's call, recorded here so a reviewer can override it.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The selected-tower white-out breaks the 0.5% white budget | per-material clamp, stack-scaled fill, column alpha cap (§3.3); the threshold is never raised |
| Only one GPU measured | a hardware perf run on three machines before the go/no-go (D3) |
| `threeRenderer.ts` (3236 lines) grows into a bigger knot | all new logic lives in new pure modules (`holoPalette`, `holoShaders`, `holoMarks`, `frameSampler`, `qualityGovernor`, `lineShotCache`); `threeRenderer` only wires them |
| Shader compile differs by backend (ANGLE D3D11, Metal, SwiftShader) | `world-engine` e2e asserts `drawn().shaderErrors === 0` on all three OSes; `renderer.debug.checkShaderErrors` and an `onShaderError` counter run in test mode |
| The CI perf numbers are noisy | blocking checks test behaviour only, with wide margins; absolute fps is reported |
| The governor flaps between tiers | two-window drop, 10 s rise, one rise per session, lockout after two drops; unit-tested on recorded gap traces |
| Merging conduits changes picking or line labels | picking stays on the CPU curves; the ribbons only draw; the `world-visual` line-card tests stay as they are |
| Label widths differ by OS with system fonts | placement already measures real DOM boxes; the no-overlap tests run on all three OSes |
| The arrival animation races the e2e checks | objects stand at their final positions from frame one; `drawn().arrival` is waited on where it matters; a click ends it |
| Export bundle size and chunk splitting | shaders are strings in one module; the bundle checks fail on a second chunk |
| Timing: go/no-go on 12-15, release 2027-01-01 | work packages are ordered so a cut after WP-LOOK-C still ships a complete, honest look |
