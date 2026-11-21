# Launch Intro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Termpolis first starts, a two-second overlay plays over the app shell, and the app keeps starting underneath the whole time. It shows the Termpolis logo, TERMPOLIS and "City of Terminals". It then crossfades to LUMOPOLIS, revealed letter by letter over the cyan → white → amber rule, with "City of Enlightenment", and fades out. All lettering is artwork rendered from the film's own title-card styles.

**Architecture:**
- A Python Playwright script renders the lettering once, on Windows, from the film's card CSS. The output is transparent PNGs at 1x and 2x plus a `manifest.json` of letter positions, committed under `src/renderer/src/assets/intro/`.
- Main decides once per process whether the intro may play (`src/main/launchIntro.ts`). Preload reads that decision synchronously so the overlay is in the very first paint.
- The renderer's `LaunchIntro` component lays the artwork out and animates it with the Web Animations API on a fixed 2.0 s timeline (`src/renderer/src/lib/launchIntro.ts`). It never takes focus or events.

**Tech Stack:** Electron 43 (main, preload, sendSync IPC), React 18 and Tailwind (renderer), Web Animations API, Vitest 4 (node and jsdom), Playwright 1.58 e2e, and the global Windows `python` (Playwright 1.60 + Chromium) for the render script only.

**Spec:** `docs/superpowers/specs/2026-11-20-launch-intro-design.md` (binding). The look comes from `C:\Users\DavidEngelhart\OneDrive - MSI\Documents\Work\Termpolis\Supporting files\Lumopolis film build\cards.html`; the values are pinned below so the build does not depend on that file.

## Global Constraints

- The renderer is ES2020: no `.at()` and no other post-ES2020 built-ins.
- Coverage is 100% on lines, functions, branches and statements for `src/main/launchIntro.ts`, `src/renderer/src/lib/launchIntro.ts` and `src/renderer/src/components/LaunchIntro/**`. Add them to `vitest.config.ts` thresholds.
  - The repo gates stay at lines 97 / functions 96 / branches 95 / statements 96 and are never lowered.
- TDD on every task.
- `tsc` (node and web) and `eslint` must be clean before every commit.
- e2e runs locally with the `tw3.sh`/`tw4.sh` swap, restored before the commit.
- Never commit `postcss.config.js`, `src/renderer/src/index.css`, `tailwind.config.js` or `film-bugs-report.md`.
- Commits:
  - go straight to `main`, with the subject `termpolis: <plain sentence>`;
  - are staged by explicit path;
  - use `git commit -F <file>`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - start with `git pull --rebase --autostash`;
  - are never force-pushed.
- Never run `npm install`, and add no dependencies: no Pillow, no pixelmatch, no font packages.
- Keep the `endpointActivityGuard` and installer-update CI gates. Add no MCP tools.
- CI must be green on Windows, macOS and Linux.
- Test-only hooks stay inert unless `NODE_ENV === 'test'`.
- Spec values, verbatim:
  - hard maximum **2.0 s** from first paint to fully gone, fade included;
  - the intro never waits on startup work;
  - it plays only on the first start of the process, on the first window;
  - it does not play on a renderer reload, an extra window, an update restart, or e2e unless a test asks;
  - any key or click ends it at once, and the key still reaches the app;
  - the setting is "Show launch intro", on by default;
  - with `prefers-reduced-motion` there is no reveal or movement, only plain fades within the same 2 s.
- Film values, pinned from `cards.html`:
  - stage background `#03050b`, with vignette `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.65) 100%)`;
  - wordmark `.mark`: `font-family: "Segoe UI Variable Display","Aptos","Segoe UI",sans-serif; font-weight: 300; font-size: 150px; letter-spacing: 34px; padding-left: 34px; color: #fff; text-shadow: 0 0 18px rgba(95,227,255,.55), 0 0 60px rgba(95,227,255,.35), 0 0 140px rgba(169,139,255,.25)`, with each letter an `inline-block` span;
  - rule `.rule`: `height: 2px; margin: 34px auto 30px; background: linear-gradient(90deg, transparent, #5fe3ff, #fff, #ffb45a, transparent); box-shadow: 0 0 18px #5fe3ff`, final width `min(900px, 80vw)`;
  - byline `.tag`: `font-family: Georgia, serif; font-style: italic; font-size: 48px; color: #d9e3f3`;
  - letter reveal per letter: opacity 0 → 1, `blur(14px)` → `blur(0)`, `translateY(18px)` → `0`, smoothstep easing (`cubic-bezier(.45,0,.55,1)` approximates `x*x*(3-2*x)`).
- Wording is the spec's, not the film's. The film's tagline is "The city of enlightenment between human and AI."; the intro uses "City of Enlightenment" and "City of Terminals".

**Command shorthands:**
- **V:** `unset PROMPT_COMMAND TERMPOLIS_LIMIT_CHOOSER && export PATH="/c/Program Files/Git/cmd:$PATH" && npx vitest run <files>`
- **COV:** V plus `--coverage --coverage.include=<file>`. Expect 100/100/100/100.
- **TSC:** `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false`
- **LINT:** `npx eslint <files>`
- **E2E:** `npx electron-vite build`, then `TERMPOLIS_E2E_PREBUILT=1 npx playwright test <spec>`.

## Review Focus

1. **A key pressed during the intro** (a letter, Enter, Ctrl+C) reaches the focused terminal exactly once: not swallowed and not doubled, and focus never moves to the overlay. Tests in Task 3 and Task 5.
2. **A first paint that comes late, or never because the window starts hidden or minimised:** the overlay is still gone 2.0 s after it first painted. If it has not painted within 1 s of mount, it never appears, so a window restored minutes later shows no stale intro. Test in Task 3.
3. **A small, very wide, very tall or high-DPI window** (800×600, 3440×1440, 900×1600 portrait, scale 100%, 150% or 250%) shows the artwork whole, centred and inside 90% of the width. The 2x images are used when `devicePixelRatio > 1`. Test in Task 3.
4. **An unreadable, garbage or unwritable `last-run-version` file**, or a read-only userData folder, never throws in main. Garbage counts as "no previous version". A failed write still answers the renderer. Test in Task 2.
5. **`localStorage` throwing** (blocked storage), or holding an unexpected value, reads as "on" and never crashes the Settings pane or the overlay. Test in Task 4.

---

### Task 1: Render the film lettering as committed artwork

**Files:**
- Create: `src/renderer/src/assets/intro/render_intro.py`. It uses the global `python` (Playwright 1.60 + Chromium); never use the Memex venv.
- Create (generated by the script, then committed):
  - `src/renderer/src/assets/intro/termpolis-mark@1x.png` and `@2x.png`;
  - `termpolis-tag@1x.png` and `@2x.png`;
  - `lumopolis-tag@1x.png` and `@2x.png`;
  - `lumopolis-0@1x.png` … `lumopolis-8@2x.png` (one per letter of LUMOPOLIS);
  - `manifest.json`.
- Create: `src/renderer/src/assets/intro/introManifest.ts` (typed import of the manifest)
- Test: `tests/renderer/launchIntro/introAssets.test.ts`

**Interfaces:**
- Produces:
  - `manifest.json` shape: `{ stage: { width: 1920, height: 1080 }, pad: number, images: { termpolisMark: Img; termpolisTag: Img; lumopolisTag: Img; letters: Img[] }, letterOffsets: number[], ruleTop: number }`.
    - `Img = { file1x: string; file2x: string; width: number; height: number }`, sizes in CSS px at 1x and including the glow padding.
    - `letterOffsets` holds each letter's left edge, in CSS px, relative to the first letter, measured with `getBoundingClientRect` in the page.
  - `export interface IntroImg { src1x: string; src2x: string; width: number; height: number }`
  - `export const INTRO_ART: { pad: number; termpolisMark: IntroImg; termpolisTag: IntroImg; lumopolisTag: IntroImg; letters: IntroImg[]; letterOffsets: number[] }` in `introManifest.ts`. It resolves files through Vite `new URL('./<file>', import.meta.url).href`, written out per file so Vite bundles each one.

- [ ] **Step 1: Write the failing test.** In `introAssets.test.ts` (node environment):
  - Every file named in `manifest.json` exists.
  - Each PNG's IHDR width and height (read from bytes 16–23) equal the manifest's 1x size, and exactly double it for 2x.
  - There are 9 letters, and `letterOffsets` has 9 entries that strictly increase.
  - The colour type is 6 (RGBA, transparent).
  - The total size of all intro PNGs is at most 4 MB.

- [ ] **Step 2: Run it and watch it fail.** Run V with `tests/renderer/launchIntro/introAssets.test.ts`. Expected: FAIL, because `manifest.json` is missing.

- [ ] **Step 3: Implement `render_intro.py`, then run it.**
  - The script writes one HTML page holding the pinned film CSS (Global Constraints).
  - Each element (TERMPOLIS mark, "City of Terminals", each LUMOPOLIS letter span, "City of Enlightenment") goes inside a wrapper with `padding: 160px`, so the 140 px glow is never clipped.
  - For each scale (`device_scale_factor` 1 and 2) it takes `locator.screenshot(omit_background=True)` of each wrapper, writes the PNGs and writes `manifest.json`.
  - Before rendering it asserts `document.fonts.check('300 150px "Segoe UI Variable Display"')` and exits non-zero otherwise, so a fallback font is never baked in.
  - The rule is not rendered: it is a CSS gradient in the component.
  - Run: `python src/renderer/src/assets/intro/render_intro.py`.

- [ ] **Step 4: Run the test and make sure it passes.** Run V on `introAssets.test.ts`, then TSC and LINT. Open `termpolis-mark@2x.png` and `lumopolis-0@2x.png` with the Read tool and check visually that the glow and the weight-300 lettering match the film.

- [ ] **Step 5: Commit.** Stage the script, `manifest.json`, `introManifest.ts`, all PNGs and the test. Subject: `termpolis: the launch intro's lettering, rendered from the film's own title cards`. The body states that the PNGs are rendered output and no font file is shipped.

---

### Task 2: Main decides once whether the intro may play

**Files:**
- Create: `src/main/launchIntro.ts`
- Modify: `src/main/index.ts`, next to `app:get-version` (line 1518). Register `ipcMain.on('launch-intro:should-play', e => { e.returnValue = introGate.claim() })`.
- Modify: `src/preload/index.ts`. Add `launchIntro: ipcRenderer.sendSync('launch-intro:should-play') === true`, evaluated once when the preload runs. Type it in `src/renderer/src/types/index.ts` as `readonly launchIntro: boolean`.
- Test: `tests/electron/launchIntro.test.ts`, `tests/electron/preload.test.ts`

**Interfaces:**
- Produces:
  - `export const LAST_RUN_FILE = 'last-run-version'`
  - `export interface IntroGateDeps { userData: string; version: string; env: NodeJS.ProcessEnv; readFile(p: string): string; writeFile(p: string, text: string): void }`
  - `export function createIntroGate(deps: IntroGateDeps): { claim(): boolean }`
    - `claim()` returns true at most once per process.
    - It returns false when `last-run-version` holds a version that is not the current one (an update restart).
    - It returns false under `NODE_ENV === 'test'` unless `TERMPOLIS_TEST_LAUNCH_INTRO === '1'`.
    - It writes the current version on its first call, whatever the answer.
  - The renderer reads `window.termpolis.launchIntro`.

- [ ] **Step 1: Write the failing tests.**
  - `it('plays on the first claim of a normal start and never again in the same process')`: `claim()` gives true, then false and false (a reload, then a second macOS window).
  - `it('skips the start after an update')`: the file holds `'1.63.0'` and the version is `'1.64.0'`, so false; the file is then rewritten to `'1.64.0'`.
  - `it('plays when the file is missing, and when it holds the same version')`.
  - Review Focus 4:
    - `readFile` throwing, or returning `'\u0000garbage'`, counts as missing (true);
    - `writeFile` throwing still returns the answer and does not throw.
  - `it('stays off in e2e unless the test asks')`: `NODE_ENV=test` gives false; adding `TERMPOLIS_TEST_LAUNCH_INTRO=1` gives true.
  - Preload: `launchIntro` is `true` when `sendSync` returns true, and `false` for any other return.

- [ ] **Step 2: Run them and watch them fail.** Run V on both files. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `createIntroGate`.** It trims what it reads and accepts only `/^\d+\.\d+\.\d+([-.+][\w.]+)?$/`; anything else counts as missing. Wire it in `index.ts` with `fs.readFileSync`/`writeFileSync` (both are tiny one-time calls, made before the window loads) and `app.getVersion()`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/main/launchIntro.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `termpolis: the launch intro plays only on a real first start, never on a reload, a second window or an update restart`.

---

### Task 3: The intro overlay and its two-second timeline

**Files:**
- Create: `src/renderer/src/lib/launchIntro.ts`
- Create: `src/renderer/src/components/LaunchIntro/LaunchIntro.tsx`
- Modify: `src/renderer/src/App.tsx`. Render `<LaunchIntro />` as the last child of App's top-level element, so nothing in startup waits on it.
- Modify: `vitest.config.ts` (coverage thresholds for the three intro paths)
- Test: `tests/renderer/launchIntro/launchIntro.test.ts`, `tests/renderer/launchIntro/LaunchIntro.test.tsx`

**Interfaces:**
- Consumes: `INTRO_ART` (Task 1), `window.termpolis.launchIntro` (Task 2) and `introEnabled()` (Task 4; until then the component treats the setting as on).
- Produces:
  - `export const INTRO_TOTAL_MS = 2000`
  - `export const INTRO_TIMELINE`, in ms from first paint:
    - `{ fadeIn: [0, 150], termpolisHold: [150, 800], crossfade: [800, 1050], letters: { start: 1050, stagger: 40, each: 300 }, rule: [1100, 1500], tag: [1300, 1600], fadeOut: [1700, 2000] }`
    - The last letter ends at 1050 + 8×40 + 300 = 1670, inside 2000.
    - These values are the builder's split that the spec leaves open; they are pinned here.
  - `export interface IntroStep { target: 'stage' | 'termpolis' | 'lumopolis' | 'letter' | 'rule' | 'tag'; index?: number; keyframes: Keyframe[]; delay: number; duration: number }`
  - `export function introSteps(reduced: boolean): IntroStep[]`. With `reduced`, every step's keyframes are opacity only (no `filter`, no `transform`, no rule width growth).
  - `export function introScale(viewport: { width: number; height: number }): number` returns `Math.min(1, (viewport.width * 0.9) / 1920, (viewport.height * 0.9) / 1080)`.
  - `export const NOT_PAINTED_MS = 1000`
  - `export function LaunchIntro(props: { play?: boolean; reducedMotion?: boolean; now?: () => number }): JSX.Element | null`
    - The root is `data-testid="launch-intro"`, `aria-hidden="true"`, with `pointer-events: none`, `position: fixed; inset: 0; z-index: 9999`, the stage background and the vignette.
    - The cards are `data-testid="launch-intro-termpolis"` (the logo `src/renderer/public/logo-termpolis.svg`, then the mark and the tag) and `data-testid="launch-intro-lumopolis"`.
    - Images use `srcSet="<1x> 1x, <2x> 2x"`.

- [ ] **Step 1: Write the failing tests.** In `launchIntro.test.ts`:
  - `it('every step ends by 2000 ms')`: `max(delay + duration) <= INTRO_TOTAL_MS` for both `introSteps(false)` and `introSteps(true)`.
  - `it('reduced motion has no filter or transform keyframes')`.
  - `it('the letters reveal in order with the film's blur and rise')`: letter `i` has delay `1050 + 40*i`; its first keyframe has `filter: 'blur(14px)'` and `transform: 'translateY(18px)'`.
  - Review Focus 3: `introScale` at 800×600, 3440×1440, 900×1600 and 1920×1080 keeps `1920*scale <= 0.9*width` and `1080*scale <= 0.9*height`, and is never above 1.

  In `LaunchIntro.test.tsx` (jsdom, with `Element.prototype.animate` stubbed to record calls and return a fake Animation):
  - It renders nothing when `play` is false.
  - When playing, it calls `animate` once per step after the first `requestAnimationFrame`.
  - It removes itself at 2000 ms after first paint, using fake timers.
  - Review Focus 1:
    - a `keydown` on `window` removes it at once, with `defaultPrevented === false` and the event still reaching a listener on a focused textarea underneath (exactly one call);
    - a `pointerdown` removes it;
    - it never calls `focus()` and has no `tabIndex`.
  - Review Focus 2: with `requestAnimationFrame` never firing for 1000 ms it renders nothing and never animates.
  - The 2x source appears in `srcSet`.

- [ ] **Step 2: Run them and watch them fail.** Run V on both files. Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement it.**
  - Listeners go on `window` with `{ capture: true, passive: true }` and never stop or prevent the event.
  - The removal timer starts at first paint, with `setTimeout(INTRO_TOTAL_MS)`.
  - `reducedMotion` defaults to `matchMedia('(prefers-reduced-motion: reduce)').matches`.
  - `play` defaults to `window.termpolis.launchIntro && introEnabled()`.
  - The letters are laid out absolutely from `letterOffsets`, minus `pad`, so the 160 px glow padding overlaps the way the film's inline spans do.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/renderer/src/lib/launchIntro.ts` and `src/renderer/src/components/LaunchIntro/LaunchIntro.tsx`, V on the App test file that renders `<App />`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `termpolis: a two-second launch intro over the starting app, ended by any key or click`.

---

### Task 4: The "Show launch intro" setting

**Files:**
- Modify: `src/renderer/src/lib/launchIntro.ts` (add the setting functions)
- Modify: `src/renderer/src/components/SettingsPane/SettingsPane.tsx`. Add a block right after the Terminal Defaults block that ends after line 357's `div`, in the General tab. The spec says "with the other appearance settings", but there is no Appearance section; General is where theme and font defaults live.
- Test: `tests/renderer/launchIntro/launchIntro.test.ts`, `tests/components/SettingsPane.test.tsx`

**Interfaces:**
- Produces:
  - `export const INTRO_SETTING_KEY = 'termpolis.launchIntro'`
  - `export function introEnabled(storage?: Pick<Storage, 'getItem'>): boolean` is false only when the stored value is exactly `'0'`.
  - `export function setIntroEnabled(on: boolean, storage?: Pick<Storage, 'setItem'>): void`
  - The setting is a checkbox `data-testid="settings-launch-intro"` labelled `Show launch intro`, with the hint `Plays for two seconds when Termpolis starts.`

- [ ] **Step 1: Write the failing tests.**
  - `introEnabled` gives true for `null` and true for `'1'`, false for `'0'`.
  - Review Focus 5: `introEnabled` gives true when `getItem` throws, and true for `'yes'`; `setIntroEnabled` swallows a throwing `setItem`.
  - SettingsPane: the General tab shows the checkbox, checked by default. Unchecking writes `'0'`, and the checkbox re-renders unchecked after a remount.

- [ ] **Step 2: Run them and watch them fail.** Run V on both files. Expected: FAIL.

- [ ] **Step 3: Implement it.** Wrap every storage call in try/catch. Style the block like Terminal Defaults' bordered box.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/renderer/src/lib/launchIntro.ts`, V on both SettingsPane test files, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `termpolis: a setting to turn the launch intro off`.

---

### Task 5: Real-app e2e and screenshot comparison on all three platforms

**Files:**
- Create: `e2e/launch-intro.spec.ts`
- Create: `e2e/launch-intro.spec.ts-snapshots/launch-intro-termpolis.png` and `launch-intro-lumopolis.png`. These are the reference frames, shared by all platforms.
- Modify: `.github/workflows/test.yml`, adding `npx playwright test e2e/launch-intro.spec.ts` to the explicit `e2e-smoke-macos` list next to line 534. `e2e-full` (Linux) and `e2e-windows` run the whole directory.

**Interfaces:**
- Consumes: `TERMPOLIS_TEST_LAUNCH_INTRO=1` (Task 2), the test ids from Tasks 3 and 4, and the existing e2e launch helper that the other specs use.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests.** In `e2e/launch-intro.spec.ts`, launch with `TERMPOLIS_TEST_LAUNCH_INTRO=1` and a fixed window size of 1280×720.
  - `it('shows on launch and is gone by 2.0 s after it first paints')`:
    - `launch-intro` becomes visible;
    - record `performance.now()` when it is first visible;
    - wait for detach;
    - the elapsed time is ≤ 2000 ms plus 250 ms of test slack.
  - Review Focus 1: `it('typing during the intro lands in the terminal once')`. While the intro is visible, type `echo intro-ok` and Enter. The terminal output then contains `intro-ok` exactly once as a command result.
  - `it('a reload does not play it again')`: after the first run, `page.reload()` and `launch-intro` never appears within 1500 ms.
  - `it('does not show when the setting is off')`: set the setting in Settings, relaunch with the same userData, and it never appears.
  - `it('does not show in e2e without the test switch')`: launch without the variable, and it never appears.
  - Screenshots:
    - set `test.info().snapshotSuffix = ''` so every platform compares against the one reference;
    - pause all animations with `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t })` at `t = 600` (the Termpolis card) and `t = 1690` (the Lumopolis card, all letters in);
    - `expect(await page.getByTestId('launch-intro').screenshot()).toMatchSnapshot('launch-intro-<card>.png', { maxDiffPixelRatio: 0.02 })`.

- [ ] **Step 2: Run them and watch them fail.** Run E2E with `e2e/launch-intro.spec.ts` (with the tw3/tw4 swap, restored afterwards). Expected: FAIL on the missing reference frames. Then run once with `--update-snapshots` on Windows to create them, and check them visually with the Read tool against the film cards.

- [ ] **Step 3: Implement the fixes.** Change only the wiring, never the assertions. Add the macOS CI line.

- [ ] **Step 4: Run them and make sure they pass.**
  - E2E locally.
  - Push, and confirm `e2e-full`, `e2e-windows` and `e2e-smoke-macos` are green with `gh run view --json conclusion`. Their passing screenshot comparisons against the Windows-made references prove the spec's "same on every platform".

- [ ] **Step 5: Commit.** Stage the spec, both reference PNGs and `.github/workflows/test.yml`. Subject: `termpolis: the launch intro is checked in the real app on Windows, macOS and Linux`.

---

## Self-review

- **Spec coverage:**

  | Spec requirement | Task |
  |---|---|
  | Sequence and look | 1, 3 |
  | Same on every platform (pre-rendered artwork, script committed, no font shipped) | 1, 5 |
  | 2.0 s hard maximum, never waiting on startup | 3, 5 |
  | When it plays | 2 |
  | Skipping and key pass-through | 3, 5 |
  | Setting | 4 |
  | Reduced motion | 3 |
  | Unit tests | 2–4 |
  | e2e | 5 |
  | Screenshot comparison on three OSes | 5 |
  | Left to the builder: time split, format and scales, mount point | 3, 1, 3 |

- **Step scan:** every step names its file, signature, values or command.
- **Types:** `INTRO_ART`, `IntroImg`, `INTRO_TIMELINE`, `introSteps`, `introScale`, `introEnabled` and `createIntroGate().claim` are used the same way across tasks.
- **Review Focus:** tests are in Tasks 3 and 5, 3, 3, 2 and 4.
- **Proportion:** the plan holds signatures, tests and pinned values only.
