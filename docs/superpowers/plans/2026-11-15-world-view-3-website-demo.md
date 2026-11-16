# Lumopolis — Plan 3: termpolis.com Interactive Demo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public page on termpolis.com where visitors fly around the world of Termpolis itself, using the real Lumopolis engine, with cards, tech chips, tours, layers, themes and a scripted Ask bar. It goes live on the day 2.0 ships.

**Architecture:** The page hosts the **same framework-free engine bundle** the app uses (Plan 1, Task 11 produces `world-viewer.js`), so there is one renderer and three hosts: the app pane, this page, and the 2.x export. The page supplies a hand-curated `WorldDoc` for Termpolis, checked against the code, plus a scripted answer file that drives the engine through the same `WorldAction` vocabulary the real Ask uses (Plan 2). It is developed in `_staging/` (excluded from deploy) and moved live in the final task.

**Tech Stack:** Static HTML/CSS/ES modules. Three.js 0.160.0 is bundled inside `world-viewer.js`. Python Playwright (global `python`, per CLAUDE.md) for the smoke check.

**Spec:** `docs/superpowers/specs/2026-11-15-world-view-design.md` (§5.10, §5.1, §5.5, §5.6)

**Repo:** `C:\Users\DavidEngelhart\repos\termpolis-web`. Commit and push directly to `main`; every push deploys (`.github/workflows/deploy.yml` uploads `git ls-files` minus `downloads/ scripts/ LICENSE .github/ .gitignore`).

## Global Constraints

- Naming (David, 2026-11-16): the page `<title>` is `Lumopolis: Where AI Worlds Become Human Understanding | Termpolis`, the page heading is `Lumopolis`, and the tagline under it is exactly `Where AI Worlds Become Human Understanding.` Lumopolis is always shown as part of Termpolis 2.0, never as a separate product.
- The page is `lumopolis.html`. Three.js comes only from the vendored engine bundle: **no CDN at runtime**.
- The homepage stays lean (site rule, ~2.2k words): a teaser block only; detail lives on `lumopolis.html`.
- It must work on phones: touch orbit and pinch zoom, a low-power quality tier, and a still image plus 2D fallback without WebGL. A 16px side gutter and no horizontal scroll.
- Fast first view: a poster image paints before the engine loads.
- No new tracking or third-party requests.
- The Ask bar is **scripted** and clearly labelled "Demo — answers are pre-written. Download Termpolis to ask about your own software." The proposal answer is labelled "Coming in 2.x".
- Every card claim must be true of Termpolis at the 2.0 release tag (spec anti-goal: "a confident, pretty lie").
- Nothing in `_staging/` deploys before launch. It goes live only in Task 6, on 2.0 release day.
- Never `curl https://termpolis.com` from this laptop (AT&T blocks the IP). Verify live pages via api.microlink.io.

## Review Focus

1. **No WebGL** (old phone, a locked-down corporate browser): show the poster and the 2D list fallback, with no blank page or console exception. Test in Task 4.
2. **A slow connection**: the poster and text are usable before the ~700 KB bundle arrives, with no layout jump when the canvas mounts. Test in Task 4 (throttled run).
3. **A narrow phone (360 px) in portrait**: the card, Ask bar and layer panel don't overlap or cover the canvas entirely, and there's no horizontal scroll. Test in Task 4.
4. **Rapid repeated scripted questions**: a second question cancels the first tour cleanly, with no stacked camera flights or stuck highlights. Test in Task 3.
5. **`prefers-reduced-motion`**: there are no automatic camera flights or flowing packets, and actions jump instead of fly. Test in Task 4.

---

### Task 1: Staging scaffold and deploy exclusion

**Files:**
- Modify: `.github/workflows/deploy.yml:95` (add `_staging/` to the exclude regex)
- Create: `_staging/lumopolis.html`, `_staging/lumopolis/world.css`, `_staging/lumopolis/README.md`
- Create: `scripts/check-world.py`

**Interfaces:**
- Produces: the page shell with these element ids, which later tasks use: `#world-canvas`, `#world-poster`, `#world-card`, `#world-layers`, `#world-ask`, `#world-ask-input`, `#world-ask-suggestions`, `#world-fallback`, `#world-tour-caption`.

- [ ] **Step 1:** Change the exclude regex in `deploy.yml` to `'^(downloads/|scripts/|_staging/|LICENSE$|\.github/|\.gitignore$)'`.
- [ ] **Step 2:** Write `scripts/check-world.py`, a Playwright smoke check taking `--file <path>` and `--width`/`--height`. It loads the page from a local `python -m http.server`, then:
  - asserts zero console errors;
  - asserts `#world-poster` is visible within 1 s;
  - prints `OK` or the failures, and exits non-zero on failure.
- [ ] **Step 3:** Run `python scripts/check-world.py --file _staging/lumopolis.html` → expect FAIL (the file doesn't exist).
- [ ] **Step 4:** Create `_staging/lumopolis.html`. Use the site header and footer markup copied from `index.html` (the `site-nav` block at lines 76–91, with links rewritten to `../index.html#…` while in staging). Add the `#world-*` elements above. The poster is `<img id="world-poster" src="lumopolis/poster.webp" alt="The world of Termpolis: districts for Screen, Engine, Memory, Token proxy, Agent gateway and Linked machines">`. Add `world.css` with the layout: canvas full-bleed under the header; the card docked left on desktop and as a bottom sheet under 720 px; the Ask bar bottom-centre. Colour tokens go on `:root`, with dark as the site default.
- [ ] **Step 5:** Run the smoke check → `OK` (the poster is a placeholder file for now).
- [ ] **Step 6:** Commit with the message `world demo: staging scaffold (not deployed)`. Push, and confirm in the Actions log that `_staging/` files are not uploaded.

### Task 2: The Termpolis world document

**Files:**
- Create: `_staging/lumopolis/data/termpolis.world.json`
- Create: `scripts/validate-world.mjs`

**Interfaces:**
- Consumes: the `WorldDoc` schema from Plan 1 Task 1 (`src/shared/world/types.ts` in the app repo). `validate-world.mjs` imports `validateWorld` from `../termpolis/dist-world/world-validate.js` (built by Plan 1 Task 11 in a sibling checkout); if the build is missing it exits with `run npm run build:world-viewer in ../termpolis first`.
- Produces: `termpolis.world.json`, a valid `WorldDoc` with `layers.plan` holding one proposal (`team-sharing`) for the scripted wireframe answer.

- [ ] **Step 1:** Write `scripts/validate-world.mjs <file>`. It runs `validateWorld` and also asserts:
  - every `edge.from`/`to` resolves;
  - every tech id used is in `glossary`;
  - every building has a `layout.positions` entry;
  - every claim has `state` and at least one `evidence`, whose `ref` is a repository-relative path.

  It exits non-zero listing violations.
- [ ] **Step 2:** Run it on an empty `{}` → FAIL with a list of errors.
- [ ] **Step 3:** Port the data from the prototype (`termpolis/.superpowers/brainstorm/2400-1794800636/content/world-relationships.html`: `DISTRICTS`, `EDGES`, `TECH`, `CARGO`, `PROC`, `TOURS`) into `WorldDoc` form. Each prose line becomes a `Claim` with evidence pointing at the real file, for example the gateway edge `src/main/mcpGateway/index.ts`. Use `state: "verified"` only where a named test covers it, and `observed` otherwise.
- [ ] **Step 4:** **Accuracy pass:** for every claim, open the cited file at the 2.0 release candidate and correct or delete anything untrue. Record each correction in `_staging/lumopolis/README.md` under "Accuracy log".
- [ ] **Step 5:** Run `node scripts/validate-world.mjs _staging/lumopolis/data/termpolis.world.json` → `valid`.
- [ ] **Step 6:** Commit with the message `world demo: Termpolis world document, every claim cited`.

### Task 3: Scripted Ask

**Files:**
- Create: `_staging/lumopolis/data/demo-answers.json`
- Create: `_staging/lumopolis/ask-demo.js`
- Test: `scripts/check-world.py` (add the `--ask` scenario)

**Interfaces:**
- Consumes: `WorldViewer.apply(action: WorldAction): Promise<void>` and `WorldViewer.cancelActions(): void` from Plan 1 Task 11. The `WorldAction` union is defined in Plan 1 Task 1.
- Produces: `mountDemoAsk(viewer: WorldViewer, root: HTMLElement, answers: DemoAnswer[]): () => void`
  - `DemoAnswer = { id: string; question: string; text: string; actions: WorldAction[]; badge?: 'coming-2x' }`

- [ ] **Step 1:** Add an `--ask` scenario to the smoke check:
  - click the suggestion "What happens when I type a prompt?" and assert `#world-tour-caption` becomes non-empty within 3 s;
  - immediately click a second suggestion and assert that only one caption sequence runs (the caption text matches the second answer's first step within 1 s);
  - assert zero console errors.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Write `demo-answers.json` with exactly these 6 questions. The ids must exist in Task 2's document.
  1. "What happens when I type a prompt?" (keystroke flow, Screen → pty host → agent → proxy → provider)
  2. "Where do my memories live, and are they encrypted?"
  3. "Why is the token proxy a separate program?"
  4. "What can my phone see, and how is it protected?"
  5. "Which parts talk to the internet?"
  6. "What would team sharing touch?" (`draftProposal` showing `team-sharing`, `badge: 'coming-2x'`)
- [ ] **Step 4:** Implement `mountDemoAsk`. Behaviour:
  - render the suggestions as buttons;
  - typed text is matched to the closest question by token overlap; with no match, show the six suggestions with "This demo answers a fixed set of questions";
  - a new question calls `viewer.cancelActions()` before playing;
  - the answer text reveals in time with the actions.
- [ ] **Step 5:** Run `python scripts/check-world.py --file _staging/lumopolis.html --ask` → `OK`.
- [ ] **Step 6:** Commit with the message `world demo: scripted Ask with cancellable tours`.

### Task 4: Phone, fallback, motion and load behaviour

**Files:**
- Modify: `_staging/lumopolis.html`, `_staging/lumopolis/world.css`
- Create: `_staging/lumopolis/boot.js` (detection and loading)
- Create: `_staging/lumopolis/poster.webp`, `_staging/lumopolis/teaser.webp` (rendered from the engine at 1600×900 and 800×450)

**Interfaces:**
- Consumes: `createWorldViewer(container, { quality, reducedMotion })` from Plan 1 Task 11.
- Produces: `boot()`. It checks for WebGL2, falling back to WebGL1, then to the fallback. It picks the quality: `'low'` when `navigator.hardwareConcurrency <= 4` or `matchMedia('(pointer:coarse)')`. It dynamic-imports `world/vendor/world-viewer.js` only after the poster has painted.

- [ ] **Step 1:** Add scenarios to the smoke check:
  - `--no-webgl` (launch Chromium with `--disable-webgl --disable-3d-apis`): assert `#world-fallback` is visible and lists every district and building name, and that there are zero console errors.
  - `--width 360 --height 740`: assert `document.documentElement.scrollWidth <= 360` and that the card and Ask bar bounding boxes don't intersect.
  - `--reduced-motion`: emulate `reduced_motion='reduce'`, run question 1, and assert that the camera position after 200 ms equals its final position (no flight).
  - `--slow` (CDP network throttle at 400 kbps): assert the poster is visible before the bundle request completes.
- [ ] **Step 2:** Run all four → FAIL.
- [ ] **Step 3:** Implement `boot.js` and the fallback (a semantic `<ul>` of districts, buildings and their one-line claims, generated from the world JSON). Add CSS breakpoints. Pass `reducedMotion` through to the engine.
- [ ] **Step 4:** Run all scenarios → `OK`.
- [ ] **Step 5:** Commit with the message `world demo: phone, no-WebGL fallback, reduced motion, poster-first load`.

### Task 5: Engine bundle drop-in

**Files:**
- Create: `_staging/lumopolis/vendor/world-viewer.js`, `_staging/lumopolis/vendor/VERSION` (the app commit SHA and the Three.js version)
- Create: `scripts/sync-world-viewer.mjs`

**Interfaces:**
- Consumes: `dist-world/world-viewer.js` built by `npm run build:world-viewer` in the app repo (Plan 1 Task 11).

- [ ] **Step 1:** Write `sync-world-viewer.mjs`. It copies `../termpolis/dist-world/world-viewer.js` into `_staging/lumopolis/vendor/` and writes `VERSION` from `git -C ../termpolis rev-parse HEAD` plus `three@0.160.0`.
- [ ] **Step 2:** Run it, then run every scenario in the smoke check → `OK`.
- [ ] **Step 3:** Commit with the message `world demo: vendor engine bundle <sha>`.

### Task 6: Launch (2.0 release day only)

**Files:**
- Move: `_staging/lumopolis.html` → `lumopolis.html`, and `_staging/lumopolis/` → `world/` (fix the `../` links)
- Modify: `index.html` (one nav link "Lumopolis" after "Features", and a teaser block in the hero area with `teaser.webp`, the sentence `Lumopolis: Where AI Worlds Become Human Understanding. New in Termpolis 2.0.`, and a "Fly through Termpolis" button to `lumopolis.html`)
- Modify: `sitemap.xml` (add `https://termpolis.com/lumopolis.html`)
- Modify: `.github/workflows/deploy.yml` (keep the `_staging/` exclusion)

- [ ] **Step 1:** Do this only after the app's v2.0.0 Release pipeline is green (`release-notify` skill). Re-run Task 5 against the `v2.0.0` tag.
- [ ] **Step 2:** Move the files, then run every scenario against `lumopolis.html` → `OK`.
- [ ] **Step 3:** Check the homepage word count stays at or under its current size plus 60 words.
- [ ] **Step 4:** Commit with the message `site: Lumopolis demo live for Termpolis 2.0` and push.
- [ ] **Step 5:** Verify live via `https://api.microlink.io/?url=https://termpolis.com/lumopolis.html&screenshot=true`: HTTP 200 and the screenshot shows the poster or canvas.
