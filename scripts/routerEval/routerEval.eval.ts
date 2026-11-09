// How well does the per-message router pick? Run: npm run router:eval
//
// 1. Seeds, leave one out: each of the 120 labelled examples classified by the other 119.
// 2. Real prompts from the local Claude Code transcripts: what the router would pick, how long it took,
//    and how that lines up with what answering actually took (tool calls, output tokens).
// 3. A labelling sheet (router-eval-labels.csv): fill the your_label column (keep / haiku / sonnet /
//    opus) and run again for the router's true accuracy on your own prompts.
//
// Everything stays on this computer. Options (environment):
//   ROUTER_EVAL_ROOTS        transcript folders, ';'-separated (default ~/.claude/projects)
//   ROUTER_EVAL_OUT          output folder (default .router-eval in the repo, git-ignored)
//   ROUTER_EVAL_MAX_FILES    newest transcripts read (default 800)
//   ROUTER_EVAL_MAX_PROMPTS  newest distinct prompts scored (default 3000)
//   ROUTER_EVAL_SAMPLE       rows in a new labelling sheet (default 300)

import { it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { performance } from 'perf_hooks'
import { embedBatch, embedText } from '../../src/main/localEmbedder'
import { unit } from '../../src/main/routerModel'
import { flatSeeds, type SeedLabel } from '../../src/shared/routerSeeds'
import { knnClassify, routeMessage, type LabeledVec, type Classification } from '../../src/shared/smartRoute'
import { routeTask } from '../../src/shared/taskRouter'
import { readTranscript, type Turn } from './transcripts'
import {
  LABELS, tierOf, confusion, direction, percentile, stratified, toCsv, parseCsv, asLabel, type Confusion, type Tier,
  LIGHT_MAX_TOOLS, LIGHT_MAX_OUT, HEAVY_MIN_TOOLS, HEAVY_MIN_OUT,
} from './metrics'

const env = (k: string, d: string) => (process.env[k] ?? '').trim() || d
const ROOTS = env('ROUTER_EVAL_ROOTS', path.join(os.homedir(), '.claude', 'projects')).split(';').filter(Boolean)
const OUT = path.resolve(env('ROUTER_EVAL_OUT', path.join(process.cwd(), '.router-eval')))
const MAX_FILES = Number(env('ROUTER_EVAL_MAX_FILES', '800'))
const MAX_PROMPTS = Number(env('ROUTER_EVAL_MAX_PROMPTS', '3000'))
const SAMPLE = Number(env('ROUTER_EVAL_SAMPLE', '300'))
const LABEL_FILE = path.join(OUT, 'router-eval-labels.csv')
const CLIP = 2000 // what the router sees

const rulesLabel = (p: string): SeedLabel => {
  const d = routeTask({ prompt: p })
  if (d.rule === 'no-task') return 'keep'
  return d.model === 'opusplan' ? 'opus' : d.model
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

function table(head: string[], rows: Array<Array<string | number>>): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function confusionTable(c: Confusion, truthName: string): string {
  return table([`${truthName} \\ picked`, ...LABELS, 'recall'], LABELS.map((t) => [t, ...LABELS.map((p) => c.matrix[t][p]), pct(c.recall[t])]))
}

async function transcriptFiles(): Promise<string[]> {
  const found: Array<{ f: string; m: number }> = []
  for (const root of ROOTS) {
    let dirs: string[] = []
    try { dirs = await fs.promises.readdir(root) } catch { continue }
    for (const d of dirs) {
      if (/AppData-Local-Temp/i.test(d)) continue // the app's own e2e probe sessions
      let names: string[] = []
      try { names = await fs.promises.readdir(path.join(root, d)) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const f = path.join(root, d, n)
        try { found.push({ f, m: (await fs.promises.stat(f)).mtimeMs }) } catch { /* gone */ }
      }
    }
  }
  return found.sort((a, b) => b.m - a.m).slice(0, MAX_FILES).map((x) => x.f)
}

interface Scored { cls: Classification | null; router: SeedLabel; source: string; confidence: number; knn: SeedLabel | null; rules: SeedLabel; ms: number }

async function score(prompt: string, seeds: LabeledVec[]): Promise<Scored> {
  const t0 = performance.now()
  const q = unit(await embedText(prompt.slice(0, CLIP)))
  const cls = q ? knnClassify(q, seeds) : null
  const r = routeMessage(prompt.slice(0, CLIP), cls)
  return { cls, router: r.label, source: r.source, confidence: r.confidence, knn: cls?.label ?? null, rules: rulesLabel(prompt), ms: performance.now() - t0 }
}

it('router evaluation', async () => {
  await fs.promises.mkdir(OUT, { recursive: true })
  const md: string[] = [`# Per-message router evaluation`, '', `Run ${new Date().toISOString()} · bge-small kNN (k=7) + word rules, as shipped.`, '']
  const summary: Record<string, unknown> = {}

  // 1. Seeds, leave one out.
  const flat = flatSeeds()
  const vecs = await embedBatch(flat.map((s) => s.text))
  const seeds: LabeledVec[] = flat.map((s, i) => {
    const v = unit(vecs[i])
    if (!v) throw new Error('The embedder did not load: is resources/models/bge-small-en-v1.5 present? (scripts/download-embedding-model.sh)')
    return { label: s.label, vec: v }
  })
  const loo = { knn: [] as Array<[SeedLabel, SeedLabel]>, blend: [] as Array<[SeedLabel, SeedLabel]>, rules: [] as Array<[SeedLabel, SeedLabel]> }
  flat.forEach((s, i) => {
    const cls = knnClassify(seeds[i].vec, seeds.filter((_, j) => j !== i))
    loo.knn.push([s.label, cls?.label ?? 'sonnet'])
    loo.blend.push([s.label, routeMessage(s.text, cls).label])
    loo.rules.push([s.label, rulesLabel(s.text)])
  })
  const looC = { knn: confusion(loo.knn), blend: confusion(loo.blend), rules: confusion(loo.rules) }
  summary.seeds = { n: flat.length, knn: looC.knn.accuracy, blend: looC.blend.accuracy, rules: looC.rules.accuracy }
  md.push('## 1. The 120 seeds, leave one out', '',
    table(['decider', 'accuracy'], [['kNN alone', pct(looC.knn.accuracy)], ['as shipped (kNN + rules)', pct(looC.blend.accuracy)], ['word rules alone', pct(looC.rules.accuracy)]]),
    '', 'As shipped:', '', confusionTable(looC.blend, 'seed'), '',
    '_The seeds are short and written to be clear-cut, so this is an upper bound, not the real-world number._', '')

  // 2. Real prompts.
  const files = await transcriptFiles()
  const byText = new Map<string, Turn>()
  for (const f of files) {
    for (const t of await readTranscript(f)) {
      const k = t.prompt.replace(/\s+/g, ' ').trim().toLowerCase()
      const old = byText.get(k)
      if (!old || t.ts > old.ts) byText.set(k, t)
    }
  }
  const turns = [...byText.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, MAX_PROMPTS)
  await score('warm up', seeds)
  const rows: Array<Turn & Scored & { tier: Tier }> = []
  for (const t of turns) rows.push({ ...t, ...(await score(t.prompt, seeds)), tier: tierOf(t) })

  const ms = rows.map((r) => r.ms)
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length
  const picks = LABELS.map((l) => [l, count((r) => r.router === l), pct(count((r) => r.router === l) / (rows.length || 1))])
  const sources = ['local-model', 'both', 'rules'].map((s) => [s, count((r) => r.source === s), pct(count((r) => r.source === s) / (rows.length || 1))])
  const tiers: Tier[] = ['light', 'medium', 'heavy']
  const cross = LABELS.map((l) => [l, ...tiers.map((t) => count((r) => r.router === l && r.tier === t))])
  const heavy = count((r) => r.tier === 'heavy')
  const light = count((r) => r.tier === 'light')
  const haikuHeavy = count((r) => r.router === 'haiku' && r.tier === 'heavy')
  const haikuAll = count((r) => r.router === 'haiku')
  const opusLight = count((r) => r.router === 'opus' && r.tier === 'light')
  const opusAll = count((r) => r.router === 'opus')
  const lowSim = count((r) => !r.cls || r.cls.topSim < 0.55)
  const fams = ['opus', 'sonnet', 'haiku'] as const
  const vsUsed = fams.map((f) => [f, ...LABELS.map((l) => count((r) => r.model === f && r.router === l))])
  summary.real = {
    files: files.length, prompts: rows.length, msP50: percentile(ms, 50), msP95: percentile(ms, 95), msMax: Math.max(0, ...ms),
    picks: Object.fromEntries(LABELS.map((l) => [l, count((r) => r.router === l)])),
    heavy, light, haikuOnHeavy: haikuHeavy, haikuPicks: haikuAll, opusOnLight: opusLight, opusPicks: opusAll, unlikeAnySeed: lowSim,
  }
  md.push('## 2. Your real prompts', '',
    `${rows.length} distinct prompts from the newest ${files.length} transcripts.`, '',
    `**Decision time** (embedding + vote, Node, one thread): p50 ${percentile(ms, 50).toFixed(1)} ms, p95 ${percentile(ms, 95).toFixed(1)} ms, max ${Math.max(0, ...ms).toFixed(0)} ms.`, '',
    `**Unlike any seed** (nearest under 0.55, so the word rules decided alone): ${lowSim} (${pct(lowSim / (rows.length || 1))}).`, '',
    table(['router picked', 'prompts', 'share'], picks), '', table(['decided by', 'prompts', 'share'], sources), '',
    `### Against what answering took`, '',
    `Light = at most ${LIGHT_MAX_TOOLS} tool calls and ${LIGHT_MAX_OUT} output tokens; heavy = ${HEAVY_MIN_TOOLS}+ tool calls or ${HEAVY_MIN_OUT}+ output tokens. A stand-in for difficulty, not a label.`, '',
    table(['router picked', 'light', 'medium', 'heavy'], cross), '',
    `- **Risky down-routes:** Haiku picked for a heavy turn: ${haikuHeavy} of ${heavy} heavy turns (${pct(haikuHeavy / (heavy || 1))}); ${pct(haikuHeavy / (haikuAll || 1))} of all Haiku picks.`,
    `- **Likely waste:** Opus picked for a light turn: ${opusLight} of ${light} light turns (${pct(opusLight / (light || 1))}); ${pct(opusLight / (opusAll || 1))} of all Opus picks.`, '',
    '### Against the model that actually ran', '', '_What you had the terminal on, not what was needed._', '',
    table(['ran on \\ router', ...LABELS], vsUsed), '')

  // Every scored prompt, for a closer look (stays in OUT, next to the report).
  await fs.promises.writeFile(path.join(OUT, 'router-eval-rows.csv'), '\uFEFF' + toCsv(
    ['id', 'tier', 'tools', 'out_tokens', 'ran_on', 'position', 'router', 'source', 'confidence', 'top_sim', 'knn', 'rules', 'prompt'],
    rows.map((r) => ({
      id: r.id, tier: r.tier, tools: r.toolCalls, out_tokens: r.outTokens, ran_on: r.model ?? '', position: r.position, router: r.router,
      source: r.source, confidence: r.confidence.toFixed(2), top_sim: r.cls ? r.cls.topSim.toFixed(2) : '', knn: r.knn ?? '', rules: r.rules,
      prompt: r.prompt.slice(0, 300),
    }))))

  // 3. The labelling sheet.
  const header = ['id', 'tier', 'tools', 'out_tokens', 'ran_on', 'router', 'source', 'confidence', 'knn', 'rules', 'your_label', 'prompt']
  if (!fs.existsSync(LABEL_FILE)) {
    const sample = stratified(rows, (r) => `${r.router}`, SAMPLE, 7)
    await fs.promises.writeFile(LABEL_FILE, '\uFEFF' + toCsv(header, sample.map((r) => ({
      id: r.id, tier: r.tier, tools: r.toolCalls, out_tokens: r.outTokens, ran_on: r.model ?? '', router: r.router, source: r.source,
      confidence: r.confidence.toFixed(2), knn: r.knn ?? '', rules: r.rules, your_label: '', prompt: r.prompt.slice(0, CLIP),
    }))))
    md.push('## 3. Labelled accuracy', '', `New labelling sheet: \`${LABEL_FILE}\` (${Math.min(SAMPLE, rows.length)} prompts, spread over the router's picks).`,
      'Fill **your_label** with keep / haiku / sonnet / opus (the cheapest model that would have done it well; keep = a reply like "yes go ahead"), then run again.', '')
  } else {
    const labelled = parseCsv(await fs.promises.readFile(LABEL_FILE, 'utf8')).filter((r) => asLabel(r.your_label) && r.prompt)
    const pairs = { router: [] as Array<[SeedLabel, SeedLabel]>, knn: [] as Array<[SeedLabel, SeedLabel]>, rules: [] as Array<[SeedLabel, SeedLabel]> }
    for (const r of labelled) {
      const truth = asLabel(r.your_label)!
      const s = await score(r.prompt, seeds) // re-scored, so a changed router is measured as it is now
      pairs.router.push([truth, s.router]); pairs.knn.push([truth, s.knn ?? s.rules]); pairs.rules.push([truth, s.rules])
    }
    const c = { router: confusion(pairs.router), knn: confusion(pairs.knn), rules: confusion(pairs.rules) }
    const dir = direction(pairs.router)
    summary.labelled = { n: labelled.length, router: c.router.accuracy, knn: c.knn.accuracy, rules: c.rules.accuracy, under: dir.under, over: dir.over, models: dir.n }
    md.push('## 3. Labelled accuracy', '', `${labelled.length} prompts you labelled in \`${LABEL_FILE}\`.`, '',
      table(['decider', 'accuracy'], [['as shipped', pct(c.router.accuracy)], ['kNN alone', pct(c.knn.accuracy)], ['word rules alone', pct(c.rules.accuracy)]]), '',
      `Where both name a model (${dir.n}): **too weak** ${dir.under} (${pct(dir.under / (dir.n || 1))}), too strong ${dir.over} (${pct(dir.over / (dir.n || 1))}).`, '',
      confusionTable(c.router, 'you'), '')
  }

  await fs.promises.writeFile(path.join(OUT, 'router-eval-report.md'), md.join('\n'))
  await fs.promises.writeFile(path.join(OUT, 'router-eval-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${md.join('\n')}\n\nWritten to ${OUT}`)
}, 3_600_000)
