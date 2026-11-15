# Memory A/B benchmark

Does Termpolis shared memory help a coding agent finish real tasks better? This benchmark gives the same
model the same tasks in the same fresh repo, twice. The only difference is memory. It then measures
success, tokens, cost, turns and wall time.

- Test: `tests/electron/memoryAbBenchmark.test.ts`
- Fixture, tasks, seeded memory, checks: `tests/fixtures/memory-ab/`
- Run: `TERMPOLIS_AB=1 npm run bench:ab`. Without `TERMPOLIS_AB=1`, or without `claude` on PATH, it
  skips, so CI never runs it and it never spends quota there.

## Result (2026-11-14, Sonnet, 2 reps, claude 2.1.325)

**Memory helped on cost-to-finish, with no change in success.** Both arms solved all 12 runs.
With memory, the average run used 21% fewer tokens, 19% fewer output tokens, 16% fewer turns and
20% less time. It cost 6% less. Four of six tasks improved clearly (t1, t3, t4, t6), t5 was mixed, and
t2 got worse.

| task | arm | success | tokens | output | cost $ | turns | time s |
|---|---|---|---:|---:|---:|---:|---:|
| t1-clock | on | 2/2 | 90,225 | 763 | 0.0493 | 5.0 | 31.4 |
| | off | 2/2 | 140,860 | 788 | 0.0479 | 5.0 | 41.8 |
| | **Δ** | +0 | **-35.9%** | -3.2% | +3.0% | +0.0% | -24.9% |
| t2-balance | on | 2/2 | 160,202 | 2,079 | 0.0815 | 9.5 | 43.4 |
| | off | 2/2 | 155,662 | 1,684 | 0.0760 | 5.5 | 41.7 |
| | **Δ** | +0 | **+2.9%** | +23.5% | +7.4% | +72.7% | +3.9% |
| t3-numbering | on | 2/2 | 155,148 | 1,878 | 0.0728 | 9.0 | 36.9 |
| | off | 2/2 | 182,678 | 2,696 | 0.0859 | 11.0 | 50.0 |
| | **Δ** | +0 | **-15.1%** | -30.3% | -15.3% | -18.2% | -26.2% |
| t4-po-number | on | 2/2 | 91,013 | 850 | 0.0513 | 3.0 | 37.8 |
| | off | 2/2 | 146,554 | 1,459 | 0.0612 | 5.0 | 50.7 |
| | **Δ** | +0 | **-37.9%** | -41.8% | -16.2% | -40.0% | -25.5% |
| t5-overpayment | on | 2/2 | 158,074 | 2,075 | 0.0785 | 11.0 | 41.3 |
| | off | 2/2 | 160,670 | 2,580 | 0.0754 | 14.0 | 52.9 |
| | **Δ** | +0 | **-1.6%** | -19.6% | +4.1% | -21.4% | -22.0% |
| t6-discount | on | 2/2 | 111,558 | 1,858 | 0.0720 | 7.5 | 34.0 |
| | off | 2/2 | 184,511 | 2,564 | 0.0843 | 13.0 | 43.7 |
| | **Δ** | +0 | **-39.5%** | -27.5% | -14.6% | -42.3% | -22.2% |
| **TOTAL** | on | **12/12** | 127,703 | 1,584 | 0.0676 | 7.5 | 37.5 |
| | off | **12/12** | 161,822 | 1,962 | 0.0718 | 8.9 | 46.8 |
| | **Δ** | **+0** | **-21.1%** | **-19.3%** | **-5.9%** | **-15.9%** | **-20.0%** |

Per-run means. Tokens = input + output + cache read + cache creation. Cost is Claude Code's
`total_cost_usd`. Time is its `duration_ms`.

How to read it:

- **Tokens fell much more than cost.** Most tokens are cache reads, which are cheap. The ON arm writes
  more to the cache (a mean of 10,031 cache-creation tokens against 9,274), because the primer and the
  instruction make the prompt prefix bigger, and cache writes are the expensive part. So a 21% cut in
  tokens became a 6% cut in dollars. On t1 and t5 the ON arm cost slightly more despite fewer tokens.
- **All of the gain came from the injected context, not from tool use.** Across the 12 ON runs, the
  agent never called a memory tool itself: no `memory_search`, `memory_list` or `memory_write`. Every
  ON run got exactly the two hook primers (session start, 3,863 chars, and first prompt, 2,572 to
  2,692 chars), and that was all. The 8 exposed tools cost schema tokens and returned nothing.
- **The superseded decision did its job, but the control solved t3 too.** The ON primer carried only
  the new `TENANT_CODE-NNNNNN` decision, and both ON runs used it. The OFF runs found the conflict
  themselves: their summaries report that `docs/ARCHITECTURE.md` and `src/legacy` disagree with
  ADR-0007, and that ADR-0007 wins. That took them 2 more turns and 30% more output. Neither arm fell
  for the stale doc.
- **t2 got worse with memory.** One ON run took 14 turns (against 5 in the other), which pulled the
  mean up. With 2 reps that is one noisy run, not evidence that memory hurts. But it is not a win.
- **t1 had the same turns and output in both arms.** Both arms reached the `useFrozenClock` fix,
  which the repo's other test files also show. The ON runs saved their tokens on cache reads (81k
  against 133k to 134k), which suggests the OFF runs read more files into context before fixing it.

The PROOF line the benchmark printed:

```
PROOF|{"bench":"memory-ab","model":"sonnet","reps":2,"tasks":["t1-clock","t2-balance","t3-numbering","t4-po-number","t5-overpayment","t6-discount"],"on":{"n":12,"success":12,"tokens":127702.91666666667,"input":8.166666666666666,"output":1583.5833333333333,"cacheRead":116080.58333333333,"cacheCreation":10030.583333333334,"cost":0.06758255833333333,"turns":7.5,"ms":37461.916666666664},"off":{"n":12,"success":12,"tokens":161822.41666666666,"input":10.833333333333334,"output":1961.5833333333333,"cacheRead":150576.41666666666,"cacheCreation":9273.583333333334,"cost":0.071789475,"turns":8.916666666666666,"ms":46826.25},"deltaPct":{"tokens":-21.1,"output":-19.3,"cost":-5.9,"turns":-15.9,"ms":-20},"successDelta":0}
```

### Raw per-run numbers

| task | arm | rep | ok | input | output | cache read | cache creation | tokens | cost $ | turns | duration s | files changed |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| t1-clock | on | 1 | pass | 6 | 743 | 81,053 | 8,451 | 90,253 | 0.0494 | 5 | 34.5 | `test/reminders.unit.js` |
| t1-clock | on | 2 | pass | 6 | 783 | 81,065 | 8,342 | 90,196 | 0.0493 | 5 | 28.4 | `test/reminders.unit.js` |
| t1-clock | off | 1 | pass | 10 | 760 | 132,668 | 7,278 | 140,716 | 0.0500 | 5 | 48.9 | `test/reminders.unit.js` |
| t1-clock | off | 2 | pass | 10 | 816 | 134,122 | 6,056 | 141,004 | 0.0458 | 5 | 34.8 | `test/reminders.unit.js` |
| t2-balance | on | 1 | pass | 8 | 1,633 | 113,192 | 10,425 | 125,258 | 0.0694 | 5 | 46.5 | `src/routes/handlers/customers.js`, `src/routes/index.js`, `test/routes.unit.js` |
| t2-balance | on | 2 | pass | 12 | 2,525 | 179,999 | 12,609 | 195,145 | 0.0937 | 14 | 40.3 | `src/routes/handlers/customers.js`, `src/routes/index.js`, `test/routes.unit.js` |
| t2-balance | off | 1 | pass | 10 | 1,517 | 139,151 | 9,751 | 150,429 | 0.0681 | 5 | 49.0 | `src/routes/handlers/customers.js`, `src/routes/index.js`, `test/routes.unit.js` |
| t2-balance | off | 2 | pass | 10 | 1,851 | 146,377 | 12,657 | 160,895 | 0.0838 | 6 | 34.5 | `src/routes/handlers/customers.js`, `src/routes/index.js`, `test/routes.unit.js` |
| t3-numbering | on | 1 | pass | 10 | 1,905 | 143,170 | 9,870 | 154,955 | 0.0729 | 9 | 41.2 | `src/services/numbering.js`, `test/numbering.unit.js` |
| t3-numbering | on | 2 | pass | 10 | 1,850 | 143,496 | 9,984 | 155,340 | 0.0728 | 9 | 32.6 | `src/services/numbering.js`, `test/numbering.unit.js` |
| t3-numbering | off | 1 | pass | 12 | 2,659 | 169,148 | 10,377 | 182,196 | 0.0850 | 10 | 58.0 | `src/services/numbering.js`, `test/numbering.unit.js` |
| t3-numbering | off | 2 | pass | 12 | 2,732 | 169,783 | 10,633 | 183,160 | 0.0869 | 12 | 42.1 | `src/services/numbering.js`, `test/numbering.unit.js` |
| t4-po-number | on | 1 | pass | 6 | 891 | 81,362 | 8,481 | 90,740 | 0.0510 | 3 | 39.6 | `src/db/migrations/index.js`, `src/db/schema.js`, `src/services/invoices.js`, `src/db/migrations/004_invoice_po_number.js` |
| t4-po-number | on | 2 | pass | 6 | 808 | 81,633 | 8,839 | 91,286 | 0.0516 | 3 | 36.0 | `src/db/migrations/index.js`, `src/db/schema.js`, `src/services/invoices.js`, `src/db/migrations/004_invoice_po_number.js` |
| t4-po-number | off | 1 | pass | 10 | 1,719 | 137,697 | 9,173 | 148,599 | 0.0677 | 5 | 54.1 | `CHANGELOG.md`, `src/db/migrations/index.js`, `src/db/schema.js`, `src/services/invoices.js`, `test/invoices.unit.js`, `test/store.unit.js`, `src/db/migrations/004_invoice_po_number.js` |
| t4-po-number | off | 2 | pass | 10 | 1,199 | 135,999 | 7,301 | 144,509 | 0.0548 | 5 | 47.4 | `CHANGELOG.md`, `src/db/migrations/index.js`, `src/db/schema.js`, `src/services/invoices.js`, `src/db/migrations/004_invoice_po_number.js` |
| t5-overpayment | on | 1 | pass | 10 | 2,094 | 145,464 | 10,787 | 158,355 | 0.0787 | 11 | 40.8 | `src/lib/errorCodes.js`, `src/services/payments.js`, `test/payments.unit.js` |
| t5-overpayment | on | 2 | pass | 10 | 2,055 | 144,910 | 10,817 | 157,792 | 0.0783 | 11 | 41.8 | `src/lib/errorCodes.js`, `src/services/payments.js`, `test/payments.unit.js` |
| t5-overpayment | off | 1 | pass | 12 | 2,592 | 163,375 | 8,597 | 174,576 | 0.0767 | 14 | 54.9 | `src/lib/errorCodes.js`, `src/services/payments.js`, `test/payments.unit.js` |
| t5-overpayment | off | 2 | pass | 10 | 2,567 | 135,477 | 8,710 | 146,764 | 0.0741 | 14 | 51.0 | `src/lib/errorCodes.js`, `src/services/payments.js`, `test/payments.unit.js` |
| t6-discount | on | 1 | pass | 6 | 1,626 | 82,280 | 10,259 | 94,171 | 0.0655 | 7 | 34.4 | `src/services/invoices.js` |
| t6-discount | on | 2 | pass | 8 | 2,090 | 115,343 | 11,503 | 128,944 | 0.0785 | 8 | 33.6 | `src/services/invoices.js`, `test/invoices.unit.js` |
| t6-discount | off | 1 | pass | 10 | 2,630 | 139,325 | 10,357 | 152,322 | 0.0817 | 13 | 37.6 | `src/services/invoices.js`, `test/invoices.unit.js` |
| t6-discount | off | 2 | pass | 14 | 2,497 | 203,795 | 10,393 | 216,699 | 0.0869 | 13 | 49.8 | `src/services/invoices.js`, `test/invoices.unit.js` |

Raw JSON (with each run's result text and check reasons) is written to `TERMPOLIS_AB_OUT`, or
`memory-ab-<stamp>.json` in the temp folder.

## Method

### The fixture: `ledgerly`

`tests/fixtures/memory-ab/repo` is a small Node billing service (50 files, no dependencies). It has:

- services, route handlers and a `ROUTES` table
- an in-memory store with hand-registered migrations and a `SCHEMA_VERSION` drift check
- a money library with banker's rounding
- an `AppError` registry that maps codes to HTTP statuses
- a frozen-clock test helper
- a custom lint script (`npm run lint`) and a plain node test harness (`npm test`)

Like a real repo, it has traps. `src/legacy/` is dead code that still shows the old ways. `docs/ARCHITECTURE.md`
and `src/legacy/billing.js` still describe the invoice-number format that ADR-0007 replaced (ADR-0004).
`test/reminders.unit.js` fails with `ERR_LEDGER_CLOCK` because it never freezes the clock.

### Tasks

Each prompt is self-contained. Everything a task needs is in the repo (README, `docs/CONVENTIONS.md`, the
ADRs, the code). Memory can only shorten the search, so none of these is a trick task. Each one ends with
"Keep `npm test` and `npm run lint` passing."

| id | task | knowledge that helps | the check (`checks/*.cjs`) requires |
|---|---|---|---|
| t1-clock | `npm test` fails in `test/reminders.unit.js` with `ERR_LEDGER_CLOCK`; fix it the way the project intends | past fix: call `useFrozenClock()`, don't loosen `clock.js` | suite (at least 20 tests) and lint pass; `clock.js`, `test/run.js`, the harness and the clock helper byte-identical; the reminders tests and their date assertions still there |
| t2-balance | add `GET /customers/:id/balance` returning `{ customerId, balanceCents, formatted }` in the customer's currency, with the standard 404 | `ledger.outstandingFor`, `formatCents(cents, currency)`, `ERR_NOT_FOUND` → 404, route table | through the real router: 200 with `balanceCents` 201234 and `CA$2,012.34` for a CAD customer, `$9.99` for a USD one, 404 with `error: 'ERR_NOT_FOUND'` for an unknown id; suite and lint pass |
| t3-numbering | implement the `nextInvoiceNumber(store, tenant)` stub in the current format, with a unit test | the superseded decision: `TENANT_CODE-NNNNNN` per tenant in `store.tables.sequences`, not `INV-YYYY-NNNN` | `ACME-000001`, `ACME-000002`, `GLOBEX-000001`, `ACME-000003`; the sequence lives in `store.tables.sequences` (a fresh store starts again at `000001`); suite and lint pass |
| t4-po-number | add an optional `poNumber` to invoices: migrated rows get `null`, `createInvoice` accepts it | the migration procedure: new file, add it to `MIGRATIONS` by hand, bump `SCHEMA_VERSION` | a `004_*.js` migration, `MIGRATIONS` has 4 entries, `SCHEMA_VERSION` 4, an old store migrates with `poNumber: null`, `createInvoice` stores `PO-77` or defaults to `null`; suite and lint pass |
| t5-overpayment | reject a payment larger than what is owed, recording nothing; exact payment still works | `invoiceOutstanding`, register a new 422 code, `withTransaction` | an overpayment throws with status 422 (service and `POST /payments`), nothing is recorded and the balance is unchanged; paying exactly the rest succeeds; suite and lint pass |
| t6-discount | add `applyDiscount(invoice, percent)` that returns a new invoice with a negative `discount` line | `percentOf` (banker's rounding), no `toFixed`, invoices are values | exact banker's-rounded amounts on four cases including ties (1015 @ 10% → -102, 1025 @ 10% → -102), a new object, input not mutated, exactly one `discount` line appended; suite and lint pass |

t2 to t6 start from a green suite: the run directory gets the t1 fix before the agent starts. Each check
was verified to FAIL on the untouched fixture and PASS on a reference solution (12 of 12 combinations).

### Seeded memory (ON arm)

`tests/fixtures/memory-ab/memories.json` holds 30 entries. A fresh `swarmMemory` store receives them through
the real bge embedder, with backdated timestamps:

- **Conventions:** money (integer cents, `percentOf`, no `toFixed`), errors (the `AppError` registry and
  status mapping), no `console` in `src/`, UTC dates and `clock.js`, `*.unit.js` tests.
- **Where things live:** the layout, the fact that `src/legacy` is dead, the route-handler contract,
  `ledger.js` for balances, `store.tables.sequences`.
- **A past fix for a recurring error:** `ERR_LEDGER_CLOCK` means "call `useFrozenClock()`".
- **A reversed decision:** the March decision says `INV-YYYY-NNNN`, global, resets yearly. The
  September decision says "no longer ... now use `TENANT_CODE-NNNNNN`" and is newer. Termpolis's own
  supersession pass (`memorySupersedePass`, reason `explicit`, cosine 0.89) retires the old one. The
  benchmark asserts this: `minted=1`, and the old decision no longer comes back from search or the primer.
- **Gotchas:** schema drift if `SCHEMA_VERSION` and the migration count disagree; payments run in a transaction.
- **Ordinary session notes,** plus 10 noise entries from three unrelated projects.

The two decisions are worded without digits on purpose. Termpolis refuses to let one memory supersede
another when the numbers in them differ. The first wording had a cosine of 0.84, under the 0.85 bar for
`explicit`, so it was reworded once to 0.89 until the real pass minted the supersession. No link was added
by hand.

### The two arms

Every run uses `claude -p --output-format json --model <model> --dangerously-skip-permissions`, with the
prompt on stdin, in a fresh temp copy of the fixture (`git init` and one commit, so the agent sees a
normal repo).

**ON:**

- The real `src/main/mcpServer.ts` runs in-process on a free port. Its handlers call the seeded store
  and mirror what `src/main/index.ts` wires (search, list, related, write, graph, link, feedback,
  primer via `buildContextPrimer` and `createPrimerRecent`).
- Claude Code gets it via `--mcp-config` (`type: http`, a bearer `Authorization` header) and
  `--strict-mcp-config`.
- The 8 memory tools are exposed. The other 32 Termpolis tools (terminals, swarm, code graph, gateway,
  linked machines) are blocked with `--disallowedTools`, so this measures memory alone.
- The launch instruction Termpolis appends to the system prompt (`buildInjectedInstruction`, steering
  off, hook installed) goes through `--append-system-prompt-file`.
- A `--settings` file wires `tests/fixtures/memory-ab/primer-hook.cjs` on SessionStart and
  UserPromptSubmit. That file mirrors `src/mcp-adapter/memory-primer-hook.cjs`: the session-start primer
  (limit 12) and the first-prompt primer (query = the first 400 characters of the prompt, limit 6).

**OFF:**

- `--strict-mcp-config` with no `--mcp-config`, so there are no MCP servers.
- No instruction, no hook. The `--settings` file holds only `autoMemoryEnabled: false`.

The two arms alternate order across tasks and reps, so neither always runs first (warmer prompt cache).

### Isolation from the user's own setup

Both arms get:

- Flags: `--setting-sources project` (no user or local settings, so none of the user's hooks, including
  the real memory-primer SessionStart hook), `--strict-mcp-config` (none of the user's MCP servers),
  `--disable-slash-commands` (no skills), `--no-session-persistence`.
- Environment:
  - `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (required: `--setting-sources project` alone still loaded the
    user's global `CLAUDE.md`), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_ORG_MEMORY=1`.
  - The parent session's variables are stripped: `CLAUDECODE`, `CLAUDE_CODE_*` session variables,
    `ANTHROPIC_BASE_URL` (which would route through the Termpolis headroom proxy), every `TERMPOLIS_*`,
    `NODE_OPTIONS`, and the vitest variables.
  - `CLAUDE_CONFIG_DIR` is kept, so the CLI uses whatever account the shell is signed in to. No
    credentials file is read or copied.

**Verified by a canary** (`TERMPOLIS_AB=1 TERMPOLIS_AB_PROBE=1`, one haiku stream-json run per arm,
claude 2.1.325). The canary asks the model, without tools, to report any user name, security vendor, desktop
app or memory digest in its context, plus the current invoice format. It also prints the init event:

| | OFF | ON |
|---|---|---|
| MCP servers | none | `termpolis` (connected) |
| tools | 26 built-ins | 26 built-ins + the 8 `mcp__termpolis__memory_*` tools |
| skills / slash commands | none / none | none / none |
| hooks that ran | none | SessionStart, UserPromptSubmit (benchmark hook only) |
| primer injected | none | 3,863 chars at session start + 2,572 at the first prompt |
| security vendor / user CLAUDE.md content | not seen | not seen |
| memory digest | null | "Relevant context from your memory — background only: This project (ledgerly) …" |
| invoice format | null | `TENANT_CODE-NNNNNN` (the superseding decision) |

Both arms still report the user's name. It comes from the git identity that Claude Code puts in its
own context. That is not memory and it is the same in both arms. Plugins listed in both arms are
Claude Code's built-in ones (`cc-plugin-*@builtin`); none of the user's plugins load.

## Caveats

Read the numbers with these in mind:

1. **Small N.** 6 tasks, 2 reps, one model (Sonnet). Agent runs vary a lot from run to run. A
   difference of a few percent on one task is noise. Only large, consistent differences mean much.
2. **One fixture, written for this.** The repo was designed so that the knowledge matters. Real repos
   have more and messier knowledge, and memory that is wrong or stale, which this does not test (apart
   from the one superseded decision).
3. **The memories restate the repo's docs.** Everything seeded is also in the README, CONVENTIONS, the
   ADRs or the code. This is deliberate (no trick tasks), but it means memory competes with reading a
   small, well-documented repo. On a large or badly documented repo, the gap should be bigger, but this
   benchmark does not show that.
4. **Not the exact production path:**
   - Claude Code reaches the server over http with a bearer header. The app normally goes through the
     stdio adapter (`src/mcp-adapter`) to the same server.
   - The primer hook is a mirror. The real one is hardwired to the app's port and bearer file. The
     mirror leaves out the PreToolUse `code_outline` hint and the compaction paths.
   - The app holds back the first-prompt primer from 10% of sessions (a holdout for its own
     measurement). The mirror salts the session id so every ON run gets it.
   - Steering is off. The code-graph tools are hidden, so the instruction's `code_locate` sentence and
     the primer's "For questions about code STRUCTURE" line are removed. Otherwise the agent would be
     told about tools it cannot call.
   - The headroom compression proxy is off in both arms (`ANTHROPIC_BASE_URL` is stripped). These are
     plain Anthropic API numbers. In the app, the proxy would cut both arms' tokens.
5. **Prompt caching crosses runs.** Runs in a row share cached system-prompt prefixes, so cache-read
   counts depend partly on order. Alternating the arm order spreads this out, but does not remove it.
   `total_cost_usd` is what Claude Code reports, under whatever plan the account uses.
6. **The checks are strict but narrow.** They test behaviour, plus the conventions the custom lint
   enforces (no `console` in `src/`, no `toFixed`, no `src/legacy` imports) and the migration
   bookkeeping. They do not check that the agent wrote the unit test some prompts ask for. A run can
   pass and still be stylistically worse, or fail on one detail a reviewer would accept.
7. **The ON arm never used its tools.** Everything measured comes from the two injected primers and
   the launch instruction. This run says nothing about whether agents benefit from searching memory
   themselves mid-task, which the app also offers.
8. **Isolation was checked once, by canary.** The probe confirms what the session is given (servers,
   tools, hooks, context). It does not prove that nothing else reached the model. The user's git name
   is visible to both arms.
