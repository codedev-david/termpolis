// MEM-F1 (1.54.5): an agent's transcript that is bigger than the 8 MiB pass budget and still growing.
// Before: each drain pass (every 3 s) re-read the whole file because it changed, spent the budget on it, marked it
// (which counted as progress), asked for one more pass, and never reached the files behind it. Now a drain pass does
// not re-read a file the same drain episode already read, so the files behind it are reached and the drain ends.
// Synthetic data only. Counters, not wall clock.
import { describe, it, expect } from 'vitest'
import { ingestConversations } from '../../src/main/conversationIngest'
import { openWatermark } from '../../src/main/ingestWatermark'
import { passResult } from '../../src/main/ingestRuntime'
import { corpus, memoryIO, MIB, sessionText } from './_ingestCorpus'
import { assistantLine, lines, userLine } from './_transcriptFixture'

async function scenario(withEpisode: boolean) {
  const c = corpus()
  let content = sessionText('a', 2, 300)
  const active = c.add('/proj/a-active.jsonl', content, 9 * MIB)
  for (let i = 0; i < 20; i++) c.add(`/proj/old/s${String(i).padStart(3, '0')}.jsonl`, sessionText(`old${i}`, 1, 100))
  const wm = await openWatermark(memoryIO(), 'probe')
  await ingestConversations(c.deps({ watermark: wm })) // warm: everything marked once
  const grow = (n: number): void => {
    content += lines(userLine(`next ask ${n}: please continue the refactor`, { sessionId: 'sess-a', cwd: '/r' }), assistantLine(`done step ${n} of the refactor`))
    c.add(active, content, 9 * MIB + content.length)
  }
  grow(-1)
  const behind = c.add('/proj/z-second-session.jsonl', sessionText('b', 2, 300))
  const episode = new Set<string>()
  const log: Array<{ reads: string[]; more: boolean; skipped: number }> = []
  // The pass that starts the episode (a full or fast pass), then the drain passes it asks for.
  for (let pass = 0; pass < 8; pass++) {
    c.clearCounters()
    const s = await ingestConversations(c.deps({
      watermark: wm, maxBytes: 8 * MIB, maxChunks: 250,
      ...(pass > 0 && { drainPass: pass }),
      ...(withEpisode && { episode }),
    }))
    const r = passResult(s)
    log.push({ reads: [...c.reads], more: r.more, skipped: s.episodeSkipped ?? 0 })
    grow(pass) // the agent keeps working between two drain ticks
    if (!r.more) break
  }
  return { log, active, behind }
}

describe('a drain episode over a growing transcript above the pass budget', () => {
  it('reads the growing file once per episode, reaches the file behind it, and ends', async () => {
    const { log, active, behind } = await scenario(true)
    const activeReads = log.reduce((n, p) => n + p.reads.filter((f) => f === active).length, 0)
    expect(activeReads).toBe(1) // the pass that started the episode; no drain pass re-reads it
    expect(log.some((p) => p.reads.includes(behind))).toBe(true)
    expect(log[log.length - 1].more).toBe(false) // the drain ends
    expect(log.length).toBeLessThanOrEqual(3)
    expect(log.slice(1).every((p) => p.skipped <= 1)).toBe(true)
    expect(log[1].skipped).toBe(1) // counted: the growing file was held for the next episode
  })

  it('control: without an episode (the kill switch), every pass re-reads it and the file behind is starved', async () => {
    const { log, active, behind } = await scenario(false)
    expect(log).toHaveLength(8)
    expect(log.every((p) => p.reads.includes(active) && p.more)).toBe(true)
    expect(log.some((p) => p.reads.includes(behind))).toBe(false)
  })

  it('a pass that is not a drain pass reads the file even when the episode holds it (a new episode starts there)', async () => {
    const c = corpus()
    const f = c.add('/proj/a.jsonl', sessionText('a', 2, 300))
    const wm = await openWatermark(memoryIO(), 'probe')
    const episode = new Set<string>([f])
    await ingestConversations(c.deps({ watermark: wm, episode }))
    expect(c.reads).toEqual([f])
  })

  it('a file cut by the chunk cap stays out of the episode, so the next drain pass continues it', async () => {
    const c = corpus()
    const big = c.add('/proj/a.jsonl', sessionText('a', 40, 400))
    const wm = await openWatermark(memoryIO(), 'probe')
    const episode = new Set<string>()
    const first = await ingestConversations(c.deps({ watermark: wm, maxChunks: 3, episode }))
    expect(first.stop).toBe('chunks')
    expect(episode.has(big)).toBe(false)
    c.clearCounters()
    const next = await ingestConversations(c.deps({ watermark: wm, maxChunks: 3, episode, drainPass: 1 }))
    expect(c.reads).toEqual([big])
    expect(next.chunksWritten).toBeGreaterThan(0)
  })
})
