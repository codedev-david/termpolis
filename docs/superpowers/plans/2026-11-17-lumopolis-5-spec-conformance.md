# Lumopolis 5: Spec Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap between Lumopolis and its approved design spec that the Plan 4 spec audit found and that is still in scope, so that Lumopolis is "100% to the design".

**Architecture:** Each task fixes one visible part of Lumopolis inside the existing layers, and adds no new layer:
- the shared world contract (`src/shared/world/`);
- the compiler and world host (`src/main/world/`);
- the engine (`src/renderer/src/world/engine/`);
- the pane (`src/renderer/src/components/World/`).

Spec rulings that need no code (naming and storage shape) go into the spec in Task 16, so the spec and the code agree.

**Tech Stack:** Electron, React 18, Three.js 0.160, TypeScript, Vitest (jsdom for the renderer), Playwright e2e on Electron with SwiftShader.

**Spec:** `docs/superpowers/specs/2026-11-15-world-view-design.md`. The gaps come from `.superpowers/sdd/2026-11-16-lumopolis-4-sources-design-build/spec-audit.md` (requirement table, plus "Gaps" items 1–29). Gap ids such as `#101` below are that table's row numbers.

## Global Constraints

- User-facing copy says "Lumopolis"; code uses `world`.
- World folders stay at 100% coverage. The repo gate is lines 97 / functions 96 / branches 95 / statements 96, and is never lowered.
- Only real in-app UI, never "open a terminal and type".
- The MCP tool-description budget is nearly full: new agent tools go through the trusted gateway (`lumopolis/...` via gateway_call), not new top-level MCP tools.
- Hosted US models only (Claude Code / Codex / Gemini CLI).
- No sync fs or long work on the Electron main thread.
- Never `npm install`. Renderer target is ES2020 (no `.at`).
- Commit directly to main.
- Test-only hooks are inert unless NODE_ENV==='test' or the probe flag is set.

**Plan-wide conventions:**

- **Unit test run (`V`):** `unset PROMPT_COMMAND TERMPOLIS_LIMIT_CHOOSER && export PATH="/c/Program Files/Git/cmd:$PATH" && npx vitest run <files>`
- **Scoped coverage (`COV`):** `V` plus `--coverage --coverage.include=<each changed file under src/shared/world, src/main/world, src/renderer/src/world/engine, src/renderer/src/components/World>`. Expected: every listed file shows 100 / 100 / 100 / 100.
- **Typecheck (`TSC`):** `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false`. Expected: no output.
- **e2e (`E2E`):** run `npx electron-vite build` once. Then run `TERMPOLIS_E2E_PREBUILT=1 npx playwright test <spec>`. Never rebuild `out/` while Playwright is running.
- **Commit:**
  - Run `git pull --rebase --autostash` first.
  - Write the message to a temp file and commit with `git commit -F <file>`. Never use `-m @'…'@`.
  - The message starts `lumopolis: ` and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Test locations:** renderer tests go in `tests/renderer/world/`, main tests in `tests/electron/`, shared tests in `tests/shared/`. Fixtures go in `tests/shared/fixtures/world.min.json` and `world.grown.json`.
- **Agent output:** never use `innerHTML` with agent output. Card and answer HTML is built only through `escapeHtml` (`src/renderer/src/world/engine/html.ts`).
- **Rule that replaces a Plan 1–2 constraint:** the ask prompt was capped at "12,000 characters, summary 1,200". Task 7 replaces that with a token budget (`ASK_TOKEN_BUDGET = 3000`, `MAX_SUMMARY_TOKENS = 300`, estimated at 4 characters per token), as spec §5.6 requires.

**Out of scope (by instruction):**
- #117 and everything in final-review.md: I1–I6, which covers #122, and the minors M1–M9.
- Website items (Plan 3).
- Spec-deferred items #6, #7, #8, #72 and #83.

## Review Focus

1. **A narrow window with Lumopolis open (1000 px wide or less).** The pane shrinks down to `WORLD_PANE_MIN_PX`, and the terminals always keep at least `TERMINAL_MIN_PX`. Making the window smaller never covers or hides the terminals. Test in Task 1.
2. **A world saved before this plan.** It has no `claims`, `nameState` or `labelTokens`. It still loads, validates and shows cards, with no console error and no forced recompile. Test in Task 5.
3. **The chosen Lumopolis agent is not installed** (for example, Codex is selected but missing). The question ends quickly with "Codex isn't installed. Choose another agent in Settings › Lumopolis." It never spins until the 90 s deadline. Test in Task 4.
4. **Hostile `world_annotate` input**: an unknown id, text over the cap, `state: "verified"`, a path outside the repository, or 1,000 evidence items. Unknown ids are refused with a message. Text and evidence are capped. The state is forced to `observed`. Paths are reduced to repository-relative. Test in Task 13.
5. **An answer that both fogs and highlights the same part.** The part stays fogged, and the highlight shows as a ring on the fog, never as a solid building. Test in Task 2.

---

### Task 1: Lumopolis is a pane beside the terminals (#2)

**Files:**
- Modify: `src/renderer/src/components/World/worldPane.tsx` (the whole `worldPaneStyle`)
- Modify: `src/renderer/src/components/World/WorldView.tsx` (the modal `role="dialog"` and `useFocusTrap`)
- Modify: `src/renderer/src/App.tsx:1231-1239` (moves into the flex row after `<main>`, as a sibling, the same way `ChangesPanel` sits)
- Create: `src/renderer/src/components/World/WorldPaneDivider.tsx`
- Test: `tests/renderer/world/worldPane.test.ts`, `tests/renderer/world/AppWorld.test.tsx`, `tests/renderer/world/WorldView.test.tsx`, `e2e/world-view.spec.ts`

**Interfaces:**
- Produces:
  - `WORLD_PANE_MIN_PX = 360`, `TERMINAL_MIN_PX = 320`, `WORLD_PANE_DEFAULT_FRACTION = 0.5`
  - `clampWorldPaneWidth(px: number, rowWidth: number): number`
  - `loadWorldPaneWidth(): number | null` and `saveWorldPaneWidth(px: number): void`, stored in localStorage under `termpolis.world.paneWidth`, with every access wrapped in try/catch
  - `worldPaneStyle(background: string, width: number): React.CSSProperties`, which returns `{ position: 'relative', flex: '0 0 auto', width, minWidth: WORLD_PANE_MIN_PX, background }`, with no `fixed` and no `zIndex`
  - `WorldPaneDivider({ onDrag(dx: number): void })`, a 4 px `role="separator"` `aria-orientation="vertical"` handle. ArrowLeft and ArrowRight move it 24 px.

- [ ] **Step 1: Write the failing tests**

```ts
// worldPane.test.ts
test('clampWorldPaneWidth keeps the terminals at TERMINAL_MIN_PX', () => {
  expect(clampWorldPaneWidth(900, 1000)).toBe(680)
  expect(clampWorldPaneWidth(100, 1000)).toBe(360)
  expect(clampWorldPaneWidth(500, 600)).toBe(360) // the pane minimum wins when both cannot fit
})
test('worldPaneStyle is a flex sibling, never an overlay', () => {
  const s = worldPaneStyle('#03050a', 500)
  expect(s.position).toBe('relative'); expect(s.zIndex).toBeUndefined(); expect(s.width).toBe(500)
})
test('a corrupt or throwing localStorage gives null and never throws', ...)
// AppWorld.test.tsx
test('opening Lumopolis keeps the terminal area rendered beside the pane', () => {
  // render App, dispatch termpolis:openWorld
  expect(screen.getByTestId('world-view').parentElement).toBe(screen.getByRole('main').parentElement)
  expect(screen.getByRole('main')).toBeVisible()
})
// WorldView.test.tsx
test('the pane is a region, not a modal dialog', () => {
  expect(screen.getByRole('region', { name: 'Lumopolis' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).toBeNull()
})
test('Esc closes the card only while focus is inside the pane; Esc in a terminal is left alone', ...)
test('dragging the divider by -100 px widens the pane by 100 px and saves it', ...)
```

Add e2e test `7. the terminal stays visible and takes typing while Lumopolis is open` to `world-view.spec.ts`:
- Open the pane.
- Click the terminal. Type `echo beside`.
- Expect `beside` in the terminal output.
- Expect the bounding boxes of `[data-testid="world-view"]` and the terminal not to overlap.

- [ ] **Step 2: Run them and see them fail**

Run `V tests/renderer/world/worldPane.test.ts tests/renderer/world/AppWorld.test.tsx tests/renderer/world/WorldView.test.tsx`. Expected: FAIL (`clampWorldPaneWidth` is not exported, and the dialog role is still there).

- [ ] **Step 3: Implement it**
  - `App.tsx` renders `{showWorld && <><WorldPaneDivider/><Suspense …><WorldView …/></Suspense></>}` after `</main>`, inside the same flex row.
  - Width is `clampWorldPaneWidth(saved ?? row * WORLD_PANE_DEFAULT_FRACTION, row)`. It is clamped again on `resize`.
  - `WorldView` keeps its Esc handling, but scoped to `onKeyDown` on the pane root.
  - The first paint (`WorldPaneOpening`) uses the same style.

- [ ] **Step 4: Run the tests and see them pass**

Run `COV` on the three files, then `TSC`, then `E2E e2e/world-view.spec.ts`. Expected: all PASS, and the World files are at 100%.

- [ ] **Step 5: Commit** with the message `lumopolis: a pane beside the terminals, resizable, not an overlay`

---

### Task 2: Honesty rule (#101)

**Files:**
- Modify: `src/shared/world/types.ts` (`WorldAction`)
- Modify: `src/shared/world/answerProtocol.ts` (`ANSWER_PROTOCOL`, `cleanAction`, `WorldAnswer`, `parseAnswer`)
- Modify: `src/main/world/askContext.ts` (`ROLE`)
- Modify: `src/renderer/src/world/engine/sceneModel.ts` (`buildSceneModel` opts)
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts` (`apply`, `WorldDrawn`)
- Modify: `src/renderer/src/components/World/WorldAnswer.tsx`
- Test: `tests/shared/worldAnswerProtocol.test.ts`, `tests/electron/worldAskContext.test.ts`, `tests/renderer/world/sceneModel.test.ts`, `tests/renderer/world/createWorldViewer.test.ts`, `tests/renderer/world/WorldAsk.test.tsx`, `e2e/world-ask.spec.ts`, `e2e/mocks/mock-claude.cjs`

**Interfaces:**
- Produces:
  - `WorldAction` adds `| { type: 'fog'; ids: string[] }`.
  - `WorldAnswer` becomes `{ text; actions; evidence; dropped; unsupported: string[]; uncited: boolean }`. `unsupported` holds the ids from fog steps. `uncited` is true when the text is not empty and carries no `[E<n>]` marker.
  - `HONESTY_RULE: string`, exported from `answerProtocol.ts`.
  - `buildSceneModel(doc, layers, opts?: { revealProposal?: string; fogged?: ReadonlySet<string> })`: an id in `fogged` gets `look: 'fog'` whatever its claims say.
  - `WorldDrawn.fogged: string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('ANSWER_PROTOCOL carries the honesty rule and the fog step', () => {
  expect(ANSWER_PROTOCOL).toContain(HONESTY_RULE)
  expect(ANSWER_PROTOCOL).toContain('{"type":"fog","ids":[...]}')
})
test('a fog step keeps known ids, drops unknown ones and fills unsupported', () => {
  const a = parseAnswer('Nothing records why. [E1]\n```world-actions\n[{"type":"fog","ids":["b1","nope"]}]\n```', doc, labels)
  expect(a.actions).toEqual([{ type: 'fog', ids: ['b1'] }]); expect(a.unsupported).toEqual(['b1']); expect(a.dropped).toBe(1)
})
test('an answer with no [E<n>] marker is uncited', () => expect(parseAnswer('It is fast.', doc, labels).uncited).toBe(true))
test('ROLE tells the agent to say so when the evidence does not support an answer', () => expect(ROLE).toMatch(/say so/))
test('buildSceneModel: a fogged id is fog even when its claims are verified', ...)
test('viewer.apply(fog) fogs the ids until the next reset; a highlight of a fogged id keeps the fog look', () => {
  // drawn().fogged equals ['b1'] after apply fog, and after apply highlight b1; after resetView it is []
})
test('WorldAnswer shows "The evidence doesn\'t say" when unsupported is non-empty, and "This answer cites no evidence" when uncited', ...)
```

`HONESTY_RULE` text, exactly: `If the WORLD DATA and evidence do not support an answer (for example nothing records why something was built this way), say so plainly in your first sentence, do not guess, and add {"type":"fog","ids":[...]} for the parts you could not support.`

Add e2e test `5. an unsupported answer says so and leaves its building fogged` to `world-ask.spec.ts`. When the question contains `why`, `mock-claude.cjs` replies with a fog step for the first building id in the prompt. The test expects the answer text to contain "evidence doesn't say", and `__termpolis_world.drawn().fogged` to contain that id.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the five unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** The viewer keeps `fogged: Set<string>`. It is cleared by `reset`, by `resetView()` and by the next `load()`. `useWorldAsk` calls `viewer.apply({ type: 'reset' })` before it plays a new answer, so an old answer's fog does not carry over to the next one.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-ask.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: honesty rule; unsupported answers say so and stay fogged`

---

### Task 3: Token cost is visible (#14)

**Files:**
- Create: `src/shared/world/tokens.ts`
- Modify: `src/shared/world/types.ts` (`AskResult`, `DesignDraftResult`, `DesignRefineResult`, `WorldDoc`)
- Modify: `src/main/world/askRunner.ts`, `src/main/world/designer.ts`, `src/main/world/label.ts` (`labelWorld`, `Labels`), `src/main/world/compile.ts` (copies `labels.tokens`)
- Modify: `src/renderer/src/components/World/useWorldAsk.ts`, `WorldAsk.tsx`, `WorldToolbar.tsx`, `src/renderer/src/components/SettingsPane/LumopolisSettings.tsx`
- Test: `tests/shared/worldTokens.test.ts`, `tests/electron/worldAskRunner.test.ts`, `tests/electron/worldDesigner.test.ts`, `tests/electron/worldLabel.test.ts`, `tests/electron/worldCompile.test.ts`, `tests/renderer/world/WorldAsk.test.tsx`, `tests/renderer/world/WorldView.test.tsx`, `tests/components/LumopolisSettings.test.tsx`

**Interfaces:**
- Produces:
  - `estimateTokens(text: string): number`, which is `Math.ceil(text.length / 4)`.
  - `formatTokens(n: number): string`:
    - `0` gives `'no tokens'`;
    - `840` gives `'about 840 tokens'`;
    - `3150` gives `'about 3.2k tokens'`;
    - `1_250_000` gives `'about 1.3M tokens'`.
  - The `ok` arm of `AskResult` adds `tokens: number`.
  - `DesignDraftResult` and `DesignRefineResult` add `tokens: number`.
  - `Labels.tokens: number` counts only model calls that missed the cache, prompt plus reply.
  - `WorldDoc.labelTokens?: number` (optional, so saved worlds stay valid).
- Ruling: the CLIs do not report usage in the text mode that `runHeadless` uses. Every figure is therefore an estimate, and the copy always says "about".

- [ ] **Step 1: Write the failing tests**

```ts
test('formatTokens', () => { expect(formatTokens(0)).toBe('no tokens'); expect(formatTokens(3150)).toBe('about 3.2k tokens') })
test('askRunner reports tokens = estimate(prompt) + estimate(output)', ...)  // exec stub returns output 'x'.repeat(400) => tokens >= 100
test('labelWorld counts only uncached calls', ...)  // second run with a warm cache => tokens === 0
test('compile copies labels.tokens to doc.labelTokens', ...)
test('the Ask bar shows "This answer: about 1.0k tokens · this session: about 2.0k tokens" after two answers', ...) // testid world-ask-cost
test('the toolbar shows "Describing parts: about 42k tokens on the last update", or "cached, no tokens" at 0, and nothing while labelling is off', ...) // testid world-label-cost
test('Settings › Lumopolis explains the cost', () => expect(screen.getByText(/Lumopolis shows an estimate after each one/)).toBeInTheDocument())
```

Settings copy, exactly: `Describing parts and asking questions use tokens on your own agent account. Lumopolis shows an estimate after each one.`

- [ ] **Step 2: Run them and see them fail.** Run `V` on the eight files. Expected: FAIL.
- [ ] **Step 3: Implement it.** `useWorldAsk` keeps `sessionTokens`, which resets when the world key changes. The design's Ask bar shows the same line, using the design results' `tokens`.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: show the estimated token cost of labelling, questions and designs`

---

### Task 4: Your agent, model, primer and proxy for every Lumopolis run (#96, #22, #61 model)

**Files:**
- Modify: `src/main/world/worldSettings.ts` (`WorldSettings`, plus `DEFAULT_WORLD_SETTINGS` with `worldAgent: 'claude'`)
- Modify: `src/main/headlessExec.ts` (`ExecRequest.baseUrl`, Codex argv)
- Modify: `src/main/world/askRunner.ts` (`AskRunnerDeps`)
- Modify: `src/main/world/designer.ts` (`DesignerDeps`)
- Modify: `src/main/world/ipc.ts` (`world:ask`, `world:design-draft`, `world:design-refine` accept `model`)
- Modify: `src/main/index.ts:2614-2662` (labelling `llm`), `:2700-2712` (ask runner), `:2632-2640` (designer)
- Modify: `src/shared/world/types.ts` (`AskRequest.model?: string`)
- Modify: `src/renderer/src/components/World/useWorldAsk.ts`, `DesignStart.tsx`, `src/renderer/src/components/SettingsPane/LumopolisSettings.tsx`
- Test: `tests/electron/worldSettings.test.ts`, `tests/electron/headlessExec.test.ts`, `tests/electron/worldAskRunner.test.ts`, `tests/electron/worldDesigner.test.ts`, `tests/electron/worldIpc.test.ts`, `tests/renderer/world/useWorldAsk.test.ts`, `tests/components/LumopolisSettings.test.tsx`

**Interfaces:**
- Consumes: `estimateTokens` (Task 3).
- Produces:
  - `WorldSettings.worldAgent: ExecAgent`. An unknown value on disk becomes `'claude'`.
  - `ExecRequest.baseUrl?: string` (Codex only). It becomes `-c openai_base_url="<url>"`, TOML-quoted the same way `codexLinkedJobMarker` quotes. Other agents ignore it.
  - `AskRunnerDeps` adds:
    - `agent(): ExecAgent`
    - `runEnv(agent: ExecAgent, cwd: string): Promise<{ env: Record<string, string>; baseUrl?: string }>`
    - `primer(cwd: string): Promise<string | null>`
  - `DesignerDeps` adds `agent` and `runEnv`, but no primer. Ruling: a design runs in an empty folder with no project to prime from.
  - `agentMissingMessage(agent: ExecAgent): string`, which gives `"<Name> isn't installed. Choose another agent in Settings › Lumopolis."`.
  - In `index.ts`, `worldRunEnv(agent, cwd)`:
    - claude: `{ env: (await claudeLaunchEnv(cwd)) ?? {} }`
    - codex: `{ env: {}, baseUrl: (await codexLaunchUrl('lumopolis', undefined)) ?? undefined }`
    - gemini: `{ env: {} }`
- Ruling, Gemini: Headroom has no Gemini route for any Termpolis launch, so a Gemini world run goes direct, the same as a Gemini terminal does. Task 16 amends spec §3 to match.
- Ruling, #61: spec §10 says labelling follows "a per-user default-agent setting" once one exists. `worldAgent` is that setting. Labelling uses `cheapModelFor(worldAgent, modelCatalog)`, and goes through `worldClaudeExec` for Claude or through `runHeadless` with `worldRunEnv` for the other agents.

- [ ] **Step 1: Write the failing tests**

```ts
test('worldSettings: worldAgent defaults to claude; "codex" round-trips; "llama" on disk reads as claude', ...)
test('runHeadless(codex, baseUrl) passes -c openai_base_url="http://127.0.0.1:9/x" before the prompt token; claude ignores baseUrl', ...)
test('askRunner runs the settings agent with the request model, the runEnv env and baseUrl, the primer dep, write:false, noRemember:true', () => {
  expect(exec).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', model: 'gpt-5.5-mini', env: { A: '1' }, baseUrl: 'u', write: false, noRemember: true }),
    expect.objectContaining({ primer: expect.any(Function) }))
})
test('an unsafe model id in the request is dropped, not passed', ...)  // 'x; rm' => model undefined
test('a missing agent CLI (ENOENT) answers agentMissingMessage at once', ...)  // ok:false, error "Codex isn't installed. Choose another agent in Settings › Lumopolis."
test('designer drafts with the settings agent and model, and without a primer', ...)
test('useWorldAsk sends the Default Models id for the Lumopolis agent; "auto" sends no model', ...)
test('Settings › Lumopolis offers Claude Code, Codex and Gemini CLI, and saves worldAgent', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the seven files. Expected: FAIL.
- [ ] **Step 3: Implement it.** The renderer reads the agent with `worldSettingsGet` and the model with `getAgentModelDefaults()[agent]`. `ipc.ts` checks the model with `isSafeModelId` from `src/main/modelCatalog.ts`. Token estimates (Task 3) add `primerChars / 4`.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` (the World files), then `V tests/electron/headlessExec.test.ts` (repo gate), then `TSC`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `lumopolis: ask, design and labelling use your Lumopolis agent and model, the primer and the proxy`

---

### Task 5: Cards to the spec: claims, states, evidence, tech chips, person confirm (#47 claims, #139, #49, #65, #76, #138)

**Files:**
- Modify: `src/shared/world/types.ts` (`Building`, `WorldEdge`, `District`, `EvidenceKind`)
- Modify: `src/shared/world/validate.ts` (old docs get defaults)
- Create: `src/main/world/annotations.ts`
- Modify: `src/main/world/compile.ts` (observed and verified claims, merged annotations)
- Modify: `src/main/world/testStatus.ts` (exports `testClaims`)
- Modify: `src/main/world/worldClient.ts`, `worldHost.ts`, `ipc.ts` (`world:annotate`)
- Modify: `src/renderer/src/world/engine/cards.ts` (`STATUS`, `claims`, evidence links)
- Modify: `src/renderer/src/components/World/WorldCard.tsx` (`onClick` for `[data-tech]`, `[data-confirm]` and `[data-evidence]`)
- Modify: `src/renderer/src/components/World/WorldView.tsx` (`openTech`)
- Modify: `src/preload/index.ts` (`worldAnnotate`)
- Test: `tests/shared/worldValidate.test.ts`, `tests/electron/worldAnnotations.test.ts`, `tests/electron/worldCompile.test.ts`, `tests/electron/worldTestStatus.test.ts`, `tests/electron/worldIpc.test.ts`, `tests/renderer/world/cards.test.ts`, `tests/renderer/world/WorldParts.test.tsx`, `e2e/world-view.spec.ts`

**Interfaces:**
- Produces:
  - `Building.claims: Claim[]` and `WorldEdge.claims: Claim[]`: the item's facts beyond `how` and `why` (observed, verified and annotations).
  - `Building.nameState: 'observed' | 'inferred'` and `District.nameState: 'observed' | 'inferred'`. `validate` defaults a missing `claims` to `[]` and a missing `nameState` to `'observed'`.
  - `EvidenceKind` adds `'person'`.
  - `annotations.ts`:
    - `MAX_ANNOTATION_TEXT = 400`, `MAX_ANNOTATION_EVIDENCE = 8`, `MAX_ANNOTATIONS_PER_ITEM = 20`
    - `createAnnotationStore(dir: string): { list(key: string): Promise<Record<string, Claim[]>>; add(key: string, itemId: string, claim: Claim): Promise<void> }`, kept in `<userData>/world/annotations/<hash(key)>.json` and written with async fs
  - `testClaims(members: string[], runs: TestRun[], testsByMember: Record<string, string[]>): Claim[]`:
    - all linked runs passed: `{ text: 'Its N linked tests passed', state: 'verified', evidence: test refs }`;
    - some failed: `{ text: 'F of N linked tests failed', state: 'observed' }`;
    - no runs: `[]`.
  - Compile adds an observed claim to each edge, `{ text: 'Seen in code', state: 'observed', evidence: [{ kind: 'file', ref: '<file>:<line>' }] }` (up to 3), and merges the annotations by item id.
  - `WorldClient.annotate(key: string, itemId: string, claim: Claim): Promise<WorldDoc>`, which rejects an unknown id with `'No part with that id.'`.
  - IPC `world:annotate {key, itemId, text}` stores `{ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] }`.
  - `cards.ts`:
    - `STATUS.gap` becomes `'Built · no test results yet'`;
    - every claim renders `<li class="claim" data-state="<state>">text <span class="state">observed|inferred|verified|proposed</span> <button data-evidence="<i>">evidence</button></li>`;
    - an inferred claim gets `<button data-confirm="<itemId>|<claim index>">Confirm</button>`;
    - an AI-named item shows `(name suggested by AI)`.
  - `WorldCard` props add `onTech(techId: string): void`, `onConfirm(itemId: string, text: string): void` and `onEvidence(ev: Evidence): void`.
  - `WorldView.openTech(techId)` runs `viewer.apply({ type: 'openCard', id: 'tech:' + techId })` and `viewer.apply({ type: 'highlight', ids: usesTech(doc, techId) })`.

- [ ] **Step 1: Write the failing tests**

```ts
test('validate fills claims [] and nameState observed on a world saved before this plan', () => {
  const old = loadFixture('world.min.json'); for (const b of old.buildings) { delete (b as any).claims; delete (b as any).nameState }
  const v = validateWorld(old); expect(v.ok).toBe(true); expect(v.doc.buildings[0].claims).toEqual([])
})
test('testClaims: all passed => one verified claim citing the tests; none => []; one failed => observed "1 of 2 linked tests failed"', ...)
test('annotation store caps text at 400 and evidence at 8, keeps 20 per item, and survives a corrupt file', ...)
test('compile merges stored annotations into the item claims and adds Seen in code claims to edges', ...)
test('cards: the gap status reads "Built · no test results yet"', ...)
test('cards: each claim shows its state and an evidence button; inferred claims have Confirm', ...)
test('WorldCard: clicking a chip calls onTech("electron"); Confirm calls onConfirm; evidence calls onEvidence', ...)
test('WorldView: a chip opens the tech card and highlights every building that uses it', ...)
test('world:annotate on an unknown id answers "No part with that id."', ...)
```

Add e2e test `8. clicking a technology chip opens its glossary card and lights up every use` to `world-view.spec.ts`. It opens a building card, clicks its first `[data-tech]` chip, and expects the card title to match the glossary term and `drawn()` to report highlighted ids of 2 or more. (Add `highlighted: string[]` to `WorldDrawn` here.)

- [ ] **Step 2: Run them and see them fail.** Run `V` on the seven unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Evidence opens in the existing evidence panel that `WorldAnswer` uses: one shared `EvidenceView`, moved out of `WorldAnswer.tsx` into `src/renderer/src/components/World/EvidenceView.tsx` (add it to the Files list). Confirm calls `worldAnnotate`, and the pane reloads the returned doc.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-view.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: cards show claim states and evidence, chips open the glossary, a person can confirm`

---

### Task 6: Labelling honesty and richer excerpts (#60, #62, #61 excerpts)

**Files:**
- Modify: `src/main/world/label.ts:209-301` (citations for every field; AI names marked) and `:79-112` (excerpts)
- Modify: `src/main/world/labelPrompt.ts` (asks for `evidence` on every field)
- Modify: `src/main/world/compile.ts` (sets `nameState` from the label)
- Modify: `src/main/world/worldClient.ts` and `worldHost.ts` (the `context` hook relayed from main)
- Modify: `src/main/index.ts` (`createWorldClient` `context` option)
- Test: `tests/electron/worldLabel.test.ts`, `tests/electron/worldCompile.test.ts`, `tests/electron/worldClient.test.ts`, `tests/electron/worldHost.test.ts`

**Interfaces:**
- Consumes: `Building.nameState` and `District.nameState` (Task 5).
- Produces:
  - `LabelDeps.context?: (members: string[]) => Promise<Evidence[]>`, which returns:
    - commit subjects (`kind: 'commit'`, `ref: <sha7>`, excerpt the subject; at most 5 per building, from `git log -n 5 --format=%h%x09%s -- <top 3 members>` via `safeGitAsync`);
    - docs lines (`kind: 'file'`, `.md` files whose text names a member's base name; at most 3);
    - memory decisions (`kind: 'memory'`, the top 3 from the brain's search for the building's code name with kind `decision`).
    - The total stays inside `BATCH_EXCERPT_BUDGET`.
  - Every label field (`name`, `subtitle`, `techLabel`, `rate`, `cargo`, `stack`, `glossary` lines) is now `{ value, evidence: string[] }`. A field with no valid citation keeps its code-derived value.
  - `BuildingLabel.nameInferred: boolean`, true when the AI's name replaced the code name.
  - `CreateWorldClientOptions.context?: (root: string, members: string[]) => Promise<Evidence[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
test('an uncited name, subtitle, techLabel, rate, cargo, stack or glossary line is dropped for the code-derived value', ...)
test('a cited AI rename sets nameInferred, and compile sets nameState "inferred"', ...)
test('the batch prompt carries commit, docs and memory evidence from context, within BATCH_EXCERPT_BUDGET', ...)
test('a context hook that throws or times out labels from file excerpts alone', ...)
test('worldClient relays context requests from the host to the main-side hook', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the four files. Expected: FAIL.
- [ ] **Step 3: Implement it.** The label cache hash includes the context evidence refs, so a new commit relabels only the buildings it touches. Bump the label cache version constant in `label.ts`, so cached replies from before this task (which have no citations) are not reused.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: labelling cites every field, marks AI names, and reads commits, docs and decisions`

---

### Task 7: Asking: active proposal, token budget, tap-or-hold voice (#95, #94)

**Files:**
- Modify: `src/main/world/askContext.ts` (`MAX_PROMPT_CHARS` and `MAX_SUMMARY_CHARS` give way to token budgets; new PROPOSAL section)
- Modify: `src/shared/world/types.ts` (`AskRequest.proposalId?: string`)
- Modify: `src/main/world/askRunner.ts` (passes the proposal)
- Modify: `src/renderer/src/components/World/useWorldAsk.ts` (sends `proposalId`) and `WorldAsk.tsx` (mic pointer events)
- Test: `tests/electron/worldAskContext.test.ts`, `tests/electron/worldAskRunner.test.ts`, `tests/renderer/world/WorldAsk.test.tsx`, `tests/renderer/world/useWorldAsk.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` (Task 3), and the selected proposal id from Task 10's `LayerState.proposal`. Until Task 10 lands, use the linked design's proposal: the one with `reconcile`.
- Produces:
  - `ASK_TOKEN_BUDGET = 3000` and `MAX_SUMMARY_TOKENS = 300`.
  - `AskInput.proposal?: Proposal`, rendered as a `PROPOSAL` section (title, summary claims, and the planned and missing part names) ahead of `OTHER`.
  - `fitNames` trims on `estimateTokens`.
  - `WorldAsk` mic button: `onPointerDown` → `tapOrHoldKeydownAction({ listening, pressActive, repeat: false })`, and `onPointerUp` → `tapOrHoldKeyupAction({ pressActive, heldMs })` from `src/renderer/src/lib/voice/voicePipeline.ts`, which drive `mic.start()` and `mic.stop()`. When `voiceSettings.pushToTalkMode` is `'toggle'` or `'tapSpace'`, a click toggles as it does today.

- [ ] **Step 1: Write the failing tests**

```ts
test('the prompt never exceeds ASK_TOKEN_BUDGET tokens on a 2,000-building world', () => expect(estimateTokens(buildAskPrompt(big).prompt)).toBeLessThanOrEqual(3000))
test('the summary is cut at MAX_SUMMARY_TOKENS', ...)
test('an active proposal is in the prompt as a PROPOSAL section, with its missing parts named', ...)
test('the runner looks up request.proposalId in the doc; an unknown id sends no proposal', ...)
test('holding the mic 600 ms records and stops on release; a 100 ms tap starts and the next tap stops', ...) // fake timers, mic stub start/stop calls
test('in toggle mode a click toggles', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the four files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Keep the existing order in which sections are dropped when the budget runs short (OTHER first, then DETAIL). PROPOSAL is dropped after OTHER and before DETAIL.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: questions carry the active proposal within a token budget; hold-to-talk voice`

---

### Task 8: Answers play as they are read, and every claim links to parts (#99, #100, #5)

**Files:**
- Modify: `src/shared/world/answerProtocol.ts` (`[A<n>]` markers, `WorldAnswer.steps`)
- Create: `src/shared/world/evidenceLinks.ts`
- Modify: `src/renderer/src/components/World/useWorldAsk.ts:121` (reveal and play, replacing play-after)
- Modify: `src/renderer/src/components/World/WorldAnswer.tsx` (progressive text, chips that name parts)
- Test: `tests/shared/worldAnswerProtocol.test.ts`, `tests/shared/worldEvidenceLinks.test.ts`, `tests/renderer/world/useWorldAsk.test.ts`, `tests/renderer/world/WorldAsk.test.tsx`, `e2e/world-ask.spec.ts`, `e2e/mocks/mock-claude.cjs`

**Interfaces:**
- Consumes: `WorldAnswer.unsupported` (Task 2), `Building.claims` (Task 5).
- Produces:
  - `ANSWER_PROTOCOL` adds: `Put [A<n>] in your text where step n (1-based) should play.`
  - `WorldAnswer.sentences: { text: string; actions: number[] }[]`. The text is split on sentence ends. Each `[A<n>]` attaches action n-1 to the sentence it sits in, and the marker is removed from the text. Unmarked actions attach to the last sentence.
  - `REVEAL_MS_PER_WORD = 70`, `MIN_SENTENCE_MS = 600`.
  - `itemsForEvidence(doc: WorldDoc, ev: Evidence): string[]`: building ids whose members include the file part of `ev.ref`, or whose `how`, `why` or `claims` cite that ref, plus edge ids whose claims cite it.
  - `AskResult.cited` values gain `items: string[]`, filled in `askRunner`.
- Ruling: `runHeadless` returns the whole answer at once. So "as the text appears" works like this: the pane reveals the answer one sentence at a time at reading pace, and plays each sentence's actions as that sentence appears. Spec §5.6 is satisfied with no streaming CLI output, and Task 16 notes this in the spec.

- [ ] **Step 1: Write the failing tests**

```ts
test('[A1] and [A2] markers attach steps to their sentences and are removed from the text', () => {
  const a = parseAnswer('Typing goes to the PTY host. [A1] It then reaches the agent. [A2]\n```world-actions\n[{"type":"focus","ids":["b1"]},{"type":"flow","edgeIds":["e1"]}]\n```', doc, labels)
  expect(a.sentences).toEqual([{ text: 'Typing goes to the PTY host.', actions: [0] }, { text: 'It then reaches the agent.', actions: [1] }])
})
test('an out-of-range [A9] is dropped and counted', ...)
test('itemsForEvidence: a file ref maps to the building holding that file; a claim ref maps to its edge', ...)
test('useWorldAsk reveals sentence 1, plays focus b1, then after the reveal time sentence 2 and flow e1', ...) // fake timers: viewer.apply call order interleaved with revealed count
test('a new question during the reveal stops it and plays nothing more from the old answer', ...)
test('an evidence chip reads "E1 · <part name>" and clicking it opens that part and highlights its items', ...)
```

Add e2e test `6. the camera moves while the answer is still being revealed` to `world-ask.spec.ts`. The mock answer has two sentences with `[A1]` and `[A2]`. The test expects `drawn().highlighted` to hold the first id while the second sentence is not yet in the DOM.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the four unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Reveal time per sentence is `max(MIN_SENTENCE_MS, words * REVEAL_MS_PER_WORD)`, or 0 with reduced motion. "Replay" replays the same schedule.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-ask.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: answers play as they are read and every cited claim opens its parts`

---

### Task 9: Bookmarks and the 2D map (#89, #92)

**Files:**
- Create: `src/renderer/src/world/engine/bookmarks.ts`
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts` (`cameraState`, `setCamera`) and `threeRenderer.ts` (`getCamera`, `flyTo`)
- Modify: `src/renderer/src/world/engine/fallback2d.ts` (SVG map plus a list for screen readers)
- Modify: `src/renderer/src/components/World/WorldToolbar.tsx` (Bookmarks menu, "2D map" switch) and `WorldView.tsx:87,435`
- Test: `tests/renderer/world/bookmarks.test.ts`, `tests/renderer/world/themesFallback.test.ts`, `tests/renderer/world/WorldView.test.tsx`, `tests/renderer/world/createWorldViewer.test.ts`, `e2e/world-view.spec.ts`

**Interfaces:**
- Produces:
  - `CameraState = { pos: [number, number, number]; target: [number, number, number] }`.
  - `WorldViewer.cameraState(): CameraState | null` (null in 2D) and `WorldViewer.setCamera(s: CameraState, instant: boolean): Promise<void>`.
  - `bookmarks.ts`:
    - `MAX_BOOKMARKS = 20`;
    - `Bookmark = { name: string; camera: CameraState; selection: string[] }`;
    - `loadBookmarks(projectKey: string): Bookmark[]` drops malformed entries and never throws;
    - `saveBookmark(projectKey: string, b: Bookmark): Bookmark[]` keeps the newest 20 and replaces an entry with the same name;
    - `removeBookmark(projectKey: string, name: string): Bookmark[]`;
    - localStorage key `termpolis.world.bookmarks.<projectKey>`.
  - `renderFallback(doc: WorldDoc, title: string): string`, which returns `<section class="world-fallback"><h2>title</h2><svg role="img" aria-label="Map of title">…</svg><ul class="world-fallback-list">…</ul></section>`:
    - districts are hexagon `<polygon data-kind="district">` shapes at the `layout.positions` x/z;
    - buildings are `<rect data-kind="building">` and edges are `<line data-kind="edge">`;
    - the list keeps today's items, with `tabindex="0"`.
  - Toolbar props add `bookmarks: Bookmark[]`, `onSaveBookmark(name: string)`, `onBookmark(b: Bookmark)`, `onRemoveBookmark(name: string)`, `map2d: boolean` and `onMap2d(on: boolean)`. The 2D choice is kept in `termpolis.world.map2d`.

- [ ] **Step 1: Write the failing tests**

```ts
test('saveBookmark keeps 20, newest first, and replaces a same-named entry', ...)
test('loadBookmarks ignores corrupt JSON, a non-array and entries with bad numbers', ...)
test('renderFallback draws a hexagon per district, a rect per building and a line per edge, and escapes names', () => {
  const html = renderFallback(doc, 'termpolis'); expect(html).toContain('<h2>termpolis</h2>'); expect(html).not.toContain(doc.projectKey)
  expect((html.match(/data-kind="district"/g) || []).length).toBe(doc.districts.length * 2) // polygon + list item
})
test('the 2D map switch shows the fallback with WebGL present, and is remembered', ...)
test('choosing a bookmark calls setCamera(camera, false) and restores its selection; an id no longer in the world is skipped', ...)
test('the 2D heading shows the project display name, not the hashed key', ...)
```

Add e2e test `9. a saved view comes back after moving away, and the 2D map switch draws an svg map` to `world-view.spec.ts`. It saves "Home view", clicks a building (the camera moves), chooses "Home view", and expects `cameraState()` within 0.5 units of the saved one. It then switches on the 2D map, expects an `svg[role=img]` with at least one `rect[data-kind="building"]`, clicks it, and expects the card to open.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the four unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Expose `cameraState` on the e2e probe (`WorldProbe`). Clicks on the SVG use the same `data-kind` and `data-id` wiring as the list.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-view.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: bookmarks, and a 2D map you can switch on for accessibility`

---

### Task 10: Plan versus built: changed outline, removed fade, proposal selector (#71, #4, #82)

**Files:**
- Modify: `src/shared/world/types.ts` (`Proposal.removes?: string[]`)
- Modify: `src/shared/world/reconcile.ts` (`PlanReconcile.changed`)
- Modify: `src/shared/world/designPatch.ts` (op `removePart`, which writes `removes`)
- Modify: `src/renderer/src/world/engine/sceneModel.ts` (`SceneBuilding.outline`, look `'fading'`, `LayerState.proposal`)
- Modify: `src/renderer/src/world/engine/threeRenderer.ts` (outline wireframe around the solid; fading opacity loop) and `createWorldViewer.ts` (`setLayers({ proposal })`)
- Modify: `src/renderer/src/components/World/WorldToolbar.tsx` (proposal select, testid `world-proposal`)
- Test: `tests/shared/worldReconcile.test.ts`, `tests/shared/worldDesignPatch.test.ts`, `tests/renderer/world/sceneModel.test.ts`, `tests/renderer/world/WorldView.test.tsx`, `e2e/lumopolis-sources.spec.ts`

**Interfaces:**
- Produces:
  - `PlanReconcile.changed: string[]`: built ids matched by a plan part whose members, floors or tech differ.
  - `Proposal.removes?: string[]`: built ids the proposal takes away.
  - `LayerState.proposal: string | null`. `null` means none. The default is the linked design's proposal id, when one exists.
  - `SceneBuilding.outline: boolean` (a wireframe shell 8% larger around a solid building) and `Look` adds `'fading'`.
  - `WorldDrawn` adds `outlined: string[]` and `fading: string[]`.
  - The toolbar's `<select data-testid="world-proposal">` offers "No proposal", then each `doc.layers.plan` proposal by title.

- [ ] **Step 1: Write the failing tests**

```ts
test('reconcile marks a matched part with different members as changed', ...)
test('designPatch removePart adds the built id to removes; an unknown id is skipped and counted', ...)
test('sceneModel: changed => solid with outline; removes => fading; new => wireframe; done => solid without outline', ...)
test('choosing "No proposal" hides the wireframes, outlines and fades; choosing a proposal shows them', ...)
test('the selector lists every plan proposal and defaults to the linked design', ...)
```

Extend e2e test `4.` in `lumopolis-sources.spec.ts`. After the first file arrives, change a matched part's files, and expect `drawn().outlined` to contain it. A design refine "remove <part>" then puts that part in `drawn().fading`.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the four unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** The fade is an opacity pulse between 0.15 and 0.45 at 0.5 Hz, held at 0.3 with reduced motion. The outline uses the theme's proposed colour.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/lumopolis-sources.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: changed parts get an outline, removed parts fade, and a proposal selector`

---

### Task 11: Legend shapes, dashed guesses, data-driven width and heat, reduced motion (#30, #35, #10, #130, #45)

**Files:**
- Modify: `src/renderer/src/world/engine/sceneModel.ts:41-79,151` (`conduitStyle`, dash rule, heat)
- Modify: `src/renderer/src/components/World/WorldLegend.tsx:66-87` (inline SVG shape per cargo, copy for dashed lines)
- Modify: `src/renderer/src/world/engine/threeRenderer.ts:1352-1372` (gate motion on reduced motion; `motionState`)
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts` (`WorldDrawn.visual`)
- Test: `tests/renderer/world/sceneModel.test.ts`, `tests/renderer/world/WorldLegend.test.tsx`, `e2e/world-engine.spec.ts`

**Interfaces:**
- Produces:
  - `conduitStyle(doc, edge, live?: Record<string, { rate?: number; latencyMs?: number }>): { width: number; color: string; dashed: boolean }`:
    - width is `clamp(0.04 + 0.02 * log2(1 + rate), 0.04, 0.2)`, where `rate` is the live rate, or else the number parsed from `edge.rate`, or else 1;
    - `dashed` is true when the edge touches a proposed part, or when `isMostlyInferred(edge)` holds, or when the edge has no observed claim.
  - `SceneBuilding.heat: number` (0..1, from `live[id].latencyMs / 1000`, clamped; 0 with no live data). `doc.layers.live` is read as that record when it is shaped right, and ignored otherwise.
  - `WorldDrawnVisual = { ringAngle: number; fogDrift: number; wirePulse: number; selectionRingAngle: number }`, and `WorldDrawn.visual: WorldDrawnVisual`. Task 16 extends it.
  - Legend: each cargo row shows an inline `<svg data-shape="cube|sphere|octa|tetra">` in its colour. Line row copy, exactly: `Dashed: planned, or a guess the code does not show`.

- [ ] **Step 1: Write the failing tests**

```ts
test('an inferred edge with no observed claim is dashed; an observed edge is solid', ...)
test('width grows with the parsed rate and with live rate, within 0.04..0.2', ...)
test('heat comes from layers.live latency; a malformed live layer gives 0', ...)
test('the legend draws each cargo shape in its colour', () => expect(container.querySelector('[data-shape="octa"]')).not.toBeNull())
```

Add e2e test `reduced motion freezes the ring, fog drift, wireframe pulse and selection ring` to `world-engine.spec.ts`. Load the harness with `reducedMotion: true` and select a verified building. Read `drawn().visual` twice, 800 ms apart, and expect all four values to be equal. Without reduced motion, `ringAngle` and `fogDrift` change.

- [ ] **Step 2: Run them and see them fail.** Run `V` on the two unit files. Expected: FAIL.
- [ ] **Step 3: Implement it.** Use the existing `reducedMotion` renderer option. Each of the four animations reads a time value that stays fixed when that option is set.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-engine.spec.ts`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: the legend shows shapes, guesses are dashed, width and heat follow data, reduced motion stops all motion`

---

### Task 12: Semantic zoom, instancing and level of detail (#90, #91)

**Files:**
- Modify: `src/renderer/src/world/engine/viewMath.ts` (`zoomTier`)
- Modify: `src/renderer/src/world/engine/threeRenderer.ts:530-570` (one `InstancedMesh` per floor material; tier visibility)
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts` (`WorldDrawn.tier`, `WorldDrawn.drawCalls`)
- Test: `tests/renderer/world/viewMath.test.ts`, `e2e/world-visual.spec.ts`

**Interfaces:**
- Produces:
  - `ZOOM_FAR = 0.25`, `ZOOM_NEAR = 0.7`.
  - `zoomTier(zoom: number): 'districts' | 'buildings' | 'floors'`. The `zoom` value is the same one `nameBudget` takes.
    - At `districts`, buildings draw as one block per district footprint, and only district names show.
    - At `buildings`, buildings draw as single boxes, with no floor seams.
    - At `floors`, floors, floor labels and seams show.
  - `WorldDrawn.tier` and `WorldDrawn.drawCalls: number` (from `renderer.info.render.calls`).
  - Floors share geometry through `THREE.InstancedMesh`, one per (theme, look) pair.

- [ ] **Step 1: Write the failing tests**

```ts
test('zoomTier', () => { expect(zoomTier(0.1)).toBe('districts'); expect(zoomTier(0.5)).toBe('buildings'); expect(zoomTier(0.9)).toBe('floors') })
```

Add e2e test `a 600-building world draws in under 150 draw calls and changes tier with distance` to `world-visual.spec.ts`. It generates the repository with the existing `bigFiles()` generator, extended to 600 files in 12 areas. It checks that `drawn().drawCalls` is below 150 at the overview, that the overview's tier is `'districts'`, and that the tier is `'floors'` after `viewer.apply({ type: 'focus', ids: [one] })`.

- [ ] **Step 2: Run them and see them fail.** Run `V tests/renderer/world/viewMath.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Picking keeps working through `instanceId`, mapped back to the building id. Explode (double-click) temporarily swaps the exploded building to its own meshes.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, then `E2E e2e/world-visual.spec.ts`, including every earlier click test in it. Expected: PASS.
- [ ] **Step 5: Commit** with the message `lumopolis: semantic zoom tiers and instanced floors for large repositories`

---

### Task 13: Gateway: world_annotate and the full world_read (#105, #103)

**Files:**
- Modify: `src/main/world/worldGatewayTransport.ts:25-37` (constants), `:135-201` (read), `:242-246` (`callTool`)
- Modify: `src/main/world/worldClient.ts` (`read` gains `cards` and `plan`)
- Create: `src/main/world/cardText.ts` (plain-text cards for agents)
- Test: `tests/electron/worldGatewayTransport.test.ts`, `tests/electron/worldCardText.test.ts`, `tests/electron/worldClient.test.ts`

**Interfaces:**
- Consumes: `WorldClient.annotate` and the annotation caps (Task 5), and `PlanReconcile.changed` (Task 10).
- Produces:
  - `WORLD_ANNOTATE_TOOL = 'world_annotate'`.
  - The arguments are `{ cwd?: string; designKey?: string; id: string; text: string; evidence?: { kind: EvidenceKind; ref: string; excerpt?: string }[] }`.
    - The stored claim is always `state: 'observed'`. Ruling: agent claims are observed; `verified` comes from tests or a person, as spec §5.2 defines it.
    - Evidence refs that are absolute paths inside the root become repository-relative. Paths outside the root are dropped.
  - `WorldQuery` adds `cards?: boolean` and `plan?: boolean`.
  - `WorldReadResult` adds `cards?: Record<string, string>` and `plan?: { proposals: { id: string; title: string; missing: string[]; changed: string[]; extra: string[]; removes: string[] }[] }`.
  - `cardText(doc: WorldDoc, id: string): string`: the same facts as the HTML card, as plain text, with each claim followed by `[<state>]`.
  - The tool description stays at 300 characters or fewer, enforced by a test.

- [ ] **Step 1: Write the failing tests**

```ts
test('world_annotate stores an observed claim and world_read returns it', ...)
test('world_annotate refuses an unknown id with "No part with that id."', ...)
test('world_annotate forces state observed even when the agent sends verified', ...)
test('world_annotate caps text at 400 chars and evidence at 8, and makes inside-root paths relative and drops outside ones', ...)
test('world_read {cards:true} returns a plain-text card per item, with claim states', ...)
test('world_read {plan:true} returns each proposal with missing, changed, extra and removes', ...)
test('the world_annotate tool description is at most 300 characters', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the three files. Expected: FAIL.
- [ ] **Step 3: Implement it.** `callTool` routes the third tool. `gateway_list_tools` lists it under `lumopolis`, and no top-level MCP tool is added.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: world_annotate, and world_read returns cards and plan versus built`

---

### Task 14: No stalls on main, and an incremental compile (#13, #17, #50, #67)

**Files:**
- Modify: `src/main/world/worldSettings.ts` (async fs; `ready()`)
- Modify: `src/main/index.ts:2675-2688` (the first index moves out of main), `:2614` (await `worldSettings.ready()` at startup, without blocking)
- Modify: `src/main/world/worldHost.ts` and `worldClient.ts` (op `snapshotFromFiles`)
- Modify: `src/main/world/compile.ts:337-355,456-500` (per-file stage cache; regroup only on structural change; `createRecompileScheduler` passes changed files)
- Modify: `src/main/world/worldStore.ts` (stores the stage cache next to the world)
- Test: `tests/electron/worldSettings.test.ts`, `tests/electron/worldHost.test.ts`, `tests/electron/worldClient.test.ts`, `tests/electron/worldCompile.test.ts`, `tests/electron/worldStore.test.ts`, plus the main-thread guards `tests/electron/mainThreadScan.test.ts` and `tests/electron/mainThreadHotPaths.test.ts` (allowlist `scripts/main-thread-allowlist.json` is never widened)

**Interfaces:**
- Produces:
  - `WorldSettingsStore`:
    - `get()` stays synchronous and reads the cached value;
    - `ready(): Promise<void>` loads the file once with `fs/promises`;
    - `set()` updates the cache at once and queues one async atomic write, writing only the last of several quick sets.
    - The file no longer imports `existsSync`, `readFileSync` or `mkdirSync`.
  - Host op `snapshotFromFiles(root: string): Promise<GraphSnapshot>`, which runs `discoverRepoFiles` and the code-graph extractor inside the world utility process. Main's `snapshot` hook calls it when `graphSnapshot(...)` is empty, instead of calling `buildCodeGraph` on main. Main then starts its own index through the existing `code-graph:build` path, without waiting for it.
  - `StageCache = { files: Record<string, { hash: string; boundaries: Boundary[]; imports: string[] }>; structureHash: string; grouping?: Grouping }`.
  - `compileWorld(input & { changed?: string[]; cache?: StageCache }, deps): Promise<{ doc: WorldDoc; cache: StageCache }>`. Only changed files are re-read and re-detected. Grouping re-runs only when `structureHash` (a hash of sorted file paths plus import edges) changes; otherwise the cached grouping is reused, and status and labelling run for the affected buildings only.
- Ruling: `graphSnapshot` reads main's in-memory graph maps with `structureOnly` and touches neither the disk nor SQLite. It stays on main. Step 1 includes a test that pins this.

- [ ] **Step 1: Write the failing tests**

```ts
test('worldSettings uses no sync fs: get() returns defaults before ready(); ready() loads; three quick sets write once', ...)
test('the worldSettings module imports none of existsSync, readFileSync, mkdirSync', () => expect(readSrc('src/main/world/worldSettings.ts')).not.toMatch(/Sync\b/))
test('snapshotFromFiles in the host returns files and imports for a fixture folder', ...)
test('an unindexed root compiles from the host snapshot; main buildCodeGraph is not awaited', ...)
test('compile with changed=[a.ts] re-reads only a.ts (readFile spy) and reuses the grouping when imports are unchanged', ...)
test('compile with a new import edge regroups', ...)
test('a world from before the cache (no stage cache stored) compiles in full and stores one', ...)
test('graphSnapshot stays a pure in-memory read (no fs or sqlite import in its call path)', ...)
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the five files. Expected: FAIL.
- [ ] **Step 3: Implement it.** The stage cache is stored as `<world file>.stages.json` through the store's async atomic write. A cache of the wrong shape is ignored.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV`, `TSC`, and `V tests/electron/mainThreadScan.test.ts tests/electron/mainThreadHotPaths.test.ts`. Expected: PASS, the World files at 100%, and both guards green with no allowlist change.
- [ ] **Step 5: Commit** with the message `lumopolis: no sync fs or code-graph build on main; compile re-reads only what changed`

---

### Task 15: Compiler sources: test results, detectors, runtimeNames, acceptance (#64, #53, #54, #128, #68)

**Files:**
- Modify: `src/main/world/testStatus.ts:16-28,265-311` (`transcriptRuns` wired, `ciRuns`)
- Modify: `src/main/index.ts` (passes `transcriptRuns` from the transcript watchers' file list and `ciRuns` through `gh`)
- Modify: `src/main/world/detectors/processes.ts:8-20` and `src/main/world/detectors/common.ts` (MessagePort reuses the existing `BoundaryKind` `'port'`)
- Modify: `src/main/world/compile.ts:76-107,412-419` (manifests feed `runtimeNames`)
- Modify: `src/shared/world/designPatch.ts` (op `setRuntimeNames`) and `src/renderer/src/world/engine/cards.ts` with `WorldCard.tsx` (a "Service names" line with an Edit button)
- Modify: `tests/electron/worldAcceptance.test.ts:170-233`
- Test: `tests/electron/worldTestStatus.test.ts`, `tests/electron/worldDetectors.test.ts`, `tests/electron/worldCompile.test.ts`, `tests/shared/worldDesignPatch.test.ts`, `tests/renderer/world/WorldParts.test.tsx`, `tests/electron/worldAcceptance.test.ts`

**Interfaces:**
- Produces:
  - `TestResultDeps.ciRuns?: () => Promise<TestRun[]>`, and `TestRun.source` adds `'ci'`.
    - Main implements it with `gh run list --limit 1 --json conclusion,headSha,createdAt,databaseId` through `execCaptureOffThread`, with a 5 s timeout, only when `gh` is on PATH. Results are kept 10 minutes per root.
    - A CI conclusion becomes one run per test file linked to the commit's changed files. Ruling: only `success` or `failure` count, and `gh` errors give `[]`.
  - `readTestResults` merges file, transcript and CI runs.
  - Detector additions:
    - `new MessageChannel()` and `.postMessage(` on a port variable give `kind: 'port'`, keyed by the variable name;
    - `exec(`, `execSync(` and `child_process.fork(` / `fork(` from `child_process` give `kind: 'spawn'`, keyed by the first literal argument.
  - `manifestServiceNames(file: string, text: string): string[]` reads `docker-compose*.yml` service keys, Kubernetes `metadata.name` under `kind: Deployment|Service`, and the `name` field of `package.json`.
  - Design op `{ op: 'setRuntimeNames', id: string, names: string[] }` (at most 10 names, each matching `/^[\w.-]{1,64}$/`). For a project world, the card's Edit button stores the names through `world:annotate` as a claim with the prefix `runtime:`. Compile reads that claim back into `runtimeNames`.

- [ ] **Step 1: Write the failing tests**

```ts
test('transcript test runs reach readTestResults and can turn a building verified', ...)
test('ciRuns success marks linked tests passed; gh missing or failing gives []', ...)
test('detectProcesses finds MessageChannel ports, exec, execSync and child_process.fork', ...)
test('manifestServiceNames reads compose services, k8s Deployment names and package.json name', ...)
test('runtimeNames merges OpenTelemetry names, manifest names and hand-edited names', ...)
test('setRuntimeNames rejects bad names and keeps at most 10', ...)
test('the card Edit button saves service names', ...)
test('acceptance: Termpolis recovers the gateway, code graph, swarm and remote bridge connections as well', ...) // add the four edge assertions next to the existing three
```

- [ ] **Step 2: Run them and see them fail.** Run `V` on the six files. Expected: FAIL.
- [ ] **Step 3: Implement it.** `transcriptRuns` reads only the transcript files the watchers already list, through async reads, capped at the 20 newest files.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` and `TSC`. Expected: PASS at 100%.
- [ ] **Step 5: Commit** with the message `lumopolis: test results from transcripts and CI, more detectors, editable runtime names, fuller acceptance`

---

### Task 16: Tests of the drawn result, the coverage ruling and the spec amendments (gap 29, #12, #21, #129, #132, #133, #47 rest, #136)

**Files:**
- Modify: `src/renderer/src/world/engine/threeRenderer.ts` (fills `WorldDrawnVisual`) and `createWorldViewer.ts`
- Modify: `vitest.config.ts:123-126` (removes the `createWorldViewer.ts` exclusion)
- Modify: `src/main/world/worldClient.ts:440-467` (removes the c8-ignore and tests the branch)
- Modify: `tests/renderer/world/createWorldViewer.test.ts` (brings it to 100%, with `vi.mock('../../../src/renderer/src/world/engine/threeRenderer')`)
- Create: `tests/shared/worldFacts.test.ts`
- Modify: `e2e/world-visual.spec.ts`
- Modify: `docs/superpowers/specs/2026-11-15-world-view-design.md` (§3, §5.2, §5.6, §10)

**Interfaces:**
- Consumes: `WorldDrawnVisual` (Task 11), `WorldDrawn.tier` (Task 12), `cameraState` (Task 9).
- Produces: `WorldDrawnVisual` extended with:
  - `bloom: boolean`
  - `stars: number`, `dust: number`
  - `platformSides: Record<string, number>`, `platformLights: number`
  - `floorOrder: Record<string, string[]>` (floor names, bottom to top)
  - `orbs: string[]` (externals drawn as spheres)
  - `exploded: string | null` and `explodeGap: number`
  - `flight: { active: boolean; t: number; eased: number }`
  - `lineLabels: number`

**Rulings recorded in this task:**
- **#133:** change the code. `createWorldViewer.ts` holds plain logic around a mocked renderer, so it comes under the 100% engine gate. `threeRenderer.ts` stays the one excluded drawing file, as spec §10 says.
- **#47 `twoWay`:** amend the spec. `twoWay: boolean` is the edge's direction (one or two way); renaming it changes nothing a person sees.
- **#47 `layers.built`:** amend the spec. Built items are the top-level `buildings`, `edges` and `districts`, which are the built layer.
- **#47 `built` versus `observed`:** amend the spec. `BuildStatus` keeps `built` for a solid part with failing or partial tests. Claims use the `observed` state (Task 5).
- **#136:** amend the spec. A design world stores its planned parts as top-level `proposed` buildings. Its plan shows on a project through `layers.plan` with `reconcile`. The result on screen is the same, and Plan 4's designer and Build it depend on this shape.
- **#12:** every mark maps to data. Pinned by a test that each `Look` and conduit property in `buildSceneModel` output derives from a doc field: the scene model is the same for two docs that differ only in `generatedAt`.
- **#21:** pinned by a test that `package.json` pins `three` at `0.160.0` and the lockfile resolves `node_modules/three` to `0.160.0`.
- **#129:** pinned by a test that `validateWorld` keeps a `layers.live` object unchanged.
- **#132:** pinned by a test that no file under `src/renderer/src/world/` or `src/renderer/src/components/World/` contains `fetch(`, `XMLHttpRequest`, `WebSocket` or `EventSource`.
- **Answers revealed at reading pace (Task 8) and Gemini running without the proxy (Task 4):** add these notes to spec §5.6 and §3.

- [ ] **Step 1: Write the failing tests**

```ts
// worldFacts.test.ts
test('three is pinned at 0.160.0 in package.json and the lockfile', ...)
test('validateWorld keeps layers.live as given', ...)
test('the Lumopolis renderer makes no network calls', ...)
test('the scene model depends only on world data, not on generatedAt', ...)
```

Add these to `e2e/world-visual.spec.ts`, one `test` each, on the small fixture with the neon theme at high quality:
- `double-click explodes a building floor by floor`: `exploded` is that id and `explodeGap` is above 0.
- `orbit drags and wheel zooms the camera`: the `cameraState()` position changes after a mouse drag, and its distance shrinks after `wheel(-400)`.
- `W and Q fly the camera`: the target moves along -z after holding W for 500 ms, and up after Q.
- `verified buildings carry a rotating ring`: `ringAngle` grows over 500 ms (uses a fixture with a passing vitest report).
- `bloom, starfield and dust are on`: `bloom` is true, `stars` is 1000 or more, and `dust` is above 0.
- `district platforms are hexagons with pooled light`: every `platformSides` value is 6, and `platformLights` is at least the district count.
- `floors stack in pipeline order`: `floorOrder[id]` equals the building's `floors` names in doc order.
- `externals float as orbs`: `orbs` equals `doc.externals` ids.
- `camera flights ease`: during a focus flight, sampled `eased` values rise monotonically, and the first step is smaller than the middle step.
- `label every line shows one label per edge`: `lineLabels` equals the edge count once `world-layer-allLineLabels` is on.

- [ ] **Step 2: Run them and see them fail.** Run `V tests/shared/worldFacts.test.ts`, then `COV tests/renderer/world/createWorldViewer.test.ts` with `--coverage.include=src/renderer/src/world/engine/createWorldViewer.ts`. Expected: worldFacts PASS, since it pins facts already true (a failure is a real gap: fix it in Step 3); the visual e2e tests FAIL because `drawn().visual` lacks the new fields; createWorldViewer coverage is below 100%.
- [ ] **Step 3: Implement it.**
  - Fill `WorldDrawnVisual` from the renderer's existing objects (no new drawing).
  - Add the createWorldViewer tests until it reaches 100%.
  - Remove the exclusion and the c8-ignore.
  - Write the spec amendments listed above, one sentence each, in the sections named.
- [ ] **Step 4: Run the tests and see them pass.** Run `COV` on the world folders, `TSC`, `E2E e2e/world-visual.spec.ts e2e/world-engine.spec.ts e2e/world-view.spec.ts e2e/world-ask.spec.ts e2e/lumopolis-sources.spec.ts`, then the full `npm run test:coverage`. Expected: all PASS, the World folders at 100%, and the repo gate at or above 97 / 96 / 95 / 96.
- [ ] **Step 5: Commit** with the message `lumopolis: e2e of the drawn result, createWorldViewer under the 100% gate, spec matches the code`

---

## Gap coverage map

| Audit gap | Task |
|---|---|
| 1 (#2) | 1 |
| 2 (#76, #138) | 5 |
| 3 (#89) | 9 |
| 4 (#101) | 2 |
| 5 (#14) | 3 |
| 6 (#99, #100, #5) | 8 |
| 7 (#96, #22, #61) | 4 (#122 is excluded: final-review I6) |
| 8 (#71, #4) | 10 |
| 9 (#82) | 10 |
| 10 (#30, #35, #10) | 11 |
| 11 (#45) | 11 |
| 12 (#90, #91) | 12 |
| 13 (#92) | 9 |
| 14 (#94) | 7 |
| 15 (#139, #49) | 5 |
| 16 (#65) | 5 |
| 17 (#95) | 7 |
| 18 (#117) | excluded by instruction |
| 19 (#105, #103) | 13 |
| 20 (#13, #17) | 14 |
| 21 (#50, #67) | 14 |
| 22 (#64) | 15 |
| 23 (#60, #62, #61) | 6 |
| 24 (#53, #54) | 15 |
| 25 (#68) | 15 |
| 26 (#128, #130) | 15 (#128), 11 (#130) |
| 27 (#47, #136) | 5 (`claims[]`, observed), 16 (rulings) |
| 28 (#133) | 16 |
| 29 (I-U items) | 16 (the motion half of #33 is also in 11) |
