# Lumopolis: export a world as one HTML file, and generate documentation from it

Status: draft for David's approval. 2026-11-20. This extends `2026-11-15-world-view-design.md` §5.9 (Export), which stays binding wherever this doc is silent.

## 1. Intent and why

David, 2026-11-19 and 11-20, verbatim:
- "how hard would it be within Lumopolis inside of termpolis to have an export option to a stand-alone web page ... with a small llm like bge built in ... Also i would love to have a button to generate documentation of an application or a plan for an application from the Lumopolis design. This is for sure needed before we ship 2.0"
- "i only say the small llm model shipped with the export so we dont lose the ability to ask questions about the world lumopolis built on export"
- "where someone could export documentation as an html as well how everything fits together and works."
- "yes i want you to work on this and have it 100% tested. yes if it holds up in testing I want this part of 2.0"
- On where the documentation's words come from: "A" (straight from the world, no agent writing).

Lumopolis turns a project into a world a person can step inside. These two features carry that understanding outside Termpolis:
- **Export** lets someone with no Termpolis open the world: a teammate, a reviewer or a manager.
- **Documentation** turns the same world into a document a person reads top to bottom: how the application fits together and works, or, for a design world, the plan for an application not built yet.

Both are part of the 2.0 headline, so the bar is the Lumopolis bar: correct on the first try, honest in every sentence, and proven by tests and by the real app.

## 2. Goals, non-goals, anti-goals

**Goals**
1. **Export interactive world.** Any code world, design world or single proposal can be exported as ONE `.html` file that opens by double-click, offline, in Chrome and Edge. Firefox and Safari also open it and navigate.
2. **Exported page contents.** The page has the 3D city with every card, tours, layers, themes and the 2D fallback, read-only. It has an **Ask** box:
   - **Smart Ask** (meaning search, using bge-small inlined in the file) when the person chose it at export.
   - **Keyword Ask** otherwise, or while smart Ask loads, or when it cannot run.
3. **Generate documentation.** Any code world or design world produces ONE self-contained `.html` document, readable and printable, built only from what the world recorded.
4. **Agreement with the cards.** Both features say exactly what the in-app cards say. Every sentence comes from the shared sentence source (`src/shared/world/cardFacts.ts`), so they cannot drift.

**Non-goals (2.0)**
- **Generative answers in the export,** meaning a bundled chat model. This is a possible post-2.0 "large export".
- **An `.exe` export.** Unsigned executables get quarantined by Defender (see project memory on the Defender false positive), and signing a per-user artifact is impossible.
- **A PDF output from Termpolis.** The document prints to PDF from any browser.
- **A new MCP tool.** The tool-description budget is nearly full; agents can already describe a world through `world_*`.

**Anti-goals: things that would make this a failure even if it technically works**
- **Overclaiming.** The exported Ask or the document states something the code or the grouping did not record, or reads a model's inferred claim as verified.
- **Network use.** The exported page makes any network request, or needs one to work.
- **Leaking local details.** The export leaks the exporter's absolute paths, user name, home folder or secrets from code excerpts.
- **A rough first open.** The first open looks broken: blank for seconds, an Ask that silently does nothing, cards with run-together text or sideways scrolling.
- **Hand-maintained sentences.** The document becomes a second, hand-maintained copy of the card logic.

## 3. Constraints

- **Viewer.** The engine already builds standalone: `npm run build:world-viewer` writes `dist-world/world-viewer.js` (ESM, Three.js inlined, ES2020; see `vite.world.config.ts`). The export uses that same bundle, so plan 3's "one engine, three hosts" holds.
- **Model and runtime.** The model is `resources/models/bge-small-en-v1.5/onnx/model_quantized.onnx` (33 MB) plus `tokenizer.json`, already shipped. The runtime is onnxruntime-web's wasm, already a dependency of `src/main/localEmbedder.ts`. Nothing new to install; never `npm install` on David's laptop.
- **file:// has no cross-origin isolation,** so the page runs ORT single-threaded (`numThreads = 1`, `proxy = false`) with `env.wasm.wasmBinary` set from inlined bytes. Chrome blocks a file:// page from reading sibling files, so everything must be inside the one file.
- **Renderer target.** It stays ES2020 (no `.at()`). Coverage: 100% on all four metrics for Lumopolis files; repo gates are lines 97, functions 96, branches 95 and statements 96, and are never lowered.
- **EDR on David's laptop.** Exporting must not start processes beyond what Termpolis already runs, and must not enumerate anything. The endpointActivityGuard and installer-update CI gates stay.
- **No cloud.** Nothing is uploaded anywhere. The files go only where the person saves them.

## 4. Approaches considered

**Export: how the smart Ask travels**

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| A | One HTML file with bge-small and the ORT wasm inlined; part vectors computed by Termpolis at export; only the question is embedded in the page | 36 MB file (gzip+base64). Fully offline. Measured to work. | **Chosen** (David, 11-19) |
| B | Also bundle a small generative model for written answers | Hundreds of MB to GBs. Slow on CPU. Can state things the world does not. | Post-2.0 "large export" at most |
| C | A folder (HTML plus model files), or download the model on first Ask | Chrome blocks file:// sibling reads, and the spec forbids network use | Rejected |
| D | `.exe` | Defender quarantines unsigned builds | Rejected |

**Spike evidence** (throwaway build, 2026-11-19, a real Termpolis world, Playwright over file:// with every request aborted and logged):

| | Size | Ask ready after open (Edge / software-rendered Chromium) | Time per answer | Requests |
|---|---|---|---|---|
| Smart, gzip | 36.3 MB | 1.8 s / 3.8 s | 20–50 ms | 0 |
| Smart, base64 | 61.5 MB | 1.6 s / 4.4 s | 20–50 ms | 0 |
| Keyword only | 1.1 MB | 1.1 s / 1.5 s | <5 ms | 0 |

- **Quality** was measured on 15 newcomer questions whose answers were fixed before any search ran (right first / right in the top 3):
  - labelled world: smart 8 / 13, keyword 6 / 12;
  - unlabelled world: smart 4 / 7, keyword 3 / 4.
- **The spike found four traps:**
  1. Blobs placed after the viewer boot starve the parser; Ask-ready rose to 16 s.
  2. The raw stored doc crashes the viewer; the export must embed `validateWorld(doc).doc`.
  3. Test files crowd out real answers.
  4. Embedding 697 items takes about 32 s on one thread.
- The full report is kept in the SDD workspace as `spike-export-report.md`.

**Documentation: where the words come from**

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| A | Every sentence assembled from the world: cards, claims, lines, tours, glossary, growth facts | Instant. No tokens. Cannot claim what the world does not record. Reads as structured reference more than prose. | **Chosen** (David, 11-20) |
| B | An agent writes a guide from the world | Reads like hand-written prose. Costs tokens and time. Can phrase beyond the evidence. | Rejected |
| C | A plus an optional AI-written introduction | Mixed provenance in one document | Rejected |

## 5. Design

### 5.1 Where a person finds it

- **Toolbar.** The World toolbar (`WorldToolbar.tsx`) gains an **Export** button (icon plus word) that opens a small menu with two items:
  - **Interactive world (HTML)…** opens the export dialog (§5.2).
  - **Documentation (HTML)…** opens the documentation dialog (§5.4).
- **Command Palette.** "Export Lumopolis world" and "Generate Lumopolis documentation" open the same dialogs.
- **Availability.** Both are available on a code world and a design world once the world has finished its first compile.
  - While a compile or labelling run is going, they remain available and use the last saved world. The dialog says so: "Uses the map as it was saved at <time>; Lumopolis is still describing its parts." while labelling runs, and "…; Lumopolis is still updating it." in any other stage.
- **No world open.** On the home (no world), the button is hidden.

### 5.2 The export dialog

```
┌ Export Lumopolis world ─────────────────────────────────┐
│ What    (•) Whole world   ( ) Proposal: [Add billing ▾] │
│                                                         │
│ [x] Include smart Ask (works offline, adds ~35 MB)      │
│     Finds the parts that match a question by meaning.   │
│                                                         │
│ Includes cards, tours, layers and themes. Not included: │
│ your conversation, and file paths outside the project.  │
│                                                         │
│ About 37 MB                     [Cancel]  [Export…]     │
└─────────────────────────────────────────────────────────┘
```

- **What.**
  - For a code world: the whole world, or the world with one proposal drawn over it.
  - For a design world: the design.
  - A proposal export includes the world plus only that proposal, shown selected on open.
- **Smart Ask switch.** It defaults on when at least 80% of buildings and 80% of lines have a model description, meaning a `how` claim from labelling, not the fallback.
  - Below that, it defaults off with the note "Most parts aren't described yet, so smart Ask would mostly match file names. <What to do>, or export with keyword Ask." The person can still switch it on. <What to do> is how the parts get described:
    - design world: "Ask Lumopolis to say what each part does" (the design conversation describes parts);
    - code world, Describe parts with AI off: "Turn on Describe parts with AI in Settings, then press Re-layout";
    - code world, a compile or labelling run going: "Wait for Lumopolis to finish updating the map";
    - otherwise: "Press Re-layout to have Lumopolis describe them" (Re-layout runs a full compile, which labels what the cache doesn't hold).
  - **Ruling (my call):** the 80% figure is a constant in one place; the builder may tune it from fixture evaluation.
- **Size estimate.** A live estimate from the world JSON size plus the fixed smart cost.
- **Saving.** **Export…** opens the OS save dialog (main process `dialog.showSaveDialog`). The default name is `<project> - Lumopolis.html`, in the person's Documents folder.
- **Progress.** The dialog shows steps with a progress bar while it works: "Preparing the map", "Indexing N parts for smart Ask" (with a count; about 30 s on a 600-line world), and "Writing the file". **Cancel** stops cleanly and leaves no partial file: write to a temp name, then rename.
- **Finish.** A toast says "Exported <file name> (37 MB)" with **Show in folder** and **Open**.
- **Errors.** Disk full, a folder without write access, or the model missing from resources: one plain sentence and no partial file. A missing model falls back to offering keyword-only export.

### 5.3 The exported page

**File layout,** in this order. The order is load-bearing; see trap 1 above.
1. `<meta charset>`, viewport, title `<Project> · Lumopolis`.
2. A CSP meta tag: `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'`. This makes "no network" enforced by the browser, not just intended.
   - The builder verifies that ORT runs under it in Chrome, Edge, Firefox and WebKit, and adjusts only what is needed, with a test proving each allowance is required. Those tests dropped `img-src data: blob:` and `worker-src blob:` (smart Ask starts without either: ORT runs on one thread with no proxy worker and loads no image); `'wasm-unsafe-eval'` stays, since smart Ask fails without it.
3. Inline CSS.
4. Data blocks as `<script type="application/octet-stream" id=…>`, each gzip-then-base64, decoded with `DecompressionStream`:
   - the validated world doc;
   - the Ask index (texts and int8 vectors);
   - the tokenizer vocab;
   - the ORT wasm;
   - the model.
   Keyword-only exports omit the last four.
5. ONE inlined classic script: the **export runtime bundle** `dist-world/world-export.js`. It is built by `vite.world.config.ts` as an IIFE entry that contains the engine, Three.js, the controls, the Ask runtime and the keyword search.
   - An inline module cannot import another inline module, which is why the spike had to rewrap the viewer. One self-contained IIFE avoids that.
   - It:
     - mounts the viewer read-only;
     - starts loading smart Ask after the first paint;
     - wires the controls and the Ask box.

**The page's controls** are a new plain-TypeScript runtime in `src/world-export/`, with no React and no Tailwind.
- **Why:** the app's controls are React and Tailwind (`WorldView.tsx`, `WorldToolbar.tsx`, `WorldLegend.tsx`, `WorldCard.tsx`). Bundling them would blow the keyword-only size budget and drag app state into a static page.
- It uses the website demo's `boot.js` (termpolis-web `_staging/lumopolis/boot.js`, 383 lines) as the reference for which controls a standalone page needs. The code lives and is tested in the termpolis repo, so the website can later load the same runtime: one engine, one page runtime.
- *My call, from the builder check.*
- **Controls:**
  - theme;
  - layers;
  - a proposal picker, when the export has a proposal;
  - tours;
  - the 2D toggle;
  - reset view;
  - legend;
  - the card panel, using the engine's own `renderCard` HTML.
- **There is no separate search box.** The World pane has none; Ask covers finding parts.
- **Card buttons in the read-only page:**
  - Confirm and Edit are not rendered (a `readOnly` render option on the engine's cards).
  - The evidence button shows its references as plain text ("src/main/foo.ts", "test: …") instead of opening files.

**What the page shows**
- **The city**, exactly as in the app's World pane: cards, tours, layers, themes, the 2D toggle, search and Esc rules.
  - Read-only: no annotate, Build it, Re-layout, conversation or editing affordances.
  - Bookmarks are kept per viewer in localStorage (wrapped in try/catch) or hidden; builder's call.
- **A slim header:** "<Project>, exported from Termpolis on <date> · commit <head7>[ (uncommitted changes)]", plus "Made with Lumopolis in Termpolis" linking to termpolis.com. A link is only followed when clicked.
- **Ask box** (top right, the app's Ask styling):
  - The placeholder is "Ask about this project".
  - While smart Ask loads: "Smart Ask is getting ready… keyword search works now."
  - Results:
    - the top 5 parts, each with its name, kind (building / line / term) and the first sentence of its card, built from data, never stripped HTML;
    - long words wrap (`overflow-wrap:anywhere`);
    - clicking a result flies to it and opens its card.
  - A fixed caption under the results: "Offline search: finds the parts that match; it doesn't write new answers."
  - If smart Ask fails to load (an old browser, memory, CSP), the box says "Smart Ask couldn't start in this browser; using keyword search." and keyword search keeps working.

**The Ask index,** built in the main process at export time
- **One entry per building, line, outside system (external), glossary term and tour.** Result kinds shown are building / line / outside system / term / tour. The spike's answer sets include externals such as the phone and the relay. Its text is:
  - the name;
  - the card's direction or size sentence from `cardFacts`;
  - the `how` and `why` claim texts;
  - cargo and tech;
  - for buildings, district name and up to 20 member file names.
- **Test parts are ranked lower** (spike trap 3): buildings whose members are all tests, and lines between two such buildings. The builder picks the method (an index flag plus a score factor) and proves it on the fixture evaluation.
- **Vectors.** They come from the existing embedder (`embedBatch` in `src/main/localEmbedder.ts`, worker-backed), bge-small, normalised, int8-quantised per vector (scale stored).
- **Ranking.**
  - Smart: cosine over the vectors.
  - Keyword: BM25 over the same texts.
  - The builder evaluates whether reciprocal-rank fusion of the two beats smart alone on the fixture questions and ships the better one. The choice and numbers are recorded in the report.
- **Index reuse.** The index is built once per export. A cached index keyed by world `generatedAt` plus index version may be kept in userData so re-exports of an unchanged world skip the 30 s; builder's call.

**Sanitising,** in the main process, on the validated doc, before anything is written
- **Excerpts are stripped, not redacted.** Every evidence `excerpt` is removed.
  - Cards never show excerpts: the evidence button carries only kind and ref (`cards.ts:19-20`).
  - Excerpts can hold up to 1,200 characters of code, and memory entries of up to 600 characters (`labelContext.ts:163`, `label.ts:459,712`).
  - *My call, from the builder check.*
- **Memory evidence is dropped.** Evidence of kind `memory`, and `transcriptStep`, is removed entirely. The memory search behind labelling is not limited to the project (`src/main/index.ts:2686-2689`), so it can carry notes from other projects. A claim whose only evidence was memory keeps its text and loses the evidence.
  - The unscoped search is itself a defect: labelling must not pull other projects' notes. It is tracked as a separate fix (ledger WP item), independent of this feature.
  - *My call.*
- **Paths.** Every absolute path in evidence `ref`, member names, captions and the project key becomes repository-relative (spec §5.9). Anything still outside the project becomes `<outside the project>/<basename>`.
  - "Never appears" applies to paths: the exporter's home folder, userData path and any absolute path must not appear anywhere in the file, and a test greps the output for them.
  - The user name inside project content (commit subjects, file names, the project title) is the project's own content and stays.
  - *My call.*
- **Secrets.** Claim texts, commit subjects and captions pass through Termpolis's existing secret scanner and redactor (the one the memory and Headroom paths use; the builder locates it). A hit becomes `[redacted]`.
- **Conversation.** The world's conversation, voice transcripts and agent session ids are dropped.

### 5.4 Generate documentation

**The dialog** is small: Title (prefilled), a "Include the city picture" checkbox, and **Save…**. The rest matches export: save dialog, temp-then-rename, a toast with Show in folder and Open. Generation is effectively instant (target under 1 s for 60 buildings and 600 lines).

**The document** is one self-contained `.html`:
- inline CSS, no script needed;
- light by default, with a dark scheme under `prefers-color-scheme`;
- a sticky contents column on wide screens;
- `@media print` for clean PDF printing (page breaks before each area).

All text is HTML-escaped. Names come from code and may contain markup.

| Section | Code world: "How <Project> works" | Design world: "<Project>: application plan" |
|---|---|---|
| Title block | Project, generated date, commit and dirty flag, "Generated by Termpolis Lumopolis from the code" | Same, "Generated from the design" |
| Coverage | "57 of 60 parts and 590 of 600 connections are described. Statements marked *inferred* come from reading the code, *verified* from tests or a person, *observed* from the code itself." | Same, with *proposed* |
| Overview | Templated sentences from districts (names and subtitles), counts, processes and the stack union | Same, in plan tense ("will") |
| The city at a glance | Optional PNG captured from the open 3D view (skipped with no WebGL) plus a deterministic SVG map: districts as boxes, buildings inside, district-to-district lines aggregated with direction arrows | Same |
| How it runs | Per process: its label and the buildings in it | Planned processes |
| Areas (one per district) | Per building: **everything its card shows, in the card's order and with the card's headings**: name (with "(name suggested by AI)" when the card says so), tech, status, What it does, Why it's built this way, the size note, What we know (test-verified and person-confirmed facts), Service names, What's inside (floors and members, capped with "and N more"), What comes in / What goes out with each line's direction sentence, and the not-in-design tag. Evidence appears as repo-relative references. Each claim carries its state badge. | Same, planned |
| Connections | A table of every line: from → to, what travels, how (via/tech), direction, why | Same |
| Main flows | Each tour as numbered steps with captions and the parts involved | Same |
| Outside systems | Externals: name, kind, which parts reach them; fog ones marked "not seen in code" | Same |
| Plan vs built | When a design is linked: matched, missing, extra, changed | n/a |
| Planned changes | Each proposal: title, summary, parts added and removed | Same |
| Glossary | The world glossary | Same |
| What this document doesn't cover yet | Every part and line still undescribed, by name; what Lumopolis does not see (runtime behaviour, data contents) | Same |

The Connections table likewise carries every line-card field, including How often.

**Card headings.** Section headings are literal strings repeated today in `cards.ts` and `cardText.ts`. They move into `cardFacts` as named constants used by all three outputs (HTML card, agent text card, document), so a heading cannot differ. *My call.*

**Single source of sentences.**
- The new pure module `src/shared/world/documentation.ts` turns a validated `WorldDoc` into a structured document model (sections, paragraphs, tables, claims with states).
- `src/shared/world/documentationHtml.ts` renders that model to HTML.
- Every sentence that also appears on a card calls the same `cardFacts` helper. A test asserts that each building's and line's card sentences appear verbatim in the document.
- Both modules are pure and run in Node, so they are unit-testable without Electron.

**Sanitising** is the same as export (§5.3): repository-relative paths, secret redaction and no conversation.

### 5.5 Code layout (builder may adjust names, not responsibilities)

- **Shared:**
  - `src/shared/world/exportSanitize.ts`: paths and secrets, pure.
  - `src/shared/world/askIndex.ts`: entry texts, BM25, cosine, fusion, int8 codec. Pure, used by both main (build) and page (query).
  - `documentation.ts` and `documentationHtml.ts`.
- **Main:** `src/main/world/export.ts`, which:
  - assembles the page from the shipped viewer bundle, model, wasm and vocab;
  - builds the index via the embedder;
  - handles progress, cancel and temp-then-rename.
  Main also gets IPC `world:export`, `world:export-cancel` and `world:document`, with the save dialog in main.
- **Page runtime:** `src/world-export/boot.ts` is bundled by the existing `vite.world.config.ts` as a second entry: Ask box, smart loader, keyword fallback.
- **Renderer:** `ExportMenu.tsx`, `ExportDialog.tsx` and `DocumentDialog.tsx` in `components/World/`, with the toolbar button and Command Palette entries.
- **Packaging:** `build:world-viewer` runs as part of the app build, and `dist-world/*.js` plus the ORT wasm ship in `extraResources`. The builder verifies the packaged paths on Windows, macOS and Linux CI artifacts.

## 6. Testing ("100% tested")

**Unit** (vitest, 100% on all four metrics for every new file)
- **Sanitiser:** Windows, UNC, POSIX and `~` paths; outside-project paths; user name and home folder never present; secret samples redacted. Use `'a'.repeat(N)`-style samples per the push-protection gotcha.
- **Ask index:** the entry text for each kind; test ranked lower; BM25; cosine; int8 round-trip error bound; fusion.
- **Documentation model and HTML,** with fixture worlds:
  - a labelled code world;
  - an unlabelled world;
  - a design world;
  - a world with a linked design and proposals;
  - an empty world;
  - a 60-building, 600-line world;
  - names with `<script>`, quotes, unicode, emoji and very long names.
  Assert: escaping, every card sentence present verbatim, the coverage numbers, the undescribed list, the tense switch for design worlds, and snapshot stability (deterministic output).
- **Export assembler:** the block order (blobs before boot), the CSP present, keyword-only omits model, wasm and vocab, temp-then-rename, cancel leaves nothing, a disk error leaves nothing, a missing model offers keyword only.

**Page e2e** (Playwright, file://, every request routed to abort and logged, so zero requests is asserted)
- In Electron's Chromium on all three CI platforms, plus Edge on Windows CI and Firefox and WebKit where Playwright has them.
- It opens and paints the 3D city; WebGL off shows the 2D fallback with Ask working; a card opens; a tour runs; Esc rules hold.
- Smart Ask becomes ready and answers; keyword Ask answers before smart is ready; a forced ORT failure shows the fallback sentence and keyword still answers.
- Clicking a result flies to the part and opens its card.

**Which page tests block a release** *(my call)*
- **Blocking:**
  - Electron's Chromium page e2e with smart Ask on Windows, macOS and Linux. The model reaches the e2e jobs through an `actions/cache` entry keyed by the model file's hash, filled by the job that already downloads it (`test.yml:198/306`), so there is no per-shard download.
  - Edge on Windows (preinstalled on the runner).
  - Firefox and WebKit on Linux, installed by Playwright, for open, navigate, cards and keyword Ask.
- **Smart Ask in Firefox and Safari is best effort.** A clean fallback to keyword Ask with the fallback sentence is a pass there; a broken page is a fail.
- **Defender gate.** The existing `defender-scan.yml` also scans one smart export and one documentation file produced in CI. A detection fails the release, as it does for installers.
  - One spike file (the 38 MB gzip export) has sat on David's laptop since 11-19 and was opened in Edge and Chromium without being quarantined. That is one machine and one sample; the CI scan is the proof that holds for recipients.

**Quality gate**
- **Fixture.** A committed, labelled fixture world: Termpolis's own labelled world, as used by the website demo (termpolis-web `_staging/lumopolis/data/`), copied into `tests/fixtures/world/`. The 15 newcomer questions come from the spike's `questions.json`, kept in the SDD workspace, with answers fixed in the test file. Smart (or fused) Ask must reach **top-3 ≥ 12/15**; the spike measured 13 on a labelled world. Keyword must reach top-3 ≥ 10/15.
- This guards the index text and ranking against regressions.

**Budgets**
- The smart export of the fixture is under 40 MB; the keyword-only export is under 1.5 MB plus the world JSON size.
- Ask is ready in under 6 s in CI's Chromium; the spike measured 3.8 s software-rendered.

**App e2e** (the real app, extending `e2e/world*.spec.ts`)
- Export ▸ Interactive world ▸ Export… with a stubbed save path writes the file, and opening it passes the page checks.
- Export ▸ Documentation writes the document, and it contains the expected sections and a known card sentence.
- The undescribed-world default-off note shows.

**Proof for David** (`feedback_lumopolis_proof`): a Playwright video of the real app exporting a world and documentation, then opening both files offline and asking three questions.

## 7. Left to the builder (decide, record in the report)

- The described-coverage threshold (80% to start) and the test-part ranking factor, tuned on fixtures.
- Fusion versus smart-only ranking, by the quality gate numbers.
- A cached Ask index in userData, or not.
- The SVG map layout (reuse fallback2d's layout if it fits).
- Bookmarks in the export: localStorage or hidden.
- Exact packaged resource paths per platform.

## 8. Known limits to state honestly in the UI and docs

- A smart export is about 37 MB: too large for most email attachments. Share it through OneDrive, Teams or a drive, or export with keyword Ask (about 0.75 MB: the page runtime is 0.73 MB, and the e2e fixture's keyword export measured 751,904 bytes).
- Exported Ask finds matching parts; it does not write new answers. In-app Ask, with an agent, can.
- A tab holding a smart export uses more memory than a plain page, roughly 150–250 MB (not measured precisely in the spike). Phones are not a target.
