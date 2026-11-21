// Exports the fixture world once, through the app's own export code and real embedder, to the three files every
// export-page spec opens: test-results/export-fixture/smart.html (smart Ask: vectors, tokenizer, ORT wasm, model),
// keyword.html (keyword Ask only) and document.html (the documentation file). It needs the page runtime
// (npm run build:world-viewer) and the bge-small model in resources/models (scripts/download-embedding-model.sh);
// without either it stops here with a message, rather than every spec failing on a missing file.
import { mkdirSync, readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { exportWorld, resolveExportAssets, writeDocument, type ExportResult } from '../../src/main/world/export'
import { embedBatch } from '../../src/main/localEmbedder'
import type { SanitizeContext } from '../../src/shared/world/exportSanitize'
import type { WorldDoc } from '../../src/shared/world/types'
import { DOCUMENT_HTML, FIXTURE_DIR, FIXTURE_JSON, KEYWORD_HTML, ROOT, SMART_HTML } from './paths'

const HOME = '/home/demo'
const CTX: SanitizeContext = { root: `${HOME}/repos/termpolis`, home: HOME, userData: `${HOME}/.config/termpolis` }
const TITLE = 'Termpolis'
const ON = '2026-11-21'

const must = (what: string, r: ExportResult): void => {
  if (!r.ok) throw new Error(`export-page setup: the ${what} could not be written: ${r.error}`)
}

export default async function globalSetup(): Promise<void> {
  const found = resolveExportAssets({ appPath: ROOT })
  if ('missing' in found && found.missing === 'runtime') throw new Error('export-page setup: dist-world/world-export.js is missing. Run npm run build:world-viewer first.')
  if ('missing' in found) throw new Error('export-page setup: the bge-small model is missing from resources/models. Run bash scripts/download-embedding-model.sh first.')
  const doc = JSON.parse(readFileSync(FIXTURE_JSON, 'utf8')) as WorldDoc
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const deps = { assets: found.assets, embed: (t: string[]) => embedBatch(t), fs: fsp, signal: new AbortController().signal, progress: () => undefined }
  must('smart page', await exportWorld({ doc, ctx: CTX, title: TITLE, smart: true, target: SMART_HTML, exportedOn: ON }, deps))
  must('keyword page', await exportWorld({ doc, ctx: CTX, title: TITLE, smart: false, target: KEYWORD_HTML, exportedOn: ON }, deps))
  must('documentation', await writeDocument({ doc, ctx: CTX, title: TITLE, target: DOCUMENT_HTML, generatedOn: ON }, fsp))
}
