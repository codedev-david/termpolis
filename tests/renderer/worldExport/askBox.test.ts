// The exported page's Ask box: its words, the result rows, keyword search while smart Ask loads, the smart
// ranking once it is ready, and the fallbacks (no words to search, a failed start, a broken embedding).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBm25, packInt8, type AskEntry, type AskKind } from '../../../src/shared/world/askIndex'
import * as askIndex from '../../../src/shared/world/askIndex'
import { ASK_CAPTION, ASK_FAILED, ASK_LOADING, ASK_NONE, ASK_PLACEHOLDER, mountAskBox, type AskBoxDeps } from '../../../src/world-export/askBox'
import type { SmartAsk } from '../../../src/world-export/smartAsk'

const entry = (id: string, kind: AskKind, name: string, text: string, first = `${name} first line`): AskEntry => ({ id, kind, name, first, text, test: false })
const ENTRIES: AskEntry[] = [
  entry('b1', 'building', 'Memory store', 'memory store sqlite vectors'),
  entry('e1', 'line', 'Saves notes', 'saves notes into the memory'),
  entry('x1', 'external', 'GitHub', 'github remote pull requests'),
  entry('tech:sqlite', 'term', 'sqlite', 'sqlite small database file'),
  entry('t1', 'tour', 'First look', 'first look tour overview', 'A-very-long-unbroken-first-line-'.repeat(8)),
]
// One direction per entry, so a query along direction i ranks entry i first by meaning.
const VECTORS = packInt8(ENTRIES.map((_, i) => [0, 1, 2, 3, 4].map((h) => (h === i ? 1 : 0))))
const along = (i: number): Float32Array => new Float32Array([0, 1, 2, 3, 4].map((h) => (h === i ? 1 : 0)))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(over: Partial<AskBoxDeps> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const onPick = vi.fn()
  const box = mountAskBox(host, { entries: ENTRIES, bm25: buildBm25(ENTRIES.map((e) => e.text)), vectors: null, smart: null, onPick, ...over })
  const input = host.querySelector('input') as HTMLInputElement
  const ask = async (q: string): Promise<void> => {
    input.value = q
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    // The answer is a few promise turns away (the embedding); a timer runs after all of them.
    await new Promise((r) => setTimeout(r, 0))
  }
  const ids = (): string[] => Array.from(host.querySelectorAll('.wx-ask-pick'), (b) => b.getAttribute('data-id') as string)
  const status = (): HTMLElement => host.querySelector('.wx-ask-status') as HTMLElement
  const none = (): HTMLElement => host.querySelector('.wx-ask-none') as HTMLElement
  return { host, box, input, ask, ids, status, none, onPick }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('mountAskBox', () => {
  it('shows the placeholder and the caption, and no status on a keyword-only page', async () => {
    const { host, box, input, status } = mount()
    expect(input.placeholder).toBe(ASK_PLACEHOLDER)
    expect(input.placeholder).toBe('Ask about this project')
    expect(host.querySelector('.wx-ask-caption')!.textContent).toBe("Offline search: finds the parts that match; it doesn't write new answers.")
    expect(ASK_CAPTION).toBe(host.querySelector('.wx-ask-caption')!.textContent)
    expect(status().hidden).toBe(true)
    expect(box.state()).toBe('keyword')
    expect(await box.ready).toBe('keyword')
  })

  it('says smart Ask is loading, then clears it once ready', async () => {
    const d = deferred<SmartAsk>()
    const { box, status, host } = mount({ vectors: VECTORS, smart: d.promise })
    expect(box.state()).toBe('loading')
    expect(status().textContent).toBe('Smart Ask is getting ready… keyword search works now.')
    expect(status().textContent).toBe(ASK_LOADING)
    expect(status().hidden).toBe(false)
    d.resolve({ embed: async () => along(0) })
    expect(await box.ready).toBe('smart')
    expect(box.state()).toBe('smart')
    expect(status().hidden).toBe(true)
    expect(host.querySelector('.wx-ask')!.getAttribute('data-state')).toBe('smart')
  })

  it('says smart Ask failed and keeps keyword search when it cannot start', async () => {
    const d = deferred<SmartAsk>()
    const { box, status, ask, ids } = mount({ vectors: VECTORS, smart: d.promise })
    d.reject(new Error('no wasm'))
    expect(await box.ready).toBe('failed')
    expect(box.state()).toBe('failed')
    expect(status().textContent).toBe("Smart Ask couldn't start in this browser; using keyword search.")
    expect(status().textContent).toBe(ASK_FAILED)
    await ask('github')
    expect(ids()).toEqual(['x1'])
  })

  it('shows the name, the kind word and the first line of each result, wrapping anywhere', async () => {
    const { host, ask } = mount()
    await ask('memory sqlite github first look tour')
    const rows = Array.from(host.querySelectorAll('.wx-ask-pick')) as HTMLElement[]
    const byId = new Map(rows.map((r) => [r.getAttribute('data-id'), r]))
    const kinds = { b1: 'building', e1: 'line', x1: 'outside system', 'tech:sqlite': 'term', t1: 'tour' }
    for (const [id, word] of Object.entries(kinds)) {
      const row = byId.get(id) as HTMLElement
      const e = ENTRIES.find((x) => x.id === id) as AskEntry
      expect(row.querySelector('.wx-ask-name')!.textContent).toBe(e.name)
      expect(row.querySelector('.wx-ask-kind')!.textContent).toBe(word)
      expect(row.querySelector('.wx-ask-first')!.textContent).toBe(e.first)
      expect(row.getAttribute('style')).toContain('overflow-wrap:anywhere')
    }
  })

  it('builds rows as text, never as HTML', async () => {
    const hostile = [entry('b9', 'building', '<img src=x onerror=alert(1)>', 'hostile name')]
    const { host, ask } = mount({ entries: hostile, bm25: buildBm25(hostile.map((e) => e.text)) })
    await ask('hostile')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.wx-ask-name')!.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('fold hides the answer under the question until the box is used again', async () => {
    const { host, box, input, ask } = mount()
    const section = host.querySelector('.wx-ask') as HTMLElement
    box.fold() // nothing asked yet: nothing to fold
    expect(section.hasAttribute('data-folded')).toBe(false)
    await ask('memory')
    box.fold()
    expect(section.hasAttribute('data-folded')).toBe(true)
    input.dispatchEvent(new Event('focus'))
    expect(section.hasAttribute('data-folded')).toBe(false)
    box.fold()
    input.dispatchEvent(new Event('pointerdown'))
    expect(section.hasAttribute('data-folded')).toBe(false)
    box.fold()
    input.dispatchEvent(new Event('input'))
    expect(section.hasAttribute('data-folded')).toBe(false)
    box.fold()
    await ask('memory') // asking again shows the answer
    expect(section.hasAttribute('data-folded')).toBe(false)
  })

  it('fold also folds a no-match answer away', async () => {
    const { host, box, ask } = mount()
    await ask('zzzz')
    box.fold()
    expect((host.querySelector('.wx-ask') as HTMLElement).hasAttribute('data-folded')).toBe(true)
  })

  it('calls onPick with the id of the clicked result', async () => {
    const { host, ask, onPick } = mount()
    await ask('github')
    ;(host.querySelector('.wx-ask-pick') as HTMLButtonElement).click()
    expect(onPick).toHaveBeenCalledWith('x1', 'external')
  })

  it('answers by keyword while smart Ask is still loading', async () => {
    const d = deferred<SmartAsk>()
    const { ask, ids, box } = mount({ vectors: VECTORS, smart: d.promise })
    await ask('github')
    expect(box.state()).toBe('loading')
    expect(ids()).toEqual(['x1'])
  })

  it('puts the part a one-word question names above a line that only repeats its name, by keyword and by meaning', async () => {
    const named = [
      entry('b-mem', 'building', 'Memory host', 'Memory host keeps each note on this computer in its own process and finds related ones with a vector index Memory memoryHost noteStore vectorIndex keyRing'),
      entry('e-mem', 'line', 'Memory host → Embedder', 'Memory host → Embedder Both ways: Memory host reaches Embedder, and Embedder reaches Memory host memories'),
      entry('b-emb', 'building', 'Embedder', 'Embedder turns text into numbers')
    ]
    const vectors = packInt8(named.map((_, i) => [0, 1, 2].map((h) => (h === i ? 1 : 0))))
    const keywordOnly = mount({ entries: named, bm25: buildBm25(named.map((e) => e.text)) })
    await keywordOnly.ask('memory')
    expect(keywordOnly.ids()[0]).toBe('b-mem')
    // The meaning ranking likes the line best, as the real model does for a short text that says the name three times.
    const smart = mount({ entries: named, bm25: buildBm25(named.map((e) => e.text)), vectors, smart: Promise.resolve({ embed: async () => new Float32Array([0, 1, 0]) }) })
    await smart.box.ready
    await smart.ask('memory')
    expect(smart.ids()).toEqual(['b-mem', 'e-mem', 'b-emb'])
    // The whole name among other words leads too.
    await smart.ask('how does the memory host work')
    expect(smart.ids()[0]).toBe('b-mem')
  })

  it('ranks by meaning fused with the keywords once smart Ask is ready', async () => {
    const embed = vi.fn(async () => along(3))
    const { ask, ids, box } = mount({ vectors: VECTORS, smart: Promise.resolve({ embed }) })
    await box.ready
    await ask('database')
    expect(embed).toHaveBeenCalledWith('database')
    expect(ids()[0]).toBe('tech:sqlite')
    expect(ids()).toHaveLength(5)
  })

  it.each(['', '?!', 'the and of'])('shows No matching parts and ranks nothing for %j', async (q) => {
    const rank = vi.spyOn(askIndex, 'rankAsk')
    const bm25 = vi.spyOn(askIndex, 'bm25Scores')
    const embed = vi.fn(async () => along(0))
    const { ask, ids, none, box } = mount({ vectors: VECTORS, smart: Promise.resolve({ embed }) })
    await box.ready
    await ask(q)
    expect(ids()).toEqual([])
    expect(none().hidden).toBe(false)
    expect(none().textContent).toBe('No matching parts')
    expect(none().textContent).toBe(ASK_NONE)
    expect(rank).not.toHaveBeenCalled()
    expect(bm25).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
  })

  it('shows No matching parts when no entry shares a word with the question', async () => {
    const { ask, ids, none } = mount()
    await ask('zebra')
    expect(ids()).toEqual([])
    expect(none().hidden).toBe(false)
  })

  it.each([NaN, Infinity, -Infinity])('ranks a question by keyword when its embedding holds %s, and stays smart', async (bad) => {
    const embed = vi.fn(async () => new Float32Array([1, bad, 0, 0, 0]))
    const { ask, ids, box, status } = mount({ vectors: VECTORS, smart: Promise.resolve({ embed }) })
    expect(await box.ready).toBe('smart')
    await ask('github')
    expect(embed).toHaveBeenCalled()
    expect(ids()).toEqual(['x1'])
    expect(box.state()).toBe('smart')
    expect(status().hidden).toBe(true)
  })

  it('ranks a question by keyword when its embedding rejects, and stays smart', async () => {
    const embed = vi.fn(async (): Promise<Float32Array> => { throw new Error('session gone') })
    const { ask, ids, box } = mount({ vectors: VECTORS, smart: Promise.resolve({ embed }) })
    await box.ready
    await ask('github')
    expect(ids()).toEqual(['x1'])
    expect(box.state()).toBe('smart')
  })

  it('ranks by keyword alone when smart Ask is ready but the page has no vectors', async () => {
    const embed = vi.fn(async () => along(0))
    const { ask, ids, box } = mount({ vectors: null, smart: Promise.resolve({ embed }) })
    await box.ready
    await ask('github')
    expect(embed).not.toHaveBeenCalled()
    expect(ids()).toEqual(['x1'])
  })

  it('drops an answer that comes back after a newer question', async () => {
    const slow = deferred<Float32Array>()
    const embed = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(along(2))
    const { host, input, ids, box } = mount({ vectors: VECTORS, smart: Promise.resolve({ embed }) })
    await box.ready
    const submit = (q: string): void => {
      input.value = q
      host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    }
    submit('memory')
    submit('github')
    await vi.waitFor(() => expect(ids()[0]).toBe('x1'))
    slow.resolve(along(0))
    await new Promise((r) => setTimeout(r, 0))
    expect(ids()[0]).toBe('x1')
  })
})
