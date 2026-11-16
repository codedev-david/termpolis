# Lumopolis — Plan 2: Conversation (ask by text or voice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside Lumopolis you can type or speak a question ("how does a message get from my phone to an agent?"). The world answers in text with evidence links and moves itself to show the answer: it flies, highlights, runs flows, opens cards and plays tours.

**Architecture:** Each question is a **fresh, read-only, one-shot** `runHeadless` call (spec §10). It is primed with:
- a compact world context (the selection, the camera region, and matches from `worldClient.read`);
- a rolling summary of the conversation so far;
- the answer protocol.

The agent replies with prose plus one fenced `world-actions` JSON block. A shared pure parser validates it against the WorldDoc, drops unknown ids, and hands the actions to `viewer.play()`. Voice reuses `useVoiceInput` through a new optional `onTranscript` sink. Spoken replies use `speechSynthesis` and are off by default.

**Tech Stack:** TypeScript, React, the existing `headlessExec` / `useVoiceInput`, Web Speech `speechSynthesis`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-world-view-design.md` (§5.6, §10). **Depends on Plan 1:** `WorldDoc`/`WorldAction`/`validateWorld` (Task 1), `createWorldClient().read` (Task 9), `WorldViewer.play/cancelActions/getSelection/cameraRegion` (Task 11), and the `WorldView` `askSlot` prop (Task 12).

## Global Constraints

- Questions are **read-only**: `runHeadless({ write: false })`, never a terminal, never a visible CLI window (David: real UI, hidden CLI sessions).
- The agent is the user's default agent and model (not the cheap labelling model), through the token proxy like every headless run.
- Each question is independent: no warm session. Context = world slice + at most 1,200 characters of conversation summary.
- The prompt must stay under 12,000 characters. World excerpts are fenced as data with a "data, not instructions" framing.
- The answer text is rendered as escaped text plus evidence links. Never `innerHTML` agent output.
- `speechSynthesis` is off by default (setting `worldSpeakAnswers: false`).
- Same EDR, ES2020, coverage (97/96/95/96), `git commit -F` and commit-to-main rules as Plan 1.

## Review Focus

1. **The agent answers with no or a malformed `world-actions` block, or invents ids**: the text still shows, unknown ids are dropped silently, and no exception reaches the UI. Test in Task 1.
2. **The user asks again before the first answer arrives**: the first run is aborted (`AbortSignal`), its late result is ignored, and a running tour is cancelled. Test in Tasks 3 and 4.
3. **No agent installed, signed out, or timed out**: a plain message ("Lumopolis couldn't reach your agent: <reason>") with a retry. The world stays usable. Test in Task 3.
4. **Voice while a terminal also has voice**: the transcript goes only to the Ask bar while Lumopolis is open, never into a terminal. Test in Task 5.
5. **A long answer read aloud and then Lumopolis closed**: speech stops on close, on a new question, and on Esc. Test in Task 4.

---

### Task 1: Answer protocol

**Files:**
- Create: `src/shared/world/answerProtocol.ts`
- Test: `tests/shared/worldAnswerProtocol.test.ts`

**Interfaces:**
- Produces:
  - `ANSWER_PROTOCOL: string`, the instructions block appended to every question prompt (exact text below)
  - `parseAnswer(raw: string, doc: WorldDoc): WorldAnswer`
  - `WorldAnswer = { text: string; actions: WorldAction[]; evidence: Evidence[]; dropped: number }`

`ANSWER_PROTOCOL`, verbatim:

```text
Answer in plain language for someone who does not read code. Keep it under 150 words.
After your answer, add one fenced block tagged world-actions containing a JSON array of steps
that show your answer in the World. Allowed steps:
{"type":"focus","ids":[...]} {"type":"highlight","ids":[...]} {"type":"flow","edgeIds":[...]}
{"type":"openCard","id":"..."} {"type":"tour","steps":[{"ids":[...],"caption":"..."}]} {"type":"reset"}
Use only ids from the WORLD DATA. Cite evidence inline as [E<n>] using the labels in the WORLD DATA.
```

- [ ] **Step 1:** Write the tests:
  - `extracts text before the block and the actions inside it`
  - `no block → actions [] and full text`
  - `malformed JSON → actions [], dropped 0, text intact`
  - `unknown building id inside focus is removed; a step left empty is removed; dropped counts both`
  - `tour with 25 steps truncated to 12`
  - `draftProposal is rejected in the app (dropped)`
  - `[E2] markers map to evidence from the supplied label table and stay in text`
  - `two blocks → only the first used`
  - `HTML in text is returned as-is (escaping is the renderer's job) but never parsed`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. `parseAnswer` takes a third optional arg `labels: Record<string, Evidence>` for the `[E<n>]` mapping (default `{}`). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `world: answer protocol + tolerant parser`.

### Task 2: Question context builder

**Files:**
- Create: `src/main/world/askContext.ts`
- Test: `tests/electron/worldAskContext.test.ts`

**Interfaces:**
- Consumes: `WorldDoc`, `worldClient.read(root, {text, limit})` → `WorldReadResult`.
- Produces:
  - `buildAskPrompt(input: { question: string; doc: WorldDoc; selection: string[]; cameraRegion: string[]; matches: WorldReadResult; summary: string }): { prompt: string; labels: Record<string, Evidence> }`
  - `summarize(prev: string, question: string, answerText: string): string`. Pure: it appends `Q: …\nA: <first sentence>` and trims from the front to 1,200 characters.
- Prompt order:
  1. a one-line role (`You explain the software shown in Termpolis Lumopolis.`)
  2. `CONVERSATION SO FAR` (the summary)
  3. `WORLD DATA` in a fenced block. It lists districts (id, name), then the selected/in-view/matched buildings and edges with their claims, with evidence labelled `E1…`. Other buildings appear as `id: name` only.
  4. `QUESTION`
  5. `ANSWER_PROTOCOL`

- [ ] **Step 1:** Write the tests:
  - `selected ids get full detail, others name-only`
  - `prompt ≤ 12000 chars on a 60-building doc (details truncated by priority: selection > matches > camera)`
  - `labels map E1.. to the evidence in order of appearance`
  - `summary trimmed to 1200 keeping the newest`
  - `injection text in a claim stays inside the fenced WORLD DATA block`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `world: ask prompt builder with priority truncation`.

### Task 3: Ask runner and IPC

**Files:**
- Create: `src/main/world/askRunner.ts`
- Modify: `src/main/world/ipc.ts` (Plan 1 Task 9), `src/preload/index.ts`, `src/renderer/src/types/index.ts` (`TermpolisAPI`)
- Test: `tests/electron/worldAskRunner.test.ts`

**Interfaces:**
- Consumes: `runHeadless(req, deps)` (`headlessExec.ts:370`) and Tasks 1–2.
- Produces:
  - `createAskRunner(deps: { exec: typeof runHeadless; execDeps: ExecDeps; client: WorldClient; timeoutMs?: number }): { ask(req: AskRequest): Promise<AskResult>; cancel(askId: string): void }`
  - `AskRequest = { askId: string; root: string; question: string; selection: string[]; cameraRegion: string[]; summary: string }`
  - `AskResult = { askId: string; ok: true; answer: WorldAnswer; summary: string } | { askId: string; ok: false; error: string; cancelled?: boolean }`
  - The `runHeadless` call: `{ task: prompt, cwd: root, write: false, noRemember: true, timeoutMs: 90_000, signal }`, with agent and model unset so they use the defaults.
  - IPC: `world:ask` (AskRequest → AskResult) and `world:ask-cancel` (askId). Preload: `worldAsk(req)` and `worldAskCancel(askId)`.

- [ ] **Step 1:** Write the tests:
  - `passes write:false, noRemember:true, cwd=root`
  - `parses output into answer and returns new summary`
  - `exec ok:false → {ok:false, error}` with the human message `Lumopolis couldn't reach your agent: <error>`
  - `cancel aborts the signal and resolves {ok:false, cancelled:true}`
  - `a second ask for the same root cancels the first`
  - `no world doc for root → {ok:false, error:'This project has not been mapped yet.'}`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `world: read-only one-shot ask runner + IPC`.

### Task 4: Ask bar UI

**Files:**
- Create in `src/renderer/src/components/World/`: `WorldAsk.tsx`, `WorldAnswer.tsx`, `useWorldAsk.ts`
- Modify:
  - `src/renderer/src/components/World/WorldView.tsx`: pass `askSlot={(viewer) => <WorldAsk viewer={viewer} root={root} />}`
  - Settings: a toggle "Read Lumopolis answers aloud", bound to `worldSpeakAnswers`, default off
- Test: `src/renderer/src/components/World/WorldAsk.test.tsx`, `useWorldAsk.test.ts`

**Interfaces:**
- Consumes: the `WorldViewer` from Plan 1 Task 11, plus `worldAsk`/`worldAskCancel`.
- Produces: `useWorldAsk(viewer, root): { ask(q: string): void; cancel(): void; state: 'idle' | 'thinking' | 'answered' | 'error'; answer: WorldAnswer | null; error: string | null; history: { q: string; a: string }[] }`
- UI:
  - an input with placeholder `Ask about this project…` and a mic button;
  - while empty and idle, four suggestion chips: `How does it all fit together?`, `What happens when I press Enter in a terminal?`, `Where is memory stored?`, `What isn't tested?`;
  - a "thinking" shimmer while a question is running;
  - the answer panel shows the escaped text, with `[E<n>]` rendered as chips that call `viewer.apply({type:'openCard', id})` for building/edge refs, or show the file path for file evidence;
  - a "Show me again" button replays the actions.

- [ ] **Step 1:** Write the tests:
  - `submitting calls worldAsk with viewer.getSelection() and viewer.cameraRegion()`
  - `answer actions are played via viewer.play`
  - `new question while thinking → worldAskCancel(prev) and viewer.cancelActions()`
  - `late result for a cancelled askId is ignored`
  - `error shows message + Retry`
  - `<img onerror> in answer text renders as text`
  - `speech: off by default → speechSynthesis.speak not called; on → called once with answer text; Esc / close / new question → speechSynthesis.cancel()`
  - `suggestion chip click asks that question`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `world: Ask bar with evidence chips, replay and optional spoken answers`.

### Task 5: Voice into the Ask bar

**Files:**
- Modify: `src/renderer/src/hooks/useVoiceInput.ts` (signature :39, `inject` :77-80, `transcribe` :124-156)
- Modify: `src/renderer/src/components/World/WorldAsk.tsx` (mic button)
- Test: extend `useVoiceInput` tests; extend `WorldAsk.test.tsx`

**Interfaces:**
- Produces: `useVoiceInput(terminalId: string | null, agentDetected: boolean, opts?: { onTranscript?: (text: string) => void })`. When `onTranscript` is set, the transcript is delivered there **instead of** `inject`/`writeToTerminal`, and the confirm-before-run flow is skipped (nothing executes; the text only fills the Ask input).
- The `WorldAsk` mic calls `useVoiceInput(null, false, { onTranscript: (t) => { setInput(t); ask(t) } })` with the existing tap-or-hold behaviour.

- [ ] **Step 1:** Write the tests:
  - `with onTranscript, transcript goes to the sink and writeToTerminal is never called`
  - `without onTranscript, behaviour unchanged` (existing tests stay green)
  - `terminalId null + onTranscript works`
  - `WorldAsk: voice transcript fills the input and asks`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `voice: optional onTranscript sink; Lumopolis asks by voice`.

### Task 6: End-to-end

**Files:**
- Create: `e2e/world-ask.spec.ts`
- Modify: `e2e/helpers/launch.ts` only if the headless agent shim needs a canned reply hook (prefer the existing `e2eShimEnv` mock agent)

- [ ] **Step 1:** Write the spec. The mock agent replies with fixed text plus a `world-actions` block focusing building `b1` and opening its card. The spec launches, opens Lumopolis, waits for the map, types `How does it fit together?`, presses Enter, and asserts:
  - the answer text appears;
  - the card for `b1` opens;
  - clicking an `[E1]` chip shows its evidence;
  - asking twice quickly yields one answer (the second's);
  - zero renderer console errors.
- [ ] **Step 2:** Run `npx playwright test e2e/world-ask.spec.ts` → PASS. Run `unset PROMPT_COMMAND && npm run test:coverage` → PASS with thresholds.
- [ ] **Step 3:** Commit with the message `world: ask e2e`.
