# Per-Agent Model Defaults — Design Spec

**Status:** Approved by David 2026-07-18. Not yet implemented — implementation plan (writing-plans skill) still to be created.

## Background

Two related requests from David about AI-model control in terminal sessions:

1. The existing per-terminal "switch model on the fly" dropdown (Claude Code terminals only, top-right of each terminal pane) was suspected of leaking a model change into other terminals/sessions.
2. New ask: a way to set a default model for Claude and for Codex under Settings → General, used when launching new terminals.

## Part 1 — Bug fix: hot-swap dropdown corrupts the global default

### Root cause (confirmed)

`TerminalPane.tsx` (~lines 1384-1390) sends the literal keystrokes `` `/model ${alias}\r` `` into the terminal's running Claude Code process. As of Claude Code CLI v2.1.153+, typing `/model <alias>` directly (as opposed to opening the interactive picker with no argument and pressing `s`) **always persists that choice as the new global default**, by rewriting the `model` field in `~/.claude/settings.json`. This is documented, intentional Claude Code behavior, not a Termpolis state-management bug — confirmed by:
- Directly observing `/model sonnet` print "saved as your default for new sessions" and rewrite `~/.claude/settings.json` earlier in this same investigation.
- Official Claude Code docs (via claude-code-guide agent): "`/model` saves your choice as the default for new sessions... Typing `/model <name>` directly behaves like Enter [in the picker, i.e. switch + save as default]."

This explains all observed symptoms:
- A newly-opened terminal starts on whatever model was last picked anywhere (reads the updated global default at launch).
- Claude Code itself prints the "default has changed" message in-terminal.
- Any terminal opened/relaunched after the pick reflects the new default.

Note: the terminal-scoping of Termpolis's own code is *not* the bug — `liveModel` React state and the `terminalId`-scoped `writeToTerminal` IPC call are correctly isolated per terminal. The leak is entirely inside Claude Code's own settings persistence, triggered by the specific keystrokes Termpolis sends.

### Fix

Claude Code also documents:
- `--model <model>`: "Model for the current session" — session-only, never touches `settings.json`.
- `-c, --continue`: "Continue the most recent conversation in the current directory."

New behavior for the hot-swap dropdown, on selecting a model:
1. Send a clean-exit sequence to interrupt that terminal's currently-running Claude process (exact sequence TBD during implementation — verify against a live session; candidates are Ctrl+C or `/exit`).
2. Type `claude --model <alias> --continue\r` into that same terminal (same cwd).
3. Update `liveModel` state as today.

This avoids the global settings.json side effect entirely while resuming the prior conversation, at the cost of a brief visible restart in that terminal. Matches Claude Code's own documented guidance for this exact scenario: "To run different models in different terminals at the same time, launch each one with its own `--model` flag rather than switching with `/model`."

Stays Claude-only (same gating as today: `badgeAgent?.name === 'Claude Code'`). Codex is not getting a live in-terminal switcher — see Part 2 for why.

### Known implementation risk

The clean-exit sequence needs empirical verification against a real running session before this is considered done (per verification-before-completion) — Claude Code's TUI exit behavior (single vs double Ctrl+C, mid-tool-call state, permission-prompt state) is not something to assume from documentation alone.

## Part 2 — New: Settings → General → per-agent default model

### Storage

New file `src/renderer/src/lib/agentModelDefaults.ts`, mirroring the existing `terminalDefaults.ts` pattern:
- `getAgentModelDefaults(): { claude?: string; codex?: string }`
- `setAgentModelDefaults(partial: { claude?: string; codex?: string }): void`
- Persisted to `localStorage` under key `termpolis.agent.modelDefaults` (not zustand/session.json — consistent with how Terminal Defaults theme/font already work: a global launch-time preference, not session state).

### UI

New "Default Models" box in `SettingsPane.tsx`'s General tab, alongside the existing Terminal Defaults box:
- **Claude:** `<select>` populated from the existing `CLAUDE_MODEL_OPTIONS` (fable/opus/sonnet/haiku) in `modelBroker.ts`. No new data needed.
- **Codex:** free-text `<input>`. Rationale: Codex model names are not a small stable set — David's own `~/.codex/config.toml` shows three migrations already (`gpt-5.3-codex` → `gpt-5.4` → `gpt-5.5`), and Codex's CLI (`-m/--model`) takes any free-form string with no fixed enum. A hardcoded dropdown would go stale the same way that config's own migration table shows it already has.

### Validation (Codex free-text field)

Regex: `/^[A-Za-z0-9._-]{1,64}$/`. Applied twice (defense in depth):
1. On save in Settings (inline error if rejected).
2. Again at launch-command-construction time, immediately before the value is concatenated into a shell-typed launch command.

This exists because this string reaches a shell command line and Codex has no fixed safe list the way Claude's dropdown does today (Claude's fixed `<select>` options *are* its allowlist; Codex's free text needs an explicit one).

### Precedence at launch

In `aiProfiles.ts`'s `launchAgentProfile()`:

```
effective model = profile.model (existing per-profile override, unchanged)
                   ?? agentModelDefaults[agentType]  (new General default)
                   ?? <nothing> (today's behavior: no --model flag, CLI's own default)
```

Extends the existing `isClaude`-gated logic with a parallel `isCodex` check, and adds a `codexModelArg()` helper in `modelBroker.ts` alongside the existing `claudeModelArg()`.

This also fixes a pre-existing gap as a side effect: today the 4 built-in profiles (Claude Code, OpenAI Codex, Gemini CLI, Qwen Code) have no editable `model` field at all — only custom profiles created via the Add-Profile modal can set one. Since built-ins' `profile.model` is always unset, they'll now automatically pick up the General default.

### Out of scope

- Gemini and Qwen: no model-selection surface exists for either today (no model list, no flag validation) and neither was requested. Not adding defaults for them now.
- A live in-terminal hot-swap dropdown for Codex (mirroring Claude's): not requested — this design only adds a Settings-level launch-time default for Codex.
- A general/global "economy mode" toggle floated in the earlier `2026-06-13-token-maximization-design.md` doc (Phase 2's idea, never built) — unrelated to this request, not being picked up here.

## Testing plan

- Rewrite `e2e/model-switch-proof.spec.ts` (currently proves *today's buggy* behavior against a real launched session) to instead assert: switching model via the dropdown does **not** change `~/.claude/settings.json`'s `model` field, and the conversation continues after the relaunch.
- Update the unit test in `tests/components/TerminalPane.test.tsx` (~lines 1146-1167) that currently asserts the old `/model sonnet\r` keystroke — assert the new interrupt + relaunch sequence instead.
- New unit tests for `agentModelDefaults.ts` (get/set roundtrip, empty default state).
- New unit tests for the Codex charset validator (valid: `gpt-5.5`, `o3`, `gpt-5.4-codex`; invalid: anything containing `;`, `` ` ``, `$(`, spaces, empty string, over-length string).
- New/updated unit tests for `launchAgentProfile()` precedence, for both Claude and Codex: profile-level `model` wins when set; General default used as fallback when profile-level is unset; neither set → no `--model` flag appended (unchanged current behavior).

## Files expected to change

- `src/renderer/src/components/TerminalPane/TerminalPane.tsx` (hot-swap handler)
- `src/renderer/src/lib/modelBroker.ts` (new `codexModelArg()`, new relaunch-command helper)
- `src/renderer/src/lib/agentModelDefaults.ts` (new file)
- `src/renderer/src/lib/aiProfiles.ts` (`launchAgentProfile()` precedence + Codex support)
- `src/renderer/src/components/SettingsPane/SettingsPane.tsx` (new Default Models UI box)
- `tests/components/TerminalPane.test.tsx`, `e2e/model-switch-proof.spec.ts`, new test file(s) for `agentModelDefaults.ts`
