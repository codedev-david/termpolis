// The export runs in Electron's main process, beside every terminal and the typing path: it must never compress
// on that thread. A smart page gzips about 47 MB (the model alone took 717 ms with gzipSync), so every block goes
// through zlib's async gzip, which runs on the libuv threadpool. Here gzipSync throws: a smart export, a keyword
// export, the estimate and the documentation must all still work, and the export must use the async gzip.
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { estimateExportBytes, exportWorld, writeDocument, type ExportAssets, type ExportFs } from '../../src/main/world/export'
import { designWorld, labelledWorld } from '../fixtures/world/docWorlds'

const { gzipCalls } = vi.hoisted(() => ({ gzipCalls: { n: 0 } }))
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>()
  const gzip = ((data: unknown, ...rest: unknown[]) => {
    gzipCalls.n++
    return (real.gzip as (...a: unknown[]) => void)(data, ...rest)
  }) as typeof real.gzip
  const blocked = (): never => { throw new Error('gzipSync blocks the main process: use the async gzip') }
  return { ...real, default: { ...real, gzip, gzipSync: blocked }, gzip, gzipSync: blocked }
})

const HOME = 'C:/Users/someone'
const CTX = { root: `${HOME}/repos/shop`, home: HOME, userData: `${HOME}/AppData/Roaming/Termpolis` }
const ASSETS: ExportAssets = { runtimeJs: 'R:/world-export.js', ortWasm: 'R:/ort.wasm', modelDir: 'M:/bge', modelFile: 'M:/bge/onnx/model.onnx' }

function memFs() {
  const files = new Map<string, Uint8Array>([
    [ASSETS.runtimeJs, Buffer.from('(function(){})()\n')], [ASSETS.ortWasm, new Uint8Array(4096).fill(7)], [ASSETS.modelFile, new Uint8Array(8192).fill(9)],
    ['M:/bge/tokenizer.json', Buffer.from('{"model":{"vocab":{"[PAD]":0}}}')], ['M:/bge/tokenizer_config.json', Buffer.from('{}')],
  ])
  const written = new Map<string, string>()
  const fs: ExportFs = {
    readFile: async (p) => {
      const f = files.get(p.replace(/\\/g, '/'))
      if (!f) throw Object.assign(new Error(p), { code: 'ENOENT' })
      return f
    },
    writeFile: async (p, d) => { written.set(p, String(d)) },
    rename: async (a, b) => { written.set(b, written.get(a) as string); written.delete(a) },
    rm: async (p) => { written.delete(p) },
    stat: async (p) => ({ size: Buffer.byteLength(written.get(p) as string) }),
  }
  return { fs, written }
}

const embed = async (texts: string[]): Promise<number[][]> => texts.map((_, i) => Array.from({ length: 384 }, (__, k) => (k === i % 384 ? 1 : 0)))

describe('the export never calls gzipSync', () => {
  it('a smart and a keyword export write their pages through the async gzip', async () => {
    for (const smart of [true, false]) {
      const { fs, written } = memFs()
      gzipCalls.n = 0
      const r = await exportWorld(
        { doc: labelledWorld(), ctx: CTX, title: 'Shop', smart, target: 'D:/Shop.html', exportedOn: '2026-11-21' },
        { assets: ASSETS, embed, fs, signal: new AbortController().signal, progress: () => undefined },
      )
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(gzipCalls.n).toBe(smart ? 7 : 3)
      const world = /id="world" data-enc="gz64">([^<]*)</.exec(written.get('D:/Shop.html') as string)![1]
      expect(JSON.parse(gunzipSync(Buffer.from(world, 'base64')).toString('utf8')).buildings.length).toBe(labelledWorld().buildings.length)
    }
  })

  it('the estimate and the documentation also work without it', async () => {
    gzipCalls.n = 0
    expect(await estimateExportBytes({ doc: designWorld(), ctx: { ...CTX, root: null }, title: 'Shop design', smart: true })).toBeGreaterThan(36_000_000)
    expect(gzipCalls.n).toBe(3)
    const { fs, written } = memFs()
    expect((await writeDocument({ doc: labelledWorld(), ctx: CTX, title: 'Shop', target: 'D:/Doc.html', generatedOn: '2026-11-21' }, fs)).ok).toBe(true)
    expect(written.get('D:/Doc.html')).toContain('How Shop works')
  })
})
