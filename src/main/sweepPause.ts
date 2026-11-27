// sweepPause.ts
//
// What a code-graph sweep (codeGraph.ts buildCodeGraph, and the watcher's reindexPaths) waits on at each of its yield
// boundaries: before its 16th file and every 16 files after, so the first 15 go ahead unasked. The conversation ingest
// (ingestRuntime.ts) waits on it too, before each file and slice.
//
// 1. The loop governor (HP-3): while the main thread is starved, the sweep holds (whenNotShed, capped).
// 2. The typing gate (typingQuiet.ts): within 500 ms of a keystroke the sweep stands aside (capped at 2 s, then one
//    slice of 16 files goes ahead), the rule the conversation ingest and the indexer's passes already keep.
//
// Why the second. A world's first compile starts main's own index of the project in the background (index.ts
// indexInBackground), and a terminal opened in a repository starts one too. The sweep parses every file with
// tree-sitter on the main thread. It yields between files, so main itself still answers a key within a few ms, and the
// governor never sees a starved loop; but it is CPU taken from the rest of the app while someone types. Holding it
// while keys arrive cut main's CPU during the e2e typing-during-a-compile check (e2e/world-view.spec.ts test 5) on the
// 3-core macOS runner from about 17-27% to 6-13% of the machine. It did not, on its own, make that check's p95 steady.
//
// Why in this order. The work starts the moment the LAST wait ends, so the last one is the condition most likely
// still to hold when it starts. The governor's wait can run for seconds (its cap), and someone may start typing
// meanwhile; the typing gate is a look at the time of the last key. Asked last, it lets the work start inside a quiet
// period it has just seen, unless its own cap ran out first. Neither is asked twice: a SHED that begins during the
// typing wait is not waited for here, only at the next boundary. (The ingest asked them the other way round until
// 2.0, so a key typed during its SHED wait was not waited for.)
//
// It only ever delays, and fails open: whenNotShed never rejects, whenTypingQuiet waits at most its cap, and a throw
// from either is ignored by the sweep (buildCodeGraph), which goes on.
import { whenNotShed } from './loopGovernor'
import { whenTypingQuiet } from './typingQuiet'

export interface SweepPauseDeps {
  notShed?: () => Promise<unknown>
  typingQuiet?: () => Promise<unknown>
}

/** Resolves once the main thread is not shedding and nobody has typed for the quiet period (each wait capped). */
export async function sweepPause(deps: SweepPauseDeps = {}): Promise<void> {
  await (deps.notShed ?? whenNotShed)()
  await (deps.typingQuiet ?? whenTypingQuiet)()
}
