import { describe, it, expect } from 'vitest'
import { distillEpisode, type Episode } from '../../src/main/mnemeReflect'

const ep = (turns: Episode['turns']): Episode => ({ id: 'e', project: 'p', turns })

// H10: a short trigger sentence carries its substance in the next sentence; the
// extractor now pulls it in instead of storing a useless stub (guarded so exact
// duplicate decisions still de-duplicate).
describe('mnemeReflect — thin-trigger sentence extension', () => {
  it('extends a split root-cause across sentences', async () => {
    const lessons = await distillEpisode(
      ep([{ role: 'assistant', text: 'Found the root cause. It was the mic capturing background noise, not the model.' }]),
    )
    const fact = lessons.find((l) => l.kind === 'fact' && l.memoryType === 'semantic')
    expect(fact).toBeDefined()
    expect(fact!.content).toMatch(/mic capturing background noise/i) // substance from the NEXT sentence
  })

  it('extends a split decision', async () => {
    const lessons = await distillEpisode(
      ep([{ role: 'assistant', text: 'The plan is clear. Use HNSW for the vector index instead of brute force.' }]),
    )
    const dec = lessons.find((l) => l.kind === 'decision')
    expect(dec).toBeDefined()
    expect(dec!.content).toMatch(/HNSW/)
  })

  it('does not extend a self-contained trigger sentence', async () => {
    const lessons = await distillEpisode(
      ep([
        {
          role: 'assistant',
          text: 'We decided to use HNSW instead of brute force for the vector index. Totally unrelated followup sentence here.',
        },
      ]),
    )
    const dec = lessons.find((l) => l.kind === 'decision')
    expect(dec).toBeDefined()
    expect(dec!.content).not.toMatch(/unrelated followup/i) // self-contained → next NOT appended
  })

  it('still de-duplicates identical short decisions (no spurious extension)', async () => {
    const lessons = await distillEpisode(ep([{ role: 'assistant', text: 'We chose Groq. We chose Groq.' }]))
    expect(lessons.filter((l) => l.kind === 'decision')).toHaveLength(1)
  })
})
