#!/usr/bin/env node
/**
 * Generates the multi-sized PNG icons electron-builder needs for the
 * Linux .deb target. A single icon.png isn't enough — .deb installs
 * the icon under /usr/share/icons/hicolor/<size>/apps/termpolis.png and
 * the desktop entry can only resolve to whichever sizes are actually
 * present. If they're missing, GNOME / KDE fall back to a generic
 * "executable" icon (or no icon at all), which is what users saw on
 * Ubuntu after dpkg-installing termpolis_<ver>_amd64.deb.
 *
 * Run via:  node scripts/generateLinuxIcons.cjs
 *
 * Outputs build/icons/{16,32,48,64,128,256,512}x{N}.png from
 * assets/icon.png (which is 512×512). Idempotent — safe to commit
 * the generated PNGs and re-run only when the source icon changes.
 */

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const SIZES = [16, 32, 48, 64, 128, 256, 512]
const SOURCE = path.join(__dirname, '..', 'assets', 'icon.png')
const OUT_DIR = path.join(__dirname, '..', 'build', 'icons')

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`generateLinuxIcons: source not found: ${SOURCE}`)
    process.exit(1)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const size of SIZES) {
    const outPath = path.join(OUT_DIR, `${size}x${size}.png`)
    await sharp(SOURCE).resize(size, size, { fit: 'contain' }).png().toFile(outPath)
    console.log(`wrote ${path.relative(process.cwd(), outPath)}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
