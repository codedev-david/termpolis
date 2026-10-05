# Manually-run e2e specs

These specs are **not** part of any build gate. Each needs something a hosted GitHub
runner cannot provide, so leaving them in the main suite would mean either a permanently
red pipeline or — the situation that actually held until v1.32.5 — a suite nobody ran and
nobody noticed rotting.

Run them from a developer machine:

```bash
npm run test:e2e:manual                                       # all of them
npm run test:e2e:manual -- e2e/manual/visual-regression.spec.ts   # just one
```

The main `playwright.config.ts` ignores `e2e/manual/**`; this directory has its own
`playwright.manual.config.ts` so an explicit run still works.

| Spec | Why it can't gate CI | To run it |
| --- | --- | --- |
| `memory-learning-proof.spec.ts` | Asserts against the **real** production memory store (~80k memories in `%APPDATA%\termpolis`). It deliberately omits `--user-data-dir`, so it also takes the single-instance lock. | Close Termpolis first, then run on the machine whose store you want to prove. |
| `second-opinion-proof.spec.ts` | Spawns the real `claude`, `codex` and `agy` binaries. On CI every one is `spawn … ENOENT`. | Needs all three CLIs installed and authed. |
| `model-switch-proof.spec.ts` | The live model picker renders empty and disabled (`title="Claude Code must be installed to switch models."`) unless `installedAgents.claude` is true, so `selectOption` has nothing to select on CI. | Needs a real `claude` on PATH. |
| `visual-regression.spec.ts` | Pixel baselines are `*-win32.png` and are **gitignored** — a Linux runner has none, so it would silently write fresh baselines and pass on anything. | Windows only. Delete a baseline to re-record it. |
| `linked-machines-real.spec.ts` | Links two instances through the **production relay** (`wss://relay.termpolis.com`) and has each run real headless agent jobs on the other via the `linked_machines` MCP tool (Claude both ways, then Codex). CI has neither the relay nor signed-in agents; `e2e/linked-machines.spec.ts` covers the pane over a dead relay instead. | Needs network plus `claude` installed and signed in; `codex` too for its leg, which is skipped (with the reason) when `api.openai.com` is unreachable from the network you are on. Spends a few tokens. Evidence (screenshots, MCP answers, each instance's main log) lands in `$LINKED_REAL_OUT`, default `test-results/linked-real`. `TERMPOLIS_E2E_SKIP_BUILD=1` reuses `out/`. |

## Adding one

Don't, if you can avoid it — a spec here is a spec that will not catch your regression.
Prefer making the assertion runnable on a hosted runner: fake the binary, isolate the
profile with `e2eUserDataDir()`, assert geometry instead of pixels (see
`e2e/terminal-layout.spec.ts`). Move a spec here only when the dependency is genuinely
outside CI's reach, and add a row above saying what that dependency is.
