import { useCallback, useEffect, useRef, useState } from 'react'
import type { VectorRamInfo } from '../../types'

/**
 * Vector memory: what the embeddings cost, and the int8 quantization toggle.
 *
 * This is deliberately a DECISION AID, not a switch. Nobody can answer "should I enable int8 vector
 * quantization?" in the abstract — so the panel answers it for them, from their own store. The
 * verdict it must be willing to give is the one it gives almost always: NOT NEEDED. A control that
 * only ever markets itself is an upsell, not a tool.
 *
 * NO POLLING, AND NO PROCESS HEALTH. The v1.25.5 version of this panel showed live tiles — RSS,
 * heap, GC pauses, event-loop percentiles — refreshed every 2 s from the MAIN process, which is the
 * same thread that echoes keystrokes into the PTY. It was part of what made the app freeze, and
 * v1.25.16 deleted the whole thing. What comes back is only the part that never needed any of that:
 * the verdict is pure arithmetic on the VECTOR COUNT (`count × 384 × 4` vs `count × 384 × 1`), so a
 * single one-shot read answers it. It loads when the tab is opened and when Refresh is pressed —
 * `refreshToken` changes — and at no other time. Do not reintroduce a timer here.
 */

/** Below this, freeing vector RAM cannot plausibly change anything: you would be trading exactness
 *  for a saving the OS will not even notice. This is the threshold that lets the panel say "no". */
const VECTOR_RAM_FLOOR_BYTES = 256 * 1024 * 1024 // 256 MB

/** The three honest verdicts. `wont-help` and `recommended` existed in v1.25.5 and are NOT coming
 *  back: both claimed to know whether the main thread was suffering, and the only instrument that
 *  could tell them was the one that caused the suffering. A panel that cannot measure the harm does
 *  not get to assert it. */
type Verdict = 'not-needed' | 'optional' | 'enabled'

interface Advice {
  verdict: Verdict
  headline: string
  detail: string
  savingBytes: number
}

const mb = (b: number): string => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round(b / 1048576)} MB`)

/** Verdict → how loudly to say it. Note that none of them is a call to action: nothing here knows
 *  of a problem this toggle would fix, and so nothing here pushes it. */
const TONE: Record<Verdict, { box: string; dot: string; label: string }> = {
  'not-needed': { box: 'bg-[#1e2a1e] border-[#2f4a2f] text-[#9ccc9c]', dot: 'bg-[#7ee2a3]', label: 'Not needed' },
  optional:     { box: 'bg-[#22303a] border-[#2f4a5a] text-[#8fc7e0]', dot: 'bg-[#22D3EE]', label: 'Your call' },
  enabled:      { box: 'bg-[#22303a] border-[#2f4a5a] text-[#8fc7e0]', dot: 'bg-[#22D3EE]', label: 'int8 on' },
}

/**
 * The recommendation. PURE — takes the numbers, returns advice — and it takes ONLY the numbers the
 * store already knows about itself. Every branch is reachable from a vector count alone.
 */
export function quantizationAdvice(v: VectorRamInfo): Advice {
  const saving = Math.max(0, v.ramBytes - v.ramBytesInt8)

  if (v.quantized) {
    return {
      verdict: 'enabled',
      headline: `int8 is on — vectors are using ${mb(v.ramBytes)}`,
      detail:
        'Exact floats are still on disk, so you can switch back at any time and lose nothing. ' +
        'The store simply re-packs at full precision on the next load.',
      savingBytes: 0,
    }
  }

  // The common case, and the whole reason this panel is worth having: it says no.
  if (v.ramBytes < VECTOR_RAM_FLOOR_BYTES) {
    return {
      verdict: 'not-needed',
      headline: `Not needed — your ${v.vectors.toLocaleString()} vectors use only ${mb(v.ramBytes)}`,
      detail:
        `Turning int8 on would free about ${mb(saving)}, which is not enough to change anything. ` +
        'Leave it off: exact vectors are the better default until memory is actually costing you something. ' +
        'This panel will tell you if that changes.',
      savingBytes: saving,
    }
  }

  // The vectors ARE large. That is a fact about the store, and it is all this panel knows — it does
  // not measure the main thread any more, so it does not get to claim the RAM is hurting you.
  return {
    verdict: 'optional',
    headline: `Your call — vectors are ${mb(v.ramBytes)}`,
    detail:
      `int8 would free about ${mb(saving)}. That saving is real, and it is reversible — but this panel ` +
      'does not measure your main thread, so it will not pretend to know whether the RAM is costing you ' +
      'anything. Turn it on if you want the headroom back; leaving it off is not a mistake.',
    savingBytes: saving,
  }
}

/** @param refreshToken bump it to re-read. Mount = tab opened; a change = Refresh pressed. */
export function VectorRamPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const [d, setD] = useState<VectorRamInfo | null>(null)
  const [err, setErr] = useState('')          // a failed READ
  // A failed ACTION (the toggle). Kept separate on purpose: a successful `load()` clears `err`, and
  // toggle()'s `finally` fires a load() -- so a toggle error written into `err` was wiped a
  // microtask later and the user never learned why the flip failed. They just watched the checkbox
  // not move. A failure that presents as silence is the worst kind. (The 2 s poll that first exposed
  // this is gone, but the load-after-toggle it raced is still here, so the two slots stay separate.)
  const [actionErr, setActionErr] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis?.memoryGetVectorRam?.()
      if (!mounted.current) return
      if (res?.success && res.data) { setD(res.data); setErr('') }
      else setErr(res?.error || 'Could not read vector memory')
    } catch (e) {
      if (mounted.current) setErr((e as Error).message || 'Could not read vector memory')
    }
  }, [])

  // On open, and on Refresh. NEVER on a timer — see the note at the top of this file.
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load, refreshToken])

  const toggle = async () => {
    if (!d || busy) return
    setBusy(true)
    setActionErr('') // a fresh attempt clears the previous failure -- a re-read never does
    try {
      const res = await window.termpolis?.memorySetVectorQuantize?.(!d.quantized)
      if (!mounted.current) return
      // The setter returns the rebuilt store's own stats, so the checkbox reflects what the store
      // ACTUALLY did, never what we asked it to do.
      if (res?.success && res.data) setD(res.data)
      else setActionErr(res?.error || 'Could not change vector precision')
    } catch (e) {
      if (mounted.current) setActionErr((e as Error).message || 'Could not change vector precision')
    } finally {
      if (mounted.current) { setBusy(false); void load() }
    }
  }

  if (err && !d) {
    return <div data-testid="vector-ram-error" className="text-xs text-[#EF5350]">{err}</div>
  }
  if (!d) {
    return <div data-testid="vector-ram-loading" className="text-xs text-[#9ca3af]">Reading vector memory…</div>
  }

  const advice = quantizationAdvice(d)
  const tone = TONE[advice.verdict]

  return (
    <section data-testid="vector-ram-panel" className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold text-[#22D3EE] mb-1 flex items-center gap-2">
          <i className="fa-solid fa-microchip text-xs"></i> Vector memory
        </h3>
        <p className="text-xs text-[#9ca3af] leading-relaxed">
          Your embeddings live in the <strong>main process</strong> &mdash; the same thread that echoes your
          keystrokes. Storing them as <code className="bg-[#3c3c3c] px-1 rounded">int8</code> instead of exact
          floats uses <strong>4&times; less RAM</strong>. Recall parity is benchmarked against the exact
          baseline, and it is <strong>reversible</strong>: the copy on disk always keeps exact floats.
        </p>
      </div>

      {/* The verdict — computed from YOUR store, and willing to tell you not to bother. */}
      <div data-testid="vector-ram-verdict" className={`rounded border px-3 py-2 ${tone.box}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-block w-2 h-2 rounded-full ${tone.dot}`} />
          <span className="text-xs font-semibold uppercase tracking-wide">{tone.label}</span>
        </div>
        <div className="text-sm font-medium">{advice.headline}</div>
        <div className="text-xs mt-1 opacity-90 leading-relaxed">{advice.detail}</div>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          data-testid="vector-quantize-toggle"
          checked={d.quantized}
          disabled={busy}
          onChange={() => { void toggle() }}
          className="mt-0.5"
        />
        <span className="text-xs text-[#cfead8] leading-relaxed">
          <strong>Store vectors as int8</strong> {busy ? <em>(rebuilding…)</em> : null}
          <br />
          <span className="text-[#9ca3af]">
            Off by default. Turning it on rebuilds the packed store in place; turning it off restores exact
            floats from disk. <strong>Nothing is ever destroyed</strong> &mdash; this is an in-RAM
            representation, not a data migration.
          </span>
        </span>
      </label>

      {actionErr ? (
        <div data-testid="vector-quantize-error" className="text-xs text-[#EF5350]">{actionErr}</div>
      ) : null}
      {err ? <div data-testid="vector-ram-error" className="text-xs text-[#EF5350]">{err}</div> : null}
    </section>
  )
}
