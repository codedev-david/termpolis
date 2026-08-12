# Strategic Surfaces Roadmap — Week of 2026-08-17

> **Status:** Roadmap and sequencing doc — NOT a step-by-step implementation plan.
> Workstream A must get its own TDD plan before any code is written (see *What still needs a plan*).
> Workstream B (cross-agent long-term memory and learning) is co-equal with A in priority; its B1 needs one investigation before it can be planned. C and D work directly from the increments below.
>
> **Baseline:** v1.35.1. **Branching:** commit directly to `main`, no PRs.
> **Coverage gate (Windows CI):** lines 97 / fn 96 / branches 95 / stmts 96 — never lower; backfill tests on the offending file.

---

## Thesis

Termpolis is not a harness. Claude Code, Codex, and Gemini CLI are the harnesses; Termpolis is the environment they run in. Effort spent inside the loop (prompt, tools-in-context, compaction, approvals) competes with three well-funded teams shipping weekly. Effort spent on the surfaces *around* the loop compounds and cannot be copied, because copying it is against the harness vendors' own interests:

- **Cross-vendor memory** — Anthropic will never ship memory that makes Codex better. Every vendor's memory stops at its own product boundary; Termpolis's does not.
- **Cross-agent long-term learning** — a store that only *recalls* is a database. One that gets measurably better at this repo, across vendors, over months, is a different category of product. No harness can build this: a harness's horizon is a session, and its evidence is one vendor's traffic.
- **A security perimeter** — no vendor will ship a guard that credibly constrains itself.

These are structural gaps, not effort gaps. They are the moat.

**Memory is the asset; learning is the compounding.** This distinction drives the whole plan. Recall is already strong — thirty-odd modules, three vendors ingesting, encrypted at rest, graph-linked. What is thin is the loop that converts *outcomes* into *calibration*: the system reports low confidence off single data points because task results rarely make it back into the store. Every session that ends without recording what worked is a session the brain did not learn from — and that loss is permanent and silent. Long-term learning is therefore not a nice-to-have alongside the headless work; it is the thing the headless work exists to feed at scale.

**The unifying insight for this week:** the headless gap and the moat are *the same lever*. A headless runner that carries the shared memory and the perimeter is what makes the moat reachable from CI. A headless runner *without* them is just a worse harness — precisely the thing not to build. So Workstream A is scoped as "headless **with the moat attached**," never as a bare runner.

There is a second-order reason this matters more than it looks. Headless runs are the only agent traffic that is **structured, repeatable, and outcome-labelled by construction** — a CI run knows whether it passed. Interactive sessions are where learning evidence is hardest to collect (was the user satisfied? did the change stick?); a headless run answers that for free in its exit code. Wiring memory into Workstream A is therefore not just distribution — it is the highest-quality training signal the brain will ever get, and the fastest route out of the one-data-point competence problem.

---

## Where things actually stand (verified against the repo, 2026-08-11)

| Area | Reality today |
|---|---|
| Cross-vendor memory | Strong. ~30 modules under `src/main/` (`memoryHost`, `memoryGraph`, `memoryAudit`, `memoryCrypto`, `memoryEconomy`, `contextPrimer`, `mnemeWeave`, …). Three transcript watchers wired: `src/main/transcriptWatchers/{claudeCodeWatcher,codexWatcher,geminiWatcher}.ts` on a shared `baseWatcher.ts`. |
| **Long-term learning** | **The weak half of the moat, and the one this plan promotes to a first-class workstream.** `mnemeWeave.ts`'s analogy miner was cross-repo-only at cosine 0.82; it now mines intra-repo with a configurable `WEAVE_COSINE_FLOOR` — but *whether it now produces edges has not been confirmed*, and a graph with no edges makes `memory_related` / `memory_graph` decorative. The competence signal is sparse enough to be misleading: it reported "low competence in termpolis (1/1 succeeded)" — a warning derived from a single outcome. Recall is strong; the loop from outcome back to calibration is what is missing. |
| Perimeter | Broad. `aiSecurity.ts`, `egressGuard.ts`, `egressAudit.ts`, `egressAttribute.ts`, `sensitiveFileWatcher.ts`, `codeWatch.ts`, `secureFile.ts`, `secureKeyStore.ts`, `crashWatch.ts`. On by default since v1.25. |
| Headroom | Mature. `src/main/headroom/` (`router`, `compressors`, `compactText`, `compactWeb`, `compressToolResult`, `diffEncode`, `ccrStore`, `outputSteering`, `injectedInstruction`, `persist`, `config`) plus `src/main/headroomProxy/`. |
| Headless / async | **This is the gap.** `src/mcp-adapter/termpolis-cli.cjs` is 170 lines and exposes 10 commands (`health`, `tools`, `list`, `create`, `run`, `read`, `write`, `close`, `files`, `git`). Every one is an HTTP call to `127.0.0.1:9315`. It is a **remote control for a running GUI**, not a headless runner. Nothing works without the Electron app already up, and it exposes **no memory access and no agent launch at all**. |

The last row is the whole competitive gap, stated precisely. Competitors ship `droid exec`, `opencode serve`, and cloud/CI execution; Termpolis ships a puppet string for a desktop window.

---

## Workstream A — Headless execution, with the moat attached

**Deliverable:** `termpolis run "<prompt>" --agent claude --cwd <path>` executes an agent non-interactively with no GUI, and on that run: primes from shared memory, enforces the perimeter, routes through Headroom, and writes results back to shared memory.

**Why first:** it is the dominant verified gap *and* it is the delivery vehicle for A, B, and C at once. It also converts the moat from "nice in the GUI" to "required in CI," which is where it defends itself.

**The blocking decision — resolve before writing code.** Today all memory, perimeter, and Headroom logic lives in the Electron main process. Headless needs it without a window. Two options:

- **A1 — Hidden-window process.** Launch Electron with no visible `BrowserWindow`, drive it over the existing MCP HTTP surface, exit when done. *Fast (days), zero refactor, reuses every subsystem as-is. Costs an Electron boot (~1-2s) and an Electron dependency in CI — awkward on a headless Linux runner without xvfb.*
- **A2 — Extract a Node core.** Pull memory + perimeter + Headroom into a plain-Node entry point that both Electron and the CLI import. *Correct long-term, CI-friendly, no display server. Costs a real refactor — the module boundary is the entire design, and it is more than a week.*

**Recommendation: ship A1 this week to prove the surface and get a usable `termpolis run`; write the A2 boundary spec while A1 is in users' hands.** A1 is not throwaway — the command contract and the memory/perimeter wiring it defines are exactly what A2 later re-hosts.

**Increment 1 (must ship):** `termpolis run` with `--agent`, `--cwd`, `--prompt`, exit code reflecting agent success, stdout carrying the agent's final output.
**Increment 2:** the run auto-primes from shared memory and writes its outcome back — so a CI run *teaches* the brain.
**Increment 3:** perimeter enforced on the headless path — secret scan on the outbound prompt, egress guard active, audit entry written. Prompt containing a secret must fail closed.

**Acceptance:** a GitHub Action on this repo runs `termpolis run` against a trivial task and passes. That is the proof the surface is real.

**Explicitly out of scope:** any scheduling, queueing, or hosted control plane. One command, one run, exits.

---

## Workstream B — Cross-agent long-term memory and learning

**Promoted to a first-class workstream, co-equal with A.** This is the half of the moat that competitors cannot reach *and* the half that is currently underbuilt. Treat B1 as the highest-value single change in this document: everything else in the brain is well-built machinery waiting on a signal that never arrives.

**B1 — Close the outcome loop.** *(The core fix. Do this even if nothing else ships.)*
The learning layer reports confidence off single data points because task outcomes rarely reach the store. Trace where a completed task's result is (or is not) written back, then close it. Ask specifically: when a session ends, what records that the work succeeded? When a test run goes green after an agent edit, does anything learn from it? Today the answer appears to be "almost nothing," which is why a whole repo's competence rests on one sample.
*Acceptance:* after one normal working day, competence for this repo is derived from double-digit outcomes rather than a handful — and the primer stops emitting a low-competence warning off a single success.

**B2 — Prove the Weave actually mines edges.** The analogy miner was relaxed (intra-repo, configurable `WEAVE_COSINE_FLOOR`) but nobody has confirmed edges now appear. `memory_related`, `memory_graph`, and graph-fused search are all worthless on an empty edge set, and they fail *silently* — returning nothing looks identical to "nothing relevant."
*Acceptance:* a query on this repo returns a non-zero edge count, with a test that fails if the graph goes empty again.

**B3 — Fourth transcript watcher.** `src/main/transcriptWatchers/baseWatcher.ts` already generalizes across three vendors, so a fourth is bounded and well-understood. Moat value scales directly with vendor count — breadth *is* the defense. Pick by whose transcript is genuinely parseable on disk; Qwen is not a candidate (removed, US-providers-only, and it never wrote an on-disk transcript).
*Acceptance:* a session in the new agent produces memories recallable from a different agent.

**B4 — CI-gate the cross-agent handoff claim.** "A fact one agent learns is instantly available to the others" is the headline promise of the product and it is currently *assumed*, not tested. It should be a gate: write as one vendor, recall as another, fail the build if the bridge breaks. A silent regression here would hollow out the moat without any visible symptom.
*Acceptance:* an e2e spec that writes via one agent's path and reads it back via another's.

**B5 — Long-term hygiene: supersession and decay.** "Long-term" means memories must not only survive but *age correctly*. What happens to a memory that becomes false? `memoryAudit.ts`, `memoryEconomy.ts`, and the `memory_conflicts` tool suggest the machinery exists — confirm it is actually reached, and that a superseded fact loses to its replacement at recall time. An unbounded, never-pruned store degrades toward noise, which is the same failure mode the `MEMORY.md` index has at a smaller scale.
*Acceptance:* a stale or contradicted memory demonstrably ranks below its correction, or is retired.

**If the week compresses, B1 and B2 are the two that must survive.** B1 is the missing signal; B2 confirms the machinery consuming it is not idling on an empty graph.

---

## Workstream C — Perimeter defense

One bounded item, hours not days. The perimeter is already broad and on-by-default since v1.25; the risk is not absence but **regression under the new headless path**. Its real work this week is Increment 3 of Workstream A — the guarantee that a run without a GUI is not a run without a guard.

**C1 — Prove the perimeter holds headless.** A prompt containing a secret, submitted through `termpolis run`, must fail closed exactly as it does in the GUI. An egress attempt from a headless run must land in the audit log with correct attribution.
*Acceptance:* a test that submits a synthetic secret headlessly and asserts the run is blocked and audited. Use `'a'.repeat(N)`-style samples so GitHub push protection does not reject the test fixture.

---

## Workstream D — Headroom

**Do not start new Headroom architecture this week.** It is the most mature of the four workstreams and the least at risk — and deliberately the lowest priority here, because effort spent on it is effort not spent on the learning loop, which is where the compounding actually is. Its role this week is to *ride along* with Workstream A: the headless path must route through the existing proxy so a CI run gets the same token economics as a GUI run. If A ships and headless traffic is compressed and measured, Workstream D is done for the week.

**One measurement worth taking:** current compression ratio on the headless path vs. the GUI path. If they differ, that difference is a bug in A's wiring, not a Headroom problem.

---

## Suggested sequence

| Day | Work |
|---|---|
| Mon | Resolve the A1/A2 decision. Write the Workstream A TDD plan. Ship **B3** (fourth transcript watcher) as a warm-up — self-contained, and it confirms the watcher pattern still holds before anything depends on it. |
| Tue | **B1 (close the outcome loop)** and **B2 (prove the Weave mines edges)** — the learning day. |
| Wed–Thu | Workstream A, Increments 1 and 2. |
| Fri am | Workstream A Increment 3 plus **C1** — perimeter holds headless. Confirm Headroom rides the headless path (D). |
| Fri pm | CI acceptance action. **B4** if time remains. Cut a release. |

**Why the learning day comes before the headless code, not after.** Workstream A's Increment 2 writes run outcomes into the memory loop. If that loop still drops outcomes on the floor, A gets wired into a dead end and the gap is baked into the new surface rather than fixed by it. B1 first means every headless run built afterwards teaches the brain from day one. Doing A first and B1 later means retrofitting the most valuable signal you have.

If the week runs short, **cut B4, B5, and the release — never Increment 3 or B1.** Dropping Increment 3 ships a headless runner that bypasses the perimeter, the exact anti-feature this plan exists to prevent. Dropping B1 ships more agent traffic that the brain still cannot learn from, which quietly makes the underbuilt half of the moat worse at larger volume.

**Backlog if not reached:** B5 (supersession and decay). It is real long-term-learning work, but it degrades slowly and can wait a cycle.

---

## What still needs a plan

**Workstream A must not be coded from this document.** Resolve A1 vs. A2 first — the module boundary that decision creates *is* the design — then write a task-by-task plan with real signatures. C and D are small enough to work directly from the increments above.

**Workstream B needs one investigation before B1 can be planned, and it should be Monday's first task:** trace the actual path a task outcome takes today, from "agent finished" to "competence score." B1 is a one-line fix if the write exists but is never called, and a design problem if nothing ever produces the outcome record in the first place. Those are very different weeks of work, and the current evidence — a confidence warning derived from a single sample — does not distinguish between them. Find out before committing Tuesday to it.
