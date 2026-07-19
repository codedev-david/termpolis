# Model Hot-Swap Relaunch Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the per-terminal model hot-swap dropdown from corrupting Claude Code's global default model, by relaunching the terminal's Claude process with `--model --continue` instead of typing `/model <alias>` into it.

**Architecture:** New pure-ish orchestrator module (`modelRelaunch.ts`) sends a documented Ctrl+C/Ctrl+D/Ctrl+D exit sequence then retypes `claude --model <alias> --continue`, wired into `TerminalPane.tsx`'s existing picker `onChange`. Gated on whether this terminal's Claude session is **authoritatively** known (Termpolis itself launched it) vs. merely output-detected — only the authoritative case is safe to interrupt (see Task 2 rationale). The heuristic-only case keeps today's `/model` behavior unchanged (same known limitation, not made worse).

**Tech Stack:** TypeScript, React, Vitest (unit + component tests), Playwright/Electron (e2e) — matches existing project stack, no new dependencies.

## Global Constraints

- TDD: every code change ships with a failing test written first, per superpowers:test-driven-development.
- Coverage floor (CI-enforced): lines ≥90%, statements/functions ≥89%, branches ≥84%.
- Commit + push directly to `main` — no feature branches, no PRs (established project convention).
- Windows dev environment; PowerShell is the primary shell, Bash tool also available.
- Follow existing code style in touched files exactly — no unrelated reformatting or refactors.

---

### Task 1: `modelRelaunch.ts` — the interrupt-and-relaunch orchestrator

**Files:**
- Create: `src/renderer/src/lib/modelRelaunch.ts`
- Create: `tests/renderer/modelRelaunch.test.ts`

**Interfaces:**
- Consumes: `claudeModelArg(model: string | undefined | null): string` from `src/renderer/src/lib/modelBroker.ts` (existing, unchanged — returns `` ` --model ${alias}` `` for a validated alias, `''` otherwise).
- Produces: `relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void>` and the `RelaunchIO` interface (`{ write: (data: string) => void; sleep: (ms: number) => Promise<void> }`) — Task 2 imports both.

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer/modelRelaunch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { relaunchClaudeWithModel } from '../../src/renderer/src/lib/modelRelaunch'

function fakeIo() {
  const writes: string[] = []
  const sleeps: number[] = []
  return {
    writes,
    sleeps,
    write: (data: string) => { writes.push(data) },
    sleep: async (ms: number) => { sleeps.push(ms) },
  }
}

describe('relaunchClaudeWithModel', () => {
  it('sends Ctrl+C, two Ctrl+D presses, then relaunches with --model and --continue', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet', io)
    expect(io.writes).toEqual(['\x03', '\x04', '\x04', 'claude --model sonnet --continue\r'])
  })

  it('validates the alias the same way claudeModelArg does (no injection)', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('sonnet; rm -rf /', io)
    expect(io.writes).toEqual([])
  })

  it('no-ops for an empty/placeholder alias', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('', io)
    expect(io.writes).toEqual([])
  })

  it('waits between each keystroke with the documented timing', async () => {
    const io = fakeIo()
    await relaunchClaudeWithModel('opus', io)
    expect(io.sleeps).toEqual([150, 150, 400])
  })

  it('builds the relaunch command for every valid Claude alias', async () => {
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
      const io = fakeIo()
      await relaunchClaudeWithModel(alias, io)
      expect(io.writes[3]).toBe(`claude --model ${alias} --continue\r`)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/modelRelaunch.test.ts`
Expected: FAIL — `Cannot find module '../../src/renderer/src/lib/modelRelaunch'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/modelRelaunch.ts`:

```typescript
// Relaunches a terminal's Claude Code process on a different model instead of
// hot-swapping in place. Claude Code (v2.1.153+) treats `/model <alias>` typed
// directly as "switch AND save as my new global default", rewriting
// ~/.claude/settings.json — so a per-terminal picker that types that command
// corrupts every other terminal's next launch. `--model` at launch is
// documented session-only, and `--continue` resumes the prior conversation in
// the same directory, so this achieves a real per-terminal switch instead.
//
// The exit sequence (Ctrl+C, then Ctrl+D twice) is Claude Code's own documented
// keyboard-shortcut behavior (see interactive-mode docs): Ctrl+C normalizes to
// an idle, empty prompt (clears input, or interrupts a running turn); Ctrl+D's
// first press shows an exit confirmation hint, and a second press within its
// documented 800ms window exits. Only call this for a terminal AUTHORITATIVELY
// known to be running Claude Code (Termpolis itself launched it) — a
// heuristically output-detected "Claude-like" terminal might be a different
// program that would just exit on the first Ctrl+D instead of consuming it.

import { claudeModelArg } from './modelBroker'

const CTRL_C = '\x03'
const CTRL_D = '\x04'
const NORMALIZE_DELAY_MS = 150
const CONFIRM_DELAY_MS = 150 // stays well under Claude Code's documented 800ms Ctrl+D exit window
const EXIT_SETTLE_MS = 400

export interface RelaunchIO {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}

export async function relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void> {
  const modelArg = claudeModelArg(alias)
  if (!modelArg) return
  io.write(CTRL_C)
  await io.sleep(NORMALIZE_DELAY_MS)
  io.write(CTRL_D)
  await io.sleep(CONFIRM_DELAY_MS)
  io.write(CTRL_D)
  await io.sleep(EXIT_SETTLE_MS)
  io.write(`claude${modelArg} --continue\r`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/modelRelaunch.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/modelRelaunch.ts tests/renderer/modelRelaunch.test.ts
git commit -m "$(cat <<'EOF'
Add modelRelaunch: interrupt-and-relaunch instead of /model hot-swap

Claude Code v2.1.153+ persists a directly-typed /model <alias> as the
new GLOBAL default (rewrites ~/.claude/settings.json), instead of
scoping to the current session. This isolates the fix as a pure,
independently-tested orchestrator; wiring into the terminal UI is next.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the relaunch into the terminal's model picker

**Files:**
- Modify: `src/renderer/src/components/TerminalPane/TerminalPane.tsx:31` (import), `:278` (add derived value), `:1384-1392` (onChange + tooltip), `:299` (comment)
- Test: `tests/components/TerminalPane.test.tsx:1128-1177` (the `describe('live model picker ...')` block)

**Interfaces:**
- Consumes: `relaunchClaudeWithModel(alias, io): Promise<void>` from Task 1's `modelRelaunch.ts`. `agentFromCommand(command): AgentInfo | null` from the already-imported `agentDetector.ts` (used here for a second, narrower check). `modelSwitchCommand(alias): string` from `modelBroker.ts` (existing, unchanged — stays in use for the fallback branch).
- Produces: nothing new consumed elsewhere — this is the UI integration endpoint.

**Why the safety gate:** `badgeAgent = agentFromCommand(agentCommand) ?? agent.detectedAgent` resolves truthy from EITHER an authoritative launch (Termpolis itself typed `claude ...` into this terminal) OR a heuristic output-scrape (`agentDetector.ts`'s `AI_AGENT_PATTERNS`, matching text like "claude" or "anthropic" anywhere in the output) — both produce the identical `{name: 'Claude Code', ...}` shape, so the existing `badgeAgent?.name === 'Claude Code'` picker-visibility check cannot tell them apart. Sending Ctrl+D twice into a real Claude Code session is safe (documented behavior); sending it into a plain bash shell that merely *looks* Claude-like in its output is not — bash exits on the very first Ctrl+D at an empty prompt, with no confirmation stage. So the relaunch path is gated on the authoritative check specifically (`agentFromCommand(agentCommand)`, ignoring the heuristic fallback); the heuristic-only case keeps today's `/model` hot-swap, unchanged.

- [ ] **Step 1: Write/update the failing tests**

In `tests/components/TerminalPane.test.tsx`, replace the two tests at lines 1146-1162 (inside `describe('live model picker (single-agent hot-swap)', ...)`) with:

```typescript
    it('shows the picker for an authoritatively-launched Claude terminal and relaunches with --model + --continue on change', async () => {
      vi.useFakeTimers()
      withClaudeTerminal('claude --dangerously-skip-permissions')
      render(<TerminalPane {...defaultProps} />)
      fireEvent.change(screen.getByTestId('model-picker'), { target: { value: 'sonnet' } })
      await vi.runAllTimersAsync()
      expect(mockWriteToTerminal).toHaveBeenNthCalledWith(1, 'term-1', '\x03')
      expect(mockWriteToTerminal).toHaveBeenNthCalledWith(2, 'term-1', '\x04')
      expect(mockWriteToTerminal).toHaveBeenNthCalledWith(3, 'term-1', '\x04')
      expect(mockWriteToTerminal).toHaveBeenNthCalledWith(4, 'term-1', 'claude --model sonnet --continue\r')
      vi.useRealTimers()
    })

    it('switches models back and forth midstream, relaunching each time', async () => {
      vi.useFakeTimers()
      withClaudeTerminal('claude --dangerously-skip-permissions')
      render(<TerminalPane {...defaultProps} />)
      const picker = screen.getByTestId('model-picker')
      for (const alias of ['opus', 'sonnet', 'haiku', 'opus', 'fable']) {
        mockWriteToTerminal.mockClear()
        fireEvent.change(picker, { target: { value: alias } })
        await vi.runAllTimersAsync()
        expect(mockWriteToTerminal).toHaveBeenNthCalledWith(4, 'term-1', `claude --model ${alias} --continue\r`)
      }
      vi.useRealTimers()
    })

    it('falls back to the plain /model hot-swap for a heuristically-detected (not authoritatively-launched) session', async () => {
      withClaudeTerminal(undefined)
      const { useAgentDetection } = await import('../../src/renderer/src/hooks/useAgentDetection')
      ;(useAgentDetection as any).mockReturnValue({ detectedAgent: { name: 'Claude Code', icon: 'fa-solid fa-robot', color: '#D97706' } })
      render(<TerminalPane {...defaultProps} />)
      fireEvent.change(screen.getByTestId('model-picker'), { target: { value: 'sonnet' } })
      expect(mockWriteToTerminal).toHaveBeenCalledTimes(1)
      expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', '/model sonnet\r')
      ;(useAgentDetection as any).mockReturnValue({ detectedAgent: null })
    })
```

Leave the two tests after this block (`does NOT show the picker for a plain (non-agent) terminal`, `sends nothing for the placeholder option`) exactly as they are — both still apply unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/components/TerminalPane.test.tsx -t "live model picker"`
Expected: FAIL — the first two tests still see `/model sonnet\r` (old behavior) instead of the 4-call sequence; the third test currently gets the interrupt sequence too (no safety gate exists yet), not the plain `/model` fallback.

- [ ] **Step 3: Implement**

In `src/renderer/src/components/TerminalPane/TerminalPane.tsx`, change the import at line 31 from:

```typescript
import { CLAUDE_MODEL_OPTIONS, modelSwitchCommand } from '../../lib/modelBroker'
```

to:

```typescript
import { CLAUDE_MODEL_OPTIONS, modelSwitchCommand } from '../../lib/modelBroker'
import { relaunchClaudeWithModel } from '../../lib/modelRelaunch'
```

Insert this line right after line 278 (`const badgeAgent = agentFromCommand(agentCommand) ?? agent.detectedAgent`), before `useTranscriptWatcher(...)`:

```typescript
  // Only an authoritatively-launched Claude session (Termpolis itself typed the launch
  // command) is safe to interrupt-and-relaunch — see modelRelaunch.ts's file comment.
  // A heuristically output-detected "Claude-like" terminal might be a different program
  // that would just exit on the first Ctrl+D (plain bash does, at an empty prompt)
  // instead of consuming it like Claude Code does, so that case keeps the old hot-swap.
  const isAuthoritativeClaudeSession = agentFromCommand(agentCommand)?.name === 'Claude Code'
```

Update the comment at line 299 from:

```typescript
  // Local hot-swap model for this terminal's Claude agent (sends /model on change).
```

to:

```typescript
  // Local hot-swap model for this terminal's Claude agent — relaunches with
  // --model/--continue for an authoritatively-launched session (see
  // isAuthoritativeClaudeSession above); falls back to a plain /model hot-swap
  // for a heuristically-detected session we can't safely interrupt.
```

Replace the picker `<select>` block at lines 1379-1399 (the non-disabled branch) from:

```tsx
            ) : (
              <select
                data-testid="model-picker"
                value={liveModel}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation()
                  const alias = e.target.value
                  setLiveModel(alias)
                  const cmd = modelSwitchCommand(alias)
                  if (cmd) window.termpolis.writeToTerminal(terminalId, cmd + '\r')
                }}
                title="Switch this Claude agent's model on the fly (takes effect next message). Cheaper models save tokens."
                className="text-[10px] font-medium text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border border-[#3c3c3c] hover:border-[#1177bb] rounded px-1.5 py-1 transition-colors outline-none"
              >
                <option value="">Model…</option>
                {CLAUDE_MODEL_OPTIONS.map((m) => (
                  <option key={m.alias} value={m.alias}>{m.label}{m.note ? ` · ${m.note}` : m.savingsPct > 0 ? ` · ${m.savingsPct}% cheaper` : ''}</option>
                ))}
              </select>
            )
```

to:

```tsx
            ) : (
              <select
                data-testid="model-picker"
                value={liveModel}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation()
                  const alias = e.target.value
                  setLiveModel(alias)
                  if (isAuthoritativeClaudeSession) {
                    void relaunchClaudeWithModel(alias, {
                      write: (data) => window.termpolis.writeToTerminal(terminalId, data),
                      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                    })
                  } else {
                    const cmd = modelSwitchCommand(alias)
                    if (cmd) window.termpolis.writeToTerminal(terminalId, cmd + '\r')
                  }
                }}
                title="Switch this Claude agent's model (restarts this terminal's session on the new model and resumes your conversation, when Termpolis launched it; cheaper models save tokens)."
                className="text-[10px] font-medium text-[#e0e0e0] bg-[#2d2d2d]/90 hover:bg-[#0e639c] border border-[#3c3c3c] hover:border-[#1177bb] rounded px-1.5 py-1 transition-colors outline-none"
              >
                <option value="">Model…</option>
                {CLAUDE_MODEL_OPTIONS.map((m) => (
                  <option key={m.alias} value={m.alias}>{m.label}{m.note ? ` · ${m.note}` : m.savingsPct > 0 ? ` · ${m.savingsPct}% cheaper` : ''}</option>
                ))}
              </select>
            )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/components/TerminalPane.test.tsx`
Expected: PASS — full file green (not just the `-t` filter this time, to catch any collateral breakage elsewhere in this large test file).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TerminalPane/TerminalPane.tsx tests/components/TerminalPane.test.tsx
git commit -m "$(cat <<'EOF'
Wire model-relaunch into the terminal picker, gated on authoritative launch

Only relaunches (interrupt + --model --continue) when Termpolis itself
launched this terminal's Claude session. A heuristically output-detected
session keeps the old /model hot-swap, since blindly sending Ctrl+D into
an unconfirmed non-Claude shell would exit it on the first press.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Clarify the e2e test's scope and run full verification

**Files:**
- Modify: `e2e/model-switch-proof.spec.ts:6-9` (top comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task is a comment clarification plus a full-suite verification gate, no behavior change.

**Why no assertion changes:** this e2e test's `createTerminal()` helper creates a plain terminal (not launched through an AI-profile flow), so it has no authoritative `agentCommand` — its Claude session is faked purely via an echoed output marker (heuristic detection only). Under Task 2's safety gate, that's exactly the fallback path that still sends `/model <alias>` unchanged. The test's assertions are already correct for that path; only its comment needs updating so a future reader doesn't wonder why `/model` is still being sent after this fix ships.

- [ ] **Step 1: Update the comment**

In `e2e/model-switch-proof.spec.ts`, replace lines 6-9:

```typescript
// Proves live model switching works MID-SESSION on a real Claude terminal: launch Claude,
// wait for the model picker to appear (which only happens once the terminal is detected as
// an AI/Claude terminal), then switch models back and forth and confirm each `/model <alias>`
// is delivered into the running session. Production Termpolis must be closed.
```

with:

```typescript
// Proves live model switching works MID-SESSION for a HEURISTICALLY-detected Claude
// terminal (no authoritative launch command — Termpolis can't safely interrupt a session
// it didn't launch itself, so this path intentionally keeps the plain `/model <alias>`
// hot-swap; see modelRelaunch.ts and TerminalPane.tsx's isAuthoritativeClaudeSession for
// the authoritatively-launched path, which relaunches instead and is covered by
// tests/components/TerminalPane.test.tsx + tests/renderer/modelRelaunch.test.ts).
// Production Termpolis must be closed.
```

- [ ] **Step 2: Run the full unit/component test suite**

Run: `npx vitest run`
Expected: PASS — every test file green, including the two touched in Tasks 1-2.

- [ ] **Step 3: Run the e2e test**

Run: `npx playwright test e2e/model-switch-proof.spec.ts`
Expected: PASS, unchanged from before this plan (confirms the comment-only edit didn't alter behavior).

- [ ] **Step 4: Commit**

```bash
git add e2e/model-switch-proof.spec.ts
git commit -m "$(cat <<'EOF'
Clarify model-switch-proof.spec.ts now covers the heuristic-only path

No assertion changes — this e2e test's terminal has no authoritative
agentCommand, so it already exercises the fallback branch added in the
previous commit. Comment-only, to avoid future confusion.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Ship as a patch release

**Files:**
- Modify: `package.json` (version field)

- [ ] **Step 1: Bump the patch version**

Read the current `"version"` value in `package.json` and increment the patch digit (e.g. `1.27.7` → `1.27.8`). Edit the `"version"` field to the new value.

- [ ] **Step 2: Commit and push to main**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Bump version to <new-version>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

(Substitute the actual new version number for `<new-version>` — this is not a placeholder to leave in the commit, it's an instruction to fill in the real value determined in Step 1.)

- [ ] **Step 3: Tag and release**

Invoke the **release-notify** skill to tag `v<new-version>`, push the tag, and watch both the Tests and Release GitHub Actions pipelines to a fully green `--json conclusion` — that skill already owns this mechanic end-to-end (including shipping a clean follow-up patch if a pipeline goes red, and the release-notification email), so it isn't re-specified here.

---

## Self-Review

**Spec coverage:** Root cause + fix (design Part 1) → Tasks 1-2. Testing plan (rewrite e2e, update unit test) → Tasks 2-3, refined during planning: the e2e test needed a comment update rather than an assertion rewrite, once tracing through `createTerminal()` showed it already exercises the (unchanged) heuristic-fallback path. Design's "Known implementation risk" (verify the clean-exit sequence against a live session) → addressed by grounding the exact keystrokes in Claude Code's own documented interactive-mode shortcuts (Ctrl+C behavior, Ctrl+D's 800ms two-press window) rather than guessing. Design's Part 2 (Settings > General defaults) is explicitly out of scope for this plan — David scoped this request to the dropdown fix only.

**New finding beyond the spec:** the spec didn't anticipate that `badgeAgent?.name === 'Claude Code'` is satisfied by both the authoritative and heuristic detection paths identically — this surfaced during planning (tracing `agentFromCommand` vs. `agentDetector`'s `AI_AGENT_PATTERNS`) and materially changes the fix's safety envelope, so Task 2 adds the `isAuthoritativeClaudeSession` gate not present in the original design doc.

**Placeholder scan:** none — every step has literal code/commands. The `<new-version>` in Task 4 is an explicit fill-in-the-real-value instruction, not an unresolved TBD.

**Type consistency:** `RelaunchIO` (`write`/`sleep`) is defined once in Task 1 and used identically in Task 2's wiring. `relaunchClaudeWithModel(alias: string, io: RelaunchIO): Promise<void>` signature matches at both the Task 1 test and the Task 2 call site.
