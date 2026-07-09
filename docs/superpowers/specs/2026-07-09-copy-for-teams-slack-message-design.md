# Copy for Teams/Slack (message form) — Design

- **Date:** 2026-07-09
- **Status:** Implemented and shipped in v1.22.4 (recipe validated by real Teams + Slack paste before build)
- **Repo:** termpolis

## Problem

Copying terminal output and pasting it into a Microsoft Teams or Slack **message**
produces a mangled result: soft-wrapped lines become hard returns, spacing and
alignment break, and (in prior attempts) the content lands as a grey monospace
**code box** with big paragraph gaps between every line.

This has been attempted twice before (v1.11.43, then "fully fixed" in v1.11.45)
and never satisfied the actual need. The user's complaint on the record, almost
verbatim: *"it gives me a sql code box at the end and has hard returns everywhere."*

## Root cause of the prior failures

Every prior attempt targeted a **code box**. They wrote `text/html` as a styled
`<pre><code>` block plus a ` ```text ` markdown fence. The `<pre>` correctly
preserved newlines, but:

1. **A code box was never the goal.** The user wants a normal, readable chat
   **message** — emojis rendered, tight line breaks, preserved spacing, no grey box.
2. `<pre>` / `<code>` is exactly what makes Teams and Slack render a code block.
3. Plain-text-into-Teams turned each `\n` into a hard paragraph break — the
   "hard returns everywhere" symptom.

The target was wrong, and there was no acceptance test that actually pasted into
the real apps.

## Goal

A new copy action — **"Copy for Teams/Slack"** — whose result pastes as a
**normal chat message** in both Teams and Slack:

- Emojis rendered (unicode passes straight through).
- Line breaks tight — no giant paragraph gaps.
- Spacing / indentation preserved (columns kept as far as the target allows).
- **No grey code box.**
- Soft-wrapped terminal lines rejoined into logical lines (already handled by the
  existing `isWrapped`-based extractor).

## Non-goals

- Not a code box. The existing **"Copy as Code Block"** stays as-is for
  logs / commands.
- Not preserving ANSI colors in the message form (stripped).
- No per-app clipboard targeting — one clipboard serves both apps, so the format
  must be innocuous in **both**.

## Design

### One copy, two clipboard formats

Reuse the existing native-clipboard IPC `clipboardWriteRich(plain, html)`
(`src/main/index.ts` → `clipboard:write-rich` → `clipboard.write({ text, html })`),
which places `text/plain` and `text/html` on the clipboard together. Teams and
Slack each pick their preferred format.

**`text/plain`** — the existing clean extraction (`formatAsPlainTextFromTerm`):
ANSI stripped, soft-wraps unwrapped via `BufferLine.isWrapped`, internal blank
lines preserved, trailing whitespace trimmed, emojis intact. Slack renders this
as a normal message with tight breaks and preserved leading spaces.

**`text/html`** — new formatter `formatAsMessageHtmlFromTerm(term)`:

- Start from the same clean extraction (unwrapped logical lines, ANSI stripped).
- HTML-escape `&`, `<`, `>`.
- **Newlines → `<br>`** (tight line breaks). Never `<p>` / `<div>`-per-line —
  those add the paragraph gaps that caused the "hard returns" complaint.
- **Whitespace → `&nbsp;` selectively**, so the space *count* survives target
  sanitizers (which collapse ordinary HTML whitespace) while long prose lines
  still wrap:
  - Leading spaces on each line → `&nbsp;` (indentation).
  - Runs of 2+ interior spaces → `&nbsp;` (column gaps).
  - Single interior spaces → left as normal, breakable spaces (lines still wrap).
- **No `<pre>`, no `<code>`** — so neither app turns it into a code block.
- Wrap in one unboxed, monospace container:
  `<span style="font-family:Consolas,Menlo,Monaco,'Courier New',monospace">…</span>`.
  Monospace is best-effort alignment; if a target forces its own font, the
  `&nbsp;` counts still keep the spacing sane. No background / border / padding —
  it is not a box.
- Emojis pass through as literal unicode.

A pure helper `toMessageHtml(text: string): string` holds the escape/`<br>`/`&nbsp;`
logic so it is unit-testable without a Terminal handle;
`formatAsMessageHtmlFromTerm` = `toMessageHtml(cleanForExportFromTerm(term))`.

### Font decision — locked: monospace, unboxed

Agent output frequently has aligned columns (trees, tables, progress bars).
Monospace keeps them lined up where the target honors the font, and it still
reads as a message, not a code box. Switching to proportional is a one-line style
change if the real paste looks better that way.

**Scope — this is important:** the monospace `font-family` lives *only* inside the
generated `text/html` payload for this one action. It is not a setting and not
global. It does **not** change the terminal font, the app UI, the `text/plain`
half of this copy (plain text carries no font), or any other copy action (Copy,
Copy as Code Block, Copy as Plain Text, Copy with Command). It affects only how
the pasted message renders in Teams/Slack, and only if that app honors the font.

### UI

- New right-click context-menu item **"Copy for Teams/Slack"** at the **top** of
  the copy group in `TerminalPane.tsx` (above "Copy as Code Block").
- Rebindable keybinding via `keybindings.ts` (a chord confirmed not to conflict;
  candidate `Ctrl+Shift+T`).
- **"Copy as Code Block"** (`Ctrl+Shift+M`) is left unchanged.

### Snapshot

Add a `messageHtml` field to `CopySnapshot` and compute it in
`buildCopySnapshot(term)` (TerminalPane.tsx), so the action uses the
right-click-time snapshot like the other copy items. The menu item calls
`clipboardWriteRich(snap.plainText, snap.messageHtml)`.

## Files to change

- `src/renderer/src/lib/exportTerminal.ts` — add `toMessageHtml()` +
  `formatAsMessageHtmlFromTerm()`.
- `src/renderer/src/components/TerminalPane/TerminalPane.tsx` — `CopySnapshot`
  field, `buildCopySnapshot`, new menu item, keybinding handler.
- `src/renderer/src/lib/keybindings.ts` — new binding entry + label.
- Tests: a `messageHtml` unit test (new or in `tests/renderer/formatAsCodeBlock.test.ts`),
  `tests/components/TerminalPane.test.tsx` (menu item + snapshot),
  `tests/renderer/keybindings.test.ts`.

## Testing / Definition of Done

1. **Unit tests** for `toMessageHtml`: emoji passthrough; `<br>` for newlines;
   leading + 2+-interior spaces → `&nbsp;`; single interior spaces stay spaces;
   `& < >` escaped; contains no `<pre>` / `<code>`; blank lines preserved.
2. **Acceptance gate (the step skipped before):** paste real samples — including
   emoji-rich Claude Code output and a table with aligned columns — into **real
   Teams AND real Slack** (desktop + web) and confirm: emojis render, breaks
   tight, spacing preserved, no code box. **This is the gate.** Unit tests alone
   do not close it.
3. Coverage gates stay green (lines ≥90, stmts ≥89, fn ≥89, branches ≥84).

## Out of scope (this spec)

- **Alt+click to move cursor (Feature 2):** confirmed already working natively in
  git bash (xterm 5.5 `altClickMovesCursor`, never disabled). No build required.
  Optional future hardening — Settings toggle, works-while-scrolled, e2e lock —
  deferred unless requested.
