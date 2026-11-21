// The exported page's data blocks: gzip then base64, decoded in the browser with DecompressionStream.
import { gzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readBlock, readJsonBlock } from '../../../src/world-export/blocks'
import { addBlock, ensureDecompressionStream } from './helpers'

beforeAll(ensureDecompressionStream)
afterEach(() => { document.body.innerHTML = '' })

describe('readBlock', () => {
  it('round-trips a block made with gzipSync and then base64', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256)
    addBlock('model', bytes)
    expect(Array.from((await readBlock('model')) as Uint8Array)).toEqual(Array.from(bytes))
  })

  it('reads a base64 block that is wrapped over several lines', async () => {
    const el = document.createElement('script')
    el.type = 'application/octet-stream'
    el.id = 'meta'
    el.setAttribute('data-enc', 'gz64')
    el.textContent = '\n' + (Buffer.from(gzipSync(Buffer.from('hello world'))).toString('base64').match(/.{1,8}/g) as string[]).join('\n  ') + '\n'
    document.body.appendChild(el)
    expect(new TextDecoder().decode((await readBlock('meta')) as Uint8Array)).toBe('hello world')
  })

  it('returns null for a missing id', async () => {
    expect(await readBlock('nothing-here')).toBeNull()
    expect(await readJsonBlock('nothing-here')).toBeNull()
  })

  it('returns null for an element that is not a gz64 block', async () => {
    addBlock('world', { a: 1 }, 'plain')
    expect(await readBlock('world')).toBeNull()
  })

  it('rejects a block that is not gzip', async () => {
    const el = document.createElement('script')
    el.type = 'application/octet-stream'
    el.id = 'bad'
    el.setAttribute('data-enc', 'gz64')
    el.textContent = Buffer.from('not gzip at all').toString('base64')
    document.body.appendChild(el)
    await expect(readBlock('bad')).rejects.toBeTruthy()
  })
})

describe('readJsonBlock', () => {
  it('parses a JSON block as UTF-8', async () => {
    addBlock('meta', { project: 'Café ✓', head7: 'abc1234' })
    expect(await readJsonBlock('meta')).toEqual({ project: 'Café ✓', head7: 'abc1234' })
  })
})
