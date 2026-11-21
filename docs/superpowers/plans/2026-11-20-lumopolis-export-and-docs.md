# Lumopolis Export and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lumopolis can save any world as one offline HTML page, with the city and an Ask box that runs bge-small in the browser, and as one HTML document that explains how the project fits together. Every sentence in that document comes from the world.

**Architecture:**
- Three pure shared modules do the work, so it runs in Node and in the page alike:
  - `exportSanitize` (paths and secrets);
  - `askIndex` (entry texts, BM25, cosine, int8, fusion);
  - `documentation` with `documentationHtml` (the document model and its HTML).
- Main assembles the page in `src/main/world/export.ts`. Data blocks are gzip+base64 and come before one inlined IIFE runtime bundle, `dist-world/world-export.js`. That bundle is built by a second pass of `vite.world.config.ts` from `src/world-export/boot.ts`.
- The renderer gains an Export menu, two dialogs and two Command Palette entries. Before any of that, Task 1 fixes the label-context memory search, which today is not scoped to the project.

**Tech Stack:** TypeScript, Electron 43 (main, preload, utilityProcess), React 18 and Tailwind (renderer only), Three.js through the existing engine, onnxruntime-web 1.26 (already a dependency) running wasm with one thread, bge-small-en-v1.5 q8, Vite 7 lib build, Vitest 4 (node and jsdom projects), Playwright 1.58.

**Spec:** `docs/superpowers/specs/2026-11-20-lumopolis-export-and-docs-design.md` (binding). Its parent is `docs/superpowers/specs/2026-11-15-world-view-design.md` §5.9. The spike that proved the page is under `.superpowers/sdd/2026-11-17-lumopolis-5-spec-conformance/spike-export/`: `src/build.mjs`, `src/askPage.mjs`, `src/core.mjs` and `questions.json`, with results in `spike-export-report.md`.

## Global Constraints

- The renderer, and now the export page runtime, is ES2020: no `.at()` and no other post-ES2020 built-ins.
- Coverage is 100% on lines, functions, branches and statements for every Lumopolis file: `src/main/world/**`, `src/shared/world/**`, `src/renderer/src/world/**`, `src/renderer/src/components/World/**`, and the new `src/world-export/**`.
  - The repo gates stay at lines 97 / functions 96 / branches 95 / statements 96 (`vitest.config.ts:157-160`) and are never lowered.
- TDD on every task: the failing test first, then the code.
- `tsc` (node and web) and `eslint` must be clean before every commit.
- e2e runs locally with the `tw3.sh`/`tw4.sh` swap, restored before the commit.
- Never commit `postcss.config.js`, `src/renderer/src/index.css`, `tailwind.config.js` or `film-bugs-report.md`.
- Commits:
  - go straight to `main`, with the subject `lumopolis: <plain sentence>`;
  - are staged by explicit path;
  - use `git commit -F <file>` (PowerShell here-strings break `-m`), with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - start with `git pull --rebase --autostash`;
  - are never force-pushed.
- Never run `npm install` on this laptop. Add no new dependencies: onnxruntime-web is already one, and esbuild, vite-node and tsx are not to be added.
- Keep the `endpointActivityGuard` and installer-update CI gates.
- Add no MCP tools: the tool-description budget is nearly full.
- CI must be green on Windows, macOS and Linux.
- Test-only hooks stay inert unless `NODE_ENV === 'test'`.
- User copy says "Lumopolis"; code and channel names say `world`.
- EDR rule: never put credential-signature words on a command line. Keep them out of file names, test names and shell greps (use the Grep tool on named files). Secret samples in tests use the `'a'.repeat(N)` style.
- Spec values used verbatim below:
  - CSP: `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:; connect-src 'none'`;
  - smart default threshold: 80% of buildings and 80% of lines described;
  - budgets: smart export under 40 MB; keyword-only export under 1.5 MB plus the world JSON size; Ask ready in under 6 s;
  - quality gate: smart or fused top-3 ≥ 12/15, keyword top-3 ≥ 10/15.

**Command shorthands** (from `.superpowers/sdd/2026-11-17-lumopolis-5-spec-conformance/global-constraints.md`):
- **V:** `unset PROMPT_COMMAND TERMPOLIS_LIMIT_CHOOSER && export PATH="/c/Program Files/Git/cmd:$PATH" && npx vitest run <files>`
- **COV:** V plus `--coverage --coverage.include=<file>`. Expect 100/100/100/100.
- **TSC:** `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false`
- **LINT:** `npx eslint <files>`
- **E2E:** `npx electron-vite build && npm run build:world-viewer`, then `TERMPOLIS_E2E_PREBUILT=1 npx playwright test <spec>`.

## Review Focus

1. **A project path written differently from the stored root** must still be made repository-relative. Examples: a Windows path in another case or with the other slash (`c:/Users/x/repo` vs `C:\Users\x\repo`), a UNC path, or a root containing regex characters such as `repo (copy)+`. Test in Task 4.
2. **A world whose text contains `</script>`, `<!--` or `]]>`** must still yield a page with exactly the scripts the assembler wrote. Text in a building name, a claim or a tour caption counts. Test in Task 9.
3. **Saving over a file that is open, or locked on Windows** (rename fails with EPERM or EBUSY) gives one plain sentence. It leaves no temp file and the old file intact. Test in Task 9.
4. **A project name that is not a valid file name** (`a/b: c?`, an empty title, 300 characters) still gives a usable default save name. Test in Task 10.
5. **An Ask query that is empty, only punctuation or stopwords, or longer than the model's 512 tokens** returns "No matching parts" or results without throwing, in both smart and keyword modes. Test in Tasks 5 and 8.

---

### Task 1: Scope the label-context memory search to the project

This is independent of export and lands first. Today labelling's memory lookup (`src/main/index.ts:2683-2690`) calls `correctedSearch({ query, limit: 3, kind: 'decision' })` with no project. A world can therefore pull decision notes from other projects into its claim evidence.

**Files:**
- Modify: `src/main/world/labelContext.ts:23-30` (`LabelContextDeps`), `:158-168` (`decisions`), `:173` (the call site)
- Modify: `src/main/index.ts:2683-2690`
- Test: `tests/electron/worldLabelContext.test.ts`

**Interfaces:**
- Produces:
  - `LabelContextDeps.memory: (query: string, root: string) => Promise<MemoryHit[]>`
  - `export function memoryForLabels(search: (opts: { query: string; limit: number; kind: 'decision'; project: string }) => Promise<{ id: string; content: string }[]>): LabelContextDeps['memory']` in `labelContext.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('asks memory for decisions scoped to the world root', async () => {
  const memory = vi.fn(async () => [{ id: 'm1', text: 'Use SQLite' }])
  await createLabelContext({ ...deps, memory })('C:/repos/demo', ['src/db/store.ts'])
  expect(memory).toHaveBeenCalledWith(expect.any(String), 'C:/repos/demo')
})
it('memoryForLabels searches decisions in the given project only', async () => {
  const search = vi.fn(async () => [{ id: 'd1', content: 'x' }])
  expect(await memoryForLabels(search)('store', 'C:/repos/demo')).toEqual([{ id: 'd1', text: 'x' }])
  expect(search).toHaveBeenCalledWith({ query: 'store', limit: 3, kind: 'decision', project: 'C:/repos/demo' })
})
```

- [ ] **Step 2: Run them and watch them fail.** Run V with `tests/electron/worldLabelContext.test.ts`. Expected: FAIL. The first test sees `memory` called with one argument; the second fails because `memoryForLabels` is not exported.

- [ ] **Step 3: Implement the changes.**
  - `decisions(root, members)` passes `root` to `deps.memory`.
  - Add `memoryForLabels` (limit 3, kind `'decision'`, `project: root`).
  - `index.ts` becomes `createLabelContext({ git, memory: memoryForLabels(correctedSearch) })`. `memorySearch` already normalises a path `project` through `normalizeProjectSlug` (`src/main/swarmMemory.ts:92`).

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV with `src/main/world/labelContext.ts` (expect 100/100/100/100), then TSC and LINT.

- [ ] **Step 5: Commit.** Stage `src/main/world/labelContext.ts`, `src/main/index.ts` and `tests/electron/worldLabelContext.test.ts`. Subject: `lumopolis: labelling only reads decision notes from the project being mapped`.

---

### Task 2: One set of card headings, and HTML escaping shared by all three outputs

**Files:**
- Modify: `src/shared/world/cardFacts.ts` (add the constants)
- Create: `src/shared/world/html.ts` (move `escapeHtml` here from `src/renderer/src/world/engine/html.ts`, which re-exports it)
- Modify: `src/renderer/src/world/engine/cards.ts` (every `section('…')` literal at lines 34, 48, 73, 90-123, 143-144)
- Modify: `src/main/world/cardText.ts:21,48-77` (the same headings)
- Test: `tests/shared/world/cardFacts.test.ts` (extend it, or create it if missing), `tests/renderer/world/cards.test.ts`, `tests/electron/worldCardText.test.ts` (or the existing cardText test file)

**Interfaces:**
- Produces:
  - `export const CARD_HEADINGS` (as const) with these keys and values:
    - `whatItIs: 'What it is'`
    - `whatItDoes: 'What it does'`
    - `inside: "What's inside"`
    - `whyBig: 'Why it is this big'`
    - `technology: 'Technology'`
    - `whyBuilt: "Why it's built this way"`
    - `know: 'What we know'`
    - `serviceNames: 'Service names'`
    - `comesIn: 'What comes in'`
    - `goesOut: 'What goes out'`
    - `carries: 'What it carries'`
    - `direction: 'Direction'`
    - `travels: 'What travels'`
    - `howTravels: 'How it travels'`
    - `whyDone: "Why it's done this way"`
    - `howOften: 'How often'`
    - `usedInside: 'Used inside'`
    - `carriesConnections: 'Carries these connections'`
  - `export function escapeHtml(value: unknown): string` in `src/shared/world/html.ts`. The behaviour is unchanged.
  - `export function serviceNamesLine(doc: WorldDoc, id: string): string | null` in cardFacts: the names and "by" text the card shows, or null when there are none. It is used by cards, cardText and the document.

- [ ] **Step 1: Write the failing tests.**
  - `it('cardText uses the HTML card headings')`: for a fixture edge, `cardText(doc, edgeId)` contains `CARD_HEADINGS.whyDone` and not `'Why it is done this way'`.
  - `it('cardText lists service names like the card')`: a building with `runtimeNames` gives a line under `CARD_HEADINGS.serviceNames`.
  - `it('every heading the HTML card prints is a CARD_HEADINGS value')`: collect `<h4>` texts from `buildingCard` and `edgeCard` over the fixture and expect each in `Object.values(CARD_HEADINGS)`.

- [ ] **Step 2: Run them and watch them fail.** Run V on the three test files. Expected: FAIL on `'Why it is done this way'` and on the missing service names section.

- [ ] **Step 3: Implement the change.** Replace every heading literal in `cards.ts` and `cardText.ts` with `CARD_HEADINGS.*`, add `serviceNamesLine`, and move `escapeHtml`. The engine's `html.ts` and `index.ts` keep exporting `escapeHtml` so existing imports don't change.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/cardFacts.ts`, `src/shared/world/html.ts`, `src/renderer/src/world/engine/cards.ts` and `src/main/world/cardText.ts`, then TSC and LINT. Update older cardText assertions that pinned the old wording.

- [ ] **Step 5: Commit.** Subject: `lumopolis: card headings come from one list, so the agent card matches the map card`.

---

### Task 3: Read-only cards for the exported page

**Files:**
- Modify: `src/renderer/src/world/engine/cards.ts` (`claims`, `serviceNames`, `buildingCard`, `edgeCard`)
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts:134-148` (options) and `cardFor`
- Test: `tests/renderer/world/cards.test.ts`, `tests/renderer/world/createWorldViewer.test.ts`

**Interfaces:**
- Produces:
  - `export interface CardOptions { readOnly?: boolean }`
  - `buildingCard(doc, id, floors?, opts?: CardOptions)` and `edgeCard(doc, id, opts?: CardOptions)`
  - `WorldViewerOptions.readOnly?: boolean`, which `cardFor` passes through

- [ ] **Step 1: Write the failing tests.**
  - `it('a read-only card has no Confirm or Edit and shows evidence as text')`: `buildingCard(doc, id, 'none', { readOnly: true })` has no `data-confirm`, `data-runtime-edit` or `data-evidence`. It does contain `<span class="ev-ref">src/main/foo.ts</span>`, the text being `evidenceText(e)`.
  - `it('createWorldViewer passes readOnly to every card it renders')`: a selected building's `renderCard` HTML lacks `data-confirm`.
  - The existing default-mode tests still pass unchanged.

- [ ] **Step 2: Run them and watch them fail.** Run V on both files. Expected: FAIL, because `data-confirm` is present.

- [ ] **Step 3: Implement it.** `readOnly` drops the Confirm and Edit buttons and swaps each evidence button for `<span class="ev-ref">${escapeHtml(evidenceText(e))}</span>`. Navigation links (`nodeLink`) stay.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `cards.ts` and `createWorldViewer.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: cards can render read-only, without Confirm, Edit or file links`.

---

### Task 4: The export sanitiser

**Files:**
- Create: `src/shared/world/exportSanitize.ts`
- Test: `tests/shared/world/exportSanitize.test.ts`

**Interfaces:**
- Consumes: `redactSecrets(text: string): string` from `src/shared/appLog.ts:72` (the spec's "existing secret scanner").
- Produces:
  - `export interface SanitizeContext { root: string | null; home: string; userData: string }`. `root` is null for a design world.
  - `export const OUTSIDE = '<outside the project>'`
  - `export function relativePath(p: string, ctx: SanitizeContext): string`
  - `export function sanitizeText(text: string, ctx: SanitizeContext): string` runs `redactSecrets` (a hit becomes `[redacted]`), then rewrites every absolute path found in free text with `relativePath`.
  - `export function sanitizeWorld(doc: WorldDoc, ctx: SanitizeContext): WorldDoc`

- [ ] **Step 1: Write the failing tests** (one `it` per line):
  - `relativePath('C:\\Users\\dev\\repo\\src\\a.ts', {root:'C:\\Users\\dev\\repo',…})` gives `'src/a.ts'`.
  - Review Focus 1: the same with `root: 'c:/users/dev/repo'`; a UNC root `\\\\srv\\share\\repo`; a root `'/home/dev/repo (copy)+'`; a POSIX path; `~/repo/x.ts` with `home: '/home/dev'`.
  - Outside the project: `'D:\\other\\secret.ts'` gives `'<outside the project>/secret.ts'`; a design world (`root: null`) with an absolute ref gives `'<outside the project>/<basename>'`.
  - `sanitizeWorld` removes every `excerpt` and every evidence of kind `memory` or `transcriptStep`. A claim whose only evidence was memory keeps its text with `evidence: []`.
  - `sanitizeWorld` relativises evidence `ref`, building, floor and district `members`, and tour captions. `projectKey` becomes the root's basename.
  - `sanitizeWorld` copies only known `WorldDoc` fields: a doc with an extra `conversation` or `sessionId` key, and `layers.live`, comes back without them.
  - Secrets: a claim text holding `'ghp_' + 'a'.repeat(36)` becomes `[redacted]`.
  - The paths never appear: `JSON.stringify(sanitizeWorld(doc, ctx))` contains neither `ctx.home` nor `ctx.userData`, in either slash form and in any case.

- [ ] **Step 2: Run them and watch them fail.** Run V with `tests/shared/world/exportSanitize.test.ts`. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement the module.** Compare paths case-insensitively when `root` looks like a Windows or UNC path, after normalising `\` to `/`. Escape every root before building a RegExp from it. Rebuild the doc field by field from `WorldDoc` (an allowlist copy), never `{...doc}`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/exportSanitize.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: an exported world keeps only project-relative paths and no memory notes or secrets`.

---

### Task 5: The Ask index, the fixture world and the keyword quality gate

**Files:**
- Create: `src/shared/world/askIndex.ts`
- Create: `tests/fixtures/world/termpolis.world.json`, copied unchanged from `termpolis-web/_staging/lumopolis/data/termpolis.world.json`
- Create: `tests/fixtures/world/askQuestions.json`: the 15 `q` entries of the spike's `questions.json`, with each question's `labelled` accept list
- Modify: `src/main/localEmbedder.ts:30` to import the query prefix from askIndex (one source)
- Test: `tests/shared/world/askIndex.test.ts`, `tests/electron/worldAskQuality.test.ts`

**Interfaces:**
- Consumes: `direction`, `sizeNote`, `NOT_DESCRIBED` and `nodeName` from cardFacts.
- Produces:
  - `export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '`
  - `export const ASK_INDEX_VERSION = 1`
  - `export const TEST_RANK_FACTOR: number` (starts at 0.8, tuned on the fixture, the value recorded in the commit body)
  - `export const FUSE: boolean` (decided by the gate in Task 12; it starts `true`)
  - `export type AskKind = 'building' | 'line' | 'external' | 'term' | 'tour'`
  - `export interface AskEntry { id: string; kind: AskKind; name: string; first: string; text: string; test: boolean }`
  - `export function askEntries(doc: WorldDoc): AskEntry[]`. Text order: name, the direction or size sentence, `how` and `why` claim texts, cargo, tech, then for buildings the district name and up to 20 member basenames. `first` is the first sentence of the card, from data: a building's first `how` claim or `NOT_DESCRIBED`; a line's `direction(doc, e).text`; an external's kind; a term's glossary text; a tour's first caption.
  - `export interface Bm25 { docs: number; avgLen: number; df: Record<string, number>; tf: Record<string, number>[]; len: number[] }`
  - `export function buildBm25(texts: string[]): Bm25` (k1 = 1.2, b = 0.75)
  - `export function bm25Scores(ix: Bm25, query: string): number[]`
  - `export interface PackedVectors { dim: number; scales: number[]; data: Int8Array }`
  - `export function packInt8(vectors: number[][]): PackedVectors`
  - `export function cosineScores(p: PackedVectors, q: Float32Array): number[]`
  - `export function rrf(rankings: number[][], k?: number): number[]` (k defaults to 60)
  - `export interface AskHit { id: string; kind: AskKind; name: string; first: string }`
  - `export function rankAsk(entries: AskEntry[], scores: { smart?: number[]; keyword: number[] }, limit?: number): AskHit[]` (limit defaults to 5). Applies `TEST_RANK_FACTOR` to `test` entries and fuses when `FUSE` and `smart` are both present.
  - `export function tokenize(text: string): string[]` (lower-case words, with a short English stopword list removed)

- [ ] **Step 1: Write the failing tests.** In `askIndex.test.ts`:
  - The entry text for each of the five kinds.
  - A building whose members are all `*.test.ts`, and a line between two such buildings, gets `test: true`.
  - BM25 ranks the doc with the rarer matching term first.
  - The int8 round trip: the cosine of a packed vector against its source is ≥ 0.995, and the zero vector packs with scale 0.
  - `rrf([[0,1,2],[2,0,1]])[0] === 0`.
  - `rankAsk` returns at most 5 hits and drops a test part below an equal non-test part.
  - Review Focus 5: `rankAsk` with an empty, `'?!'` or `'the of and'` query (`keyword` all zeros) returns `[]`; a 5,000-character query does not throw.

  In `worldAskQuality.test.ts`, `it('keyword Ask finds the right part in the top 3 for at least 10 of 15 questions')` runs over `tests/fixtures/world/termpolis.world.json` through `validateWorld`, `askEntries`, `buildBm25` and `rankAsk`. A hit is an id in the accept set, or a line whose two ends are both in it.

- [ ] **Step 2: Run them and watch them fail.** Run V on both files. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `askIndex.ts`.** Point `localEmbedder.ts` at `BGE_QUERY_PREFIX`. Port the BM25, int8 and top-k logic from `spike-export/src/core.mjs`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/askIndex.ts`, then V on `tests/electron/localEmbedder.test.ts` (it must stay green), then TSC and LINT. Record the keyword score (x/15) in the commit body.

- [ ] **Step 5: Commit.** Subject: `lumopolis: an Ask index that ranks a world's parts by keyword and by meaning`.

---

### Task 6: The documentation model

**Files:**
- Create: `src/shared/world/documentation.ts`
- Create: `tests/fixtures/world/docWorlds.ts`, which builds these fixture worlds:
  - labelled code;
  - unlabelled;
  - design;
  - a linked design with proposals;
  - empty;
  - 60 buildings and 600 lines;
  - hostile names (`<script>`, quotes, unicode, emoji, a 400-character name).
- Test: `tests/shared/world/documentation.test.ts`

**Interfaces:**
- Consumes: `CARD_HEADINGS`, `serviceNamesLine`, `direction`, `sizeNote`, `runsIn`, `BUILD_STATUS_TEXT`, `notInDesign`, `edgeFromCode`, `NO_WHY_YET`, `NOT_DESCRIBED`, `FLOOR_CAP` and `evidenceText` from cardFacts, and `sanitizeWorld` from Task 4. The caller sanitises first; the model only reads.
- Produces:
  - `export type DocBlock = { kind: 'p'; text: string } | { kind: 'claims'; items: { text: string; state: ClaimState; refs: string[] }[] } | { kind: 'list'; items: string[] } | { kind: 'table'; head: string[]; rows: string[][] } | { kind: 'map' } | { kind: 'picture' }`
  - `export interface DocSection { id: string; title: string; blocks: DocBlock[]; children?: DocSection[] }`
  - `export interface DocModel { title: string; subtitle: string; design: boolean; sections: DocSection[] }`
  - `export interface DocOptions { title: string; picture: boolean; generatedOn: string }`. `generatedOn` is passed in so the output is deterministic.
  - `export function buildDocumentation(doc: WorldDoc, opts: DocOptions): DocModel`
  - `export const SECTION_IDS = ['title','coverage','overview','glance','runs','areas','connections','flows','outside','planVsBuilt','planned','glossary','notCovered'] as const`

- [ ] **Step 1: Write the failing tests.**
  - Section titles: a code world gives `How <Project> works`; a design world gives `<Project>: application plan`, and the title block says `Generated from the design`.
  - Coverage sentence, verbatim for the fixture: `'57 of 60 parts and 590 of 600 connections are described.'` followed by the states sentence. A design world adds *proposed*.
  - Every card sentence appears verbatim:
    - for each building: `sizeNote`, `runsIn`, `BUILD_STATUS_TEXT[status]`, each claim text, and `serviceNamesLine`;
    - for each line: `direction(doc,e).text`.
    - All of them occur somewhere in the model's text.
  - Area blocks follow the card's order (`cards.ts:87-98`) under the `CARD_HEADINGS` titles.
  - The Connections table head is `['From','To','What travels','How','Direction','Why','How often']`, with one row per line.
  - Planned changes lists each proposal's title, summary and the parts it adds and removes. Plan vs built appears only when a linked design exists.
  - The "doesn't cover yet" section names every building with no `how` claim and every line with no `how` claim.
  - Design worlds use plan tense: the overview sentence contains ` will `.
  - The empty world gives a model with the title, coverage `0 of 0` and the "doesn't cover yet" text, and nothing throws.
  - Deterministic: two calls give a deep-equal model.
  - Speed: for 60 buildings and 600 lines, `buildDocumentation` completes in under 1000 ms. Assert `performance.now()` deltas, with a 3× slack factor under CI.

- [ ] **Step 2: Run them and watch them fail.** Run V with `tests/shared/world/documentation.test.ts`. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `buildDocumentation`.** Every sentence that also appears on a card calls the cardFacts helper; there are no new copies of card wording. Fixed copy, verbatim from spec §5.4:
  - `'Generated by Termpolis Lumopolis from the code'`
  - `'Generated from the design'`
  - `'Statements marked *inferred* come from reading the code, *verified* from tests or a person, *observed* from the code itself.'`

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/documentation.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: a documentation model built only from what the world records`.

---

### Task 7: Documentation HTML and the SVG map

**Files:**
- Create: `src/shared/world/documentationHtml.ts`
- Test: `tests/shared/world/documentationHtml.test.ts`, with snapshot `tests/shared/world/__snapshots__/documentationHtml.test.ts.snap`

**Interfaces:**
- Consumes: `DocModel` (Task 6) and `escapeHtml` (Task 2).
- Produces:
  - `export function renderDocumentation(model: DocModel, doc: WorldDoc, picturePng?: string): string`. `picturePng` is a `data:image/png;base64,…` URL or nothing.
  - `export function docMapSvg(doc: WorldDoc): string`. Districts are boxes laid out from `doc.layout.positions` (the fallback2d placement rule, `fallback2d.ts:19-28`), with buildings inside. District-to-district lines are aggregated, each with a count label and a direction arrow `marker-end`.

- [ ] **Step 1: Write the failing tests.**
  - Escaping: the hostile-names world renders no `<script` except none at all, since the document has no script. The `<script>` name appears as `&lt;script&gt;`.
  - The page has these:
    - `<meta charset="utf-8">`;
    - `@media (prefers-color-scheme: dark)`;
    - `@media print`, with `break-before: page` on `.area`;
    - a sticky contents `nav`;
    - no `<script`;
    - no `http://` or `https://` except the one `https://termpolis.com` link.
  - `docMapSvg` is deterministic, and every district id appears once as a `<g data-id=…>`.
  - The picture is included when given and absent otherwise.
  - Snapshot of the labelled fixture's output, for stability.

- [ ] **Step 2: Run them and watch them fail.** Run V on the file. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement it.** Use inline CSS, light by default. Every text node and attribute goes through `escapeHtml`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/documentationHtml.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: documentation renders to one printable HTML file with a map of the areas`.

---

### Task 8: The export page runtime and its bundle

**Files:**
- Create:
  - `src/world-export/boot.ts` (entry: read blocks, mount the viewer, wire controls);
  - `src/world-export/blocks.ts` (gz64 decode);
  - `src/world-export/controls.ts` (header, theme, layers, proposal picker, tours, 2D toggle, reset, legend, card panel);
  - `src/world-export/askBox.ts` (UI and states);
  - `src/world-export/smartAsk.ts` (ORT, tokenizer, query embedding).
- Modify: `vite.world.config.ts`. Under `--mode export` it runs a second pass: IIFE, entry `src/world-export/boot.ts`, `fileName: 'world-export'`, `outDir: 'dist-world'`, `emptyOutDir: false`, `rollupOptions.output.inlineDynamicImports: true`, `define: { 'import.meta.url': '""' }`.
- Modify: `package.json` scripts:
  - `"build:world-viewer": "vite build -c vite.world.config.ts && vite build -c vite.world.config.ts --mode export && node scripts/checkWorldExportBundle.cjs"`
  - `"build"` runs `npm run build:world-viewer` before `electron-vite build`.
- Create: `scripts/checkWorldExportBundle.cjs`. It fails when `dist-world/world-export.js` contains `</script` (any case), `import(` or `import.meta`.
- Modify: `tsconfig.web.json` include (add `src/world-export/**/*`), `vitest.config.ts` coverage include (add `'src/world-export/**/*.ts'`), and thresholds (add `'src/world-export/**': { lines: 100, functions: 100, branches: 100, statements: 100 }`)
- Test: `tests/renderer/worldExport/blocks.test.ts`, `controls.test.ts`, `askBox.test.ts`, `smartAsk.test.ts`, `boot.test.ts` (jsdom); `tests/scripts/checkWorldExportBundle.test.ts`

**Interfaces:**
- Consumes:
  - `createWorldViewer(container, { title, readOnly: true, renderCard })` and `renderFallback`, `hasWebGL`, `THEMES` and `DEFAULT_LAYERS` from the engine index;
  - `askEntries` types, `buildBm25`, `bm25Scores`, `cosineScores`, `rankAsk`, `BGE_QUERY_PREFIX` and `PackedVectors` from Task 5;
  - `BertTokenizer.fromJSON` from `src/main/bertTokenizer.ts` (pure, no imports).
- Produces:
  - Page contract (block ids, read by Task 9):
    - `world` (validated, sanitised `WorldDoc` JSON);
    - `meta` (JSON: `{ project, exportedOn, head7, dirty, proposalId? }`);
    - `ask` (JSON: `{ version, entries: AskEntry[], dim, scales }`);
    - `askvec` (raw `Int8Array` bytes);
    - `vocab` (`{ tokenizer, tokenizerConfig }` JSON);
    - `ortwasm` (bytes);
    - `model` (bytes).
    - Every block is a `<script type="application/octet-stream" id="<id>" data-enc="gz64">`.
    - Keyword-only pages carry only `world`, `meta` and `ask` without vectors.
  - `export async function readBlock(id: string): Promise<Uint8Array | null>` and `export async function readJsonBlock<T>(id: string): Promise<T | null>` in blocks.ts. They use `DecompressionStream('gzip')` on the base64-decoded bytes.
  - `export interface SmartAsk { embed(q: string): Promise<Float32Array> }`
  - `export async function startSmartAsk(load: (id: string) => Promise<Uint8Array | null>, ort?: OrtLike): Promise<SmartAsk>` in smartAsk.ts. It imports `onnxruntime-web/wasm`, sets `env.wasm.numThreads = 1`, `env.wasm.proxy = false` and `env.wasm.wasmBinary = <ortwasm bytes>`, then mean-pools and L2-normalises to 384 dims, with `BGE_QUERY_PREFIX` on queries.
  - `export type AskState = 'keyword' | 'loading' | 'smart' | 'failed'`
  - `export function mountAskBox(host: HTMLElement, deps: { entries: AskEntry[]; bm25: Bm25; vectors: PackedVectors | null; smart: Promise<SmartAsk> | null; onPick(id: string): void }): { state(): AskState }`
  - `window.__worldExport = { ready: Promise<AskState>, state(): AskState }`. It is always set (the page has no NODE_ENV) and is read-only. The page e2e reads it.

- [ ] **Step 1: Write the failing tests.**
  - `blocks`: a block written with Node's `gzipSync` and then base64 round-trips; a missing id returns null.
  - `askBox`:
    - placeholder `'Ask about this project'`;
    - while loading, `'Smart Ask is getting ready… keyword search works now.'`;
    - after rejection, `'Smart Ask couldn't start in this browser; using keyword search.'`;
    - the fixed caption `"Offline search: finds the parts that match; it doesn't write new answers."`;
    - results show name, kind word (`building` / `line` / `outside system` / `term` / `tour`) and `first`, with `overflow-wrap:anywhere`;
    - a click calls `onPick(id)`;
    - keyword answers while `smart` is still pending;
    - Review Focus 5: empty and `'?!'` queries show `'No matching parts'`.
  - `smartAsk` (with a fake `OrtLike`): sets `numThreads` 1, `proxy` false and `wasmBinary`; prefixes queries; returns a unit-length 384-float vector; truncates a 5,000-word query to the tokenizer's 512 tokens without throwing.
  - `controls`:
    - the header text is `'<Project>, exported from Termpolis on <date> · commit <head7> (uncommitted changes)'` when dirty, without the parenthesis when clean;
    - the `Made with Termpolis` link points to `https://termpolis.com`;
    - the proposal picker exists only with a proposal and starts on `meta.proposalId`;
    - there is no bookmarks control (ruling: hidden, because every file:// page in Chromium shares one localStorage origin);
    - there are no annotate, Build it or Re-layout controls.
  - `boot`:
    - mounts the viewer with `readOnly: true`;
    - with `hasWebGL() === false` it shows `renderFallback` and the Ask box still works;
    - starts smart loading only after `requestAnimationFrame`;
    - a page without `model` never calls `startSmartAsk`.
  - `checkWorldExportBundle`: fails on a temp file containing `</SCRIPT`, on `import(`, and on `import.meta`; passes on clean text.

- [ ] **Step 2: Run them and watch them fail.** Run V on `tests/renderer/worldExport` and `tests/scripts/checkWorldExportBundle.test.ts`. Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement the runtime, the export pass and the check script.** The runtime is plain DOM and TypeScript, with no React or Tailwind. Use the website's `termpolis-web/_staging/lumopolis/boot.js` only as the list of controls a standalone page needs. Card HTML comes from the engine's `renderCard`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/world-export/*.ts`, then run `npm run build:world-viewer` and check that `dist-world/world-export.js` exists and the check passes. Then TSC and LINT.

- [ ] **Step 5: Commit.** Stage the new files and the modified `vite.world.config.ts`, `package.json`, `tsconfig.web.json` and `vitest.config.ts`. Subject: `lumopolis: the runtime an exported world page runs, built as one self-contained script`.

---

### Task 9: The export assembler in main, and packaging

**Files:**
- Create: `src/main/world/export.ts`
- Modify: `src/main/localEmbedder.ts:124-156`. Export `resolveEmbedderAssets(): { dir: string; model: string } | undefined`, built from the private resolvers.
- Modify: `package.json` `build.extraResources` (add `{ "from": "dist-world", "to": "world-export", "filter": ["*.js"] }`)
- Modify: `scripts/verifyPackagedResources.cjs` and its test `tests/electron/verifyPackagedResources.test.ts`. Require `world-export/world-export.js`. The ORT wasm already ships asar-unpacked and is already verified (`verifyPackagedResources.cjs:300-302`), so it is read from there and not copied twice.
- Test: `tests/electron/worldExport.test.ts`

**Interfaces:**
- Consumes: `sanitizeWorld` (Task 4); `askEntries`, `packInt8`, `ASK_INDEX_VERSION` (Task 5); `validateWorld`; `embedBatch(texts)` and `resolveEmbedderAssets()`.
- Produces:
  - `export interface ExportAssets { runtimeJs: string; ortWasm: string; modelDir: string; modelFile: string }`
  - `export function resolveExportAssets(env: { resourcesPath?: string; appPath: string }): { assets: ExportAssets } | { missing: 'runtime' | 'model' }`. Packaged: `<resourcesPath>/world-export/world-export.js`, `<resourcesPath>/app.asar.unpacked/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` and the embedder assets. Dev: `<appPath>/dist-world/…` and `<appPath>/node_modules/onnxruntime-web/dist/…`.
  - `export const SMART_DEFAULT_SHARE = 0.8`
  - `export function describedShare(doc: WorldDoc): { buildings: number; lines: number; smartDefault: boolean }`. A part counts as described when it has at least one `how` claim, which is the model description, not the fallback.
  - `export function estimateExportBytes(doc: WorldDoc, smart: boolean): number`
  - `export type ExportStep = 'prepare' | 'index' | 'write'`
  - `export interface ExportProgress { step: ExportStep; done: number; total: number }`
  - `export interface ExportRequest { doc: WorldDoc; ctx: SanitizeContext; smart: boolean; proposalId?: string; target: string; exportedOn: string }`
  - `export interface ExportDeps { assets: ExportAssets; embed(texts: string[]): Promise<(number[] | null)[]>; fs: { readFile; writeFile; rename; rm; stat }; signal: AbortSignal; progress(p: ExportProgress): void }`
  - `export type ExportResult = { ok: true; path: string; bytes: number } | { ok: false; error: string; cancelled?: boolean; keywordOnly?: boolean }`
  - `export async function exportWorld(req: ExportRequest, deps: ExportDeps): Promise<ExportResult>`
  - `export async function writeDocument(req: { doc: WorldDoc; ctx: SanitizeContext; title: string; picturePng?: string; target: string; generatedOn: string }, fs: ExportDeps['fs']): Promise<ExportResult>`
  - `export function exportPageHtml(parts: { title: string; blocks: { id: string; gz64: string }[]; runtimeJs: string }): string`. The order is meta charset, viewport, `<title>`, CSP meta, inline CSS, the blocks, then one classic `<script>` holding `runtimeJs`.
  - Error copy (one sentence each):
    - `"There isn't enough space on that drive to save the file."`
    - `"Termpolis can't write to that folder. Choose another one."`
    - `"That file is open in another program. Close it and try again."`
    - `"The smart Ask model isn't installed with this copy of Termpolis, so this export can use keyword Ask only."` (with `keywordOnly: true`)

- [ ] **Step 1: Write the failing tests.**
  - Block order: in `exportPageHtml`, every `data-enc="gz64"` block's index is less than the runtime `<script>` index, and the CSP meta string equals the spec's exactly.
  - The keyword-only output has no `askvec`, `vocab`, `ortwasm` or `model` blocks.
  - Review Focus 2: a world with the building name `'</script><script>alert(1)</script><!--'` gives HTML whose count of `<script` tags equals the number of blocks plus 1.
  - Temp-then-rename: the write goes to `<target>.part-<random>`, then `rename`.
  - Cancel: aborting during `index` leaves no `.part` file (`rm` called) and returns `{ ok: false, cancelled: true }`.
  - `ENOSPC` and `EACCES` give the two sentences and remove the `.part`.
  - Review Focus 3: `rename` rejecting with `EPERM` or `EBUSY` gives `"That file is open in another program. Close it and try again."`. The `.part` is removed, and no write touched `target` itself.
  - A missing model gives `keywordOnly: true`.
  - Progress: `prepare`, then `index` with `done` climbing in steps of 16 up to `total === entries.length`, then `write`.
  - `describedShare` at 79% and at 80% buildings gives `smartDefault` false and then true.
  - `estimateExportBytes(smart) - estimateExportBytes(keyword)` equals the asset byte sizes within 5%.
  - The sanitiser runs: the output never contains `ctx.home`.
  - `writeDocument` writes a doc whose text contains a known card sentence, also through temp-then-rename.
  - `resolveExportAssets` covers the packaged path, the dev path, a missing runtime and a missing model.

- [ ] **Step 2: Run them and watch them fail.** Run V with `tests/electron/worldExport.test.ts` and `tests/electron/verifyPackagedResources.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `export.ts`.**
  - Embed in chunks of 16, checking `signal.aborted` between chunks.
  - Use Node `zlib.gzipSync` and base64 for the blocks.
  - Make `safeJson` replace `<` with `\u003c` inside JSON before compression.
  - Map error codes to the copy above.
  - Index reuse ruling: no userData cache in 2.0. The 30 s index time is acceptable, and a cache adds a stale-index failure mode; record this in the commit body.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/main/world/export.ts`, V on `tests/electron/localEmbedder.test.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: main assembles an offline world page and a documentation file`.

---

### Task 10: IPC, preload and the save dialog

**Files:**
- Create: `src/main/world/exportIpc.ts`
- Modify: `src/main/world/testHooks.ts` (add `testSavePath`)
- Modify: `src/main/world/ipc.ts:1-40` (header comment: list the three new channels and the progress push)
- Modify: `src/main/index.ts`, next to `registerWorldIpc` (2798-2826): call `registerWorldExportIpc`
- Modify: `src/preload/index.ts:286-311` and `src/renderer/src/types/index.ts:721-732`
- Test: `tests/electron/worldExportIpc.test.ts`, `tests/electron/worldTestHooks.test.ts` (or the existing testHooks test)

**Interfaces:**
- Consumes: `exportWorld`, `writeDocument`, `resolveExportAssets`, `describedShare` and `estimateExportBytes` (Task 9); `client.get(root)` and `designs.load(key)` from the existing world deps.
- Produces:
  - Channels:
    - `world:export-info` (`{ root?: string; designKey?: string }`) returns `ok({ title, savedAt: number, smartDefault: boolean, buildings: number, lines: number, smartBytes: number, keywordBytes: number, smartAvailable: boolean, proposals: {id,title}[] })`.
    - `world:export` (`{ exportId, root?, designKey?, smart, proposalId? }`) returns `ok({ path, bytes })`, `err(message)` or `ok({ cancelled: true })`.
    - `world:export-cancel` (`{ exportId }`).
    - `world:document` (`{ root?, designKey?, title, picturePng? }`) returns `ok({ path, bytes })` or `err`.
    - Push `world:export-progress` (`{ exportId } & ExportProgress`).
  - `export function defaultSaveName(title: string, kind: 'world' | 'document'): string`. It gives `<title> - Lumopolis.html` for a world and `<title> - Lumopolis documentation.html` for a document. Characters `\/:*?"<>|` and control characters become `-`, the stem is trimmed to 120 characters, and an empty title becomes `Lumopolis`.
  - `export async function testSavePath(env, read): Promise<string | null | undefined>`. It reads `TERMPOLIS_TEST_WORLD_SAVE_FILE` and is inert unless `NODE_ENV === 'test'`, like `testPickedFolder`.
  - `export interface WorldExportDeps { getWorld(root: string): Promise<WorldDoc | null>; loadDesign(key: string): Promise<WorldDoc | null>; rootFor(key: string): string | null; saveDialog(defaultPath: string): Promise<string | null>; documentsDir: string; homeDir: string; userDataDir: string; assets(): ReturnType<typeof resolveExportAssets>; embed: ExportDeps['embed']; send(channel: string, payload: unknown): void; testSave?: () => Promise<string | null | undefined> }`
  - `export function registerWorldExportIpc(ipc, deps: WorldExportDeps): void`
  - Preload: `worldExportInfo`, `worldExport`, `worldExportCancel`, `worldDocument` and `onWorldExportProgress(cb) => unsubscribe`, typed in `types/index.ts`.
  - Main also handles `world:show-file` (`{ path }`, which calls `shell.showItemInFolder`) and `world:open-file` (`shell.openPath`). The path must be one this session exported (an allowlist set in exportIpc), so the renderer can't open arbitrary paths.

- [ ] **Step 1: Write the failing tests.**
  - `world:export` loads the saved world, not renderer state: `getWorld` is called with the root.
  - The save dialog's default path is `<documentsDir>/<defaultSaveName>`. A cancelled dialog returns `ok({ cancelled: true })` and writes nothing.
  - Progress pushes carry the `exportId`, and `world:export-cancel` aborts that export only.
  - `world:export-info` reports `smartAvailable: false` when assets are missing.
  - `world:open-file` with a path that was not exported returns `err('That file was not exported here.')`.
  - Review Focus 4: `defaultSaveName('a/b: c?', 'world') === 'a-b- c- - Lumopolis.html'`; `''` gives `'Lumopolis - Lumopolis.html'`; a 300-character title gives a stem of 120 characters.
  - `testSavePath` is inert without `NODE_ENV=test`, returns the file's text in a test run, and treats empty text as a cancel.

- [ ] **Step 2: Run them and watch them fail.** Run V on both test files. Expected: FAIL.

- [ ] **Step 3: Implement it.** In `index.ts`:
  - `saveDialog` is `dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'Web page', extensions: ['html'] }] })`;
  - `testSave` is `testSavePath(process.env, read)`;
  - `embed` is `embedBatch`;
  - `documentsDir` is `app.getPath('documents')`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/main/world/exportIpc.ts` and `src/main/world/testHooks.ts`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: export and documentation requests reach main and save where the person chooses`.

---

### Task 11: The Export menu, the two dialogs and the Command Palette entries

**Files:**
- Create: `src/renderer/src/components/World/ExportMenu.tsx`, `ExportDialog.tsx`, `DocumentDialog.tsx`
- Modify: `src/renderer/src/components/World/WorldToolbar.tsx:9-42` (props) and the right-hand group before `world-build-it-open`
- Modify: `src/renderer/src/components/World/WorldView.tsx`:
  - mount the dialogs next to `BuildItDialog`;
  - hide Export on `home`;
  - capture the picture from the open viewer's canvas (`toDataURL('image/png')`), skipped with no WebGL.
- Modify: `src/renderer/src/components/CommandPalette/CommandPalette.tsx:41` (two entries after `show_world`) and `src/renderer/src/App.tsx:1002-1032`
- Test: `tests/renderer/world/ExportDialog.test.tsx`, `tests/renderer/world/DocumentDialog.test.tsx`, `tests/renderer/world/WorldToolbar.test.tsx` (or `WorldParts.test.tsx`), `tests/renderer/world/WorldView.test.tsx`, and the CommandPalette and App tests that cover `show_world`

**Interfaces:**
- Consumes: the preload APIs from Task 10.
- Produces:
  - `WorldToolbarProps.onExport?: (kind: 'world' | 'document') => void`. When absent, no Export button.
  - `ExportMenu`: a button with `data-testid="world-export"`, the icon `fa-solid fa-file-export` and the word `Export`. Its menu (`data-testid="world-export-menu"`, same pattern and style as the bookmarks menu) has the items `Interactive world (HTML)…` (`world-export-world`) and `Documentation (HTML)…` (`world-export-document`).
  - `ExportDialog` props `{ root?: string; designKey?: string; labelling: boolean; onClose(): void }`, with `data-testid="world-export-dialog"`. Copy, verbatim from spec §5.2:
    - title `Export Lumopolis world`;
    - `Whole world` / `Proposal:`;
    - `Include smart Ask (works offline, adds ~35 MB)`;
    - `Finds the parts that match a question by meaning.`;
    - `Includes cards, tours, layers and themes. Not included: your conversation, and file paths outside the project.`;
    - `About <n> MB`;
    - `Cancel`, `Export…`;
    - steps `Preparing the map`, `Indexing <N> parts for smart Ask`, `Writing the file`;
    - the low-coverage note `Most parts aren't described yet, so smart Ask would mostly match file names. Re-label the world first, or export with keyword Ask.`;
    - while labelling, `Uses the map as it was saved at <time>; labelling is still running.`
  - `DocumentDialog` props `{ root?: string; designKey?: string; projectName: string; picture(): string | null; onClose(): void }`, with `data-testid="world-document-dialog"`. Its fields are Title (prefilled with `projectName`), `Include the city picture` and `Save…`.
  - The finish toast is `Exported <file name> (<n> MB)` with `Show in folder` and `Open`, using the pane's existing notice slot (`data-testid="world-notice"`).
  - Command Palette:
    - `{ pattern: /^\s*export\s+(the\s+)?(lumopolis|world)\b/i, action: 'world_export', label: 'Export Lumopolis world', … }`
    - `{ pattern: /^\s*(generate\s+)?(lumopolis\s+)?documentation\b/i, action: 'world_document', label: 'Generate Lumopolis documentation', … }`
  - `WorldViewProps.exportRequest?: { kind: 'world' | 'document'; seq: number }`. App sets it with `worldPane.open()`, and WorldView opens the matching dialog when `seq` changes. This survives the pane mounting after the palette closes.

- [ ] **Step 1: Write the failing tests.**
  - The toolbar shows Export only with `onExport`, and the menu items call `onExport('world')` and `onExport('document')`.
  - On `home`, WorldView renders no `world-export`.
  - `ExportDialog`:
    - with `smartDefault: false` the switch is off and the note shows;
    - with `true` it is on and there is no note;
    - the size line updates when the switch toggles;
    - `labelling` shows the saved-at line;
    - Export calls `worldExport` with `smart` and `proposalId`;
    - progress events advance the steps;
    - Cancel calls `worldExportCancel`;
    - `err` shows its sentence;
    - `smartAvailable: false` disables the switch and shows the keyword-only sentence;
    - success raises the toast, and its buttons call `world:show-file` and `world:open-file`.
  - `DocumentDialog`: the title is prefilled, the checkbox passes `picturePng`, and success raises the toast.
  - The palette: `'export lumopolis world'` gives `world_export`, `'generate documentation'` gives `world_document`, and `'lumopolis'` still gives `show_world`.
  - App: `world_export` opens the pane and passes `exportRequest`.

- [ ] **Step 2: Run them and watch them fail.** Run V on those test files. Expected: FAIL.

- [ ] **Step 3: Implement the components.** Use the toolbar's `btn` class, the bookmarks menu's pattern, and the existing dialog fit rules (`tests/renderer/world/dialogFit.test.ts`).

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on the three new components, `WorldToolbar.tsx` and `WorldView.tsx`, then TSC and LINT.

- [ ] **Step 5: Commit.** Subject: `lumopolis: an Export button saves the world as a page or as documentation`.

---

### Task 12: Page e2e across browsers, the smart quality gate and CI wiring

**Files:**
- Create:
  - `playwright.export.config.ts`: `testDir: 'e2e/export-page'`, `testMatch: '**/*.page.ts'` (so `playwright.config.ts`, which matches `*.spec.ts`, never picks these up), `globalSetup: 'e2e/export-page/globalSetup.ts'`, and the projects `electron`, `msedge` (`channel: 'msedge'`, Windows only), `firefox` and `webkit`.
  - `e2e/export-page/globalSetup.ts`: Playwright runs TS itself. It imports `exportWorld`, `writeDocument` and the real `embedBatch`, and writes `test-results/export-fixture/{smart,keyword,document}.html` from `tests/fixtures/world/termpolis.world.json`.
  - `e2e/export-page/electronHost.cjs`: opens `process.argv` file in a `BrowserWindow`.
  - `e2e/export-page/page.page.ts`, `smart.page.ts`, `fallback.page.ts`
- Modify: `tests/electron/worldAskQuality.test.ts` (smart and fused gate), and add `tests/electron/worldExportEmbedParity.test.ts`
- Modify: `.github/workflows/test.yml`:
  - `package-verify` computes `sha256` of `resources/models/bge-small-en-v1.5/onnx/model_quantized.onnx` after download, saves `resources/models` with `actions/cache/save` under `bge-small-<sha>`, and exposes the key as a job output.
  - It also runs the quality gate and the parity test with `TERMPOLIS_REQUIRE_MODEL=1`.
  - It runs `npm run build:world-viewer` before packaging.
  - A new job, `export-page`, runs on Windows, macOS and Ubuntu with `needs: package-verify`. It restores with `fail-on-cache-miss: true`, installs Firefox and WebKit with `npx playwright install --with-deps firefox webkit` (Ubuntu only), runs `npm run build:world-viewer`, then `npx playwright test -c playwright.export.config.ts` with the project list per OS.
- Modify: `.github/workflows/release.yml` and any other workflow that runs `electron-builder` without `npm run build`: run `npm run build:world-viewer` first. Find them with the Grep tool for `electron-builder` in `.github/workflows/`.

**Interfaces:**
- Consumes: the page contract and `window.__worldExport` (Task 8), and `exportWorld` and `writeDocument` (Task 9).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests.** Every page test routes `**/*` to abort and logs `page.on('request')`. The assertion: the requests other than the page's own `file://` URL and `data:` or `blob:` URLs number zero.
  - `page.page.ts` (all projects):
    - the city paints (canvas non-blank via a pixel sample);
    - with WebGL disabled (`--disable-gpu --disable-webgl`, or `context.addInitScript` stubbing `getContext` to return null), the 2D fallback shows and keyword Ask answers;
    - a card opens on click, and no `data-confirm` is present;
    - a tour runs;
    - one Esc clears the selection, and a second does nothing harmful;
    - keyword Ask answers before smart is ready;
    - clicking a result flies to it and opens its card.
  - `smart.page.ts` (`electron` and `msedge` blocking; `firefox` and `webkit` accept `'failed'` with the fallback sentence):
    - `await page.evaluate(() => window.__worldExport.ready)` resolves to `'smart'` in under 6000 ms;
    - the three questions `'how does the phone connect to my desktop'`, `'where are passwords and API keys kept safe'` (from `askQuestions.json`) and one more from that file each list an accepted id in the top 3.
  - `fallback.page.ts`: `context.addInitScript` makes `WebAssembly.instantiate` reject. The box then says `"Smart Ask couldn't start in this browser; using keyword search."` and keyword still answers.
  - CSP allowances: one test per allowance loads a copy of `smart.html` with that allowance removed and expects smart Ask to report `'failed'`. This proves each allowance is required: `'wasm-unsafe-eval'`, `blob:` in `worker-src`, `data:`/`blob:` in `img-src`.
  - Budgets:
    - `smart.html` is under `40 * 1024 * 1024` bytes;
    - `keyword.html` is under `1.5 * 1024 * 1024` bytes plus the fixture JSON's size.
  - `worldAskQuality.test.ts`: `it('smart or fused Ask finds the right part in the top 3 for at least 12 of 15 questions')` uses the real `embedBatch`. It runs only when the model is present, and with `TERMPOLIS_REQUIRE_MODEL=1` a missing model fails instead of skipping. Put the guard inside the `it`, not as a `describe.skipIf` (the false-green trap in `reference_vitest_run_gotchas`). It also prints smart-only and fused scores.
  - `worldExportEmbedParity.test.ts`: the page's `startSmartAsk` (under Node with the real ORT and model bytes) and the main embedder's `embedText(q, { isQuery: true })` agree to cosine ≥ 0.999 on five fixture questions.

- [ ] **Step 2: Run them and watch them fail.** Run `npm run build:world-viewer && npx playwright test -c playwright.export.config.ts --project=electron`. Expected: FAIL at first, because globalSetup's import or a selector doesn't exist yet. Fix the harness only, never the assertions.

- [ ] **Step 3: Implement the fixes and the choices the gate decides.**
  - Set `FUSE` and `TEST_RANK_FACTOR` in `askIndex.ts` from the gate numbers.
  - Keep a CSP allowance only if its test proves it is needed. Remove any that is not, and say so in the commit body.

- [ ] **Step 4: Run the tests and make sure they pass.**
  - Locally: the `electron` and `msedge` projects, the quality gate and parity with `TERMPOLIS_REQUIRE_MODEL=1` (V), then TSC and LINT.
  - Push, and confirm the `export-page` job is green on all three operating systems. Use `gh run watch` and then `gh run view --json conclusion`.

- [ ] **Step 5: Commit.** Subject: `lumopolis: an exported page is proven offline in four browsers, with a quality gate on Ask`. Record the gate numbers (smart, fused and keyword, out of 15), the chosen ranking and the measured Ask-ready time in the body.

---

### Task 13: App e2e, the Defender scan and the proof video

**Files:**
- Create: `e2e/world-export.spec.ts`
- Modify: `.github/workflows/test.yml`, adding `npx playwright test e2e/world-export.spec.ts` to `e2e-smoke-macos`'s explicit list (`e2e-full` and `e2e-windows` run the whole directory)
- Modify: `.github/workflows/defender-scan.yml`. Generate one smart export and one document with the Task 12 globalSetup (`npx playwright test -c playwright.export.config.ts --list` runs globalSetup), add both files to the scanned set, and fail the job on any detection, as for installers.
- Modify: `docs/DOCUMENTATION.md`, adding a Lumopolis export section with the spec §8 limits stated plainly (about 37 MB; finds parts and does not write answers; 150–250 MB of tab memory; phones are not a target)

**Interfaces:**
- Consumes:
  - `TERMPOLIS_TEST_WORLD_SAVE_FILE` (Task 10);
  - the world e2e helpers in `e2e/world-view.spec.ts`;
  - `TERMPOLIS_TEST_WORLD_PICK_FILE`.
- Produces: the proof video `test-results/world-export-proof/*.webm`, kept local and not committed.

- [ ] **Step 1: Write the failing test.** `e2e/world-export.spec.ts`:
  - Export ▸ Interactive world ▸ Export…, with the save file stubbed, writes the file. Opening it in a new Electron window passes `window.__worldExport.ready` and one keyword Ask.
  - Export ▸ Documentation writes a file containing `How ` + the project name, the `CARD_HEADINGS.whatItDoes` heading and one known card sentence from the mapped fixture project.
  - On an unlabelled world, the dialog shows the low-coverage note and the switch is off.
  - The palette `export lumopolis world` opens the dialog.

- [ ] **Step 2: Run it and watch it fail.** Run E2E with `e2e/world-export.spec.ts` (with the tw3/tw4 swap, restored afterwards). Expected: FAIL only where wiring is missing. Fix the wiring, not the assertions.

- [ ] **Step 3: Implement the fixes, the CI edits and the docs section.**

- [ ] **Step 4: Run it and make sure it passes.**
  - E2E for `e2e/world-export.spec.ts` and `e2e/world-view.spec.ts` locally.
  - Push, and confirm Tests (e2e-full, e2e-windows, e2e-smoke-macos, export-page) and Defender scan are green with `gh run view --json conclusion`.
  - Record the proof video: run the spec with `video: 'on'` through an added `PROOF=1` branch. Export, document, open both files offline, and ask three questions. Give David the path.

- [ ] **Step 5: Commit.** Stage `e2e/world-export.spec.ts`, the workflow files and `docs/DOCUMENTATION.md`. Subject: `lumopolis: the real app exports a world and its documentation, checked in CI and by Defender`.

---

## Self-review

- **Spec coverage:**

  | Spec section | Tasks |
  |---|---|
  | §5.1 (toolbar, palette, availability, hidden on home) | 11 |
  | §5.2 (dialog, 80% default, estimate, save, progress, cancel, errors, keyword fallback) | 9, 10, 11 |
  | §5.3 file layout and CSP | 9, 12 |
  | §5.3 runtime and controls | 8 |
  | §5.3 read-only cards | 3 |
  | §5.3 Ask box copy | 8 |
  | §5.3 index | 5, 9 |
  | §5.3 sanitising | 4 |
  | §5.4 documentation | 2, 6, 7, 9, 10, 11 |
  | §5.5 layout and packaging | 8, 9, 12 |
  | §6 unit | 4–9 |
  | §6 page e2e, blocking choice, Defender, quality gate, budgets | 12, 13 |
  | §6 app e2e and proof | 13 |
  | §7 builder choices | 5, 9, 12 (threshold, factor, fusion), 9 (no cache), 7 (SVG layout), 8 (bookmarks hidden), 9 (paths) |
  | §8 limits | 13 |
  | Unscoped memory defect | 1 |

- **Step scan:** every code step names a file, a signature and the pinned values; there are no bodies beyond the fixed copy.
- **Types:** these names are used the same way across tasks: `SanitizeContext`, `AskEntry`, `PackedVectors`, `ExportAssets`, `ExportProgress`, `ExportResult`, `CARD_HEADINGS`, `readOnly` and `exportRequest`.
- **Review Focus:** each of the five lines has its test in Tasks 4, 9, 9, 10 and 5/8.
- **Proportion:** the plan holds signatures, tests and copy only.
