import { useEffect, useRef, useState } from 'react'
import type { GraphSampleNode, GraphSampleEdge } from '../../types'
import { typeColor } from '../../lib/memoryDashboard'

// Live knowledge-graph view: a force-directed canvas over a real sampled subgraph.
// Nodes are memories (colored by cognitive type, sized by connectedness); links are the
// typed edges recall actually walks. Click a node to trace its connections. The sim is a
// small hand-rolled spring/repulsion layout (no external deps) — the same approach as the
// design mockup, adapted to React refs so hover/drag never re-runs the effect. Node colors
// come from the shared, validated TYPE_COLOR palette (see lib/memoryDashboard).

const REL_COLOR: Record<string, string> = {
  solves: '#22D3EE', 'solved-by': '#22D3EE',
  'caused-by': '#f48771', causes: '#f48771',
  supersedes: '#e2c08d', 'superseded-by': '#e2c08d',
  follows: '#f472b6', precedes: '#f472b6',
  'part-of': '#7aa2f7', 'has-part': '#7aa2f7',
  'refers-to': '#6b7280', 'referred-by': '#6b7280',
}
const colorForRel = (r: string): string => REL_COLOR[r] || '#3c3c3c'

interface SimNode extends GraphSampleNode {
  x: number; y: number; vx: number; vy: number; sx: number; sy: number; r: number
}

interface Props {
  nodes: GraphSampleNode[]
  edges: GraphSampleEdge[]
  totalNodes: number
  totalEdges: number
}

export function ConnectionsGraph({ nodes, edges, totalNodes, totalEdges }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<{ node: GraphSampleNode; edges: Array<{ rel: string; other: string; dir: 'out' | 'in' }> } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || nodes.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const N = nodes.length
    const maxDeg = Math.max(1, ...nodes.map((n) => n.degree))
    const idx = new Map<string, number>(nodes.map((n, i) => [n.id, i]))
    const sim: SimNode[] = nodes.map((n) => ({
      ...n, x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0,
      r: 3.5 + 5 * Math.sqrt(n.degree / maxDeg),
    }))
    // adjacency (only edges whose endpoints are both in the sample)
    const links = edges.filter((e) => idx.has(e.from) && idx.has(e.to) && e.from !== e.to)
      .map((e) => ({ a: idx.get(e.from)!, b: idx.get(e.to)!, rel: e.relation }))
    const adj: Array<Array<{ o: number; rel: string; dir: 'out' | 'in' }>> = sim.map(() => [])
    for (const l of links) { adj[l.a].push({ o: l.b, rel: l.rel, dir: 'out' }); adj[l.b].push({ o: l.a, rel: l.rel, dir: 'in' }) }

    // seeded RNG → deterministic layout across renders
    let seed = 7
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    let W = 0, H = 0, DPR = 1
    const resize = (): void => {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      const r = wrap.getBoundingClientRect()
      W = Math.max(240, r.width); H = 360
      canvas.width = W * DPR; canvas.height = H * DPR
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    resize()
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2, rad = 30 + rnd() * Math.min(W, H) * 0.34
      sim[i].x = W / 2 + Math.cos(a) * rad; sim[i].y = H / 2 + Math.sin(a) * rad
    }

    const step = (): void => {
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const dx = sim[i].x - sim[j].x, dy = sim[i].y - sim[j].y
        const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2), f = 820 / d2
        const fx = (dx / d) * f, fy = (dy / d) * f
        sim[i].vx += fx; sim[i].vy += fy; sim[j].vx -= fx; sim[j].vy -= fy
      }
      for (const l of links) {
        const A = sim[l.a], B = sim[l.b]
        const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01
        const f = (d - 72) * 0.01, fx = (dx / d) * f, fy = (dy / d) * f
        A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy
      }
      for (let i = 0; i < N; i++) {
        const n = sim[i]
        // gentle gravity toward centre keeps the graph a cohesive cluster instead of
        // splaying nodes onto the edges; stronger on x since the panel is wide.
        n.vx += (W / 2 - n.x) * 0.006; n.vy += (H / 2 - n.y) * 0.004
        n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy
        n.x = Math.max(n.r + 14, Math.min(W - n.r - 14, n.x))
        n.y = Math.max(n.r + 14, Math.min(H - n.r - 14, n.y))
      }
    }
    for (let s = 0; s < 220; s++) step()

    let selIdx: number | null = null
    let hovIdx: number | null = null
    const nbrSet = (i: number): Set<number> => { const s = new Set<number>([i]); for (const k of adj[i]) s.add(k.o); return s }

    const draw = (): void => {
      ctx.clearRect(0, 0, W, H)
      // Screen position == settled position. Resolved up front so edges, nodes, labels and
      // hit-testing all agree on where each node is.
      for (let i = 0; i < N; i++) {
        const n = sim[i]
        n.sx = n.x
        n.sy = n.y
      }
      const hi = selIdx != null ? nbrSet(selIdx) : null
      for (const l of links) {
        const A = sim[l.a], B = sim[l.b]
        const inc = selIdx != null && (l.a === selIdx || l.b === selIdx)
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy)
        ctx.strokeStyle = colorForRel(l.rel)
        if (selIdx != null) { ctx.globalAlpha = inc ? 0.95 : 0.05; ctx.lineWidth = inc ? 1.8 : 0.5 }
        else { ctx.globalAlpha = l.rel === 'relates-to' ? 0.22 : 0.5; ctx.lineWidth = l.rel === 'relates-to' ? 0.7 : 1.2 }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      for (let i = 0; i < N; i++) {
        const n = sim[i]
        const dim = hi != null && !hi.has(i)
        ctx.globalAlpha = dim ? 0.15 : 1
        const rr = n.r + (i === selIdx ? 3 : i === hovIdx ? 1.5 : 0)
        if (i === selIdx) { ctx.beginPath(); ctx.arc(n.sx, n.sy, rr + 5, 0, Math.PI * 2); ctx.fillStyle = typeColor(n.type); ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1 }
        ctx.beginPath(); ctx.arc(n.sx, n.sy, rr, 0, Math.PI * 2)
        ctx.fillStyle = typeColor(n.type); ctx.fill()
        ctx.lineWidth = 1.4; ctx.strokeStyle = '#161b26'; ctx.stroke()
      }
      ctx.globalAlpha = 1
      // labels for the selected node + its neighbours (or a single hovered node)
      const lab = selIdx != null ? nbrSet(selIdx) : hovIdx != null ? new Set([hovIdx]) : null
      if (lab) {
        ctx.font = '600 10.5px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center'
        for (let i = 0; i < N; i++) {
          if (!lab.has(i)) continue
          const n = sim[i], tx = n.sx, ty = n.sy - n.r - 6, w = ctx.measureText(n.label).width
          ctx.globalAlpha = 0.9; ctx.fillStyle = '#0d1119'; ctx.fillRect(tx - w / 2 - 4, ty - 11, w + 8, 15)
          ctx.globalAlpha = 1; ctx.fillStyle = '#e6edf3'; ctx.fillText(n.label, tx, ty)
        }
        ctx.textAlign = 'start'
      }
    }

    // DRAW ON DEMAND — never on a clock.
    //
    // This used to run `requestAnimationFrame` forever: ~60 fps, up to 600 stroked edges and 160
    // node arcs per frame, for as long as the Memory tab was mounted — even while scrolled out of
    // sight. The entire purpose of that loop was a cosmetic 1.3-pixel sinusoidal "bob". It landed
    // on exactly the frames scrolling needed, which is why the dashboard juddered whenever it was
    // dragged. The layout is fully settled by the pre-steps above, so a settled graph is a STATIC
    // image: paint it once, and repaint only when something a viewer can see actually changes
    // (hover, selection, resize). Idle cost is now zero.
    let raf = 0
    const schedule = (): void => {                 // coalesce: never paint twice in one frame
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; draw() })
    }
    draw()

    const hit = (px: number, py: number): number | null => {
      let best: number | null = null, bd = 1e9
      for (let i = 0; i < N; i++) { const n = sim[i], dx = px - n.sx, dy = py - n.sy, d = Math.sqrt(dx * dx + dy * dy); if (d < n.r + 7 && d < bd) { bd = d; best = i } }
      return best
    }
    const onMove = (e: MouseEvent): void => {
      const r = canvas.getBoundingClientRect(); const h = hit(e.clientX - r.left, e.clientY - r.top)
      canvas.style.cursor = h != null ? 'pointer' : 'default'
      if (h === hovIdx) return                     // nothing changed -> nothing to repaint
      hovIdx = h
      schedule()
    }
    const onLeave = (): void => { if (hovIdx == null) return; hovIdx = null; schedule() }
    const onClick = (e: MouseEvent): void => {
      const r = canvas.getBoundingClientRect(); const h = hit(e.clientX - r.left, e.clientY - r.top)
      selIdx = h != null && h !== selIdx ? h : null
      if (selIdx == null) setSelected(null)
      else setSelected({ node: nodes[selIdx], edges: adj[selIdx].map((k) => ({ rel: k.rel, other: nodes[k.o].label, dir: k.dir })) })
      schedule()
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('click', onClick)
    // Resize re-runs the O(N^2) relaxation, so it must never fire once per resize EVENT — a window
    // drag emits those continuously. Coalesce to one settle per quiet moment.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const onResize = (): void => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => { resize(); for (let s = 0; s < 60; s++) step(); draw() }, 120)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(resizeTimer)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('click', onClick)
      window.removeEventListener('resize', onResize)
    }
  }, [nodes, edges])

  const present = Array.from(new Set(nodes.map((n) => n.type)))

  if (nodes.length === 0) {
    return <span className="text-xs text-[#9ca3af]">No connections yet &mdash; they form as the brain reflects and links memories.</span>
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas ref={canvasRef} data-testid="ml-graph-canvas" className="w-full block rounded" style={{ height: 360, background: 'radial-gradient(120% 120% at 30% 0%, rgba(34,211,238,0.05), transparent 60%), #12161f' }} />
      <div className="absolute top-2 left-2 text-[10px] font-mono text-[#9ca3af] bg-[#12161f]/70 border border-[#3c3c3c] rounded px-2 py-1 backdrop-blur">
        {nodes.length} of {totalNodes.toLocaleString()} nodes · {totalEdges.toLocaleString()} edges
      </div>
      {selected && (
        <div className="absolute top-2 right-2 w-56 max-w-[62%] bg-[#12161f]/95 border border-[#22D3EE]/40 rounded-lg p-2.5 shadow-lg backdrop-blur" data-testid="ml-graph-card">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: typeColor(selected.node.type) }} />
            <span className="font-bold text-xs text-[#e6edf3] truncate" title={selected.node.label}>{selected.node.label}</span>
            <button onClick={() => setSelected(null)} className="ml-auto text-[#9ca3af] hover:text-[#e6edf3] text-xs leading-none px-1">✕</button>
          </div>
          <div className="text-[10px] font-mono text-[#9ca3af] uppercase tracking-wide mt-1.5 mb-2">{selected.node.type} · {selected.edges.length} connection{selected.edges.length === 1 ? '' : 's'}</div>
          <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
            {selected.edges.length === 0
              ? <span className="text-[10px] text-[#6b7280]">no edges</span>
              : selected.edges.map((e, i) => (
                <div key={i} className="text-[11px] leading-tight">
                  <span className="font-mono text-[10px]" style={{ color: colorForRel(e.rel) }}>{e.dir === 'out' ? `→ ${e.rel} →` : `← ${e.rel} ←`}</span>{' '}
                  <span className="text-[#c9d1d9]">{e.other}</span>
                </div>
              ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5">
        {present.map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#9ca3af]">
            <span className="w-2 h-2 rounded-sm" style={{ background: typeColor(t) }} />{t}
          </span>
        ))}
        <span className="text-[11px] font-mono text-[#6b7280]">— click a node to trace its connections</span>
      </div>
    </div>
  )
}
