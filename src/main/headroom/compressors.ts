import { compactText } from './compactText'
import type { Thresholds } from './config'

export interface Compressed { text: string; offload?: unknown }

export function compressArray(arr: unknown[], t: Thresholds): Compressed {
  const kept = arr.slice(0, t.topK).map(x => JSON.stringify(x)).join('\n')
  if (arr.length <= t.topK) return { text: kept }
  const elided = arr.length - t.topK
  return { text: `${kept}\n… (${elided} more items elided)`, offload: arr }
}

export function compressObject(obj: Record<string, unknown>, t: Thresholds): Compressed {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > t.maxFieldChars) {
      const c = compactText(v, { headLines: t.headLines, tailLines: t.tailLines, maxChars: t.maxFieldChars })
      out[k] = c.text
      if (c.elided) changed = true
    } else if (Array.isArray(v) && v.length > t.topK) {
      out[k] = [...v.slice(0, t.topK), `… (${v.length - t.topK} more elided)`]
      changed = true
    } else {
      out[k] = v
    }
  }
  const text = JSON.stringify(out)
  return changed ? { text, offload: obj } : { text }
}
