import path from 'node:path'

/** The project folder: Playwright runs from it (as the app's e2e specs assume, path.resolve('.')). */
export const ROOT = path.resolve('.')
/** Where globalSetup writes the exported fixture world. Outside the config's outputDir, which Playwright empties. */
export const FIXTURE_DIR = path.join(ROOT, 'test-results', 'export-fixture')
export const SMART_HTML = path.join(FIXTURE_DIR, 'smart.html')
export const KEYWORD_HTML = path.join(FIXTURE_DIR, 'keyword.html')
export const DOCUMENT_HTML = path.join(FIXTURE_DIR, 'document.html')
export const FIXTURE_JSON = path.join(ROOT, 'tests', 'fixtures', 'world', 'termpolis.world.json')
export const QUESTIONS_JSON = path.join(ROOT, 'tests', 'fixtures', 'world', 'askQuestions.json')
