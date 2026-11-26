# WP-LOOK: Lumopolis Holotable Look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Lumopolis the Holotable look and keep it at 60 fps:
- the look is an original holographic projector-table style, in the app and in exported worlds;
- three quality tiers drop automatically when frames miss;
- a frame-time sampler and a CI perf soak measure it;
- the 4K blank canvas is closed;
- four data fixes, VISFLAKE Minor 2 and WP2 M-a ship with it.

**Spec:** `docs/superpowers/specs/2026-11-24-lumopolis-holotable-look-design.md` (called "the look spec" below; `§` numbers refer to it). Parent: `docs/superpowers/specs/2026-11-15-world-view-design.md` (the 2.0 spec).

**Visual target:** the look test `OneDrive - MSI\Documents\Work\AI Tools\Termpolis 2.0 Launch\Look test\Lumopolis - Look test Holotable - 2026-11-24.html` and `Supporting files/src/{v1.js,parts.js,core.js,v1.css}`, `perf.json`, `screenshots/` and `clips/`. Port the ideas, not the code. Every number taken from the spike is restated in the look spec, so read the spike only for the shape of a shader.

**Architecture:** new logic goes into new pure modules under `src/renderer/src/world/engine/`. Each of them is at 100% coverage. `threeRenderer.ts` only wires them in:

| Module | What it holds |
|---|---|
| `holoPalette.ts` | palette tokens, district hue fold, member brightness |
| `holoShaders.ts` | GLSL strings and the uniform factories |
| `holoMarks.ts` | the data-mark and stage-mark description of a scene (#12) |
| `frameSampler.ts` | ring buffer and percentiles |
| `qualityGovernor.ts` | tier decisions |
| `tierBudget.ts` | per-tier pixel ratio and render-target budget |
| `lineShotCache.ts` | the line close-up search result, kept per line |

The compiler fixes live in `src/main/world/`.

**Tech stack:** Electron 43, React 18, Three.js 0.160 (no new dependency), TypeScript, Vitest (jsdom), Playwright e2e on Electron (SwiftShader on Linux CI).

## Global Constraints

- User-facing copy says "Lumopolis"; code says `world`.
- Coverage gate: lines 97 / functions 96 / branches 95 / statements 96. It is never lowered. The world folders stay at 100%, and `threeRenderer.ts` stays the one excluded drawing file (2.0 spec §10).
- Renderer target is ES2020: no `.at`, `findLast`, `replaceAll` or `Intl.Segmenter`. No `*Sync` calls in main. Never run `npm install`.
- No MSAA at any tier. No web fonts, no network calls from the renderer (#132), and exports work offline.
- Every mark maps to data, or is a stage mark from the closed list in look spec §4.3 (#12).
- Accessibility never regresses: reduced motion freezes all motion, contrast holds, and the keyboard route to the parts stays.
- Test-only hooks are inert unless `NODE_ENV === 'test'` or the probe flag is set.
- Commit directly to main.

**Plan-wide conventions** (the same as the Plan 5 conformance plan):

- **Unit tests (`V`):** `unset PROMPT_COMMAND TERMPOLIS_LIMIT_CHOOSER && export PATH="/c/Program Files/Git/cmd:$PATH" && npx vitest run <files>`
- **Scoped coverage (`COV`):** `V` plus `--coverage --coverage.include=<each changed file under src/shared/world, src/main/world, src/renderer/src/world/engine, src/renderer/src/components/World>`. Expected: every listed file shows 100 / 100 / 100 / 100.
- **Typecheck (`TSC`):** `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false`. Expected: no output.
- **e2e (`E2E`):** run `npx electron-vite build` and `npm run build:world-viewer` once, then `TERMPOLIS_E2E_PREBUILT=1 npx playwright test <spec>`. Never rebuild `out/` while Playwright is running.
- **3-OS proof (`SOAK`):** dispatch the "E2E soak" workflow with `copies: [1, 2, 3]` on ubuntu-24.04, windows-latest and macos-latest. Pass `specs` = the task's e2e files. The ref is a hidden `refs/batch/look-<task>` branch pushed for the purpose. Expected: every copy is green, with 0 retries (`--retries=0`; the soak already runs that way).
- **Commit:**
  - Run `git pull --rebase --autostash` first.
  - Write the message to a temp file and commit with `git commit -F <file>`. Never use `-m @'…'@`.
  - The message starts `lumopolis: ` and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Test locations:** renderer tests go in `tests/renderer/world/`, main tests in `tests/electron/`, shared tests in `tests/shared/`. The renderer harness is `tests/renderer/world/threeHarness.ts`.
- **Screenshots are never golden images.** Visual checks stay metric checks: mean luminance, lit fraction, white fraction, label readability and overlap, as `e2e/world-visual.spec.ts` does now. A new visual check is a metric with a stated threshold and a reason. Screenshots are written for people to look at (`test-results/world-visual/`, which the soak uploads).

## Work packages

Each package is one implementer's round. Packages in the same round touch disjoint files and can run in parallel.

| Round | Package | Tasks | Size |
|---|---|---|---|
| 1 | **WP-LOOK-A1** Foundation: blank canvas and measurement | 0, 1, 2 | L |
| 1 | **WP-LOOK-D** Data fixes (main process only) | 6, 7, 8, 9 | M |
| 2 | **WP-LOOK-A2** Governor and engine debts | 3, 4, 5 | L |
| 3 | **WP-LOOK-B** Palette, marks, stage, slabs and plates | 10, 11, 12 | XL |
| 4 | **WP-LOOK-C** Conduits, orbs, selection, labels, chrome, export | 13, 14, 15, 16 | XL |
| 5 | **WP-LOOK-E** Arrival, accessibility, the 3-OS soak, hardware proof | 17, 18, 19, 20 | L |

Sizes: S ≈ half a day, M ≈ a day, L ≈ two days, XL ≈ three or more.

**Cut line.** If the 12-15 go/no-go is tight, a cut after WP-LOOK-C still ships a complete, honest look. WP-LOOK-E adds the arrival and the proofs, but the release bar needs Task 20's hardware numbers whatever is cut.

**David's decisions (look spec §10)** must land before Round 3 starts:
- D1, the selection colour, is needed by Task 14 (and Task 10's palette);
- D2, Neon, is needed by Task 10;
- D3, the low-end device, is needed by Task 20.

Until they land, implementers use the recommended options: (b), (a), and the software floor only.

**Decided by David on 2026-11-25** (he took the recommendations):
- **D1:** (b), ice-white `#eafaff` as the selection colour.
- **D2:** (a), Holotable replaces Neon, and a saved Neon loads as Holotable.
- **D3:** an integrated-graphics laptop at 1080p is the low-end proof device for Task 20, alongside the software floor.

## Review Focus

1. **The 4K canvas is never blank or white.** At 3840x2160 and 5120x2880, on Linux SwiftShader, a canvas the browser could not allocate shows the dark background. The watchdog then lands on a drawn tier or on the 2D map with its notice. Tasks 0 and 19.
2. **Auto-drop on real slow frames.** Force High in software at 1080p, and the governor reaches Flat through Low in 8 s or less, with no rise. On a fast machine it never drops. Tasks 3 and 2.
3. **The white-out budget.** Selecting the busiest building in the Termpolis repo keeps saturated white under 0.5% of the canvas in every palette. Tasks 12 and 14.
4. **Honesty.** No stage mark varies with the doc, and every data mark is reproducible from the doc alone. A dash still means a guess or a planned line, and nothing else. Tasks 10 and 13.
5. **A world saved before this plan** (a `neon` theme choice, a `TCP` tech word on a port, an `other` floor) loads with no console error and no forced recompile. Tasks 9, 8 and 10.

---

### Task 0: The 4K blank canvas cannot happen (deferral-audit #30) [M]

What has landed already (do not redo it):
- context loss: the first loss calls `graphics('lost')`, the second calls `dropToFlat`, and `forgetWebGL` runs on every loss;
- `bufferCap` and `fitBuffer`;
- no MSAA;
- the software 1920x1080 budget;
- the fence;
- the deferred first software frame.

This task closes the rest (look spec §5.3).

**Files:**
- Create: `src/renderer/src/world/engine/tierBudget.ts`:
  - `TierName = 'high' | 'low' | 'flat'`;
  - `TIER_MAX_PIXELS: Record<TierName, number>` (high 3840*2160, low and flat 1920*1080);
  - `tierPixelRatio(tier, dpr, width, height, cap, software): number`, which composes the tier factor, `pixelBudgetRatio` and `bufferRatio`;
  - `targetsPixels(tier, w, h): number`, the composer and bloom-chain pixel total;
  - `shrunk(gl: { drawingBufferWidth; drawingBufferHeight }, canvas: { width; height }): boolean`.
- Modify: `src/renderer/src/world/engine/threeRenderer.ts`:
  - `pixelRatio()` and `fitBuffer` (about :2185-2239) call `tierPixelRatio`;
  - after each `setSize`, if `shrunk()` holds, step the ratio down by 0.75 and refit, at most 4 steps;
  - count every presented frame in `drawnCounts().presented`.
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts`:
  - add `firstFrameWatchdog`: `FIRST_FRAME_MS_HW = 4000`, `FIRST_FRAME_MS_SW = 15000`, read through `drawnCounts().presented`;
  - on a miss, `onTierRequest('down')` (stubbed to Flat until Task 3), then `dropToFlat()` with the notice text from look spec §5.3;
  - `WorldGraphics` gains `'watchdog'`.
- Modify: the canvas host CSS, wherever the pane styles `world-canvas-host` and the CSS2D label layer: `background: var(--world-bg)`, set from the theme's `background` on `setTheme`. The export page body does the same (`src/world-export/boot.ts`, `showMessage`).
- Modify: `src/renderer/src/components/World/LumopolisNotice.tsx`, for the watchdog notice copy.
- Test:
  - `tests/renderer/world/tierBudget.test.ts` (new);
  - `tests/renderer/world/createWorldViewer.test.ts`;
  - `tests/renderer/world/threeRenderer.demand.test.ts`;
  - `e2e/world-responsive.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tierBudget.test.ts
test('high allows 3840x2160 drawing buffers and no more; low and flat allow 1920x1080', ...)
test('the bloom chain and composer targets count toward the budget', ...)
test('software lands on the 1920x1080 budget at every tier', ...)
test('a drawing buffer smaller than the canvas is shrunk', ...)
// createWorldViewer.test.ts
test('no frame presented within 4 s on hardware asks for a lower tier, then shows the 2D map with the notice', ...)
test('a software renderer waits 15 s before the watchdog fires', ...)
test('a lost context with no loss event trips the watchdog', ...)
test('the watchdog never fires once a frame was presented', ...)
// threeRenderer.demand.test.ts
test('a shrunk drawing buffer steps the pixel ratio down until it fits, at most four times', ...)
test('the canvas host takes the theme background on setTheme', ...)
```

In `world-responsive.spec.ts`, add `the canvas is painted, never blank or white, at 3840x2160 and 5120x2880`. Hide the overlays, then screenshot the canvas:
- lit fraction > `MIN_LIT_FRACTION`;
- white fraction < `MAX_WHITE_FRACTION`;
- each 8x8 corner patch within 8 levels of the theme background.

Import the metric helpers from a new shared `e2e/worldPixels.ts`, moved out of `world-visual.spec.ts` with no change to the thresholds. The reduced Linux run (`RESPONSIVE_REDUCED`) checks 3840x2160 only, as it does for other checks.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the three unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Keep the order `fitBuffer` already has, so no intermediate size exceeds `bufferCap`. `shrunk()` is read once per resize, never per frame.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-responsive.spec.ts e2e/world-platform.spec.ts`. Then run `SOAK` with those two specs on all three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: a 4K canvas is never blank: a pixel budget at every tier, the theme background behind the canvas, and a first-frame watchdog`

**Acceptance:**
- No path leaves a white or transparent canvas.
- A run with `--force-gpu-mem-available-mb=64` (a starved GPU) at 5120x2880 lands on a drawn tier or on the 2D map with the notice within 15 s.
- The soak is green on three OSes with 0 retries.

---

### Task 1: The in-app frame-time sampler [S]

**Files:**
- Create: `src/renderer/src/world/engine/frameSampler.ts`:
  - `createFrameSampler(size = 600)`, returning `{ add(gapMs: number, counted: boolean): void; skip(n: number): void; stats(): FrameStats; window(): FrameStats; reset(): void }`;
  - `FrameStats = { frames; p50; p95; p99; worst }`, by nearest rank;
  - an uncounted frame breaks the back-to-back chain (look spec §5.1).
- Modify: `threeRenderer.ts`, the loop (about :2733-2830):
  - feed the rAF gap of each drawn frame;
  - mark a frame uncounted after an idle sleep, a hidden pane, a resize, a tier change or a restore, and `skip(5)` after each.
- Modify: `createWorldViewer.ts`:
  - `WorldDrawn.perf: { tier; auto; p50; p95; p99; worst; frames; drops; firstFrameMs; resizeWorstMs }`;
  - the probe-only `__worldPerf = { begin(), end(): FrameStats }` on `window`.
- Modify:
  - `src/main/world/worldSettings.ts`: add `showFrameRate: boolean`, default false;
  - `src/renderer/src/components/World/WorldView.tsx`: the corner readout `NN fps · N.N ms · tier`, `aria-hidden`, shown only when the setting is on;
  - the Settings ▸ Lumopolis panel: the "Show frame rate" switch.
- Test:
  - `tests/renderer/world/frameSampler.test.ts` (new);
  - `createWorldViewer.test.ts`;
  - `WorldView.test.tsx`;
  - the world settings test in `tests/electron/`.

- [ ] **Step 1: Write the failing tests**

```ts
test('p50/p95/p99/worst by nearest rank over the counted gaps', ...)
test('a gap after an uncounted frame is not counted (idle sleep never reads as a 2 s frame)', ...)
test('skip(5) drops the next five gaps', ...)
test('the ring keeps the last 600 gaps', ...)
test('__worldPerf exists only with the probe flag', ...)
test('the readout shows fps, p95 and tier only when Show frame rate is on', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Use no `performance.now()` in pure code: the clock is injected. The ES2020 rule holds (sort a copy, then index it).
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`.
- [ ] **Step 5: Commit** with the message `lumopolis: an in-app frame-time sampler, its readout, and a perf hook for tests`

**Acceptance:** `drawn().perf` reports stable numbers across an idle period: an idle sleep adds no 2 s outlier.

---

### Task 2: The CI perf soak and the software floor [M]

**Files:**
- Create: `e2e/world-perf.spec.ts`. Two fixtures, the Termpolis repo and the 168-file generated world (reuse `world-visual`'s generator), at 1920x1080. Tests:
  1. `a 10 s scripted orbit reports frame times`: `__worldPerf.begin()`, a mouse-drag orbit of 360° over 10 s, then `end()`. Write `test-results/world-perf/<os>-<fixture>-<tier>.json` with the stats, `drawCalls`, `triangles`, the renderer string and `software`. Reported only, no assertion on fps.
  2. `software starts at Flat and its orbit stays within the floor`: only when `drawn().software`. Assert `p95 <= SOFTWARE_FLOOR_P95_MS`.
  3. `the first frame is fast`: `firstFrameMs <= 3000` in software and `<= 1000` on hardware. The hardware CI margin is wider than the spec's 400 ms, which Task 20 proves on real GPUs.
  4. `forced High in software drops through Low to Flat within 8 s and never rises`. Added in Task 3, as `test.fixme` here.
- Modify: `playwright.config.ts`: add `e2e/world-perf.spec.ts` to `HEAVY_SPECS`.
- Modify: `.github/workflows/test.yml`. Add shard 7, `world-perf`, to the Linux, Windows and macOS e2e matrices, under `xvfb-run` on Linux as shards 5 and 6 run. Upload `test-results/world-perf/` as `lumopolis-perf-<os>`.
- Modify: `.github/workflows/e2e-soak.yml`: upload `test-results/world-perf/` too.
- Modify: the look spec §6.2. Fill in `SOFTWARE_FLOOR_P95_MS` as 1.5 × the median p95 of 3 soak runs × 3 copies on ubuntu-24.04, and put the same constant in `e2e/world-perf.spec.ts`.

- [ ] **Step 1: Write the spec with the floor test pending** (`test.fixme` until the baseline exists).
- [ ] **Step 2: Baseline.** Run `SOAK` with `specs: e2e/world-perf.spec.ts` three times on ubuntu-24.04, and once each on windows-latest and macos-latest. Gather the JSONs.
- [ ] **Step 3: Set the floor** from the Linux median. Turn the floor test on. Record every OS's numbers in the look spec §6.2 (renderer string, p50/p95, draw calls).
- [ ] **Step 4: Prove it.** Run `SOAK` on three OSes, 3 copies, 0 retries. Expected: green.
- [ ] **Step 5: Commit** with the message `lumopolis: a perf soak on three systems and a measured software floor`

**Acceptance:** shard 7 is green on three OSes, and `perf` artifacts are uploaded. The look spec carries the real floor number and the baseline table.

**Deviation (Task 2, 2026-11-25).** The CI bounds are not 1.5 × the Linux median, and the first-frame gate is not 3000 ms on every runner. A median-based floor and a flat 3 s left an 11-12% margin on the worst soak copies, which flakes on shared runners, and the first frame on GPU-less runners swings from 0.5 s to 5.7 s on one commit (macOS). These are CI regression guards, not the spec's targets (look spec §6.2): each world gets a warm-up orbit, not counted, then three orbits, and the gate takes the median p95 against a per-system, per-world floor, the worst counted orbit seen × 1.3 (Linux 810/440, Windows 510/300 ms; macOS reported, not asserted, because its runner swings 2-5× and Macs do not draw in software in use). The first frame is held to 2.7 × a small warm-up world's first frame in the same launch (worst seen 2.04 in 52 first frames) and under the 15 s software watchdog; on a GPU to 1000 ms. Fix round 1 (review I1, I2) adds, once both worlds are drawn, in software on Linux and Windows: each world's first frame under a time per system, the worst seen × 1.3 and no more than 3 s where that is less (Windows 1320 ms; Linux 3140 ms, a CI-runner deviation over the 3 s target, look spec §6.2), and the first frames against the runner's own speed (`FIRST_FRAME_PER_GL`), so a 2× first frame on every world fails. The 3 s first frame in software and 400 ms on the iGPU stay the real-hardware targets. Task 20 times the 400 ms in its GPU runs; its GPU runs cannot time the 3 s, so its release bar has a software run on real hardware with the GPU off. Test titles follow: `3 scripted orbits of 10 s after a warm-up orbit report frame times`, `in software the median orbit stays within the floor`.

---

### Task 3: Quality tiers and the governor [L]

**Files:**
- Create: `src/renderer/src/world/engine/qualityGovernor.ts`:
  - `createGovernor({ start: TierName; mode: 'auto' | TierName; now: () => number })`, returning `{ onWindow(stats: FrameStats): TierName | null; onContextRestored(): TierName; tier(): TierName; drops(): number }`;
  - constants: `DROP_P95_MS = { high: 18.5, low: 33 }`, `RISE_P95_MS = { low: 10, flat: 20 }`, `DROP_WINDOWS = 2`, `RISE_HOLD_MS = 10_000`, `MAX_RISES = 1`, `LOCKOUT_DROPS = 2`, `MIN_WINDOW_FRAMES = 30`.
- Modify: `threeRenderer.ts`:
  - `RendererOptions.quality` widens to `TierName | 'auto'`;
  - `setTier(tier)` applies the look spec §5 table (pixel ratio via `tierPixelRatio`, composer on or off, bloom size, grain, stage counts, static scan lines) without rebuilding the scene;
  - `drawnCounts().tier` reports it.
- Modify: `createWorldViewer.ts`:
  - wire the sampler windows to the governor, and the governor to `setTier`;
  - software starts at `flat`;
  - a context restore starts one tier lower (`onContextRestored`);
  - the second loss is unchanged (`dropToFlat`);
  - Task 0's watchdog stub becomes `governor` steps.
- Modify:
  - `src/renderer/src/components/World/WorldToolbar.tsx`: a Quality menu (Auto, High, Low, Flat), with a visible label and keyboard support;
  - `worldSettings.ts`: `quality: 'auto' | TierName`, default `'auto'`;
  - `WorldView.tsx`: pass the setting through.
- Test:
  - `tests/renderer/world/qualityGovernor.test.ts` (new): traces recorded as arrays of gaps, including one taken from the spike's High trace (`perf.json`);
  - `createWorldViewer.test.ts`;
  - `threeRenderer.themesLod.test.ts`: the tier table;
  - `WorldToolbar` tests in `WorldView.test.tsx`;
  - `e2e/world-perf.spec.ts`: turn test 4 on.

- [ ] **Step 1: Write the failing tests**

```ts
test('two windows over 18.5 ms p95 drop High to Low; one does not', ...)
test('two windows over 33 ms drop Low to Flat', ...)
test('a rise needs 10 s of windows under 60% of the higher budget, and happens at most once', ...)
test('a tier dropped from twice is never re-entered in auto mode', ...)
test('a window under 30 frames is ignored', ...)
test('a user-chosen tier is never changed', ...)
test('a context restore starts one tier lower; the second loss still goes to the 2D map', ...)
test('software starts at Flat', ...)
test('setTier changes pixel ratio, composer, bloom size, dust and shafts per the tier table without rebuilding', ...)
test('the Quality menu is reachable by keyboard and saves the choice', ...)
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.** The governor is pure and clock-injected. `setTier` disposes the composer's targets when it leaves High or Low (no leak; `threeRenderer.dispose.test.ts` counts them).
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, `E2E e2e/world-perf.spec.ts e2e/world-engine.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: High, Low and Flat quality tiers that drop by themselves when frames miss, with hysteresis and a user choice`

**Acceptance:** Review Focus 2 holds. The perf soak's forced-High test is green on three OSes, with 0 retries.

---

### Task 4: OrbitControls damping counts the time since its last update (VISFLAKE Minor 2) [S]

The bug (`.superpowers/sdd/2026-11-17-lumopolis-5-spec-conformance/visflake-review.md`, "Named risk", and af9c0928): OrbitControls r160 calls `scope.update()` from its own handlers:
- the mouse rotate handler (`OrbitControls.js:691`);
- the wheel handler (`:745`);
- the touch handlers.

Each call applies the factor `dampingFactor` set by the last frame. A drag sends many pointer events per frame, so on a slow screen the glide is spent during the drag.

**Files:**
- Modify: `threeRenderer.ts`, at about :2938-2942 and where the controls are made. Wrap the instance's `update`, so every call sets `dampingFactor = easeShare(CONTROLS_DAMPING_RATE, (now - lastUpdateAt) / 1000)` and then stamps `lastUpdateAt`. Drop the per-frame assignment. A call with a gap of 0 or less applies the motion with a factor of 0, so nothing decays.
- Create: `src/renderer/src/world/engine/timedDamping.ts`, `timedUpdate(controls, rate, now)`, pure apart from the instance it wraps.
- Test:
  - `tests/renderer/world/timedDamping.test.ts` (new): a fake controls object that records its factors;
  - `threeRenderer.demand.test.ts`: keep VISFLAKE's glide test, and add the drag case.

- [ ] **Step 1: Write the failing tests**

```ts
test('ten input updates inside one 33 ms frame decay as much as one update 33 ms later', ...)
test('the glide after a drag on a 15 fps screen takes the same wall time as at 60 fps (within 5%)', ...)
test('a zero or negative gap decays nothing', ...)
```

- [ ] **Step 2: Run them and see them fail.** Reverting the wrapper must fail the 15 fps test.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, `E2E e2e/world-engine.spec.ts`.
- [ ] **Step 5: Commit** with the message `lumopolis: orbit damping counts the time since its last update, so input events no longer spend the glide (VISFLAKE M2)`

---

### Task 5: The line close-up is searched once per line and re-aimed on resize (WP2 M-a) [M]

The bug: `cameraRig.ts` `resized()` and `refit()` (about :181-189) rerun `goal()`, then `shotFor` (`threeRenderer.ts:1564`), then `lineShot` (:1867). That is a full direction search, about 320 ms at worst (400 × 40) on every ResizeObserver callback, so dragging the pane divider with a line card open stutters.

**Files:**
- Create: `src/renderer/src/world/engine/lineShotCache.ts`:
  - `createLineShotCache()`, returning `{ get(key): CachedLineShot | undefined; put(key, v): void; clear(): void }`;
  - the key is `lineId + '\0' + layoutVersion`;
  - `CachedLineShot = { dir: V3; target: V3; points: V3[] }`: the size-free result of the search;
  - `reaim(cached, aspect, fov, area: FreeArea): Shot` fits the distance only, with `fitDistance` over the cached points: O(points), with no search.
- Modify: `threeRenderer.ts` `lineShot`. Search only on a cache miss, and otherwise `reaim`. Clear the cache on `draw()` (a layout change) and on `setExploded`. Record each `resized()` cost in `drawnCounts().perf.resizeWorstMs`.
- Modify: `cameraRig.ts`. No change in behaviour; add a comment that `resized` and `refit` rely on the cache.
- Test:
  - `tests/renderer/world/lineShotCache.test.ts` (new);
  - `threeRenderer.pickFocus.test.ts` (a spy counts the searches);
  - `e2e/world-responsive.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('thirty resizes with a line card open search the line once', ...)
test('reaim keeps both ends of the line in view at any aspect from 0.5 to 3', ...)
test('a new layout or an explode searches again', ...)
test('the reaimed shot matches a fresh search within 2% distance and 3° direction at the original aspect', ...)
```

Add the e2e drag-jank test `dragging the pane divider with a line card open stays smooth` to `world-responsive.spec.ts`:
- open a line card;
- drag the divider 300 px over 2 s in 40 steps;
- assert `drawn().perf.resizeWorstMs < 16`;
- with a `PerformanceObserver('longtask')`, assert no task over 200 ms is attributed to the renderer document during the drag;
- assert both ends of the line are still in view afterwards.

- [ ] **Step 2: Run them and see them fail.** On the old code `resizeWorstMs` is around 300.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, `E2E e2e/world-responsive.spec.ts e2e/world-visual.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: a line close-up is searched once and re-aimed on resize, so dragging the pane stays smooth (WP2 M-a)`

**Deviation (Task 5, 2026-11-26), PENDING SIGN-OFF.** The search was not the drag's only cost. With the cache in place the drag still failed on all three CI systems (worst resize 250-700 ms, long tasks over 200 ms): a timed run put the cost in `renderer.setSize`, because giving the canvas a new buffer waits on the frames the GPU process still has to draw, and in software a frame of the repository's world takes that long. So a resize once the view has drawn no longer fits the buffer at once: the canvas stretches the buffer it has over the new size (the camera already uses the new shape, so nothing is out of proportion, only a little soft), and the buffer is fitted, with a frame drawn, once the size has held for `BUFFER_SETTLE_MS` (150 ms). The fit stays immediate before the first frame, from or to a hidden pane's 1 × 1 view, and on a pixel-ratio change; dispose drops a pending fit. `resizeWorstMs` therefore counts the stretch, not the fit. The e2e test counts a long task as the drag's only when it starts within 150 ms of a pointer move (later, the hand held still and the fit ran), and checks the buffer is fitted to the narrowed view's shape afterwards.

**Deviation (Task 5, 2026-11-26, second), PENDING SIGN-OFF.** "No task over 200 ms during the drag" is checked as "no frame of the page spends over 200 ms on its own work during the drag", timed by long animation frames. With the buffer settle in place the drag's resizes cost 0.5-12 ms, yet long tasks of 200-330 ms still came on all three CI systems, as long with the hand held still as during the drag (soaks 45862505941 and 45862510698: 323 ms still on Windows, 204 ms on Linux). Their frames name no script at all: they are the page waiting while the GPU process draws the frame before (SwiftShader, a frame of the repository's world at High), which a long task alone cannot tell from the drag's work. A frame's own work is its scripts before it rendered plus its rendering (requestAnimationFrame callbacks with the frame's drawing, the resize observer, style, layout and paint); a piece counts as the drag's when a pointer move came while it ran or within `BUFFER_SETTLE_MS` before it began. Every long task is still logged. Mutations caught: a linear camera ease (world-visual), 250 ms of drawing work after each resize, and 250 ms of untimed work in the resize observer.

**Test note (world-visual "camera flights ease", world-engine "reduced motion", 2026-11-26), PENDING SIGN-OFF.** Two checks of main's e2e were made robust to software frames of 0.7 s on macOS, where they flaked 1 in 3 on A2's soaks (9072911f) and not on main's e204bb97 soak (rare flakes, the same look: world-visual holds High on both). The ease check's windows are now the two halves of the flight, [0, 0.5] and [0.5, 0.95] (t = 0 left out), instead of [0.05, 0.45] and [0.55, 0.95]: a cubic ease in and out lies below the straight line through the whole first half and above it through the second, and a slow first frame put every flight's second point at t = 0.46-0.48. The reduced-motion check polls (up to 10 s) for the ring to turn and the fog to drift with motion on, instead of reading twice 800 ms apart. A linear ease still fails the ease check (soak 45867580163).

**A2.1 note (2026-11-26), PENDING SIGN-OFF.** (1) The settled buffer fit is named with `performance.measure('world-buffer-fit')` (`engine/bufferFit.ts`, which also holds `BUFFER_SETTLE_MS`, read by the e2e), and a tier change during the wait fits the buffer at once and cancels the timer's fit. (2) The divider-drag check now watches from the first move to 1.5 s after the mouse-up, not only the frames near a move: a frame that holds a named fit is left out (in software a fit is 100-360 ms, the GPU process drawing the pending frames), and any other frame over 200 ms fails the check, so app work that comes later than the settle after the last move cannot escape it. CI showed at most 127 ms of such work on Linux and none over 100 ms on Windows or macOS. (3) The quality tooltip says Auto lowers the quality when frames come too slowly and can raise it once when they stay fast (`QUALITY_TITLE` in `components/World/qualityChoices.ts`). (4) The idle-frames test in world-scenarios chooses Low for its motion half, as Flat draws no dust and holds its disc and scan lines still (look spec §5), and asserts that Flat sleeps with motion allowed; CI's software renderer starts Auto at Flat, so the old test saw 0 frames there (main red at 0df37765).

---

### Task 6: Tooling dot-folders are not districts [S]

**Files:**
- Modify: `src/main/world/compile.ts` (or `group.ts`, wherever the file snapshot becomes groups). Add `isToolingPath(rel)`: the first path segment starts with `.`. Files under such a path are dropped from the world's file set before grouping, so they are not parts, not floors and not ends of conduits. `repoFileList.ts` `SKIP_DIRS` is **not** changed, because memory ingest and the file tree still see these folders.
- Test: `tests/electron/worldCompile*.test.ts` (whichever holds grouping): a fixture with `.superpowers/sdd/x.md`, `.claude/hooks/h.py`, `.github/workflows/ci.yml` and `src/a.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a top-level dot-folder never becomes a district, even with code files in it', ...)
test('a dot-folder deeper down (src/.generated) is not treated as tooling', ...)
test('an import from src into .superpowers makes no conduit', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, then run `COV` and `TSC`.
- [ ] **Step 5: Commit** with the message `lumopolis: tooling dot-folders such as .superpowers are left out of the world`

---

### Task 7: Hosts that only tests call are not outside orbs [S]

**Files:**
- Modify: `src/main/world/compile.ts`, `externalsOf` (about :569):
  - a `service` hit counts only when its boundary file is not a test file (`TEST_FILE`, or a path segment `tests`, `test`, `e2e`, `__tests__` or `fixtures`);
  - `isReservedHost(host)` refuses `*.test`, `*.example`, `*.invalid`, `*.localhost`, and `example.com`, `example.net` and `example.org` with their subdomains.
- Test: the compile test file. Its fixture calls `https://relay.test/x` and `https://t.example.com` from `tests/a.test.ts`, `https://h.io` from `e2e/b.spec.ts`, and `https://api.github.com` from `src/c.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a host called only from test files is not an orb', ...)
test('a reserved host is never an orb, even from source', ...)
test('a host called from source and from tests is one orb with only the source conduit', ...)
test('orb ids of the remaining hosts are unchanged (no idRenames churn)', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, then run `COV` and `TSC`.
- [ ] **Step 5: Commit** with the message `lumopolis: hosts that only tests call, and reserved test domains, are not outside orbs`

---

### Task 8: No catch-all "other" floor [M]

**Files:**
- Modify: `src/main/world/label.ts` `fallbackFloors` (about :227-231). It groups by sub-folder relative to the building's root, then by the longest shared camel or kebab stem prefix (at least 4 characters), and merges the smallest adjacent groups until there are at most `MAX_FLOORS` (12). A group floor is named `folder/` or `prefix*`. A single-file floor keeps its stem name, as today.
- Modify: the load path for saved worlds (`src/shared/world` validate or `idMigration.ts`). A saved world with an `other` floor keeps it until the next compile, with no error.
- Test: the label test file, with 43 files (the `brainIpc` shape from the look test: 11 single files and 32 under three sub-folders).

- [ ] **Step 1: Write the failing tests**

```ts
test('43 members make at most 12 floors and none is called other', ...)
test('members under one sub-folder share a floor named after it', ...)
test('no floor holds more than ceil(n/12)*2 files when folders allow it', ...)
test('12 or fewer members keep one floor per file, unchanged', ...)
test('a saved world with an other floor still loads', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, then run `COV` and `TSC`.
- [ ] **Step 5: Commit** with the message `lumopolis: a building with many files gets floors by folder and name, not one "other" floor`

---

### Task 9: A message port is not TCP [S]

**Files:**
- Modify: `src/main/world/label.ts`. `KIND_WORD.port` changes from `'TCP'` to `'Message port'`.
- Modify: `src/main/world/compile.ts`, `BUILTIN_GLOSSARY`. Remove `TCP` and add `'Message port': 'Messages passed over a channel between two parts of the app'`.
- Modify: the saved-world load path. Rename a `TCP` tech word to `Message port` on a building whose boundaries are all `port`.
- Test: the label and compile tests, with the `ptyHost.ts` shape (`parentPort.postMessage(`).

- [ ] **Step 1: Write the failing tests**

```ts
test('parentPort.postMessage gives a Message port tech chip, not TCP', ...)
test('the glossary explains Message port', ...)
test('a saved world with TCP on a port-only building shows Message port', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, then run `COV` and `TSC`.
- [ ] **Step 5: Commit** with the message `lumopolis: message ports are called message ports, not TCP`

---

### Task 10: The Holotable palette and the mark map (#12 extended) [M]

**Files:**
- Create: `src/renderer/src/world/engine/holoPalette.ts`:
  - `HoloPalette` holds the tokens of look spec §3.1;
  - `PALETTES: Record<'holotable' | 'blueprint' | 'glass', HoloPalette>`;
  - `foldHue(h)`, `memberGain(n)`, `selectColor` (from D1).
- Modify: `src/renderer/src/world/engine/themes.ts`:
  - `ThemeName` becomes `'holotable' | 'blueprint' | 'glass'` (D2 option a);
  - `normalizeTheme(name)` maps `neon` to `holotable`;
  - the default is `holotable`.
  - `THEME_TUNING` in `threeRenderer.ts` (:170-178) gains a `holotable` row and loses `neon`.
- Create: `src/renderer/src/world/engine/holoMarks.ts`:
  - `holoMarks(scene: SceneModel, palette): { data: DataMark[]; stage: StageMark[] }`, the description of look spec §4;
  - `STAGE_MARKS`, the closed list of §4.3.
- Modify: `src/renderer/src/world/engine/fallback2d.ts`, so the 2D map uses the palette.
- Test:
  - `tests/renderer/world/holoPalette.test.ts` (new);
  - `tests/renderer/world/holoMarks.test.ts` (new);
  - `themesFallback.test.ts`;
  - the #12 test in the conformance suite (`worldFacts.test.ts`);
  - `tests/renderer/world/contrast.test.ts` (new).

- [ ] **Step 1: Write the failing tests**

```ts
test('foldHue keeps every district in 186..224 degrees and keeps neighbours apart', ...)
test('memberGain is 1 up to 4 members and falls as 2.2/sqrt(n)', ...)
test('cargo colours pass through unfolded', ...)
test('holoMarks is identical for two docs that differ only in generatedAt', ...)
test('every stage mark is identical for two docs with the same layout extent and different contents', ...)
test('the stage list is exactly STAGE_MARKS', ...)
test('a saved neon theme loads as holotable', ...)
test('ink on background, and ink on the brightest slab with the halo, are 4.5:1 or more in every palette', ...)
test('the focus ring and selection colour are 3:1 or more against the background in every palette', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, then run `COV`, `TSC` and `E2E e2e/world-visual.spec.ts e2e/world-platform.spec.ts`. The theme loop in `world-visual` now covers `holotable`, `blueprint` and `glass`.
- [ ] **Step 5: Commit** with the message `lumopolis: the Holotable palette, a 2D map to match, and a test that every mark is data or a named stage mark`

---

### Task 11: The stage: projector disc, outside-ring track, shafts, dust and grade [L]

**Files:**
- Create: `src/renderer/src/world/engine/holoShaders.ts`. GLSL strings `DISC_VERT/FRAG`, `SHAFT_*`, `GRADE_*`, plus uniform factories:
  - `discUniforms(extent, tier)`;
  - `gradeUniforms(tier)`;
  - `HOLO_SLAB` is the marker define the bundle check looks for (Task 16).
- Modify: `threeRenderer.ts`:
  - build the stage from `holoMarks().stage`: disc radius from the layout extent, the track at the orb ring radius only with orbs, one beam per district, shafts and dust counts by tier;
  - the existing stars stay;
  - add the grade pass to the composer (High and Low);
  - the disc sweep runs only while `setWorking(true)` (a new `ThreeRenderer` method, called by `createWorldViewer` while a compile or an Ask runs) and never under reduced motion;
  - the stage marks get `visual` entries: `discAngle`, `sweep`, `dustDrift`.
- Modify: `createWorldViewer.ts`, to call `setWorking` from the compile and ask states it already knows.
- Test:
  - `tests/renderer/world/holoShaders.test.ts`: the uniform factories, and each GLSL string has no `#version`, no `texture2D` in GLSL3-only places, and the expected uniforms;
  - `threeRenderer.scene.test.ts`: the stage objects per tier;
  - `threeRenderer.motion.test.ts`;
  - `e2e/world-engine.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the disc radius follows the layout extent', ...)
test('no track without orbs; the track sits at the orb ring radius', ...)
test('High draws 2 shafts and 1800 dust, Low 1 and 600, Flat none', ...)
test('the sweep runs only while working, and never under reduced motion', ...)
test('the grade pass has grain only at High', ...)
```

In `world-engine.spec.ts`, add `every Holotable shader compiles` (`drawn().shaderErrors === 0`, through `renderer.debug.checkShaderErrors` and an `onShaderError` counter in test mode) on every tier. Extend `reduced motion freezes …` with `discAngle`, `sweep` and `dustDrift`.

- [ ] **Step 2–4:** Run them and see them fail, implement it, run `COV` (`holoShaders`), `TSC`, `E2E e2e/world-engine.spec.ts e2e/world-visual.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: the Holotable stage: projector disc, outside-ring track, light shafts, dust and grade`

---

### Task 12: Hologram slabs and hex plates [XL]

**Files:**
- Modify: `holoShaders.ts`, to add `SLAB_*` and `PLATE_*`, plus `slabUniforms`, `plateUniforms`, and `slabState(focus, selected, hovered, related): number` (the §3.2 encoding) as pure functions.
- Modify: `threeRenderer.ts` and `batching.ts`:
  - the `InstancedMesh` per look takes the slab material, with instance attributes `aState`, `aHeat`, `aStack` and `aLook`;
  - the `wire` look draws a pulsing wireframe with no fill;
  - the `amber` look draws amber edges;
  - `fog` and `fading` keep their meaning;
  - the verified ring stays green (`seal`) and keeps rotating;
  - the process shell keeps its process colour;
  - hex plates replace the platform meshes, keeping `platformSides === 6` and `platformLights`;
  - slab signals at the districts tier (`slabSignals.ts`) draw through the plate shader.
- Modify: `slabSignals.ts`, only if a signal needs a new field. The 100% coverage stays.
- Test:
  - `holoShaders.test.ts` (`slabState`, gains, stack fill);
  - `batching.test.ts`;
  - `slabSignals.test.ts`;
  - `threeRenderer.scene.test.ts`;
  - `threeRenderer.pickFocus.test.ts`;
  - `e2e/world-visual.spec.ts`;
  - `e2e/world-scenarios.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('slabState encodes selected ≥1.5, hovered ≥0.75, related 0.25..0.75, dimmed ≤ -0.5', ...)
test('fill falls as 1/(1+0.12*stack)', ...)
test('each Look maps to its own instance pool and draw call', ...)
test('picking a floor still returns its building id through the instanced pool', ...)
test('a plate focus eases by time, not per frame', ...)
```

e2e:
- `world-visual`'s existing checks pass unchanged for all three palettes, on the small fixture, the generated one and the Termpolis repo: luminance, lit fraction, white fraction under 0.5% at the overview and the close-up, label readability, and no overlap.
- `world-scenarios` keeps its look assertions: proposed is a wireframe, a gap is amber, verified has a ring, fog.

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.** Use the white-out controls of look spec §3.3. If a white-fraction check fails, lower the gain, never the threshold.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, `E2E e2e/world-visual.spec.ts e2e/world-scenarios.spec.ts e2e/world-engine.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: hologram floors and hex district plates, every look kept`

**Acceptance:**
- Review Focus 3 holds at this stage, before the selection column exists.
- Draw calls on the Termpolis repo overview: High ≤ 80, Low ≤ 55, Flat ≤ 40 (`drawn().drawCalls`).

---

### Task 13: Conduit ribbons, packets and the pulse head [XL]

**Files:**
- Modify: `holoShaders.ts`, to add `RIBBON_*` and `ribbonUniforms`.
- Create: `src/renderer/src/world/engine/ribbonGeometry.ts`. `buildRibbons(conduits: SceneConduit[], segments)` returns `{ solid: Float32Array…; dashed: … }`: position, side, `t`, edge index and width attributes. The control point is raised by `d * 0.22 + 4`. It is pure, with no `THREE` import.
- Modify: `threeRenderer.ts`:
  - all conduits draw in two merged meshes (solid and dashed);
  - per-edge state goes in a small data texture or a per-vertex `aState` updated on focus, with no rebuild on hover;
  - width in pixels comes from `conduitStyle().width`;
  - colour is the cargo colour;
  - packets keep their cargo shapes on solid lines;
  - `pulse(edgeIds)` runs a pulse head once;
  - the CPU curves stay for picking, `linePoints`, `screenPoint` and line labels;
  - `tubeMats` and `packetMats` per edge are replaced by state slots, and `drawnCounts()` keeps its fields.
- Test:
  - `tests/renderer/world/ribbonGeometry.test.ts` (new);
  - `threeRenderer.pickFocus.test.ts`;
  - `threeRenderer.motion.test.ts`;
  - `e2e/world-visual.spec.ts` (the line card checks);
  - `e2e/world-ask.spec.ts` (an answer pulses its lines).

- [ ] **Step 1: Write the failing tests**

```ts
test('a dashed conduit goes to the dashed ribbon, a solid one to the solid ribbon', ...)
test('no ribbon is dashed unless conduitStyle says dashed', ...)
test('the ribbon follows the same curve linePoints reports (within 0.5 px at the reference view)', ...)
test('hover changes per-edge state without rebuilding the geometry', ...)
test('637 conduits draw in two calls', ...)
test('pulse runs one head per call and none idly; reduced motion shows the lit line without travel', ...)
```

- [ ] **Step 2–4:** Run them and see them fail, implement it, run `COV`, `TSC`, `E2E e2e/world-visual.spec.ts e2e/world-ask.spec.ts e2e/world-engine.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: conduits draw as two merged light ribbons; dashes still mean a guess or a plan`

---

### Task 14: Orbs, the selection mark and the verified ring [M]

**Files:**
- Modify: `holoShaders.ts`, to add `ORB_*` and `SELECT_*`.
- Modify: `threeRenderer.ts`:
  - instanced orbs, with an agent glyph (a ring) and a service glyph (a latitude/longitude sphere), fog, and heat;
  - `setSelected` draws a base ring (rotating, 0.5 Hz pulse at 4% scale), a hex outer ring and a column (alpha ≤ 0.35) in the D1 colour;
  - `visual.selectionRingAngle` keeps working.
- Modify: `src/renderer/src/components/World/WorldLegend.tsx`, to add a row for the selection mark: an inline SVG of the ring and column, with the copy `Selected part`.
- Test:
  - `threeRenderer.scene.test.ts`;
  - `threeRenderer.motion.test.ts`;
  - `WorldLegend.test.tsx`;
  - `e2e/world-visual.spec.ts`;
  - `e2e/world-engine.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('agent and service orbs draw different glyphs from one instanced pool each', ...)
test('the selection column alpha never exceeds 0.35', ...)
test('the selection pulse is 0.5 Hz and freezes under reduced motion', ...)
test('the legend explains the selection mark', ...)
```

e2e: select the busiest building of the Termpolis repo in each palette. The white fraction stays under 0.5% (Review Focus 3).

- [ ] **Step 2–4:** Run them and see them fail, implement it, run `COV`, `TSC`, `E2E e2e/world-visual.spec.ts e2e/world-engine.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: Holotable orbs and a selection mark that keeps the close-up readable`

---

### Task 15: Labels, floor tags and the chrome [M]

**Files:**
- Modify: the label CSS for the CSS2D labels (where `threeRenderer.ts` styles label kinds). Add the classes and font stacks of look spec §3.6, and the text halo. Exploded floor tags show `NN name count` on an opaque plate.
- Modify:
  - `WorldCard.tsx`, `WorldLegend.tsx` and `WorldToolbar.tsx`, with their CSS: the panel look of §3.7;
  - blur only when `drawn().tier === 'high' && !drawn().software`, otherwise opaque (ASKFLAKE);
  - the focus ring is `attention`, 2px.
- Test:
  - `threeRenderer.labels.test.ts`;
  - `WorldView.test.tsx`;
  - `WorldLegend.test.tsx`;
  - `e2e/world-visual.spec.ts`;
  - `e2e/world-ask.spec.ts` (ASKFLAKE's opaque card in software);
  - `e2e/world-responsive.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a floor tag reads "NN name count" from the floor data', ...)
test('the card and legend are opaque in software and at Low and Flat; blurred only at High on hardware', ...)
test('label font stacks contain no web font and no url(', ...)
test('the focus ring is visible on every toolbar control', ...)
```

e2e: no two labels overlap, all labels are readable, and the counts are unchanged at every viewport in `world-responsive`.

- [ ] **Step 2–4:** Run them and see them fail, implement it, run `COV`, `TSC`, `E2E e2e/world-visual.spec.ts e2e/world-ask.spec.ts e2e/world-responsive.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: Holotable labels, floor tags, card, legend and toolbar`

---

### Task 16: Export parity [M]

**Files:**
- Modify: `src/world-export/boot.ts` and `controls.ts`:
  - the page body and the `showMessage` panel use the palette;
  - the export passes `quality: 'auto'`;
  - the watchdog and ladder come with the engine.
- Modify: `scripts/checkWorldExportBundle.cjs` and `scripts/checkWorldStandalone.cjs`. Assert:
  - the `HOLO_SLAB` marker is present in `world-export.js` and `dist-world/world-viewer.js`;
  - there are no `http://` or `https://` font or asset URLs;
  - there is no dynamic `import(`;
  - there is still one chunk per entry.
- Modify: `vite.world.config.ts`, only if a new module splits out. Keep the 3-pass build.
- Test:
  - `tests/scripts/` (the bundle check tests, if present; otherwise the checks run in `build:world-viewer`);
  - `e2e/world-export.spec.ts`.

- [ ] **Step 1: Write the failing tests.** In `world-export.spec.ts`:
  - `an exported world draws the Holotable look`: a painted canvas with corner pixels at the background, `drawn().tier` set, and `shaderErrors` 0;
  - `an exported world without WebGL shows the 2D map in the same palette`.
- [ ] **Step 2–4:** Run them and see them fail, implement it, run `npm run build:world-viewer`, `TSC`, `E2E e2e/world-export.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: exported worlds carry the same Holotable look, tiers and fallbacks`

---

### Task 17: The arrival [S]

**Files:**
- Modify: `threeRenderer.ts`:
  - an `arrival` uniform timeline of 1.6 s (disc, then buildings by district delay, then conduits drawn along `uDraw`, then orbs);
  - objects stand at their final positions from frame one;
  - a click or a key finishes it;
  - skipped under reduced motion, at Flat, and on a restore;
  - `drawn().arrival` reports it.
- Create: `src/renderer/src/world/engine/arrival.ts`. `arrivalAt(t, districtIndex, count)` returns the per-layer progress. Pure.
- Test:
  - `tests/renderer/world/arrival.test.ts` (new);
  - `threeRenderer.motion.test.ts`;
  - `e2e/world-engine.spec.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the arrival ends by 1.6 s and every layer reaches 1', ...)
test('a click during the arrival opens the card and finishes the arrival', ...)
test('reduced motion, Flat and a restore skip it', ...)
```

The e2e helpers in `world-visual` and `world-scenarios` that take overview metrics first wait for `drawn().arrival === 'done'`, through one shared helper `waitArrived(page)`.

- [ ] **Step 2–4:** Run them and see them fail, implement it, run `COV`, `TSC`, `E2E e2e/world-engine.spec.ts e2e/world-visual.spec.ts e2e/world-scenarios.spec.ts`.
- [ ] **Step 5: Commit** with the message `lumopolis: the world arrives in 1.6 s, and a click or reduced motion skips it`

---

### Task 18: The accessibility pass [M]

**Files:**
- Modify: the tests only, unless they find a gap. Check:
  - reduced motion freezes every animated value in `drawn().visual`, the stage entries included;
  - the contrast tests run on all three palettes;
  - the 2D map's keyboard order is unchanged;
  - `CANVAS_DESCRIPTION` is unchanged;
  - forced colours keep the chrome readable;
  - nothing flashes faster than 3 Hz.
- Test:
  - `e2e/world-engine.spec.ts` (reduced motion: every `visual` key equal over 800 ms);
  - `e2e/world-platform.spec.ts` (2D map keyboard route with the new palette; forced colours through `emulateMedia({ forcedColors: 'active' })`);
  - `tests/renderer/world/contrast.test.ts`;
  - a new unit test that every periodic animation in `holoShaders` and `threeRenderer` has a frequency of 3 Hz or less (each periodic term is declared with its `HZ` constant, and the test reads them).

- [ ] **Steps 1–4:** Write the tests, see any of them fail, fix what fails, then run `COV`, `TSC`, `E2E e2e/world-engine.spec.ts e2e/world-platform.spec.ts`, then `SOAK` on three OSes.
- [ ] **Step 5: Commit** with the message `lumopolis: the Holotable look passes reduced motion, contrast, keyboard and flash checks`

---

### Task 19: The full Lumopolis suite on three OSes with zero retries [M]

**Files:**
- Modify: whichever e2e spec still assumes the old look:
  - `world-visual`: the theme list and the luminance floor per palette, with a stated reason if a floor moves for the darker background (the white-out and lit-fraction floors never move);
  - `world-scenarios`, `world-platform`, `world-responsive`, `world-engine` and `world-ask`.
- Run: `SOAK` with `specs` = `e2e/world-visual.spec.ts e2e/world-scenarios.spec.ts e2e/world-platform.spec.ts e2e/world-responsive.spec.ts e2e/world-engine.spec.ts e2e/world-ask.spec.ts e2e/world-export.spec.ts e2e/world-perf.spec.ts` on ubuntu-24.04 (x11, and wayland once), windows-latest and macos-latest, `copies: [1, 2, 3]`.

- [ ] **Step 1:** Run the soak.
- [ ] **Step 2:** Find the root cause of every red copy (superpowers:systematic-debugging). Never add a retry, a longer blind timeout or a looser threshold without a written reason in the spec's comment block.
- [ ] **Step 3:** Repeat until two full soaks in a row are green on all three OSes.
- [ ] **Step 4: Commit** any spec fixes with the message `lumopolis: the Lumopolis e2e suite is green on three systems with no retries under the Holotable look`

---

### Task 20: Hardware proof and spec amendments [M]

**Files:**
- Create: `scripts/perfWorld.cjs` and the `package.json` script `perf:world`. It runs `e2e/world-perf.spec.ts` with `TERMPOLIS_PERF_HW=1` against the built app, with the GPU on, and writes `docs/perf/lumopolis/<machine>-<date>.json`.
- Run on:
  1. David's laptop (Intel Arc) at 1080p, in High, Low and Flat;
  2. david-linux, through `linked_machines`;
  3. the D3 low-end device;
  4. a software run: David's laptop again with the GPU off (without `TERMPOLIS_PERF_HW=1`, so the launch forces SwiftShader with `--use-angle=swiftshader` as CI does, and the map draws in software as on a GPU-less machine), at 1080p.
- Modify: the look spec §6, a results table. Release bar:
  - High p95 ≤ 16.7 ms on the iGPU;
  - Low p95 ≤ 16.7 ms on the weak GPU;
  - first frame ≤ 400 ms on the iGPU;
  - first frame ≤ 3 s in software (run 4): a GPU run cannot time it;
  - the software floor from Task 2.
- Modify: the 2.0 spec:
  - §5.1, the depth-tricks line: name the Holotable stage marks and the `holotable` theme;
  - §5.5: the quality tiers;
  - §5.9: export parity.
  Mark deferral-audit #30 closed in `.superpowers/sdd/2026-11-17-lumopolis-5-spec-conformance/deferral-audit.md`, with the commit ids.

- [ ] **Step 1:** Run on each machine. Commit the JSONs.
- [ ] **Step 2:** If a bar is missed, open a task naming the costliest pass (from `drawCalls`, triangles, and a High-minus-Low p95 split). Do not lower the bar.
- [ ] **Step 3: Commit** with the message `lumopolis: Holotable frame times measured on three machines; the specs record the look and its tiers`

**Acceptance:** the go/no-go on 12-15 has the three machine numbers in front of it.
