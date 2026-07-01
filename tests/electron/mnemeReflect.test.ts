import { describe, it, expect, vi } from 'vitest'
import {
  distillEpisode,
  extractEntities,
  splitSentences,
  buildDistillPrompt,
  type Episode,
} from '../../src/main/mnemeReflect'

function ep(partial: Partial<Episode> & { turns: Episode['turns'] }): Episode {
  return { id: 'ep-1', project: 'termpolis', source: 'claude', ...partial }
}

describe('mnemeReflect — deterministic distillation', () => {
  it('distills a procedural lesson from an error → fix episode', async () => {
    const lessons = await distillEpisode(
      ep({
        turns: [
          { role: 'user', text: 'the build throws Error: cannot find module `foo.ts`' },
          { role: 'assistant', text: 'I fixed it by adding the path alias in `tsconfig.json`. Now works.' },
        ],
        outcome: { kind: 'test', success: true },
      }),
    )
    const proc = lessons.find((l) => l.memoryType === 'procedural')
    expect(proc).toBeDefined()
    expect(proc!.kind).toBe('fact')
    expect(proc!.problem).toMatch(/cannot find module/i)
    expect(proc!.solution).toMatch(/tsconfig/i)
    expect(proc!.links).toEqual([{ relation: 'solves' }])
    expect(proc!.entities).toEqual(expect.arrayContaining(['foo.ts', 'tsconfig.json']))
    expect(proc!.importance).toBeGreaterThan(0.6)
  })

  it('distills a decision lesson', async () => {
    const lessons = await distillEpisode(
      ep({ turns: [{ role: 'assistant', text: 'We decided to use HNSW instead of brute force for the vector index.' }] }),
    )
    const dec = lessons.find((l) => l.kind === 'decision')
    expect(dec).toBeDefined()
    expect(dec!.memoryType).toBe('semantic')
    expect(dec!.content).toMatch(/HNSW/)
  })

  it('distills a gotcha / root-cause lesson as a semantic fact', async () => {
    const lessons = await distillEpisode(
      ep({ turns: [{ role: 'assistant', text: 'Gotcha: the root cause was the mic capturing background noise, not the model.' }] }),
    )
    const fact = lessons.find((l) => l.kind === 'fact' && l.memoryType === 'semantic')
    expect(fact).toBeDefined()
    expect(fact!.gotcha).toMatch(/background noise/i)
  })

  it('extracts entities: backtick spans, file paths, error codes', () => {
    const ents = extractEntities('saw `ENOENT` from `readFile` on src/main/index.ts')
    expect(ents).toEqual(expect.arrayContaining(['ENOENT', 'readFile', 'src/main/index.ts']))
    expect(ents.length).toBeLessThanOrEqual(12)
  })

  it('splits sentences and drops fragments', () => {
    expect(splitSentences('First sentence here. Second one!\nThird line')).toEqual([
      'First sentence here.',
      'Second one!',
      'Third line',
    ])
    expect(splitSentences('too\nshort')).toEqual([])
  })

  it('scores a grounded success higher than a failure', async () => {
    const turns = [
      { role: 'user' as const, text: 'Error: request failed with ETIMEDOUT' },
      { role: 'assistant' as const, text: 'Fixed by adding a retry in `client.ts`.' },
    ]
    const ok = await distillEpisode(ep({ turns, outcome: { kind: 'test', success: true } }))
    const bad = await distillEpisode(ep({ turns, outcome: { kind: 'test', success: false } }))
    expect(ok[0].importance).toBeGreaterThan(bad[0].importance)
  })

  it('uses outcome.detail as the problem when the error kind is set', async () => {
    const lessons = await distillEpisode(
      ep({
        turns: [{ role: 'assistant', text: 'Resolved it by rebuilding the native module.' }],
        outcome: { kind: 'error', success: false, detail: 'segfault loading addon.node' },
      }),
    )
    const proc = lessons.find((l) => l.memoryType === 'procedural')
    expect(proc).toBeDefined()
    expect(proc!.problem).toMatch(/segfault/i)
    expect(proc!.importance).toBeLessThan(0.6) // failed outcome → low importance
  })

  it('is deterministic', async () => {
    const episode = ep({
      turns: [
        { role: 'user', text: 'Error: cannot read property of undefined' },
        { role: 'assistant', text: 'The fix was a null guard in `store.ts`. We decided to always guard.' },
      ],
      outcome: { kind: 'commit', success: true },
    })
    expect(await distillEpisode(episode)).toEqual(await distillEpisode(episode))
  })

  it('dedupes identical lessons', async () => {
    const lessons = await distillEpisode(
      ep({ turns: [{ role: 'assistant', text: 'We decided to use Groq for voice. We decided to use Groq for voice.' }] }),
    )
    expect(lessons.filter((l) => l.kind === 'decision')).toHaveLength(1)
  })

  it('caps output at maxLessons', async () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: 'assistant' as const,
      text: `We decided to use option number ${i} for the widget subsystem.`,
    }))
    const lessons = await distillEpisode(ep({ turns }), { maxLessons: 3 })
    expect(lessons).toHaveLength(3)
  })

  it('returns nothing for an empty episode', async () => {
    expect(await distillEpisode(ep({ turns: [] }))).toEqual([])
    expect(await distillEpisode(ep({ turns: [{ role: 'assistant', text: '   ' }] }))).toEqual([])
  })

  it('truncates over-long lesson content', async () => {
    const long = 'We decided to ' + 'x'.repeat(800)
    const lessons = await distillEpisode(ep({ turns: [{ role: 'assistant', text: long }] }))
    const dec = lessons.find((l) => l.kind === 'decision')
    expect(dec).toBeDefined()
    expect(dec!.content.length).toBeLessThanOrEqual(600)
    expect(dec!.content.endsWith('…')).toBe(true)
  })

  it('uses an injected llm distiller and survives its failure', async () => {
    const llm = vi.fn().mockResolvedValue('When the ORT wasm 404s, copy the full ort-wasm-simd-threaded.* family.')
    const lessons = await distillEpisode(
      ep({ turns: [{ role: 'assistant', text: 'Fixed the voice 404 by copying wasm files.' }] }),
      { llm },
    )
    expect(llm).toHaveBeenCalledTimes(1)
    expect(llm.mock.calls[0][0]).toContain('copying wasm files')
    expect(lessons.some((l) => l.content.includes('ort-wasm-simd-threaded'))).toBe(true)

    const boom = vi.fn().mockRejectedValue(new Error('model down'))
    const stillOk = await distillEpisode(ep({ turns: [{ role: 'assistant', text: 'We decided to ship it.' }] }), { llm: boom })
    expect(stillOk.some((l) => l.kind === 'decision')).toBe(true)
  })

  it('adds no lesson when the llm returns empty', async () => {
    const llm = vi.fn().mockResolvedValue('   ')
    const lessons = await distillEpisode(ep({ turns: [{ role: 'assistant', text: 'We decided to cache embeddings.' }] }), { llm })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(lessons).toHaveLength(1)
    expect(lessons[0].kind).toBe('decision')
  })

  it('clamps enriched importance to 1', async () => {
    const llm = vi.fn().mockResolvedValue('Reusable: `a` `b` `c` `d` `e` `f` `g` are all needed.')
    const lessons = await distillEpisode(
      ep({ turns: [{ role: 'assistant', text: 'Fixed the crash.' }], outcome: { kind: 'commit', success: true } }),
      { llm },
    )
    const enriched = lessons.find((l) => l.content.includes('are all needed'))
    expect(enriched).toBeDefined()
    expect(enriched!.importance).toBe(1)
  })

  it('buildDistillPrompt includes instructions and the transcript', () => {
    const p = buildDistillPrompt(
      ep({ turns: [{ role: 'assistant', text: 'hello world lesson' }], outcome: { kind: 'test', success: false, detail: '2 failing' } }),
    )
    expect(p).toContain('reusable')
    expect(p).toContain('hello world lesson')
    expect(p).toContain('FAILED')
  })
})
