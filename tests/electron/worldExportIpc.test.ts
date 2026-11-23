// The export and documentation requests in main (src/main/world/exportIpc.ts): the renderer names a world (a folder
// or a design key) and main loads the saved world itself, titles it the way the World pane does, builds the
// sanitiser's context from its own folders, asks where to save, and exports through Task 9's assembler. Show in
// folder and Open take only a file this session exported or documented. The file system is in memory and the
// export assets are fakes; the assembler, the estimate and the sanitiser are the real ones.
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  ALREADY_RUNNING, DOCUMENT_FAILED, EXPORT_FAILED, KEYWORD_ONLY, NO_SAVED_WORLD, NOT_EXPORTABLE, NOT_EXPORTED, OPEN_FAILED, WHOLE_DESIGN, WORLD_REQUIRED,
  defaultSaveName, registerWorldExportIpc, type WorldExportDeps,
} from '../../src/main/world/exportIpc'
import { describedShare, estimateExportBytes, NO_MODEL, NO_PROPOSAL, NO_RUNTIME, NO_SPACE, NOT_DOCUMENTABLE, type ExportAssets, type ExportFs } from '../../src/main/world/export'
import { DESIGN_NOT_FOUND } from '../../src/main/world/designer'
import { ok, err } from '../../src/main/ipcResult'
import type { WorldDoc, WorldEntry } from '../../src/shared/world/types'
import { describedWorld, designWorld, labelledWorld, linkedDesignWorld } from '../fixtures/world/docWorlds'

const HOME = 'C:\\Users\\someone'
const USER_DATA = `${HOME}\\AppData\\Roaming\\Termpolis`
const ROOT = `${HOME}\\repos\\shop`
const CLONE = `${USER_DATA}\\world\\repos\\9f2c`
const LINKED = `${HOME}\\repos\\orders`
const DESCRIBED = `${HOME}\\repos\\described`
const BROKEN = `${HOME}\\repos\\broken`
const DESIGN = 'design:7f3a'
const DOCS = `${HOME}\\Documents`

const ASSETS: ExportAssets = { runtimeJs: 'R:/world-export.js', ortWasm: 'R:/ort.wasm', modelDir: 'M:/bge', modelFile: 'M:/bge/model.onnx' }
const KEYWORD_ASSETS: ExportAssets = { ...ASSETS, modelDir: '', modelFile: '' }

const ENTRIES: WorldEntry[] = [
  { key: DESIGN, source: { kind: 'design', id: '7f3a', title: 'Shop design' }, title: 'Shop design', lastOpened: 4 },
  { key: 'kg', source: { kind: 'git', url: 'https://example.com/acme/shop.git', root: CLONE }, title: 'acme-shop', lastOpened: 3 },
  { key: 'kf', source: { kind: 'folder', root: ROOT }, title: 'A title the pane does not show', lastOpened: 2 },
]

/** The labelled world, with a claim naming a file by its full path and the home folder in a line label. */
function shopWorld(): WorldDoc {
  const doc = labelledWorld()
  doc.buildings[0].how = [{ text: `Opens ${ROOT}\\src\\main\\index.ts first.`, state: 'observed', evidence: [{ kind: 'file', ref: 'src/main/index.ts' }] }]
  doc.edges[2].label = `env HOME=${HOME}\\notes`
  return doc
}
const broken = (): WorldDoc => ({ ...labelledWorld(), edges: 7 }) as unknown as WorldDoc

/** A file system in memory: the export's own files, and what it writes. */
function memFs(over: { write?: Error } = {}) {
  const files = new Map<string, Uint8Array>([
    [ASSETS.runtimeJs, Buffer.from('(function(){window.__exported=1})()\n')],
    [ASSETS.ortWasm, new Uint8Array(64).fill(7)],
    [ASSETS.modelFile, new Uint8Array(128).fill(9)],
    [join(ASSETS.modelDir, 'tokenizer.json'), Buffer.from('{"model":{"vocab":{"a":0}}}')],
    [join(ASSETS.modelDir, 'tokenizer_config.json'), Buffer.from('{}')],
  ])
  const written = new Map<string, string>()
  const fs: ExportFs = {
    readFile: vi.fn(async (p: string) => {
      const f = files.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return f
    }),
    writeFile: vi.fn(async (p: string, data: string | Uint8Array) => {
      if (over.write) throw over.write
      written.set(p, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    }),
    rename: vi.fn(async (from: string, to: string) => {
      written.set(to, written.get(from) as string)
      written.delete(from)
    }),
    rm: vi.fn(async (p: string) => { written.delete(p) }),
    stat: vi.fn(async (p: string) => ({ size: Buffer.byteLength(written.get(p) as string, 'utf8') })),
  }
  return { fs, written }
}

const vector = (): number[] => Array.from({ length: 384 }, (_, i) => ((i % 7) - 3) / 10)

type Handler = (e: unknown, args?: unknown) => Promise<unknown> | unknown

function setup(over: Partial<WorldExportDeps> & { mem?: ReturnType<typeof memFs> } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc = { handle: vi.fn((ch: string, fn: Handler) => { handlers.set(ch, fn) }) }
  const mem = over.mem ?? memFs()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const worlds: Record<string, () => WorldDoc> = { [ROOT]: shopWorld, [CLONE]: labelledWorld, [LINKED]: linkedDesignWorld, [DESCRIBED]: () => describedWorld(10, 10, 10, 10), [BROKEN]: broken }
  const deps: WorldExportDeps = {
    getWorld: vi.fn(async (root: string) => worlds[root]?.() ?? null),
    loadDesign: vi.fn(async (key: string) => (key === DESIGN ? designWorld() : null)),
    entries: vi.fn(async () => ENTRIES),
    saveDialog: vi.fn(async (defaultPath: string) => defaultPath),
    documentsDir: vi.fn(() => DOCS),
    homeDir: HOME,
    userDataDir: USER_DATA,
    assets: vi.fn(() => ({ assets: ASSETS })),
    embed: vi.fn(async (texts: string[]) => texts.map(vector)),
    fs: mem.fs,
    send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload: payload as Record<string, unknown> }) }),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ''),
    platform: 'win32',
    now: () => new Date(2026, 10, 21, 9, 30),
    ...over,
  }
  registerWorldExportIpc(ipc, deps)
  const call = (channel: string, args?: unknown): Promise<any> => Promise.resolve((handlers.get(channel) as Handler)({}, args))
  return { deps, mem, sent, call, handlers }
}

const ctxFor = (root: string | null) => ({ root, home: HOME, userData: USER_DATA })
/** A real PNG's first bytes (its eight-byte signature and the IHDR chunk's start), as a data URL. */
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const pngUrl = (bytes: Uint8Array = PNG_HEAD): string => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

describe('defaultSaveName', () => {
  it('names a world page and a documentation file after the title', () => {
    expect(defaultSaveName('Shop', 'world')).toBe('Shop - Lumopolis.html')
    expect(defaultSaveName('Shop', 'document')).toBe('Shop - Lumopolis documentation.html')
  })

  it('turns the characters a file name cannot hold, and control characters, into dashes', () => {
    expect(defaultSaveName('a/b: c?', 'world')).toBe('a-b- c- - Lumopolis.html')
    expect(defaultSaveName('x\\y*z"<>|\u0001\u007f', 'world')).toBe('x-y-z------ - Lumopolis.html')
  })

  it('names an empty title Lumopolis and keeps the stem to 120 characters', () => {
    expect(defaultSaveName('', 'world')).toBe('Lumopolis - Lumopolis.html')
    expect(defaultSaveName('   ', 'document')).toBe('Lumopolis - Lumopolis documentation.html')
    const name = defaultSaveName('x'.repeat(300), 'world')
    expect(name.replace(' - Lumopolis.html', '')).toHaveLength(120)
  })

  it('counts the 120 by characters, so an emoji at the boundary is kept whole, never split', () => {
    const stem = defaultSaveName(`${'x'.repeat(119)}\u{1F600}\u{1F600}tail`, 'world').replace(' - Lumopolis.html', '')
    expect(stem).toBe(`${'x'.repeat(119)}\u{1F600}`)
    expect(Array.from(stem)).toHaveLength(120)
    expect(stem).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('turns the text-direction controls into dashes, so a name cannot show reversed', () => {
    expect(defaultSaveName('report\u202Eexe.html', 'world')).toBe('report-exe.html - Lumopolis.html')
    expect(defaultSaveName('a\u202Ab\u202Bc\u202Cd\u202De\u2066f\u2067g\u2068h\u2069i', 'world')).toBe('a-b-c-d-e-f-g-h-i - Lumopolis.html')
  })
})

describe('registerWorldExportIpc', () => {
  it('registers the export, cancel, document, show and open channels', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(['world:document', 'world:document-cancel', 'world:export', 'world:export-cancel', 'world:export-info', 'world:open-file', 'world:show-file'])
  })
})

describe('world:export-info', () => {
  it("answers a code world's title as the pane shows it, when it was saved, its sizes and its proposals", async () => {
    const { call, deps } = setup()
    const doc = shopWorld()
    const share = describedShare(doc)
    const keywordBytes = await estimateExportBytes({ doc, ctx: ctxFor(ROOT), title: 'shop', smart: false })
    const smartBytes = await estimateExportBytes({ doc, ctx: ctxFor(ROOT), title: 'shop', smart: true })
    expect(await call('world:export-info', { root: ROOT })).toEqual(ok({
      title: 'shop', savedAt: doc.generatedAt, smartDefault: share.smartDefault, buildings: share.buildings, lines: share.lines,
      smartBytes, keywordBytes, smartAvailable: true, proposals: [],
    }))
    expect(deps.getWorld).toHaveBeenCalledWith(ROOT)
  })

  it('names a cloned repository by its registry title, and lists the proposals of a code world', async () => {
    const { call } = setup()
    expect((await call('world:export-info', { root: CLONE })).data.title).toBe('acme-shop')
    expect((await call('world:export-info', { root: LINKED })).data.proposals).toEqual([{ id: 'p1', title: 'Shop design' }, { id: 'p2', title: 'Retire the export' }])
  })

  it('names a design by its title, lists no proposals (a design exports whole) and sizes it with no folder', async () => {
    const { call, deps } = setup()
    const doc = designWorld()
    const keywordBytes = await estimateExportBytes({ doc, ctx: ctxFor(null), title: 'Shop design', smart: false })
    const res = await call('world:export-info', { designKey: DESIGN })
    expect(res.data).toMatchObject({ title: 'Shop design', proposals: [], keywordBytes })
    expect(deps.loadDesign).toHaveBeenCalledWith(DESIGN)
  })

  it('starts smart Ask on for a world described enough, and off when the model is missing (keyword stays possible)', async () => {
    expect((await setup().call('world:export-info', { root: DESCRIBED })).data).toMatchObject({ smartDefault: true, smartAvailable: true, buildings: 1, lines: 1 })
    const missing = setup({ assets: () => ({ missing: 'model', assets: KEYWORD_ASSETS }) })
    const res = await missing.call('world:export-info', { root: DESCRIBED })
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ smartDefault: false, smartAvailable: false })
    expect(res.data.keywordBytes).toBeGreaterThan(0)
  })

  it('refuses honestly when the runtime is missing or the world would not export', async () => {
    expect(await setup({ assets: () => ({ missing: 'runtime' }) }).call('world:export-info', { root: ROOT })).toEqual(err(NO_RUNTIME))
    expect(await setup().call('world:export-info', { root: BROKEN })).toEqual(err(NOT_EXPORTABLE))
  })

  it('titles the world by its folder when the recent worlds cannot be read', async () => {
    const { call } = setup({ entries: vi.fn(async () => { throw new Error('disk') }) })
    expect((await call('world:export-info', { root: CLONE })).data.title).toBe('9f2c')
  })

  it.each([
    ['nothing', undefined, WORLD_REQUIRED],
    ['a string', 'C:/x', WORLD_REQUIRED],
    ['an empty object', {}, WORLD_REQUIRED],
    ['both a folder and a design', { root: ROOT, designKey: DESIGN }, WORLD_REQUIRED],
    ['a number for the folder', { root: 7 }, WORLD_REQUIRED],
    ['an empty folder', { root: '  ' }, WORLD_REQUIRED],
    ['a relative folder', { root: 'repos/shop' }, WORLD_REQUIRED],
    ['an endless folder', { root: `C:\\${'x'.repeat(5000)}` }, WORLD_REQUIRED],
    ['a folder with no saved world', { root: `${HOME}\\repos\\other` }, NO_SAVED_WORLD],
    ['a number for the design', { designKey: 7 }, DESIGN_NOT_FOUND],
    ['a design key that is not one', { designKey: 'design:../x' }, DESIGN_NOT_FOUND],
    ['an endless design key', { designKey: `design:${'a'.repeat(300)}` }, DESIGN_NOT_FOUND],
    ['a design that is not stored', { designKey: 'design:gone' }, DESIGN_NOT_FOUND],
  ])('refuses %s with an honest sentence and never throws', async (_what, args, message) => {
    const { call } = setup()
    expect(await call('world:export-info', args)).toEqual(err(message))
  })

  it('a first map drawn from the listing is not a saved world: nothing is exported from it (fix round 1, I1)', async () => {
    const { call } = setup({ getWorld: vi.fn(async () => ({ ...shopWorld(), provisional: true })) })
    expect(await call('world:export-info', { root: ROOT })).toEqual(err(NO_SAVED_WORLD))
  })

  it('answers a fixed sentence when the world cannot be read', async () => {
    const { call } = setup({ getWorld: vi.fn(async () => { throw new Error('EIO raw detail') }) })
    const res = await call('world:export-info', { root: ROOT })
    expect(res.success).toBe(false)
    expect(res.error).not.toContain('EIO')
  })
})

describe('world:export', () => {
  const page = (mem: ReturnType<typeof memFs>, path: string): string => mem.written.get(path) as string
  const block = (html: string, id: string): string => {
    const m = new RegExp(`id="${id}" data-enc="gz64">([^<]*)<`).exec(html) as RegExpExecArray
    return gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8')
  }

  it('loads the saved world (never renderer state), asks where to save in Documents, and answers the path and size', async () => {
    const { call, deps, mem } = setup()
    const target = join(DOCS, 'shop - Lumopolis.html')
    const res = await call('world:export', { exportId: 'x1', root: ROOT, smart: false, doc: { projectKey: 'renderer-made' }, title: 'Renderer title' })
    expect(deps.getWorld).toHaveBeenCalledWith(ROOT)
    expect(deps.saveDialog).toHaveBeenCalledWith(target)
    expect(res).toEqual(ok({ path: target, bytes: Buffer.byteLength(page(mem, target), 'utf8') }))
    const html = page(mem, target)
    expect(html).toContain('<title>shop · Lumopolis</title>')
    expect(html).not.toContain('Renderer title')
    expect(JSON.parse(block(html, 'meta'))).toMatchObject({ project: 'shop', exportedOn: '2026-11-21' })
    // the sanitiser's context is main's own: the project folder and the home folder never leave
    const world = block(html, 'world')
    expect(world).not.toMatch(/someone/i)
    expect(world).toContain('src')
  })

  it('a cancelled save dialog answers cancelled and writes nothing', async () => {
    const { call, mem } = setup({ saveDialog: vi.fn(async () => null) })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(ok({ cancelled: true }))
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
  })

  it('a cancel while the world loads answers cancelled and never opens the save dialog', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const getWorld = vi.fn(async (root: string) => { await gate; return root === ROOT ? shopWorld() : null })
    const testSave = vi.fn(async () => undefined)
    const { call, deps, mem } = setup({ getWorld, testSave })
    const pending = call('world:export', { exportId: 'x1', root: ROOT, smart: true })
    expect(await call('world:export-cancel', { exportId: 'x1' })).toEqual(ok(true))
    release()
    expect(await pending).toEqual(ok({ cancelled: true }))
    expect(testSave).not.toHaveBeenCalled()
    expect(deps.saveDialog).not.toHaveBeenCalled()
    expect(mem.fs.readFile).not.toHaveBeenCalled()
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
  })

  it('a cancel while the save dialog is open answers cancelled once it closes, reading no assets and writing nothing', async () => {
    let cancel: () => Promise<unknown> = async () => undefined
    const saveDialog = vi.fn(async (defaultPath: string) => { await cancel(); return defaultPath })
    const { call, mem } = setup({ saveDialog })
    cancel = () => call('world:export-cancel', { exportId: 'x1' })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: true })).toEqual(ok({ cancelled: true }))
    expect(saveDialog).toHaveBeenCalledTimes(1)
    expect(mem.fs.readFile).not.toHaveBeenCalled()
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
    expect(mem.written.size).toBe(0)
  })

  it('a chosen name without .html gets it, so Open always opens a web page; .HTML in any case is kept', async () => {
    const bat = setup({ testSave: vi.fn(async () => 'D:\\out\\name.bat') })
    const res = await bat.call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(res.data.path).toBe('D:\\out\\name.bat.html')
    expect([...bat.mem.written.keys()]).toEqual(['D:\\out\\name.bat.html'])
    expect(await bat.call('world:open-file', { path: 'D:\\out\\name.bat.html' })).toEqual(ok(true))
    expect(bat.deps.openPath).toHaveBeenCalledWith('D:\\out\\name.bat.html')
    expect(await bat.call('world:open-file', { path: 'D:\\out\\name.bat' })).toEqual(err(NOT_EXPORTED))
    const upper = setup({ testSave: vi.fn(async () => 'D:\\out\\name.HTML') })
    expect((await upper.call('world:export', { exportId: 'x1', root: ROOT, smart: false })).data.path).toBe('D:\\out\\name.HTML')
    const doc = setup({ platform: 'linux', saveDialog: vi.fn(async () => '/home/ann/guide') })
    expect((await doc.call('world:document', { root: ROOT, title: 'Shop' })).data.path).toBe('/home/ann/guide.html')
  })

  it("model listed but the world couldn't be indexed: its own sentence and a keyword-only flag, never 'isn't installed'", async () => {
    const nothing = setup({ embed: vi.fn(async (texts: string[]) => texts.map(() => null)) })
    expect(await nothing.call('world:export', { exportId: 'x1', root: ROOT, smart: true })).toEqual({ ...err(KEYWORD_ONLY), keywordOnly: true })
    expect(KEYWORD_ONLY).not.toMatch(/install/i)
    expect(nothing.mem.written.size).toBe(0)
    expect((await nothing.call('world:export', { exportId: 'x2', root: ROOT, smart: false })).success).toBe(true)
    const unreadable = memFs()
    const read = unreadable.fs.readFile
    unreadable.fs.readFile = vi.fn(async (p: string) => {
      if (p === ASSETS.modelFile) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return read(p)
    })
    const locked = setup({ mem: unreadable })
    expect(await locked.call('world:export', { exportId: 'x1', root: ROOT, smart: true })).toEqual({ ...err(KEYWORD_ONLY), keywordOnly: true })
  })

  it('saves default to the home folder when the OS cannot say where Documents is, asked at each save', async () => {
    const documentsDir = vi.fn((): string => { throw new Error("Failed to get 'documents' path") })
    const { call, deps } = setup({ documentsDir })
    expect(documentsDir).not.toHaveBeenCalled()
    await call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(deps.saveDialog).toHaveBeenLastCalledWith(join(HOME, 'shop - Lumopolis.html'))
    await call('world:document', { root: ROOT, title: 'Shop' })
    expect(deps.saveDialog).toHaveBeenLastCalledWith(join(HOME, 'Shop - Lumopolis documentation.html'))
    expect(documentsDir).toHaveBeenCalledTimes(2)
  })

  it("takes the test run's save path instead of the dialog, and its cancel; undefined still shows the dialog", async () => {
    const picked = setup({ testSave: vi.fn(async () => 'D:\\e2e\\out.html') })
    expect(await picked.call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toMatchObject(ok({ path: 'D:\\e2e\\out.html' }))
    expect(picked.deps.saveDialog).not.toHaveBeenCalled()
    const cancelled = setup({ testSave: vi.fn(async () => null) })
    expect(await cancelled.call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(ok({ cancelled: true }))
    expect(cancelled.deps.saveDialog).not.toHaveBeenCalled()
    const real = setup({ testSave: vi.fn(async () => undefined) })
    await real.call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(real.deps.saveDialog).toHaveBeenCalledTimes(1)
  })

  it('pushes progress carrying the exportId, through a smart export', async () => {
    const { call, sent } = setup()
    expect((await call('world:export', { exportId: 'x1', root: ROOT, smart: true })).success).toBe(true)
    expect(sent.length).toBeGreaterThan(3)
    expect(sent.every((s) => s.channel === 'world:export-progress' && s.payload.exportId === 'x1')).toBe(true)
    expect(sent.map((s) => s.payload.step)).toEqual(expect.arrayContaining(['prepare', 'index', 'write']))
  })

  it('finishes the export when the window is gone and every progress send throws', async () => {
    const { call } = setup({ send: vi.fn(() => { throw new Error('Object has been destroyed') }) })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: true })).toMatchObject({ success: true, data: { path: expect.any(String) } })
  })

  it('world:export-cancel stops that export only, and the cancelled one leaves no file', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const embed = vi.fn(async (texts: string[]) => { await gate; return texts.map(vector) })
    let n = 0
    const { call, mem } = setup({ embed, saveDialog: vi.fn(async () => `D:\\out\\${++n}.html`) })
    const a = call('world:export', { exportId: 'a', root: ROOT, smart: true })
    const b = call('world:export', { exportId: 'b', root: CLONE, smart: true })
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(2))
    expect(await call('world:export-cancel', { exportId: 'a' })).toEqual(ok(true))
    release()
    expect(await a).toEqual(ok({ cancelled: true }))
    expect(await b).toMatchObject({ success: true, data: { path: 'D:\\out\\2.html' } })
    expect([...mem.written.keys()]).toEqual(['D:\\out\\2.html'])
  })

  it('refuses a second export with a running id, and takes the id again once the first finished', async () => {
    let release: (p: string | null) => void = () => undefined
    const first = new Promise<string | null>((r) => { release = r })
    const saveDialog = vi.fn().mockReturnValueOnce(first).mockResolvedValue('D:\\out\\again.html')
    const { call } = setup({ saveDialog })
    const running = call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(err(ALREADY_RUNNING))
    release(null)
    expect(await running).toEqual(ok({ cancelled: true }))
    expect((await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).success).toBe(true)
  })

  it('a missing model refuses a smart export but still exports with keyword Ask', async () => {
    const { call, mem } = setup({ assets: () => ({ missing: 'model', assets: KEYWORD_ASSETS }) })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: true })).toEqual({ ...err(NO_MODEL), keywordOnly: true })
    expect(mem.written.size).toBe(0)
    expect((await call('world:export', { exportId: 'x2', root: ROOT, smart: false })).success).toBe(true)
  })

  it('a missing runtime refuses before the save dialog opens', async () => {
    const { call, deps } = setup({ assets: () => ({ missing: 'runtime' }) })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(err(NO_RUNTIME))
    expect(deps.saveDialog).not.toHaveBeenCalled()
  })

  it('exports one proposal of a code world, and refuses a proposal the world no longer has', async () => {
    const { call, mem } = setup()
    const res = await call('world:export', { exportId: 'x1', root: LINKED, smart: false, proposalId: 'p2' })
    expect(JSON.parse(block(page(mem, res.data.path), 'meta')).proposalId).toBe('p2')
    expect(await call('world:export', { exportId: 'x2', root: LINKED, smart: false, proposalId: 'gone' })).toEqual(err(NO_PROPOSAL))
  })

  it('exports a design whole, and refuses a proposal for a design', async () => {
    const { call, mem } = setup()
    const res = await call('world:export', { exportId: 'x1', designKey: DESIGN, smart: false })
    expect(res.data.path).toBe(join(DOCS, 'Shop design - Lumopolis.html'))
    expect(page(mem, res.data.path)).toContain('<title>Shop design · Lumopolis</title>')
    expect(await call('world:export', { exportId: 'x2', designKey: DESIGN, smart: false, proposalId: 'p1' })).toEqual(err(WHOLE_DESIGN))
  })

  it("answers the assembler's sentence for a failed write and opens nothing it did not save", async () => {
    const { call, deps } = setup({ mem: memFs({ write: Object.assign(new Error('full'), { code: 'ENOSPC' }) }) })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(err(NO_SPACE))
    expect(await call('world:open-file', { path: join(DOCS, 'shop - Lumopolis.html') })).toEqual(err(NOT_EXPORTED))
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('answers a fixed sentence when something unexpected throws, and frees the id', async () => {
    const saveDialog = vi.fn().mockRejectedValueOnce(new Error('raw dialog failure')).mockResolvedValue('D:\\out\\ok.html')
    const { call } = setup({ saveDialog })
    expect(await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).toEqual(err(EXPORT_FAILED))
    expect((await call('world:export', { exportId: 'x1', root: ROOT, smart: false })).success).toBe(true)
  })

  it.each([
    ['no request', undefined, 'exportId required'],
    ['no exportId', { root: ROOT, smart: false }, 'exportId required'],
    ['an empty exportId', { exportId: '', root: ROOT, smart: false }, 'exportId required'],
    ['a numeric exportId', { exportId: 7, root: ROOT, smart: false }, 'exportId required'],
    ['an endless exportId', { exportId: 'x'.repeat(200), root: ROOT, smart: false }, 'exportId required'],
    ['no smart choice', { exportId: 'x1', root: ROOT }, 'smart must be true or false'],
    ['a string smart choice', { exportId: 'x1', root: ROOT, smart: 'yes' }, 'smart must be true or false'],
    ['a numeric proposal', { exportId: 'x1', root: ROOT, smart: false, proposalId: 3 }, 'proposalId must be a short string'],
    ['an empty proposal', { exportId: 'x1', root: ROOT, smart: false, proposalId: '' }, 'proposalId must be a short string'],
    ['an endless proposal', { exportId: 'x1', root: ROOT, smart: false, proposalId: 'p'.repeat(200) }, 'proposalId must be a short string'],
    ['no world', { exportId: 'x1', smart: false }, WORLD_REQUIRED],
    ['an unknown folder', { exportId: 'x1', root: 'C:\\nowhere', smart: false }, NO_SAVED_WORLD],
    ['an unknown design', { exportId: 'x1', designKey: 'design:gone', smart: false }, DESIGN_NOT_FOUND],
  ])('refuses %s and never throws', async (_what, args, message) => {
    const { call, deps } = setup()
    expect(await call('world:export', args)).toEqual(err(message))
    expect(deps.saveDialog).not.toHaveBeenCalled()
  })
})

describe('a world that fails its checks', () => {
  it('answers the plain sentence and writes the validator text to the app log only', async () => {
    const log = vi.fn()
    const { call } = setup({ log })
    const exp = await call('world:export', { exportId: 'x1', root: BROKEN, smart: false })
    expect(exp).toEqual(err(NOT_EXPORTABLE))
    expect(log).toHaveBeenCalledWith('Lumopolis export: the world failed its checks: edges must be an array')
    const doc = await call('world:document', { root: BROKEN, title: 'Shop' })
    expect(doc).toEqual(err(NOT_DOCUMENTABLE))
    expect(log).toHaveBeenLastCalledWith('Lumopolis documentation: the world failed its checks: edges must be an array')
  })

  it('logs through the console (which main mirrors into the app log) when no log is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await setup().call('world:export', { exportId: 'x1', root: BROKEN, smart: false })
      expect(warn).toHaveBeenCalledWith('Lumopolis export: the world failed its checks: edges must be an array')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('world:export-cancel', () => {
  it('answers false for an export that is not running, and refuses a bad id', async () => {
    const { call } = setup()
    expect(await call('world:export-cancel', { exportId: 'nothing' })).toEqual(ok(false))
    expect(await call('world:export-cancel', { exportId: 5 })).toEqual(err('exportId required'))
    expect(await call('world:export-cancel')).toEqual(err('exportId required'))
  })
})

describe('world:document', () => {
  it("writes the documentation under the person's title, sanitised, where they choose", async () => {
    const { call, mem, deps } = setup()
    const target = join(DOCS, 'Shop guide - Lumopolis documentation.html')
    const res = await call('world:document', { root: ROOT, title: 'Shop guide' })
    expect(deps.saveDialog).toHaveBeenCalledWith(target)
    expect(res).toEqual(ok({ path: target, bytes: Buffer.byteLength(mem.written.get(target) as string, 'utf8') }))
    const html = mem.written.get(target) as string
    expect(html).toContain('Shop guide')
    expect(html).not.toMatch(/someone/i)
    const named = await call('world:document', { root: ROOT, title: `${HOME}\\private\\name` })
    expect(mem.written.get(named.data.path) as string).not.toMatch(/someone/i)
  })

  it("uses the world's own title when the person's is blank, and carries the city picture", async () => {
    const { call, mem } = setup()
    const png = pngUrl()
    const res = await call('world:document', { designKey: DESIGN, title: '  ', picturePng: png })
    expect(res.data.path).toBe(join(DOCS, 'Shop design - Lumopolis documentation.html'))
    expect(mem.written.get(res.data.path) as string).toContain(png)
  })

  it('a cancelled save dialog answers cancelled and writes nothing; a failed write answers its sentence', async () => {
    const cancelled = setup({ saveDialog: vi.fn(async () => null) })
    expect(await cancelled.call('world:document', { root: ROOT, title: 'Shop' })).toEqual(ok({ cancelled: true }))
    expect(cancelled.mem.fs.writeFile).not.toHaveBeenCalled()
    const full = setup({ mem: memFs({ write: Object.assign(new Error('full'), { code: 'ENOSPC' }) }) })
    expect(await full.call('world:document', { root: ROOT, title: 'Shop' })).toEqual(err(NO_SPACE))
    expect(await full.call('world:show-file', { path: join(DOCS, 'Shop - Lumopolis documentation.html') })).toEqual(err(NOT_EXPORTED))
  })

  it('world:document-cancel stops that save: while the dialog is open nothing is written, and the answer is cancelled', async () => {
    let cancel: () => Promise<unknown> = async () => undefined
    const saveDialog = vi.fn(async (defaultPath: string) => { await cancel(); return defaultPath })
    const { call, mem } = setup({ saveDialog })
    cancel = () => call('world:document-cancel', { documentId: 'd1' })
    expect(await call('world:document', { documentId: 'd1', root: ROOT, title: 'Shop' })).toEqual(ok({ cancelled: true }))
    expect(mem.fs.writeFile).not.toHaveBeenCalled()
    expect(mem.written.size).toBe(0)
  })

  it('a cancel while the world loads never opens the dialog; one during the write leaves no file', async () => {
    let release: () => void = () => undefined
    const loading = setup({ getWorld: vi.fn(() => new Promise<WorldDoc>((r) => { release = () => r(shopWorld()) })) })
    const pending = loading.call('world:document', { documentId: 'd1', root: ROOT, title: 'Shop' })
    expect(await loading.call('world:document-cancel', { documentId: 'd1' })).toEqual(ok(true))
    release()
    expect(await pending).toEqual(ok({ cancelled: true }))
    expect(loading.deps.saveDialog).not.toHaveBeenCalled()

    const mem = memFs()
    const writing = setup({ mem })
    const write = mem.fs.writeFile
    mem.fs.writeFile = vi.fn(async (p: string, d: string | Uint8Array) => { await writing.call('world:document-cancel', { documentId: 'd2' }); return write(p, d) })
    expect(await writing.call('world:document', { documentId: 'd2', root: ROOT, title: 'Shop' })).toEqual(ok({ cancelled: true }))
    expect(mem.written.size).toBe(0)
    expect(mem.fs.rename).not.toHaveBeenCalled()
  })

  it('world:document-cancel answers false when that save is not running, and refuses a bad id; a save runs once per id', async () => {
    const { call } = setup()
    expect(await call('world:document-cancel', { documentId: 'none' })).toEqual(ok(false))
    expect(await call('world:document-cancel', { documentId: 3 })).toEqual(err('documentId required'))
    expect(await call('world:document', { documentId: 7, root: ROOT, title: 'Shop' })).toEqual(err('documentId must be a short string'))
    let release: () => void = () => undefined
    const slow = setup({ getWorld: vi.fn(() => new Promise<WorldDoc>((r) => { release = () => r(shopWorld()) })) })
    const first = slow.call('world:document', { documentId: 'd1', root: ROOT, title: 'Shop' })
    expect(await slow.call('world:document', { documentId: 'd1', root: ROOT, title: 'Shop' })).toEqual(err('That documentation is already being written.'))
    release()
    expect((await first).success).toBe(true)
    // Finished: the id is free again, and a cancel finds nothing.
    expect(await slow.call('world:document-cancel', { documentId: 'd1' })).toEqual(ok(false))
  })

  it("takes the test run's save path", async () => {
    const { call, deps } = setup({ testSave: vi.fn(async () => 'D:\\e2e\\doc.html') })
    expect(await call('world:document', { root: ROOT, title: 'Shop' })).toMatchObject(ok({ path: 'D:\\e2e\\doc.html' }))
    expect(deps.saveDialog).not.toHaveBeenCalled()
  })

  it('answers a fixed sentence when something unexpected throws', async () => {
    const { call } = setup({ saveDialog: vi.fn(async () => { throw new Error('raw') }) })
    expect(await call('world:document', { root: ROOT, title: 'Shop' })).toEqual(err(DOCUMENT_FAILED))
  })

  it.each([
    ['no request', undefined, 'title must be a string (up to 200 characters)'],
    ['no title', { root: ROOT }, 'title must be a string (up to 200 characters)'],
    ['a numeric title', { root: ROOT, title: 4 }, 'title must be a string (up to 200 characters)'],
    ['an endless title', { root: ROOT, title: 't'.repeat(201) }, 'title must be a string (up to 200 characters)'],
    ['a picture that is not a PNG data URL', { root: ROOT, title: 'Shop', picturePng: 'https://example.com/x.png' }, 'picturePng must be a PNG data URL'],
    ['a numeric picture', { root: ROOT, title: 'Shop', picturePng: 1 }, 'picturePng must be a PNG data URL'],
    ['a PNG data URL whose bytes are not a PNG', { root: ROOT, title: 'Shop', picturePng: pngUrl(Buffer.from('GIF89a not a png')) }, 'picturePng must be a PNG data URL'],
    ['a PNG data URL too short to hold the signature', { root: ROOT, title: 'Shop', picturePng: pngUrl(PNG_HEAD.subarray(0, 4)) }, 'picturePng must be a PNG data URL'],
    ['no world', { title: 'Shop' }, WORLD_REQUIRED],
    ['an unknown design', { designKey: 'design:gone', title: 'Shop' }, DESIGN_NOT_FOUND],
  ])('refuses %s and never throws', async (_what, args, message) => {
    const { call, deps } = setup()
    expect(await call('world:document', args)).toEqual(err(message))
    expect(deps.saveDialog).not.toHaveBeenCalled()
  })

  it('refuses a picture past the size bound', async () => {
    const { call } = setup()
    const huge = `data:image/png;base64,${'A'.repeat(33 * 1024 * 1024)}`
    expect(await call('world:document', { root: ROOT, title: 'Shop', picturePng: huge })).toEqual(err('picturePng must be a PNG data URL'))
  })
})

describe('world:show-file and world:open-file', () => {
  it('refuse a path this session did not export, and a path that is not text', async () => {
    const { call, deps } = setup()
    expect(await call('world:open-file', { path: 'C:\\Windows\\notepad.exe' })).toEqual(err(NOT_EXPORTED))
    expect(await call('world:show-file', { path: 'C:\\Windows\\notepad.exe' })).toEqual(err(NOT_EXPORTED))
    expect(await call('world:open-file', { path: 'relative.html' })).toEqual(err(NOT_EXPORTED))
    expect(await call('world:open-file', { path: 7 })).toEqual(err('path required'))
    expect(await call('world:show-file')).toEqual(err('path required'))
    expect(await call('world:open-file', { path: `C:\\${'x'.repeat(5000)}` })).toEqual(err('path required'))
    expect(deps.openPath).not.toHaveBeenCalled()
    expect(deps.showItemInFolder).not.toHaveBeenCalled()
  })

  it('show and open an exported file; on Windows the same file matches in any case and either slash', async () => {
    const { call, deps } = setup({ testSave: vi.fn(async () => 'C:\\X\\a.html') })
    await call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(await call('world:show-file', { path: 'c:/x/A.HTML' })).toEqual(ok(true))
    expect(deps.showItemInFolder).toHaveBeenCalledWith('C:\\X\\a.html')
    expect(await call('world:open-file', { path: 'C:\\X\\sub\\..\\a.html' })).toEqual(ok(true))
    expect(deps.openPath).toHaveBeenCalledWith('C:\\X\\a.html')
  })

  it('on Linux the match keeps letter case', async () => {
    const { call, deps } = setup({ platform: 'linux', testSave: vi.fn(async () => '/home/ann/a.html') })
    await call('world:document', { root: ROOT, title: 'Shop' })
    expect(await call('world:open-file', { path: '/home/ann/A.HTML' })).toEqual(err(NOT_EXPORTED))
    expect(await call('world:open-file', { path: '/home/ann/x/../a.html' })).toEqual(ok(true))
    expect(deps.openPath).toHaveBeenCalledWith('/home/ann/a.html')
  })

  it("answers a fixed sentence when the OS can't open the file", async () => {
    const { call } = setup({ testSave: vi.fn(async () => 'C:\\X\\a.html'), openPath: vi.fn(async () => 'No application is associated') })
    await call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    expect(await call('world:open-file', { path: 'C:\\X\\a.html' })).toEqual(err(OPEN_FAILED))
  })

  it('a cancelled export adds nothing', async () => {
    const { call } = setup({ testSave: vi.fn(async () => 'C:\\X\\a.html') })
    const pending = call('world:export', { exportId: 'x1', root: ROOT, smart: true })
    await call('world:export-cancel', { exportId: 'x1' })
    expect(await pending).toEqual(ok({ cancelled: true }))
    expect(await call('world:open-file', { path: 'C:\\X\\a.html' })).toEqual(err(NOT_EXPORTED))
  })
})

describe('defaults', () => {
  it("runs on this machine's platform and clock when none is given", async () => {
    const here = resolve('now.html')
    const { call, mem } = setup({ platform: undefined, now: undefined, testSave: vi.fn(async () => here) })
    const res = await call('world:export', { exportId: 'x1', root: ROOT, smart: false })
    const meta = new RegExp('id="meta" data-enc="gz64">([^<]*)<').exec(mem.written.get(res.data.path) as string) as RegExpExecArray
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(JSON.parse(gunzipSync(Buffer.from(meta[1], 'base64')).toString('utf8')).exportedOn).toBe(day)
    expect(await call('world:open-file', { path: here })).toEqual(ok(true))
  })
})
