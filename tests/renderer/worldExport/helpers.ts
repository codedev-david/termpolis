// Shared bits for the exported page's runtime tests: page blocks written the way the export writes them
// (gzip, then base64, in a <script type="application/octet-stream" data-enc="gz64">), and DecompressionStream
// from Node's web streams when jsdom does not give one.
import { gzipSync } from 'node:zlib'
import * as webStreams from 'node:stream/web'

export function ensureDecompressionStream(): void {
  const g = globalThis as { DecompressionStream?: unknown }
  if (typeof g.DecompressionStream !== 'function') g.DecompressionStream = webStreams.DecompressionStream
}

/** Adds block `id` to the page, holding `bytes` (or the JSON text of a value). */
export function addBlock(id: string, data: Uint8Array | object, enc = 'gz64'): HTMLScriptElement {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data))
  const el = document.createElement('script')
  el.type = 'application/octet-stream'
  el.id = id
  el.setAttribute('data-enc', enc)
  el.textContent = Buffer.from(gzipSync(bytes)).toString('base64')
  document.body.appendChild(el)
  return el
}
