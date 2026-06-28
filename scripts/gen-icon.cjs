// Generate a multi-size Windows .ico from assets/icon.png using sharp (already a
// dependency). The previous assets/icon.ico held a SINGLE 256px PNG-compressed
// entry, so Windows had no small representation to show at taskbar/Explorer sizes
// (16/24/32/48) and fell back to a generic/blurry icon. This emits a proper
// multi-size icon with PNG-compressed entries (valid on Windows Vista+), which is
// what electron-builder stamps onto the exe + Start-menu/taskbar shortcut.
//
// Run: node scripts/gen-icon.cjs   (also wired as the "gen:icon" npm script)

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SRC = path.join(__dirname, '..', 'assets', 'icon.png')
const OUT = path.join(__dirname, '..', 'assets', 'icon.ico')

async function main() {
  const pngs = await Promise.all(
    SIZES.map((s) =>
      sharp(SRC)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  )

  // ICONDIR header (6 bytes)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // image type: 1 = icon
  header.writeUInt16LE(SIZES.length, 4) // number of images

  const entries = []
  let offset = 6 + 16 * SIZES.length // image data starts after dir entries
  for (let i = 0; i < SIZES.length; i++) {
    const s = SIZES[i]
    const png = pngs[i]
    const e = Buffer.alloc(16) // ICONDIRENTRY
    e.writeUInt8(s >= 256 ? 0 : s, 0) // width  (0 means 256)
    e.writeUInt8(s >= 256 ? 0 : s, 1) // height (0 means 256)
    e.writeUInt8(0, 2) // palette colors (0 = no palette)
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8) // size of image data
    e.writeUInt32LE(offset, 12) // offset of image data from file start
    entries.push(e)
    offset += png.length
  }

  const ico = Buffer.concat([header, ...entries, ...pngs])
  fs.writeFileSync(OUT, ico)
  console.log(`Wrote ${OUT}: ${SIZES.length} sizes (${SIZES.join(', ')}), ${ico.length} bytes`)
}

main().catch((err) => {
  console.error('gen-icon failed:', err)
  process.exit(1)
})
