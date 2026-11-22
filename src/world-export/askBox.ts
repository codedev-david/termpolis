// The exported page's Ask box: finds the parts of the world that match a question. Keyword search (BM25 over the
// same entry texts the export indexed) answers at once; when the page carries the model, smart Ask loads in the
// background and, once ready, ranks by meaning fused with the keywords. It never writes an answer of its own.
// Every result is built from the index's data with textContent, never from HTML.
import { bm25Scores, cosineScores, nameFit, rankAsk, tokenize, type AskEntry, type AskHit, type AskKind, type Bm25, type PackedVectors } from '../shared/world/askIndex'
import type { SmartAsk } from './smartAsk'

export type AskState = 'keyword' | 'loading' | 'smart' | 'failed'

export interface AskBoxDeps {
  entries: AskEntry[]
  bm25: Bm25
  /** The packed entry vectors; null on a keyword-only page. */
  vectors: PackedVectors | null
  /** Smart Ask starting; null on a keyword-only page. */
  smart: Promise<SmartAsk> | null
  /** A result was chosen: its id and kind (a tour's id may equal a part's, so the kind says which). */
  onPick(id: string, kind: AskKind): void
}

export interface AskBox {
  state(): AskState
  /** Settles once smart Ask is ready or has failed ('keyword' at once on a keyword-only page). Never rejects. */
  ready: Promise<AskState>
  /**
   * Folds the answer away (the results and the caption) down to the question and a "Show N answers" button, when the
   * page needs the room for what was just opened. The question stays; the button, clicking into the question, typing
   * or asking again brings the answer back. Only results fold: with none (nothing asked yet, or no match) nothing
   * changes. True when the answer is folded.
   */
  fold(): boolean
  /** Brings a folded answer back. */
  unfold(): void
  /** Whether the answer is folded now. */
  folded(): boolean
  /** What `read` measures with the answer shown, the fold put back after (synchronously, so nothing is drawn between). */
  withAnswer<T>(read: () => T): T
}

export const ASK_PLACEHOLDER = 'Ask about this project'
export const ASK_LOADING = 'Smart Ask is getting ready… keyword search works now.'
export const ASK_FAILED = "Smart Ask couldn't start in this browser; using keyword search."
export const ASK_CAPTION = "Offline search: finds the parts that match; it doesn't write new answers."
export const ASK_NONE = 'No matching parts'
/** The button a folded answer leaves under the question. */
export const showAnswers = (n: number): string => `Show ${n} ${n === 1 ? 'answer' : 'answers'}`
export const KIND_WORD: Record<AskKind, string> = { building: 'building', line: 'line', external: 'outside system', term: 'term', tour: 'tour' }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Each box's results list gets its own id, for the fold button's aria-controls. */
let boxes = 0

export function mountAskBox(host: HTMLElement, deps: AskBoxDeps): AskBox {
  let state: AskState = deps.smart ? 'loading' : 'keyword'
  let smart: SmartAsk | null = null
  /** Each question gets a number: an answer that comes back after a newer question is dropped. */
  let asked = 0

  const box = el('section', 'wx-ask')
  box.setAttribute('aria-label', 'Ask')
  const form = el('form', 'wx-ask-form')
  form.setAttribute('role', 'search')
  const input = el('input', 'wx-ask-input')
  input.type = 'search'
  input.placeholder = ASK_PLACEHOLDER
  input.setAttribute('aria-label', ASK_PLACEHOLDER)
  input.autocomplete = 'off'
  form.appendChild(input)
  const status = el('p', 'wx-ask-status')
  status.setAttribute('role', 'status')
  const results = el('ul', 'wx-ask-results')
  results.id = `wx-ask-results-${++boxes}`
  const more = el('button', 'wx-ask-more')
  more.type = 'button'
  more.hidden = true
  more.setAttribute('aria-controls', results.id)
  more.setAttribute('aria-expanded', 'true')
  const none = el('p', 'wx-ask-none', ASK_NONE)
  none.hidden = true
  const caption = el('p', 'wx-ask-caption', ASK_CAPTION)
  box.append(form, status, more, results, none, caption)
  host.appendChild(box)

  /** Folded (fold): the answer is hidden under the question, and the button says how many results it holds. */
  const setFolded = (on: boolean): void => {
    if (on) box.setAttribute('data-folded', '')
    else box.removeAttribute('data-folded')
    more.hidden = !on
    more.setAttribute('aria-expanded', String(!on))
    if (on) more.textContent = showAnswers(results.childElementCount)
  }
  const folded = (): boolean => box.hasAttribute('data-folded')
  const unfold = (): void => setFolded(false)
  more.addEventListener('click', () => {
    unfold()
    ;(results.querySelector('button') as HTMLButtonElement).focus()
  })
  input.addEventListener('focus', unfold)
  input.addEventListener('pointerdown', unfold)
  input.addEventListener('input', unfold)

  const showState = (): void => {
    status.textContent = state === 'loading' ? ASK_LOADING : state === 'failed' ? ASK_FAILED : ''
    status.hidden = status.textContent === ''
    box.setAttribute('data-state', state)
  }
  showState()

  const show = (hits: AskHit[]): void => {
    unfold()
    results.textContent = ''
    none.hidden = hits.length > 0
    for (const hit of hits) {
      const li = el('li', 'wx-ask-hit')
      const button = el('button', 'wx-ask-pick')
      button.type = 'button'
      button.setAttribute('style', 'overflow-wrap:anywhere')
      button.setAttribute('data-id', hit.id)
      const head = el('span', 'wx-ask-head')
      head.append(el('b', 'wx-ask-name', hit.name), el('span', 'wx-ask-kind', KIND_WORD[hit.kind]))
      button.append(head, el('span', 'wx-ask-first', hit.first))
      button.addEventListener('click', () => deps.onPick(hit.id, hit.kind))
      li.appendChild(button)
      results.appendChild(li)
    }
  }

  /** The query's meaning scores, or undefined to rank by keyword alone (not ready, or this one embedding failed). */
  const meaning = async (q: string): Promise<number[] | undefined> => {
    if (smart === null || deps.vectors === null) return undefined
    try {
      const v = await smart.embed(q)
      // A broken embedding (NaN or infinity anywhere) would rank at random: this question goes by keyword.
      for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return undefined
      return cosineScores(deps.vectors, v)
    } catch {
      return undefined
    }
  }

  const ask = async (q: string): Promise<void> => {
    const n = ++asked
    // Nothing to search for (empty, punctuation, only common words): no ranking runs at all.
    if (tokenize(q).length === 0) { show([]); return }
    const keyword = bm25Scores(deps.bm25, q)
    const named = nameFit(deps.entries, q)
    const smartScores = await meaning(q)
    if (n !== asked) return
    show(rankAsk(deps.entries, smartScores ? { smart: smartScores, keyword, named } : { keyword, named }))
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void ask(input.value)
  })

  const ready: Promise<AskState> = deps.smart === null
    ? Promise.resolve(state)
    : deps.smart.then(
      (s) => { smart = s; state = 'smart'; showState(); return state },
      () => { state = 'failed'; showState(); return state },
    )
  const fold = (): boolean => {
    if (results.childElementCount > 0) setFolded(true)
    return folded()
  }
  const withAnswer = <T>(read: () => T): T => {
    const was = folded()
    setFolded(false)
    try { return read() } finally { setFolded(was) }
  }
  return { state: () => state, ready, fold, unfold, folded, withAnswer }
}
