// zipArchive.ts — a tiny, dependency-free ZIP reader/writer for the brain export/import.
//
// Native-free: DEFLATE comes from Node's built-in zlib; the CRC32 and the ZIP container
// (local file headers + central directory + end-of-central-directory) are written by hand, so
// there is no new dependency and no native module. The output is a standard .zip that Finder /
// Explorer open, and readZip validates each entry's CRC so a corrupt archive can never silently
// restore garbage into your brain. Reader scans local file headers (we only read our own zips).

import { deflateRawSync, inflateRawSync } from 'zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const LOCAL_SIG = 0x04034b50 // PK\x03\x04
const CENTRAL_SIG = 0x02014b50 // PK\x01\x02
const EOCD_SIG = 0x06054b50 // PK\x05\x06
const METHOD_DEFLATE = 8

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

/** Build a standard (DEFLATE) .zip from entries. Deterministic — no timestamps embedded. */
export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = e.data
    const comp = deflateRawSync(raw)
    const crc = crc32(raw)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(LOCAL_SIG, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(METHOD_DEFLATE, 8)
    lh.writeUInt16LE(0, 10) // mod time (fixed → reproducible archives)
    lh.writeUInt16LE(0, 12) // mod date
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28) // extra len
    locals.push(lh, nameBuf, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(CENTRAL_SIG, 0)
    ch.writeUInt16LE(20, 4) // version made by
    ch.writeUInt16LE(20, 6) // version needed
    ch.writeUInt16LE(0, 8) // flags
    ch.writeUInt16LE(METHOD_DEFLATE, 10)
    ch.writeUInt16LE(0, 12) // time
    ch.writeUInt16LE(0, 14) // date
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30) // extra len
    ch.writeUInt16LE(0, 32) // comment len
    ch.writeUInt16LE(0, 34) // disk number
    ch.writeUInt16LE(0, 36) // internal attrs
    ch.writeUInt32LE(0, 38) // external attrs
    ch.writeUInt32LE(offset, 42) // local header offset
    centrals.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + comp.length
  }

  const localBuf = Buffer.concat(locals)
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // cd start disk
  eocd.writeUInt16LE(entries.length, 8) // cd records this disk
  eocd.writeUInt16LE(entries.length, 10) // total cd records
  eocd.writeUInt32LE(cdBuf.length, 12) // cd size
  eocd.writeUInt32LE(localBuf.length, 16) // cd offset (= size of all local records)
  eocd.writeUInt16LE(0, 20) // comment len
  return Buffer.concat([localBuf, cdBuf, eocd])
}

/** Read a .zip produced by createZip (scans local file headers). Throws on a CRC mismatch. */
export function readZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  let p = 0
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === LOCAL_SIG) {
    const method = buf.readUInt16LE(p + 8)
    const crc = buf.readUInt32LE(p + 14)
    const compSize = buf.readUInt32LE(p + 18)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8')
    const dataStart = p + 30 + nameLen + extraLen
    const comp = buf.slice(dataStart, dataStart + compSize)
    const data = method === METHOD_DEFLATE ? inflateRawSync(comp) : comp
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name} — archive is corrupt`)
    entries.push({ name, data })
    p = dataStart + compSize
  }
  return entries
}
