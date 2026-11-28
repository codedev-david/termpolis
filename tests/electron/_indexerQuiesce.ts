/** Brings the memory indexer to rest before a test measures what the main thread does, so no timed pass can land inside
 *  the window: the timers are stopped, a pass already under way is waited for, and the follow-up that pass may arm as it
 *  finishes (a drain, when it reports more to do: memoryIndexer's scheduledTick) is cancelled too. stopIndexer() keeps the
 *  configuration, so tick() still runs the app's own pass afterwards. */
export async function quiesceIndexer(
  indexer: { stopIndexer: () => void; isIndexing: () => boolean },
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<void> {
  indexer.stopIndexer()
  for (let i = 0; i < 2400 && indexer.isIndexing(); i++) await sleep(25)
  if (indexer.isIndexing()) throw new Error('the memory indexer was still running a pass after 60 s')
  // The pass that just ended may have armed its follow-up after the first stop. Its last step runs in the same turn as the
  // end of the pass, so once the indexer reads idle here it is armed already, and this clears it. That holds because the
  // app's drain waits 3 s (memoryIndexer's DEFAULT_DRAIN_DELAY_MS) before it runs, far longer than the 25 ms between looks:
  // a drain due within one look (an indexer started with a drain delay of a few ms) could run before this stop (Codex R2).
  indexer.stopIndexer()
}
