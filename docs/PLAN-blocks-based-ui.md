# Plan — Blocks-Based Terminal UI

> _Status: design proposal · 2026-05-05_
> _Owner: Termpolis core_
> _Targets: v1.12 (heuristic blocks) → v1.13 (OSC 133 blocks) → v1.14 (AI-aware blocks)_

## Executive Summary

Today every Termpolis terminal is one continuous scrollback buffer.
Output and commands blur together visually, the new four-way Copy
submenu has to ask the user what they want copied (selection? buffer?
last command?), and the AI Security Center can only intercept *whole
prompts*, never *the diff between a command and its reply*.

The fix is the same UX shift that Warp, Wave, Hyper, and others have
made: **structure the buffer into blocks** — each one a `(prompt,
command, output)` triplet — and then build features on top of that
structure. With blocks, "Copy with Command" is a property of a single
block, not a runtime guess. The redaction scanner can show "this block
contains 2 secrets" before you press Enter again. The swarm conductor
can reference *the third block* of an agent's terminal in its
hand-offs.

This document covers the strategy:

1. **Heuristic blocks** (v1.12) — ship a working blocks model that
   *works for every existing shell* without any user setup. Best-effort
   prompt/command/output segmentation from PTY data alone.
2. **OSC 133 blocks** (v1.13) — opt-in upgrade for users who source
   our tiny shell-init snippet. Authoritative segmentation, supports
   exit codes, command duration, and remote sessions.
3. **AI-aware blocks** (v1.14) — every block carries a *kind*: shell,
   AI prompt, AI tool call, AI tool result, AI thought. Wire the
   conductor, security center, and Copy submenu to the kind.

We deliberately do **not** put the AI-block work in v1.12: until the
foundation is solid, the AI features layered on top will inherit the
foundation's bugs.

---

## Why blocks at all?

Three concrete pain points in the current single-buffer model:

### 1. The Copy submenu has to guess intent

The Copy → Code Block / Plain Text / With Command / Image submenu we
shipped in v1.11.43 has a runtime fallback: if the user has nothing
selected, copy *the entire visible buffer*. That's the right answer
maybe a third of the time. The other two-thirds the user wanted *the
last response*, *the failed command and its error*, or *the tool-call
result that was on screen 30 seconds ago*. With blocks, every one of
those becomes a single click.

### 2. The Security Center can only see whole prompts

The pre-paste secret scanner runs on the *paste payload*. If you
manually type `export AWS_SECRET_ACCESS_KEY=…` it never sees it,
because there was no paste. With blocks, every command becomes a
scannable unit at *Enter*-time, before it even leaves the terminal,
and the audit log gets per-block records instead of per-launch.

### 3. The conductor has nothing to reference

Today swarm hand-offs are blob-of-buffer references: *"Codex saw
something on line 442 of its terminal, please scroll up"*. Blocks let
the conductor say *"Codex's block #14 is a failed test run; route to
Claude Code with that block as context"*. This is also the foundation
for the redundancy detector to flag *"Claude and Codex both ran the
same command in their last block"* with a hard reference instead of a
text-similarity heuristic.

A structural answer beats a heuristic answer in every one of these
cases.

---

## Strategy 1 — Heuristic blocks (v1.12)

### Goal

Every terminal in Termpolis renders as an ordered list of blocks
**without any shell setup**, on the first launch, with bash / zsh /
PowerShell / Cmd / Git Bash / WSL all working.

### Detection model

We watch the PTY byte stream and detect *prompt boundaries* by
matching the user's actual prompt against a small set of common
shapes:

| Shell | Default prompt heuristic |
|-------|-------------------------|
| bash  | line ending in `$ ` (after CSI clear) |
| zsh   | line ending in `% ` or `# ` |
| fish  | line ending in `> ` after a `❯` glyph |
| PowerShell | line starting with `PS ` and ending in `> ` |
| Cmd   | line ending in `>` after a path |
| Git Bash | bash heuristic, plus the `MINGW64 …$ ` prefix |

Each shell has a regex *and* a confidence score. We never assume — if
the user customizes their PS1 (very common), the heuristic falls back
gracefully:

- **No prompt detected for N seconds with no output** → assume the
  buffer between two long idle periods is one block.
- **`PROMPT_COMMAND` echo trick** (optional) — Termpolis can offer to
  inject a no-op marker into the user's `PS1` on first launch, with a
  *one-click revert*. Not OSC 133 yet — just a unique sentinel string
  the heuristic can lock onto.

### What a heuristic block contains

```typescript
interface HeuristicBlock {
  id: string                 // ULID, stable across re-renders
  ordinal: number            // 1-based per terminal
  prompt: { text: string; ansi: string; cwd?: string }  // best-effort
  command: { text: string; startedAt: number }
  output: { text: string; ansi: string; bytes: number }
  endedAt: number | null     // null while running
  exitCode: null             // heuristics can't recover this
  kind: 'shell'              // always 'shell' in v1.12
}
```

### Edge cases we accept losing

| Case | Behaviour |
|------|-----------|
| Multi-line commands (continuation prompt `> `) | Stitch to the previous block's `command`. |
| Pasted scripts that contain newlines | One block per *executed* command, not one per pasted line — we lock to the next prompt re-emit. |
| `clear` / `Ctrl+L` | Visual clear; blocks remain in the model and can be revealed via "Show all blocks". |
| `vim`, `htop`, full-screen TUIs | The block enters a `frozen` sub-state — we stop appending output, freeze the partial block, and resume on TUI exit. The frozen block is still copyable as a screenshot. |
| Remote SSH | Heuristic only sees the local PTY; if the remote shell prompts look different, detection degrades to "block per idle window". OSC 133 (next strategy) fixes this. |

We document every limitation in the in-app onboarding tooltip the
first time a block does the wrong thing. Honesty beats magic.

### Render strategy

We keep xterm.js as the canvas — it is fast, battle-tested, supports
WebGL, ligatures, and we already ship it. Blocks are an *overlay*, not
a replacement.

**The plan:**

1. xterm.js continues to write into a single buffer.
2. A `blockTracker.ts` module wraps every PTY data event, runs the
   heuristic, and emits `blockStarted` / `blockUpdated` / `blockEnded`
   events on the `EventBus` that the observability layer already uses.
3. The renderer keeps a parallel `blocks: HeuristicBlock[]` array in
   `terminalStore` (zustand). xterm's scrollback is the source of truth
   for *display*; blocks are the source of truth for *semantics*.
4. A new `BlockOverlay.tsx` component renders thin gutter markers on
   the left edge of the terminal — a small chevron at every block
   boundary. Hovering reveals a context menu (Copy block, Copy block as
   image, Pin output, Re-run command).
5. Right-click on the chevron, or on any line of output, gets the
   *block-aware* Copy submenu. The runtime "what is selected?" guess
   goes away.

We do not rewrite xterm. We add a 200-line tracker and an overlay.

### Kill switch

A `Settings → Terminal → Block UI` toggle. Default ON in v1.12, but
revertable to "classic single-buffer" with one click. The store still
records blocks even when the overlay is hidden — Copy and Security
Center features keep working invisibly.

---

## Strategy 2 — OSC 133 blocks (v1.13)

### What OSC 133 is

OSC 133 (also known as the *Final Term* prompt protocol, popularized by
iTerm2 and now supported by VS Code's terminal) is a tiny set of ANSI
escape sequences that let a shell *tell* the terminal where prompts
and commands begin and end:

| Sequence | Meaning |
|----------|---------|
| `\033]133;A\007` | "A new prompt is about to print." |
| `\033]133;B\007` | "Prompt printed; user input begins now." |
| `\033]133;C\007` | "Command started executing." |
| `\033]133;D;<exit-code>\007` | "Command finished with exit code N." |

If the shell emits these markers, the terminal *knows* with zero
ambiguity where the boundaries are, what the exit code was, and how
long the command ran. Heuristics become irrelevant.

### How we ship it

The user's shell needs a one-line snippet sourced. We ship snippets
in `resources/shell-init/` — `osc133.bash`, `osc133.zsh`,
`osc133.ps1`, `osc133.fish` — and the **Settings → Shell Configuration**
pane gets a new card:

```
[ ] Enable OSC 133 prompt markers
    Adds a 12-line snippet to your shell's startup file (.bashrc,
    .zshrc, $PROFILE) so Termpolis can detect prompts perfectly,
    including over SSH. Click "Preview" to see exactly what gets
    appended. Revert with one click. No effect on other terminals.
```

We never edit dotfiles silently. Preview-then-apply with a
`# >>> termpolis osc133 >>> … # <<< termpolis osc133 <<<` block so
revert is a literal `sed` between markers.

### What changes in the data model

```typescript
interface Osc133Block extends HeuristicBlock {
  kind: 'shell'
  source: 'osc133'                // vs 'heuristic'
  exitCode: number | null         // now real
  durationMs: number | null       // now real
  cwd: string                     // OSC 7 also captured
}
```

Heuristic and OSC 133 blocks coexist in the same store. The renderer
shows a tiny ✓ on the gutter chevron when the block has authoritative
data. The Security Center audit log records `source` so admins can see
the difference.

### Why we don't go straight to OSC 133

Three reasons:

1. **It requires per-shell setup.** v1.12 must work on first launch,
   for every user, on every shell. OSC 133 in v1.13 is the upgrade for
   the users who want perfect data; it cannot be the only path.
2. **SSH and tmux pass it through.** Once the user opts in, the
   markers travel through SSH and tmux without extra config — but
   that's a *bonus* on top of a working v1.12, not a v1.12 prerequisite.
3. **Gives us telemetry.** v1.12 ships the heuristic. We can compare
   heuristic blocks against OSC 133 blocks in beta (anonymized,
   opt-in) and fix the heuristic for the cases where it disagrees with
   ground truth — *before* OSC 133 reaches GA in v1.13.

---

## Strategy 3 — AI-aware blocks (v1.14)

This is where the strategic value compounds.

### The kinds we want

```typescript
type BlockKind =
  | 'shell'              // bash/zsh/etc — the v1.12+v1.13 cases
  | 'ai-user-prompt'     // user typed a prompt INTO Claude/Codex/Gemini/Qwen
  | 'ai-assistant-text'  // model said something
  | 'ai-tool-call'       // model invoked a tool, with name + args
  | 'ai-tool-result'     // tool returned, with output + status
  | 'ai-thought'         // model emitted reasoning (Codex / Claude extended)
  | 'compaction-event'   // context window compaction notice
```

### Where the data comes from

Termpolis already has `transcriptWatchers/` (shipped with the
observability plan). Those watchers parse the JSONL transcripts that
Claude Code, Codex, Gemini CLI, and Qwen Code each write to disk —
*authoritative* events, not buffer regex. The AI-aware blocks layer is
mostly **wiring**:

1. Match a transcript event to the terminal that owns it (we already
   do this via the agent-detection status badge).
2. Convert each event to a block of the appropriate `kind`.
3. Insert into the terminal's block list at the right ordinal.

The PTY-side heuristic / OSC 133 detection still runs in parallel.
When a block of kind `shell` overlaps in time with a block from the
transcript watcher, the transcript wins for that timestamp range. The
buffer-derived block becomes the *fallback* for the gap *between*
transcript events (e.g. a tool call that ran an external command).

### The features that light up

1. **Copy submenu becomes block-typed.**
   Right-click an `ai-tool-call` block → "Copy as Slack-ready" produces
   a clean `> /diff src/foo.ts` instead of the raw JSON.
2. **Security Center scans every kind.**
   `ai-user-prompt` blocks get the secret scanner. `ai-tool-result`
   blocks (the model received a 50KB log file?) get a separate
   *outbound-context* heuristic. Audit log gets `kind` per record.
3. **Conductor references real units.**
   Hand-off message becomes *"Claude block 14 (`ai-tool-call`:
   `read_file src/auth.ts`) failed; routing to Codex with same arg."*
4. **Redundancy detector becomes precise.**
   Today it diffs raw buffer text. With blocks: "two agents emitted
   `ai-tool-call` blocks with identical `name + args` in the last 60s"
   — exact, not heuristic.
5. **Pin a block instead of a region.**
   The pinned-output panel becomes a list of pinned *blocks*, each one
   re-renderable from its model. Surviving compaction, agent restart,
   and even Termpolis restart.

---

## Timeline

| Quarter | Version | Scope | Gate |
|---------|---------|-------|------|
| 2026-Q3 | **v1.12** | Heuristic blocks: tracker, store, overlay, Copy-by-block, kill switch. All five default shells. No AI changes — the existing single-buffer AI flows keep working unchanged. | Smoke test: 6 shells × {`ls`, multi-line, `clear`, `vim`} produces correct block counts. Per-shell. |
| 2026-Q4 | **v1.13** | OSC 133 opt-in: shell-init snippets, dotfile preview-then-apply, exit-code + duration in audit log, ✓ marker in gutter. | E2E test: user installs the bash snippet → restarts shell → runs `false` → block records exit code 1. |
| 2027-Q1 | **v1.14** | AI-aware blocks: `kind` attribute, transcript-watcher integration, conductor block references, kind-aware Copy menu, kind-aware audit log. | E2E: launch Claude in a terminal, ask it to run a tool, verify `ai-tool-call` and `ai-tool-result` blocks appear; conductor hand-off message references them. |
| 2027-Q2 | **v1.15** | Polish: block search (Ctrl+Shift+B), block bookmarks, "Re-run this block in a fresh terminal", export-blocks-as-markdown for PRs. | Ship after telemetry from v1.14 says block detection accuracy ≥ 95% across the install base. |

We do **not** start v1.13 work until v1.12 has shipped one stable
patch release with no blocks-related Sentry incidents.

---

## Open questions

These are deliberately not answered in v1.0 of this doc — they belong
to the design pass that opens v1.12:

1. **Storage.** Blocks are unbounded; a long-running terminal could
   accumulate hundreds. Memory cap? On-disk overflow? Both? Today we
   cap xterm scrollback at 10,000 lines — blocks should follow the
   same rule.
2. **Search.** With blocks we can offer "find me the block where Claude
   ran `npm test`". Does that go in the existing Conversation Search
   (`Ctrl+Shift+I`) or a new shortcut?
3. **Themes.** The block gutter chevron needs to look right in all 7
   themes (Dark, Light, Solarized Dark/Light, Monokai, Dracula, Nord)
   and respect WCAG AA. Designer pass before merge.
4. **Tests.** A real shell session is non-deterministic. We mock the
   PTY for unit tests, but per-shell heuristic accuracy needs a real
   sub-process integration test. Cost of running 5 shells × N
   scenarios in CI is non-trivial — likely matrix-only on Linux
   runners.
5. **Plugin surface.** Should third parties be able to register custom
   block kinds via the MCP server? Decisive *no for v1.14* — we don't
   commit to a plugin API on a fresh feature. Revisit in v1.15+.

---

## Non-goals

To keep scope honest, blocks-based UI is **not**:

- A replacement for xterm.js. We ship blocks as an overlay; the
  underlying renderer stays.
- A re-implementation of Warp's UI. Termpolis stays a terminal — no
  command palette inside the buffer, no inline editor, no
  auto-completion at the prompt that interferes with the user's shell.
  We stay invisible to the shell.
- A way to "lock down" what users can run. Block kinds inform the
  audit log and the security scanner; they do **not** add policy
  enforcement that wasn't already there in Strict Mode.
- A cloud sync feature. Blocks are local-only, like every other piece
  of state in Termpolis.

---

## Acceptance for v1.12 (the only commitment this doc makes)

- [ ] `blockTracker.ts` lands with unit-test coverage ≥ 90% lines.
- [ ] Heuristic detects ≥ 95% of prompt boundaries on a corpus of 200
      recorded shell sessions across the 5 supported shells.
- [ ] BlockOverlay renders ≤ 1 frame slower than the current renderer
      on a `yes | head -100000` stress test.
- [ ] Copy → Code Block / Plain Text / With Command / Image all
      operate on the *clicked block* when invoked from a chevron, with
      no behavioural change when invoked elsewhere (back-compat).
- [ ] Settings → Terminal → "Use block UI" toggle reverts cleanly.
- [ ] No regression in the AI Security Center: secret scanner +
      Strict Mode keep working unchanged.
- [ ] No new Sentry issues in beta for one week before promotion.

v1.13 and v1.14 are scoped *aspirationally* in this doc and will get
their own design pass when v1.12 reaches stable.
