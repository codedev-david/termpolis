import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Vector RAM + main-thread health, and the int8 quantization toggle.
 *
 * This is deliberately a DECISION AID, not a switch. Nobody can answer "should I enable int8
 * vector quantization?" in the abstract — so the panel answers it for them, from their own machine:
 * how much RAM the vectors actually hold, whether the main thread (the one that echoes their
 * keystrokes) is stalling, and whether the vectors are even the reason.
 *
 * The verdict it must be willing to give is `wont-help`: "your thread is stalling, but not because
 * of the vectors." A control that only ever markets itself is an upsell, not a tool.
 */

const POLL_MS = 2000

interface Health {
  rssBytes: number
  heapUsedBytes: number
  arrayBufferBytes: number
  loopDelayP50Ms: number
  loopDelayP99Ms: number
  loopDelayMaxMs: number
  gcMajorCount: number
  gcTotalPauseMs: number
  gcMaxPauseMs: number
  sampleWindowMs: number
  gcTimeFraction: number
}

interface Advice {
  verdict: 'not-needed' | 'wont-help' | 'optional' | 'recommended' | 'enabled'
  headline: string
  detail: string
  savingBytes: number
}

interface VectorRam {
  vectors: number
  dim: number
  quantized: boolean
  ramBytes: number
  ramBytesFloat: number
  ramBytesInt8: number
  persisted: boolean
  health: Health
  advice: Advice
}

const mb = (b: number): string => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round(b / 1048576)} MB`)

/** Verdict → how loudly to say it. `recommended` is the only one that gets a call-to-action colour. */
const TONE: Record<Advice['verdict'], { box: string; dot: string; label: string }> = {
  'not-needed':  { box: 'bg-[#1e2a1e] border-[#2f4a2f] text-[#9ccc9c]', dot: 'bg-[#7ee2a3]', label: 'Not needed' },
  'wont-help':   { box: 'bg-[#3a2a0d] border-[#6e4d1f] text-[#FFB74D]', dot: 'bg-[#FFB74D]', label: "Won't help" },
  optional:      { box: 'bg-[#22303a] border-[#2f4a5a] text-[#8fc7e0]', dot: 'bg-[#22D3EE]', label: 'Your call' },
  recommended:   { box: 'bg-[#3d2a1a] border-[#7a4a20] text-[#FFB74D]', dot: 'bg-[#FF9800]', label: 'Recommended' },
  enabled:       { box: 'bg-[#22303a] border-[#2f4a5a] text-[#8fc7e0]', dot: 'bg-[#22D3EE]', label: 'int8 on' },
}

export function VectorRamPanel() {
  const [d, setD] = useState<VectorRam | null>(null)
  const [err, setErr] = useState('')          // a failed READ (the 2s poll)
  // A failed ACTION (the toggle). Kept separate on purpose: `load()` clears `err` on every
  // successful poll, and toggle()'s `finally` fires a load() -- so a toggle error written into
  // `err` was wiped a microtask later and the user never learned why the flip failed. They just
  // watched the checkbox not move. A failure that presents as silence is the worst kind.
  const [actionErr, setActionErr] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await window.termpolis?.memoryGetVectorRam?.()
      if (!mounted.current) return
      if (res?.success && res.data) { setD(res.data as VectorRam); setErr('') }
      else setErr(res?.error || 'Could not read vector memory')
    } catch (e) {
      if (mounted.current) setErr((e as Error).message || 'Could not read vector memory')
    }
  }, [])

  // Live: the numbers move while you watch. GC pressure is only meaningful as a trend.
  useEffect(() => {
    mounted.current = true
    void load()
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => { mounted.current = false; clearInterval(t) }
  }, [load])

  const toggle = async () => {
    if (!d || busy) return
    setBusy(true)
    setActionErr('') // a fresh attempt clears the previous failure -- a poll never does
    try {
      const res = await window.termpolis?.memorySetVectorQuantize?.(!d.quantized)
      if (!mounted.current) return
      if (res?.success && res.data) setD((prev) => (prev ? { ...prev, ...(res.data as VectorRam) } : prev))
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

  const tone = TONE[d.advice.verdict] ?? TONE.optional
  // Each row reports its OWN number. The combined stall judgement lives in the verdict (computed
  // in main from both), so a long GC pause no longer makes the loop row claim its own 4.5 ms is
  // "above 50 ms".
  const loopStalling = d.health.loopDelayP99Ms >= 50

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

      {/* The verdict — computed from THIS machine, refreshed live. */}
      <div data-testid="vector-ram-verdict" className={`rounded border px-3 py-2 ${tone.box}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-block w-2 h-2 rounded-full ${tone.dot}`} />
          <span className="text-xs font-semibold uppercase tracking-wide">{tone.label}</span>
        </div>
        <div className="text-sm font-medium">{d.advice.headline}</div>
        <div className="text-xs mt-1 opacity-90 leading-relaxed">{d.advice.detail}</div>
      </div>

      {/* Live metrics. A number without its context is noise, so each says what "bad" looks like. */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Metric
          testid="m-vectors"
          label="Vectors"
          value={`${d.vectors.toLocaleString()} × ${d.dim}d`}
          sub={d.quantized ? 'int8 (1 B/component)' : 'float32 (4 B/component)'}
        />
        <Metric
          testid="m-vector-ram"
          label="Vector RAM"
          value={mb(d.ramBytes)}
          sub={d.quantized ? `${mb(d.ramBytesFloat)} as exact floats` : `${mb(d.ramBytesInt8)} as int8`}
        />
        <Metric
          testid="m-rss"
          label="Process RAM"
          value={mb(d.health.rssBytes)}
          sub={`vectors are ${d.health.rssBytes ? Math.round((d.ramBytes / d.health.rssBytes) * 100) : 0}% of it`}
        />
        <Metric
          testid="m-loop"
          label="Main-thread stall (p99)"
          value={`${d.health.loopDelayP99Ms} ms`}
          sub={loopStalling ? 'above 50 ms — you would feel this' : 'healthy (under 50 ms)'}
          bad={loopStalling}
        />
        <Metric
          testid="m-gc"
          label="Longest GC pause"
          value={`${d.health.gcMaxPauseMs} ms`}
          sub={`${d.health.gcMajorCount} major collections`}
          bad={d.health.gcMaxPauseMs >= 50}
        />
        <Metric
          testid="m-gc-share"
          label="Time spent in GC"
          value={`${(d.health.gcTimeFraction * 100).toFixed(2)}%`}
          sub={`over ${Math.round(d.health.sampleWindowMs / 1000)}s of this session`}
          bad={d.health.gcTimeFraction > 0.05}
        />
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

function Metric(props: { testid: string; label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <div data-testid={props.testid} className="rounded border border-[#3c3c3c] bg-[#2d2d2d] px-2.5 py-1.5">
      <div className="text-[#9ca3af] text-[10px] uppercase tracking-wide">{props.label}</div>
      <div className={`text-sm font-medium ${props.bad ? 'text-[#FFB74D]' : 'text-[#e0e0e0]'}`}>{props.value}</div>
      <div className="text-[10px] text-[#7d8590] mt-0.5">{props.sub}</div>
    </div>
  )
}
