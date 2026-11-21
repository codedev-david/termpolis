# Task 5 report

Commit 45055075 `termpolis: the launch intro is checked in the real app on Windows, macOS and Linux` (not pushed).

## Built
- `e2e/launch-intro.spec.ts`: 7 tests (timing, typing during intro, reload, setting off via real click + relaunch with same userData, no test switch, two card frames).
- `e2e/launch-intro.spec.ts-snapshots/launch-intro-{termpolis,lumopolis}.png` (1280x720, shared, `snapshotSuffix=''`).
- `.github/workflows/test.yml`: macOS smoke line for the spec.
- **A real bug found and fixed in main** (`src/main/index.ts`): the preload also runs in the window's initial empty document; that call used up `introGate.claim()`, so the real page got `false` and the intro never played in the real app (all visibility tests were RED for this reason). The handler now answers `false` without claiming when `e.sender.getURL() === ''`. Unit test updated, plus one new test (`tests/electron/mainIpcTerminal.test.ts`, 148 pass).

## RED
- First run: 6 of 7 failed (the intro never appeared; the setting test also failed to click Settings behind the onboarding modal). After the main fix: 4 passed, 3 failed (setting test; both snapshots "doesn't exist, writing actual").
- Wiring changes only, no assertion weakened: viewport set with `page.setViewportSize(1280x720)` (setContentSize gave 1282x723 and DPR 1.14, so frames were 1461x824); `dismissOnboarding` before opening Settings; screenshot is a 1280x720 page clip with `scale:'css'` (the overlay is the whole viewport) rather than the element screenshot.

## GREEN
- `--update-snapshots`: 7 passed (1.1 min). Then `--repeat-each=2 --retries=0`: 14 passed (2.1 min). Per test: timing 6.8s, typing 8.0s, reload 9.6s, setting 16.5s, no-switch 7.8s, frames about 6s each.
- Timing measured from the stage animation's startTime to detach: under 2250 ms (and over 1000 ms).
- tsc node and web clean, eslint 0 errors (existing warnings only). Tailwind files restored, status clean. Lock released.
- `launchIntro.ts` animations already use `fill: 'both'`; no change needed.

## Visual check (Read tool, both 1280x720)
- termpolis (t=600): dark stage with soft vignette, 3-bottle logo above, TERMPOLIS thin glowing lettering centred, "City of Terminals" italic serif below. Nothing clipped, no box around the glow.
- lumopolis (t=1690): all 9 LUMOPOLIS letters evenly spaced and aligned, cyan-to-amber rule below, "City of Enlightenment" in italic serif. No misalignment or clipping.

## Concerns
- Typing test creates its shell without clicking: PTY via `window.termpolis.createTerminal` then main sends `mcp:terminal-created` (remote:true), because clicking ends the intro and there is no terminal at launch. It asserts the intro is still up when typing starts.
- Frame tests must finish within 2 s of first paint; they passed 4 of 4 runs here but could flake on slow CI runners (retries=1 in config).
- Cross-platform pixel match (Linux, macOS font and antialiasing differences, DPR) is unproven until CI; the artwork is pre-rendered, threshold 0.02.
- The main fix should be checked on a real packaged launch; the root cause was visible only in the e2e.

## Fix round 1 (base 45055075)

- **I1, frame race:** no `src/` change. The frame tests now install an init script (`freezeScript(t)`, e2e/launch-intro.spec.ts) on the context before the window exists. It wraps `setTimeout`, and the moment the overlay mounts it cancels the 2000 ms timer made just before (the removal timer) and pins every animation at `t` each frame. The page sets `__introFrozen`, and the test waits for that, not for visibility. The timing test installs no freeze and still proves the real removal.
- **Slowness proof (throwaway, removed):** a `waitForTimeout(5000)` before the screenshot, run with `-g "reference frame"`: 2 passed (14.2 s, 10.5 s), frames still matched. The delay is not in the commit.
- **M1:** `WATCH_SCRIPT` (MutationObserver in an init script) records whether the overlay was ever attached. `expectNeverShown` waits for the app shell (`button[title="Settings"]`), then INTRO_MAX_MS+250+500 ms, then reads the record. Used in reload (new document after reload), setting-off relaunch and no-switch. The timing test asserts the watcher saw the overlay, proving the injection works before the window opens.
- **M2:** `e2eLaunchArgs(label)` takes its folder from `e2eUserDataDir(label)`, a per-label map (e2e/helpers/launch.ts:31, 44-47, 52-55), so the same label gives the same userData across a relaunch. The spec's label is `<base>-<retry>`, so a retried attempt does not inherit the stored setting.
- **M3:** the `> 1000` floor is now `>= INTRO_MAX_MS - FLOOR_SLACK_MS` (400 ms, commented). A first try with 250 failed once at 1741 ms: the measure starts at the animation clock, which begins a few frames after the removal timer, so 400 is the measured-and-reasoned slack.
- **Final run** (lock + tw3-t2 / tw4-t2, build, `TERMPOLIS_E2E_PREBUILT=1 npx playwright test e2e/launch-intro.spec.ts --retries=0 --repeat-each=3`): 21 passed (3.2 min). Tailwind files restored (status shows only the spec), lock released. eslint clean; no `src/` change, so no unit run or COV needed.

## Fix round 2

Product defect fixed in `LaunchIntro.tsx`: the removal timer started at first paint but the animations started only after the re-render, effect and next frame (about 240-300 ms later in the real app), so the overlay was removed with the closing fade cut off. Fix: the playing effect sets each animation's `startTime` to the first-paint time (`paintedAt`, from `now()`), so the animation clock and the 2000 ms removal timer end together; the hard cap stays at 2000 ms from paint, and reduced motion uses the same code path. (A first attempt with `currentTime = now() - paintedAt` still measured 1700-1766 ms, because the pending start waits for a frame; `startTime` avoids that.) Comment rewritten accurately.

Unit tests (RED first): start on the paint clock with removal at 2000 ms from paint; a start delayed past the whole timeline still removes at the cap. Coverage for the intro files 100/100/100/100.

e2e: freeze hook now cancels only the most recent 2000 ms timer; `INTRO_MAX_MS` imports `INTRO_TOTAL_MS`; frame tests wait past `INTRO_MAX_MS + 250` and assert the overlay is still attached (loud coupling); timing test floor is now 2000 - 50 ms and also asserts the last opacity before removal is <= 0.1. Measured (3 runs): 2013, 2010, 2004 ms; last opacity 0, 0, 0.012. Reference PNGs unchanged. `--repeat-each=3 --retries=0`: 21 passed. tsc and eslint clean; tailwind/postcss files untouched; lock released.
