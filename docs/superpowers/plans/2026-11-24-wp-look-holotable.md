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

**A2.1 note (2026-11-26), PENDING SIGN-OFF.** (1) The settled buffer fit is named with `performance.measure('world-buffer-fit')` (`engine/bufferFit.ts`, which also holds `BUFFER_SETTLE_MS`, read by the e2e), and a tier change during the wait fits the buffer at once and cancels the timer's fit. (2) The divider-drag check now watches every long task of the page from the first move to 1.5 s after the mouse-up, not only the frames near a move: the task that holds a named fit is left out (in software a fit is 186-594 ms, the GPU process drawing the pending frames), and any other task over 200 ms fails the check, so app work that comes later than the settle after the last move cannot escape it. It reads long tasks, not long animation frames: on the app's file:// page a long animation frame names none of its scripts, so a timer's work was invisible to the frame check. CI traces showed at most 151 ms of other work (a frame's rendering) on Linux, Windows and macOS. (3) The quality tooltip says Auto lowers the quality when frames come too slowly and can raise it once when they stay fast (`QUALITY_TITLE` in `components/World/qualityChoices.ts`). (4) The idle-frames test in world-scenarios chooses Low for its motion half, as Flat draws no dust and holds its disc and scan lines still (look spec §5), and asserts that Flat sleeps with motion allowed; CI's software renderer starts Auto at Flat, so the old test saw 0 frames there (main red at 0df37765). (5) Drawn in software, a panel opened, moved or shut over the map while a frame is held back for the GPU (up to SOFTWARE_FENCE_MAX_MS) lays the names out at once, DOM only with nothing drawn, so they keep off it; before, they were laid out only in a drawn frame and showed through an answer's card at 5120x2880 for seconds (world-responsive's locked-note test, red on Linux before A2 and after it). (6) A resize fits the overview from the city's points made once per draw (its parts' corners, its externals and its platforms' rims, and their ground), handed to fitDistance and fitView as the same array each time (the unit tests pin that a resize hands the fit the same points array and the same name points, with no copy made; what fitDistance makes inside itself is not pinned by a unit test): before, every resize of a pane drag made some eight arrays per part and three copies of them, and the collection of that garbage fell inside a resize (16 ms, then 96 ms, on a Windows runner, against the drag check's 16 ms for a resize's own work; fitOverview was nearly all of every resize's time, up to 17.3 ms). The names' ends are pushed onto the cached points and taken off again after each pass, so a resize copies none of them. (7) Drawn in software, a settled buffer fit puts in a fence and the frame after it waits for it, held back as any frame is while the GPU is busy (up to SOFTWARE_FENCE_MAX_MS): that frame waited inside the page for the GPU process to make the new buffer, 175 to 189 ms on the Linux runners right after the fit's task, which failed the divider-drag check there (45900285688). (8) A batch outgrown hands its material to the bigger one, and the batch last dropped of each shader program keeps its material until another of that program is dropped (`programOf`): three.js frees a program with the last material using it, and building it again took 100 to 250 ms of one divider-drag frame on ubuntu-24.04 (the box batch grown from 64 to 512) and 155 ms to 1.4 s of the frame after a slab click at the overview on macOS (world-visual 3). After it the drag's worst other task was 87 ms on Linux (45918973172, 8/8 jobs) and world-visual passed 6 x 15 on macOS (45918989735). (9) PENDING SIGN-OFF. A resize fits the overview without remaking its points: whether a portrait overview turns is worked out once per draw (`groundTurns`), `overviewDir` answers with one of three frozen directions, and the names' points are the draw's own, filled in place. Before, each resize of a pane drag walked every ground point twice for the turn and made the names' points again; on a Windows runner that section took 5 to 14 ms of a resize and three multi-MB scavenges landed in it (45921137239). Traced on Windows (each resize run in an event dispatch, timed on the wall and on the thread's clock, with its GC): before, of 720 resizes in 18 drags two held a minor GC, 13.7 ms of one of 18.4 ms on the wall and 10.7 ms of one of 11.4 ms, the eight others over 8 ms on the wall (8.3 to 13.7 ms) ran at most 1.5 ms on the thread's clock with no GC, and the slowest drag failed the 16 ms check at 18.5 ms (45922179018); after, of 680 resizes in 17 drags none over 8 ms holds a GC, and the seven over 8 ms on the wall (9.9 to 14.8 ms) ran at most 0.8 ms on the thread's clock: the runner took the CPU (Windows' clock tick is 15.6 ms) (45924006574). Without the trace, the worst resize per drag was 16.5 and 35.2 ms (45918981080) and 25.5 ms (45919777906) before, and 1.0 to 13.8 ms in 16 drags after (45924066048, 16/16 passed). So the drag check now holds every resize but the slowest under 16 ms of its own (the renderer then kept the second longest, `resizeNextMs`; (10) replaced it with `resizeCount`) and the slowest under 32 ms (16 ms and one lost clock tick): a resize made slow every time, or every eighth time, fails it as the old check did, and so does a single resize made 40 ms (mutants 45925460361 every resize 20 ms slower, the second longest 22.4 to 22.9 ms; 45925465217 every eighth resize 20 ms slower, 20.2 to 20.5 ms; 45925472317 the twentieth resize 40 ms slower, the slowest 40.1 to 40.4 ms; each failed every drag on ubuntu-24.04, and the old check failed each too). It lets through one resize per drag of 16 to 32 ms, the size of one tick of the CPU lost to the runner; the unit tests pin what they can of it (a resize counts no ground walk, and fits from the same points array with the same name points filled in place). (10) PENDING SIGN-OFF, replacing (9)'s rule: the drag check reads the page's own time from a CDP trace of the drag (toplevel, devtools.timeline, blink.user_timing, gpu, ipc; mojom, base and cc since the A2.1 reviews, below), as on the windows-latest runner SwiftShader's frame presentation takes the CPU from the page. Before, on the wall: the 5191825a soak failed on Windows with tasks of 219 and 210 ms (45928083537, 45928089823) that were 13 to 39 ms of the page's thread time, and a busy loop of 250 ms on the wall got only 128 to 178 ms of the CPU there (45933139623). The renderer names each timed resize inside a frame-time window (`RESIZE_MEASURE`), which puts the page's clock on the trace's (0.00 ms apart on every OS; the clocks are paired by the offset most resizes agree on, as the macOS trace dropped one or two of 40 in three drags of four, 45933131129, and a dropped one is timed on the wall). A resize's own time is the thread time of the JS call or task around it, less the work in it wholly before or after it, plus its waits on the GPU or another process, at most its wall; a long task's is the same for the task. The rules at a03b9e05 (replaced after the A2.1 reviews, below): every resize under 16 ms of its own (stricter than (9), which let the slowest reach 32 ms); every long task but the fit under 200 ms of its own; and every one under 500 ms on the wall, for a wait the trace does not name. After: Windows 24 drags at 67ce74e7, every resize at most 4.2 ms of its own (26.2 ms on the wall) and every task at most 61.5 ms (174 ms on the wall) (45936475546, 24/24 passed; 45933123158 and 45934725342 at the earlier forms, 48/48); macOS 16 drags at most 1.0 and 75.8 ms (45934731513, 16/16); ubuntu at most 0.7 and 47.5 ms (45934752046, 45933127072). Mutants, each RED every drag: 20 ms of calibrated CPU in each resize, 20.0 to 52.3 ms of its own (45934761067 and 45936492212 Windows); a resize 20 ms slower on the wall (45933134762 Windows); 250 ms of calibrated CPU 400 ms after the last resize, 245 to 345 ms of its own (45934767923 Windows, also failing the 500 ms wall rule; 45934785884 ubuntu; 45934777997 macOS); frames drawn and finished for 300 ms 400 ms after the last resize, 684 to 863 ms of its own with 635 to 807 ms waited on the GPU (45933145508 Windows). The old check failed each too. A loop of 250 ms on the wall (45933139623) passed the new check on Windows, as the runner gave it 128 to 178 ms of the CPU: the check charges the page what it ran, not what the runner took. **After the A2.1 reviews (2026-11-27), PENDING SIGN-OFF.** The scorer is `e2e/helpers/dragTrace.ts` (`ownTimes`, `dragVerdict`, `DRAG_LIMITS`), unit-tested with synthetic traces in `tests/scripts/dragTrace.test.ts` (100% covered; 15 of its 17 tests fail on a03b9e05's scorer and rules). What changed: a wait is any event of the gpu or ipc category or named Wait, Sync or Blocking, and the trace now records mojom, base and cc too, so a renderer blocked in a sync IPC or a blocking call is charged (traced on Windows, macOS and ubuntu-24.04: diag 45943499189, 45943514479, 45944088435, 4 drags each, all passing with the larger trace; the fits' tasks were 1 to 5 ms of thread time and up to 438, 1154 and 417 ms on the wall, all but 2 to 7 ms of it traced waits: WaitForCmd, CommandBufferHelper::Finish, WaitForGetOffset, GpuChannel::WaitForGetOffsetInRange, ScopedAllowBaseSyncPrimitivesOutsideBlockingScope; a resize in a sync call to the main process showed as ElectronApiIPC::MessageSync and ScopedBlockingCallWithBaseSyncPrimitives and was charged in full, 35.8 ms wall and own, 45943524157); nested slices of the same span are merged once and never subtracted twice (a 20 ms resize inside an identical 20 ms FunctionCall scores 20 ms, not 0); the fit's task is scored, not left out, from its whole RunTask, so work after the fit's measure (the fence, the wake, anything else in the task) counts; and the page's measures are counted against what the renderer timed (`resizeCount`), so a dropped measure fails. The rules and limits (`DRAG_LIMITS`), with the clean drags they rest on (Windows tc45933123158, td45934725342, te45936475546, 45937511354, 45943499189, 78 drags; macOS tc45933131129, td45934731513, 45937518670, 45943514479, 28; ubuntu 45933127072, 45934752046, 45937504603, 45944088435, 14): every resize the renderer timed is named (named = timed); each resize under 16 ms of its own (worst 4.2 ms own; (9) and the review's floor); each resize under 100 ms on the wall, for a wait the trace does not name (worst 26.2 ms on Windows, 5.9 macOS, 8.0 ubuntu: about 4 times the worst); no long task but a fit's over 200 ms of its own (worst 77 ms, macOS; a frame of 200 ms is what the drag must not show) or 350 ms on the wall (worst 256 ms on Windows, td45934725342, 119 macOS, 77 ubuntu: the worst plus about 35%, down from 500); no fit's task over 200 ms of thread time with its GPU waits left out (worst 5 ms) or 1000 ms on the wall beyond its traced waits (worst 16 ms; the wall alone was up to 5204 ms on macOS, tc45933131129, and 1783 ms in 45943539971, all GPU waits, so a raw wall ceiling would flake there, and a fit the trace drops is held to 1000 ms on the wall); and the page handles the drag's pointer moves no more than 7000 ms apart (widest gap 3346 ms on Windows, 4626 macOS, 951 ubuntu; frames cannot be the measure, as SwiftShader draws as few as 0 to 1 frames in a drag on macOS, so the gap between the moves the page handled is asserted instead: the worst plus about 50%, a page frozen for 7 s fails it). The check that most resizes are in the trace stays (a dropped one is timed on the wall), and the clocks' spread is logged, not asserted (Opus m-1: it could not fail). Rulings on the Opus review's minors: m-1, as above; m-2, the threshold that matters is 200 ms of CPU in one task, so a timer's regression of 150 to 199 ms of CPU passes on every OS (main's long-animation-frame check could not see a timer's work at all); m-3, the check charges the page's CPU plus the waits the trace names, at most its wall, and the wall ceilings (100 ms a resize, 350 ms a task, 1000 ms a fit's task beyond its waits) are the backstop for anything else, so a loop the runner starves of the CPU passes only while it stays under them; m-4, the packet batches share `dropBatch` and the `im ? dropBatch(im) : make()` line with the box batches, so the box test and its mutants cover them, and a packet case is owed if the paths split; m-5, the `programOf` comments now say it is the material's part of three.js 0.160's program key only (the rest covers lights, fog, environment, render target, renderer state, instancing, morph and skinning), a wrong key costing a rebuilt or a kept program, never a wrong draw, and the set is bounded, one per key; m-6, after a lost context is restored the kept materials hold no built program and are built again on first use, as any material is, a cost and never a fault (said in the keeper's comment too); m-7, `resizeNextMs` is gone, replaced by `resizeCount`, which the check asserts (named = timed); m-8, if a render throws, that frame's `freeRetired()` is skipped and the retired materials wait for the next frame or for `dispose`, which frees each once (a unit test counts the frees): bounded, not a leak. Mutants of the final check are in the report. **After the Round 2 reviews (2026-11-27), PENDING SIGN-OFF**, replacing the rules above where they differ. Correction: "15 of its 17 tests fail on a03b9e05's scorer" above counts a port that also kept a03b9e05's `OwnTime` without its `cpu` field, so two of the 15 (the clocks' pairing, and a long task's thread time and waits) failed only on the missing field; behaviourally 13 of the 17 fail, the Opus review's count. Waits: the waits in a span are their union cut to the span (`waitedIn`), each piece less its thread time pro rata, so a wait that runs past a task's or a resize's end counts only inside it, waits that overlap in part count each instant once (waits [0,10] and [5,25] score 25 in a 25 ms resize), and of two with the very bounds the one with more thread time is taken. A fit's task: at most 200 ms of thread time, a fit the trace drops charged its wall as thread time; at most 1000 ms on the wall beyond its waits on the GPU only (category gpu: WaitForCmd, CommandBufferHelper::Finish, WaitForGetOffset, with the base and mojom waits nested in them), so a sync call, a lock or a compositor wait in it counts (a 3010 ms fit blocked 3000 ms in ElectronApiIPC::MessageSync failed nothing before; the fits' tasks were 3 to 5 ms beyond their GPU waits in the soaks); and at most 8000 ms on the wall whatever it waits on (the macOS worst 5204 ms, tc45933131129, times about 1.5). Coverage: at least 80% of the resizes the page named are in the trace (`tracedResizes`; the macOS trace drops up to 4 of 39, 89.7%, in the drop mutant's run 45953445618, and 3 of 40 in soak 45953332993, so 90% would leave one resize of margin; a resize it drops is still timed on the wall), and at least 90% of the fits' tasks (`tracedFits`; every fit's task was traced in every soak), and a fit named that no long task holds fails (every soak drag with a fit named had at least 8 fits' long tasks); the fits are counted in the long tasks' window, ending after the first move and beginning before 1.5 s after the release (`fitsNamed`). Pairing: a resize's begin pairs with an end of its own process, and the page's thread is the one whose resizes most agree on an offset, so another process's spans do not count as traced. Each resize under 50 ms on the wall, down from 100 (worst 26.2 ms, Windows). The pointer moves, the gap from the last to the release included (`widestGap`), no more than 5000 ms apart on Windows (worst 3346 ms), 7000 on macOS (worst 4626) and 2000 on ubuntu (worst 951); an OS the limits do not name gets the widest. `DRAG_LIMITS` is pinned by a unit test. Ruling (Codex minor): the thread time of the call around a resize that lies outside the resize but in no traced slice of its own stays charged to the resize; it is conservative, and as a resize's own time is at most its wall it can only fail a resize already 16 ms on the wall. Each Round 2 change has a unit test that fails on e30760ce's scorer (15 of the 30 fail on e30760ce ported to the new interface, the 15 that pass being the older tests), and each of 20 unit mutants of the new guards fails a test. **After the Round 3 reviews (2026-11-27), PENDING SIGN-OFF**, replacing the rules above where they differ. (a) A fit's task on the wall, its waits on the GPU too, is held by OS (`fitCeiling`): 2000 ms on Windows and ubuntu, 6000 ms on macOS, the widest for an OS the limits do not name, down from 8000 ms everywhere. The worst seen: Windows 457 ms (td45934725342; 1278 ms only on a diag mutant's build), ubuntu 518 ms (45933127072), macOS 5204 and 4429 ms (tc45933131129), then at most 3323 ms (td45934731513), at most about 1.8 s in every later soak and 880 ms at c0b8626a. So 2000 is about 4 times the worst on Windows and ubuntu, and 6000 the macOS worst plus about 15%: a fit stalled 3 s on the GPU fails on Windows and ubuntu and passes on macOS, where the GPU process's waits have reached 5.2 s in a clean soak. (b) Waits: where the trace does not say where a wait's thread time lies (in the part a span's end cuts off, or in the part another wait covers too), the scorer takes the bound unkind to the page (`waitedIn(..., bound)`): a fit's waits on the GPU, which its wall is excused, are taken to hold the most thread time they can (`'least'` waited), and the waits charged in a resize's or a task's own time the least (`'most'` waited). A wait cut to a span holds at least its tdur less the part cut off and at most min(tdur, the part kept); one that extends a piece of the union adds at most its thread time past the piece's end and at least what of it cannot lie in the part already counted; one nested in a piece adds no length, but its thread time is in the piece, so a piece holds at least as much thread time as the waits inside it (a missing tdur is 0, and an outer slice without one is no proof the thread spent none in it). So waits [0,600] with tdur 0 and [400,1000] with tdur 150 credit 850 ms, not 900, and a GPU slice nested in an outer one with no tdur is credited its length less its own thread time. (c) The resizes' share counts those timed on the thread's clock, each in the work around it (`matched`), at least 80%, not those the trace merely holds; in 168 soak drags the two counts were equal in every drag, the worst 35 of 39 on macOS (45953445618). (d) The fits' tasks: at least 90% in the trace, or all but one (`fitsDropped` 1), so one dropped of fewer than 10 fits fails no drag: no soak dropped a fit's task (no "(not traced)" in any log), and ubuntu drags hold as few as 6 or 7 fits (45928080914; macOS at least 12, Windows at least 13), where 90% would have allowed none. (e) Ruling, the count of fits in one task: not capped, harmless. A task holding any number of fits is held as one, to 200 ms of thread time, 1000 ms on the wall beyond its GPU waits and the ceiling, so more fits in it only make it fail sooner (the drags named at most 40 fits on Windows, 30 on macOS, 36 on ubuntu). (f) Ruling, the enclosing call's overcharge (Round 2's Codex minor, above): it stays. It only ever charges more, and as a resize's own time is at most its wall, it can fail only a resize already 16 ms on the wall. (g) Tests: each of (a) to (d) has a unit test that fails on c0b8626a's scorer (9 of the 37 fail there); a resize share at 39 resizes (32 timed pass, 31 fail: `Math.ceil`, not floor) and a tie of the threads' votes (the first named wins) pass on c0b8626a and kill its two surviving unit mutants; each of 36 unit mutants of the guards fails a test. The tie-break of Round 2 for two waits with the very bounds (more thread time first) is gone: a piece now holds at least the thread time of the waits inside it, so either order scores the same, and its mutant could not fail. The e2e mutants are in the report. **After the Round 4 reviews (2026-11-27), PENDING SIGN-OFF**, replacing the rules above where they differ. (a) A fit's GPU credit (`waitedIn(..., 'least')`) is now a true lower bound: the union U of the waits cut to the span, less the heaviest family of disjoint timed slices (`heaviest`, weighted interval scheduling; touching ends do not conflict), each slice weighing its thread time, at most its part inside U. The slices are the waits and the `known` slices the caller hands in (every timed slice on the page's thread: the fit's RunTask, any call or task nested in it), so thread time of any category counts, not only a wait's. Proof: slices that overlap may hold the same instants of thread time, so only disjoint ones are sure to hold different instants; the thread ran at least the heaviest such family's thread time inside U, and every instant it ran is no instant it waited, so U less that is the least the page can have waited. The family never holds more than U, so no floor is needed. With the task itself in `known` (a cover slice) it is sound whatever the trace leaves out. Codex's case, waits [0,600] of no thread time, [50,150] of 100 nested in it and [500,800] of 70 past it, credits 630 ms (800 less 100 and 70, which lie apart), not 700 (Round 3 counted the 70 only past 600); and a call [0,100] of 30 ms of thread time with a wait [90,200] of none and one [150,160] of 10 credits 90, a slice holding at most its part of U (Opus's mutant N10: 70). A FunctionCall of 150 ms of thread time inside a 1000 ms GPU wait with none credits 850, with or without the task around it (Round 3: 1000). (b) A resize's call: of its thread time, what lies outside the resize is taken off only as far as the trace shows it there, as the heaviest family of the timed slices nested in the call, each weighing its thread time less its part inside the resize, plus the part of the resize outside the call (`within`). So (f) above, that the enclosing call's overcharge only overcharges, is now true: a 17 ms resize whose call's 1.04 ms of thread time lies in work ending 0.04 ms into it, then 15.98 ms waiting, scores 16.02 and fails (Round 3 took the work off whole, inside the 50 us slack, and scored 15.98). The waits charged in a resize's or a task's own time stay the most the trace allows (`'most'`); a twin of the task test pins it for a resize (18.5 ms in a call of 10.3 ms of thread time, 10 waited, 18.5 own; with `'least'` 10.3), killing Opus's mutant N13. (c) Begin/end pairs (ph B and E): the trace's B/E events are paired per thread (`paired`: last in, first out, in the trace's order, stable on ties), each pair made a complete slice, its thread time the two thread clocks' difference when both are given; an end with no begin open is dropped, and a begin never ended runs to the trace's last instant, is a wait if its name or category says so, and is never credited to a fit as a wait on the GPU (it is charged, never excused). So a 20 ms resize with an 18 ms B/E wait scores 20, not 2. Evidence: the drag check now logs the B/E pairs on the page's thread by name; in 72 drags on Windows, ubuntu and macOS (diag 45985754504, 45985767956, 45985786689) and 66 more (45981436930, 45981456610, 45981476460) there were none, the waits being complete (X) slices on every OS; the pairing is a guard, not a fix of a seen fault. (d) The fits' thread time in all (`fitCpuTotal`, 200 ms): the tasks that hold the drag's fits, each once, a fit in no task the trace holds charged its long task's wall, or 50 ms in none, so many fits too short to be long tasks fail (40 fits of 39 ms in tasks of 40: 1567 ms, and 8 such fits in the quiet test drag, 202 ms). A fit's task is the RunTask around its measure within 0.25 ms (`FIT_SLACK`; of several, the one holding most of the measure, then the innermost), else the long task's own task when the trace holds it: the page's clock is coarsened (100 us and a jitter, the page not being cross-origin isolated), and a fit's measure began up to 0.17 ms before its task and ended up to 0.07 ms after it, so the resizes' 50 us slack left 5 to 9 fits of a drag in no task and charged them their long tasks' wall, up to 4049 ms in all in a drag whose fits' tasks took about 40 (diag 45983711383, 45983723838, 45983738302). With it every fit was in a task the trace holds in all 72 drags, and the totals were 18 to 41 ms on Windows, 14 to 31 on ubuntu and 9 to 82 on macOS, so 200 is about 2.5 times the worst. (e) `fitCeiling` on macOS is 8000 ms, about 1.54 times its worst clean fit of 5204 ms (tc45933131129), up from 6000 (the worst plus 15%, too close); Windows and ubuntu stay 2000. (f) Tests: each of (a) to (d) has a unit test whose f70a6aad value is in its comment (Codex 700, the call 1000, the resize 15.98, the B/E resize 2, 40 fits no rule), and a test of Opus's mutant N10 (above); 44 unit tests, 100% of dragTrace.ts covered; every unit mutant of the guards fails a test but one dropped as equivalent: a slice that is both a wait and known need not be deduplicated, as two slices with the very bounds overlap and the family holds one of them (the code now says so). The e2e mutants are in the report. **After the Round 5 reviews (2026-11-27), PENDING SIGN-OFF**, replacing the rules above where they differ. The rule: every doubt in what a slice of the trace is charged resolves to the overcharge. (a) A fit's tasks: every RunTask around its measure within `FIT_SLACK` (0.25 ms) is charged, not the one holding most of it (Opus m5-1: a fit in a task in a task is charged the outer, 8, not the inner's 4; Codex's six fits on the edge of a 40 ms task of 39, their measures 0.15 ms late, were charged the 0.2 ms task after it, 7.6 ms in all, and are now charged both, 241.6, over the 200), each task once and a task with tasks in it the more of its own thread time and theirs (`heldAll`, a nesting forest). Rationale: the page's clock is coarsened, so a measure within the slack of two tasks may be either's, and charging one would undercharge whenever it is the other's. The slack holds the clocks' skew with margin: the worst skew seen between a fit's measure and its task was 0.17 ms, against 0.25 ms of slack (Opus m5-2). A fit whose measure is in doubt (the trace dropped it, or a measure of its length within 0.5 ms is as near another fit, or two are near it) is charged every task around each measure it may be (`FIT_SLACK`), every task around it on the thread's clock put from the page's (0.5 ms, the pairing's tolerance, plus `FIT_SLACK`), and its long task's task the trace holds; in none, its long task's wall, or 50 ms (each once). A measure on another thread puts no fit in doubt. (b) Every wait and every credited slice is cut to the window scored: a long task's waits and its GPU credit count only inside both the page's task and the trace's (Codex: a 1150 ms fit task in a trace task from 400 ms before it, 375 ms of GPU wait before the page's task began, was excused; now 0 and it fails), and a long task's window outside the trace's task is charged whole as thread time (300 ms, a task of 240 and 20 of thread time: 80). (c) `waitedIn(..., 'least')` always holds the window scored as a slice of the family, its thread time the caller's required `cpu` (the task's or the call's), with every other timed slice on the thread (Codex: two overlapping waits of 100 us of thread time each, in a window of 200, were credited 900; now 800). (d) Begin/end events pair by name, last in, first out per thread: an end of another name than the open begin's, an end with none open, and a begin never ended are each a wait from the trace's first instant to the end, or from the begin to its last instant, are never a GPU credit, and are logged (`unpaired`; Codex: a B/E wait closed by an end of another name scored 4 ms in a 20 ms resize, a lone end 2; now 20). (e) A seeded property test, 2000 traces cut in 10 us cells of thread time, GPU wait, other wait or none, with tasks side by side, nested and within the slack, calls, waits as X and as B/E split, nested and overlapping, thread time dropped, B/E noise, measures off by up to 0.25 ms at each end and fits' measures dropped, asserts that each resize, long task and the fits' total is never charged less than the truth. It found the doubt fits of (a). (f) Data, with `fitCpuTotal` off (diag 1c11e0bf; Windows 46006162810, ubuntu 46006172278, macOS 46006182935; 24 drags each, 72 in all, every one passing every other rule): the fits' thread time in all was at most 42.3 ms on Windows (median 32.2), 27.5 on ubuntu (18.7) and 64.7 on macOS (26.1), and no fit was in no task the trace holds, so `fitCpuTotal` stays 200 ms, about 3 times the worst; the fits' tasks on the wall were at most 400 ms on Windows, 734 on ubuntu and 2548 on macOS, under `fitCeiling` (2000, 2000, 8000). The trace left begins unpaired in 14 Windows drags, 3 ubuntu and 2 macOS, every one a begin never ended (a task, its frame and its call open when the trace stopped, as `ThreadController active`, `RunTask`, `BeginMainFrame`, `FireAnimationFrame` and `FunctionCall` at one instant); no end of another name and no lone end. They are charged as waits to the trace's last instant and broke no rule. (g) Tests: 54 unit tests, Codex's (a) to (d) and Opus m5-1 each a named test with the old value in its name or comment; 100% of dragTrace.ts covered; 129 unit mutants of the guards, every one fails a test, none equivalent. The e2e mutants are in the report. **After the Round 6 reviews (2026-11-27), (a) to (i) approved 2026-11-28 (controller)**, replacing the rules above where they differ. The rule: only a trace the drag can show is whole is trusted; else the drag fails closed, or the span is charged as one the trace does not hold. (a) A whole trace. A trace that lost events (`Tracing.tracingComplete`'s `dataLossOccurred`) fails the drag (`events lost`): it may have dropped any task or wait. A task counts as one the trace holds only if it lies wholly inside the page's marker (see (b) below) and the trace leaves it neither begun nor ended alone (`open`): a task cut at the trace's edge holds only its part inside the trace, so a fit in it was charged that part (Opus m6-2; a fit in a task the trace stopped in, 10 ms of it inside, is now charged 50, or its long task's score, 60). The fits in a long task are charged at least what that long task scores (`tasks`: its task's thread time and the part of its window outside the task, whole; Codex: a long task [4000,4200] whose task the trace holds to 4150 with 125 ms of thread time, and the fit's measure in another task of 25, was charged 25 though the long task scored 175; now 175), each long task once, and a fit in none the trace holds whole its long task's score, or 50 ms. (b) The page's thread is the one that names the page's marker, not the one the resizes' vote picks: the e2e names two measures of its own, `<marker>:from` from an instant just after the trace starts to the same instant and `<marker>:to` from that instant to the drag's end, the marker a name made for that drag alone (time and random, `world-drag-...`). Each must be in the trace once, both on one thread and from the same instant (within 50 us); else no thread is the page's, every span is timed on the wall and the drag fails (`the marker held`). Only work inside the marker counts as traced. Codex's second renderer with the page's resize cadence 333 ms earlier, which won the vote 10 to 9 when one of the page's measures was dropped (13 charged against 241), is a named test: the marker picks the page's thread, and the other's spans are on another. (c) Skew. When the resizes paired disagree on the offset by more than `FIT_SLACK` / 2 (0.125 ms; `spread`), every fit is in doubt and charged as Round 5 (a) charges a fit in doubt (Opus m6-1: the six fits of Codex's (a), their measures 0.26 ms past the 40 ms task's end and 0.30 past the 0.2 ms task's start, are charged 7.6 at a spread of 0.12 and 241.6 at 0.13, over the 200). The limit, stated: the spread sees drift between the page's numbers and the trace's measures, and in the e2e that drift is nil, as the e2e reads the page's numbers from the very measures the trace logs (`performance.getEntriesByName`), so each of the trace's measures is the page's number plus one offset (the logged spread is 0.00 ms in every drag on every OS). The skew that matters, between a measure and the task that holds it (worst seen 0.17 ms), is held only by `FIT_SLACK` (0.25 ms): a fit's measure further than that from its task, on clocks the resizes show steady, is not seen, and Round 5 (a)'s rationale holds only under that precondition. A test pins the limit (spread 0.12, the fits charged 7.6). (d) An end of no name (the JSON trace format lets an end leave it out) closes the begin open last on its thread; an end named, but not as that begin, still fails closed as Round 5 (d) says (Codex: a B/E scope of 1 ms closed by an unnamed end at +18 ms in a 20 ms resize of 2 ms of thread time scored 20; now 2). (e) A dropped outer record. A trace that holds an inner slice and not the task around it cannot show it: nothing left in it differs from a task that is only that slice, so no scorer can see it. Its causes are covered: a buffer overrun sets `dataLossOccurred` and fails the drag (a); a record cut where the trace began or stopped lies across the marker's edge, as each of the marker's measures is named in a page task of its own after the trace starts and before it stops, so the cut task is outside the marker or left open, and is no task the trace holds (a). Not covered: a record the tracer drops mid-trace with no loss flagged (every category recorded at the outer level is in the trace's categories; the macOS drops of 1 or 2 of 40 resizes, soak 45933131129, came before the check read `dataLossOccurred`, so whether the trace flagged them is not known; since it reads the flag, the evidence is the c665b301 soak, 6 drags with 40 of 40 resizes and no loss, and the mutant runs), the outer task of a fit under 50 ms (no long task, so no floor from its window): a fit in a 40 ms task of which the trace holds only a nested 1 ms task is charged 1 (with no task around it at all it is charged 50). (f) Ruling, the slack's boundary overcharge (Codex minor): it stays, a trade-off. A fit whose measure lies within `FIT_SLACK` of the task after its own is charged both (six 0.5 ms fits in the last 0.25 ms of 1 ms tasks, each followed by a 35 ms task: 220 against 10), as the coarsened clock cannot say which task the measure is in, and charging one would undercharge whenever it is the other's. It can fail only the fits' total in all (200 ms), and no soak came near it (worst 64.7 ms, Round 5 (f)). (g) The property test, 4000 seeded traces: of every eight, four as Round 5 (e), and one each that loses a tenth of its events (the drag must fail), is cut at both edges (a lone end where it begins, a begin never ended where it stops, the page's marker inside), holds a second renderer (the page's measures 333 ms earlier on another process, its thread named as the page's; in one of four the marker too, and then no thread is the page's), or has the page's numbers apart from the trace's by up to 0.15 ms and its fits' measures up to 0.4 ms from their work (the spread must exceed 0.125). It asserts that nothing is charged less than the truth, or the drag fails closed. Its first runs failed on traces the e2e cannot make, not on the scorer: the page named spans outside its marker (the e2e names only the drag's, inside it), and resizes under 1 ms apart paired with each other's spans when skewed (the page's resizes are frames apart); the generator now makes neither. (h) Tests: 62 unit tests, each of Codex's and Opus's Round 6 cases a named test with the old value in its name or comment; 100% of dragTrace.ts covered; 155 unit mutants of the guards, every one fails a test but one dropped as equivalent: a spread of NaN settling every fit, as a spread of NaN means no resize paired, and then no fit has a measure near it to be sure of (the code now says so); the first run's three other survivors are tests now (a fit whose measure the trace dropped, at its long task's end, charged the task past the window too, 80 not 61; the marker's start or its span alone twice). The e2e mutants are in the report. (i) The first CI runs at 566a4e30 failed every drag at the marker (0 from, 1 to): Chromium 148 and Electron 43 trace a measure of no length, as the marker's `:from` is, as one async instant (`ph: 'n'`), not a begin and an end, and the scorer read only begins, ends and complete events. A Playwright probe on Chromium 148.0.7778.96 showed it: a zero-length measure traced as `n`, one of 1 us as `b`/`e`, both even when named straight after `Tracing.start` returns, so the trace had not started late. The scorer now reads an instant as a span of no length; the unit fixture writes `:from` the way Chromium does, and a test keeps the begin-and-end form holding too. Unit mutants: 159, 158 fail a test, the equivalent the same as in (h); the 4 new ones (the instant dropped, unhandled, on another thread, 0.06 ms late) fail 46 tests or more. Every e2e run at 566a4e30 failed on the marker and none of them counts; the soak and the e2e mutants were run again on the fix. **After the Round 7 reviews (2026-11-27), PENDING SIGN-OFF.** (j) A long task the trace holds is a fit's by the trace, not by the page's 1 ms. The page tags a long task as a fit's when a fit's measure lies within 1 ms of it, and the scorer used the same 1 ms, so a long task that ended just before a fit's task was judged as the fit's (Codex/Opus Round 7: a task over [3000, 3400], 4 ms of thread time and 395 ms waiting on the GPU, then a fit measured at 3400.4 in a task of its own, passed at 4 ms own and 9 after the GPU's credit; it is a 400 ms stall, now charged 399 own and 400 wall and failing both limits for the other long tasks). When the trace holds the long task (its task, the one that covers more than half of its window, inside the marker), it is a fit's only if a fit's measure in the trace, paired with the fit within the 0.5 ms window, lies inside that task to `FIT_SLACK` (0.25 ms); the page's 1 ms is kept only for a long task the trace does not hold, and only for a fit whose measure the trace holds so paired. The e2e's own 1 ms is not shrunk: it stays the page's view, and the e2e logs each long task the trace tags otherwise (`retagged`) and, for each drag, the worst a fit's measure lies outside every task the trace holds (`fitSkew`). The residual, stated: a fit's measure that starts within 0.25 ms after the end of a long task the trace holds still tags that task as the fit's (a test pins it: 0.2 ms after, tagged; 0.26 ms, not), the same coarsened clock as (f). Round 9 (Codex; approved 2026-11-28, controller, A2.1 R9): the page's number is never put on the trace's clock to tag a long task. A fit whose measure the trace dropped, or holds outside the 0.5 ms window it is paired in, gives no long task a fit's tag, so its long task is judged by the limits for the other long tasks (it is still charged to the fits too), and the e2e logs, per drag, the long tasks the page tags a fit's for such a fit (`withheld`, each with its reason, "dropped" or "unmatched") and how many fits are of each kind (`unmeasured`). Round 8 had put the page's number there on a clock the resizes showed settled, and Codex's probes let a 400 ms stall pass by it: a spread of exactly 0.125 ms with a 0.010 ms fit 0.350 ms after the stall; one resize pair, a spread of 0; and a resize 0.625 ms off that the window left out of the spread, with the fit's own measure as far off, outside the window and taken as dropped. The clock is now settled (which only decides whether a fit's measure is sure of its task, for its charge) only when every resize the page named is paired, at least two, agreeing to `FIT_SLACK` / 2 (0.125 ms): a resize left out of the window counts as drift, and one pair alone is never settled. Named unit tests give each of Codex's three cases, (c) with the fit's real measure too, failing the drag on the stall, and a fit traced and paired inside the stall's task still the fit's on each of those clocks. (k) The resize budget against a runner's stall, PENDING SIGN-OFF: main's drag check still holds the renderer's `resizeWorstMs` under 16 ms, and that is the page's `performance.now()` around the resize observer's call, its wall, so a runner that takes the CPU from the page inside one resize fails it (GROUPCAP's Windows soak 46132196302: one resize 23.3 ms, the retry 8.3 ms, a rerun 46135534740 clean, on a runner with long tasks up to 568 ms in the drag). That is the machine, not the code: in the A2.1 soaks of Round 7 and 8 (36 drags, 1440 resizes: Windows 46111108327, 46111163097, 46113047374, 46123513776; ubuntu 46111116633, 46111169751, 46113052797, 46123553693; macOS 46111124399, 46111179771, 46113058296, 46123584002) the worst resize per drag on the wall reached 27.6 ms (macOS 46113058296) and 15.8 ms (Windows 46113047374) with 1.8 and 0.7 ms of their own on the thread's clock, the median drag's worst was 1.6 ms, the second worst in any drag at most 11.9 ms, and no resize ran over 5.6 ms of its own (the one 5.6 ms own held a frame's work, 41.2 ms of BeginMainFrame around it). Main's rule would have failed one of the 36 drags (27.6 ms), as it failed GROUPCAP's. A2.1 already replaces it with the rule above, which this keeps unchanged: each resize under 16 ms of its own (thread time and the waits the trace names; worst seen 5.6 ms, about 3x under) and under 50 ms on the wall, for a wait the trace does not name (worst seen 27.6 ms, about 1.8x under), so a runner's stall inside one resize passes unless it outlasts 50 ms, and a resize that is slow by its own work fails at 16 ms as before. No median or second-worst rule is needed: the stall shows on the wall and not in the thread's own time. The repro is a named unit test, with the measure 0.4 ms after (fails both limits), 0.2 and 0.26 ms after, a dropped measure, and the page's 1 ms on a task the trace does not hold.

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
