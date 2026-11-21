// The data an exported world page carries: <script type="application/octet-stream" id="<id>" data-enc="gz64">
// blocks, each gzip then base64, written by the export in main. The browser decodes them itself
// (DecompressionStream), so the page needs no library and makes no request to read its own data.

/** Base64 text to bytes (white space, as a line-wrapped block may hold, is ignored). */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Every chunk a stream gives, joined into one array. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const ignore = (): void => undefined

/** The bytes of block `id`, or null when the page has no such block. A block that is not valid gzip rejects. */
export async function readBlock(id: string): Promise<Uint8Array | null> {
  const el = document.getElementById(id)
  if (!el || el.getAttribute('data-enc') !== 'gz64') return null
  const gz = new DecompressionStream('gzip')
  const writer = gz.writable.getWriter()
  // Not awaited: the writer waits for the reader below, and a broken block rejects that read instead.
  writer.write(fromBase64(String(el.textContent))).catch(ignore)
  writer.close().catch(ignore)
  return readAll(gz.readable)
}

/** Block `id` parsed as UTF-8 JSON, or null when the page has no such block. */
export async function readJsonBlock<T>(id: string): Promise<T | null> {
  const bytes = await readBlock(id)
  return bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as T)
}
