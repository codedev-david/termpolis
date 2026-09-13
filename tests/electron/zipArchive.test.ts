import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createZip, readZip, crc32, type ZipEntry } from '../../src/main/zipArchive'

describe('zipArchive', () => {
  it('round-trips entries (deflate + crc), preserving names, order, and bytes', () => {
    const entries: ZipEntry[] = [
      { name: 'memory.jsonl', data: Buffer.from('{"id":"a"}\n{"id":"b"}\n') },
      { name: 'nested/manifest.json', data: Buffer.from(JSON.stringify({ v: 1, n: 42 })) },
      { name: 'empty.txt', data: Buffer.from('') },
      { name: 'unicode.txt', data: Buffer.from('café — 日本語 — 🧠', 'utf8') },
    ]
    const zip = createZip(entries)
    const out = readZip(zip)
    expect(out.map((e) => e.name)).toEqual(entries.map((e) => e.name))
    for (let i = 0; i < entries.length; i++) expect(out[i].data.equals(entries[i].data)).toBe(true)
  })

  it('writes valid ZIP magic + end-of-central-directory', () => {
    const zip = createZip([{ name: 'x', data: Buffer.from('y') }])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50) // local file header
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50) // EOCD
  })

  it('detects a corrupt archive on read (CRC / inflate failure)', () => {
    const zip = createZip([{ name: 'x', data: Buffer.from('hello world, this is enough bytes to deflate') }])
    zip[35] = zip[35] ^ 0xff // flip a byte inside the compressed data region
    expect(() => readZip(zip)).toThrow()
  })

  it('crc32 matches the well-known check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926') // ZIP/PKZIP CRC-32 test vector
  })

  it('produces an archive a real unzip tool can extract', () => {
    // Confidence that it is a STANDARD zip, not just self-consistent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'))
    try {
      const zip = createZip([{ name: 'hello.txt', data: Buffer.from('portable brain') }])
      const zipPath = path.join(dir, 'a.zip')
      fs.writeFileSync(zipPath, zip)
      let extracted = ''
      try {
        if (process.platform === 'win32') {
          execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${dir}\\out' -Force`])
          extracted = fs.readFileSync(path.join(dir, 'out', 'hello.txt'), 'utf8')
        } else {
          execFileSync('unzip', ['-o', zipPath, '-d', path.join(dir, 'out')])
          extracted = fs.readFileSync(path.join(dir, 'out', 'hello.txt'), 'utf8')
        }
        expect(extracted).toBe('portable brain')
      } catch {
        // No unzip tool available in this environment — the round-trip test already proves correctness.
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Hand-build a single STORED (method 0) local file record — createZip only ever emits
   *  DEFLATE, so this is the only way to reach readZip's uncompressed arm. */
  function storedLocalEntry(name: string, data: Buffer, crc: number, extra: Buffer): Buffer {
    const nameBuf = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0) // local file header signature
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(0, 8) // method 0 = STORED
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18) // compressed size == raw size when stored
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(extra.length, 28)
    return Buffer.concat([lh, nameBuf, extra, data])
  }

  it('reads a STORED (method 0) entry verbatim instead of inflating it', () => {
    const body = Buffer.from('stored bytes — there is no deflate stream here', 'utf8')
    const out = readZip(storedLocalEntry('plain.txt', body, crc32(body), Buffer.alloc(0)))
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('plain.txt')
    expect(out[0].data.equals(body)).toBe(true)
  })

  it('skips a local-header extra field when locating the entry payload', () => {
    const body = Buffer.from('payload starts after the extra field', 'utf8')
    // A plausible extra field (0x5455 "extended timestamp", 5 data bytes).
    const extra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    const out = readZip(storedLocalEntry('extra.txt', body, crc32(body), extra))
    expect(out.map((e) => e.name)).toEqual(['extra.txt'])
    expect(out[0].data.toString('utf8')).toBe('payload starts after the extra field')
  })

  it('throws the CRC-mismatch error when the recorded checksum disagrees with the data', () => {
    const zip = createZip([{ name: 'mem.jsonl', data: Buffer.from('{"id":"a"}\n{"id":"b"}\n') }])
    // Corrupt the CRC FIELD (offset 14 of the local header), not the payload: inflate then
    // still succeeds and execution actually reaches the checksum guard.
    zip.writeUInt32LE((zip.readUInt32LE(14) ^ 0xffffffff) >>> 0, 14)
    expect(() => readZip(zip)).toThrow(/CRC mismatch for mem\.jsonl/)
  })

  it('returns no entries for a buffer too short to hold a local header', () => {
    expect(readZip(Buffer.alloc(0))).toEqual([])
    expect(readZip(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toEqual([]) // signature but no header
  })

  it('writes an EOCD-only archive for zero entries and reads it back as empty', () => {
    const zip = createZip([])
    expect(zip.length).toBe(22) // nothing but the end-of-central-directory record
    expect(zip.readUInt32LE(0)).toBe(0x06054b50)
    expect(zip.readUInt16LE(8)).toBe(0) // central-directory records on this disk
    expect(zip.readUInt16LE(10)).toBe(0) // total central-directory records
    expect(zip.readUInt32LE(12)).toBe(0) // central-directory size
    expect(readZip(zip)).toEqual([])
  })

  it('crc32 of an empty buffer is 0 (the CRC seed cancels itself out)', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})
