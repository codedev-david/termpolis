// WPA items 2 and 4 in the store: project-key aliases, strict label scope, 8.3 names, and cancel checkpoints.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  initSwarmMemory, memorySearch, memoryList, memoryListLong, memoryWrite, _resetForTests, _setEmbedFnForTests, _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { projectKeyOf } from '../../src/main/projectKey'
import { setRerankBatchScorer, _resetRerankForTests } from '../../src/main/crossEncoderRerank'
import { EMBED_DIM } from '../../src/main/localEmbedder'

const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
let dir: string
const shard = (): string => path.join(dir, 'swarm-memory.jsonl')
const drop = (lines: object[]): void => fs.writeFileSync(shard(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
const line = (id: string, content: string, extra: object): object => ({ id, ts: Date.now() - 1000, agentId: 'a', kind: 'fact', content, ...extra })
const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memscope-'))
  _resetForTests()
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _setEmbedFnForTests(null)
  _resetRerankForTests()
  _resetForTests()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('project-key aliases (no migration)', () => {
  it('a note keyed by an older spelling of the folder keeps matching; a same-named other folder never does', async () => {
    drop([
      line('old', 'zebra crossing notes from the doubled path', { project: 'repo', projectKey: sha('/srv/x//repo') }),
      line('new', 'zebra crossing notes from the clean path', { project: 'repo', projectKey: sha('/srv/x/repo') }),
      line('other', 'zebra crossing notes from another repo', { project: 'repo', projectKey: sha('/srv/y/repo') }),
    ])
    initSwarmMemory(dir)
    expect(ids(await memorySearch({ query: 'zebra crossing', project: '/srv/x//repo', limit: 10 }))).toEqual(['new', 'old'])
    expect(ids(memoryList({ project: '/srv/x//repo' }))).toEqual(['new', 'old'])
    // The canonical spelling has one key: the old note is reached from the spelling it was written with.
    expect(ids(await memorySearch({ query: 'zebra crossing', project: '/srv/x/repo', limit: 10 }))).toEqual(['new'])
    // A caller that already names the key gets exactly that key.
    expect(ids(memoryList({ project: '/srv/x/repo', projectKey: sha('/srv/y/repo') } as never))).toEqual(['other'])
  })

  it('cross-project recall does not damp a note that carries an alias key of this folder', async () => {
    drop([
      line('old', 'quokka habitat survey', { project: 'repo', projectKey: sha('/srv/x//repo') }),
      line('far', 'quokka habitat survey', { project: 'zoo', projectKey: sha('/srv/zoo') }),
    ])
    initSwarmMemory(dir)
    const hits = await memorySearch({ query: 'quokka habitat survey', project: '/srv/x//repo', crossProject: true, limit: 10 })
    expect(hits.map((h) => h.id)).toEqual(['old', 'far'])
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it.runIf(process.platform === 'win32')('Windows: a note written from Git Bash (/c/...) matches a search from C:\\', async () => {
    drop([line('bash', 'walrus migration log', { project: 'repo', projectKey: sha('/c/users/x/repo') })])
    initSwarmMemory(dir)
    expect(ids(await memorySearch({ query: 'walrus migration', project: 'C:\\Users\\X\\repo', limit: 5 }))).toEqual(['bash'])
    expect(ids(memoryList({ project: 'C:\\Users\\X\\repo' }))).toEqual(['bash'])
    // and a new note written from Git Bash gets the canonical key
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'walrus new note', project: '/c/Users/X/repo' })
    expect(e.projectKey).toBe(projectKeyOf('C:\\Users\\X\\repo'))
  })

  it.runIf(process.platform === 'win32')('Windows: an 8.3 short spelling is read as its long name in a write and a search', async () => {
    const long = fs.realpathSync.native(dir)
    const target = path.join(long, 'Project Folder With Long Name')
    fs.mkdirSync(target)
    initSwarmMemory(dir)
    // The folder's short name, if 8.3 names are on for this volume; otherwise the test is the plain path.
    const short = target.replace('Project Folder With Long Name', 'PROJEC~1')
    const spelled = fs.existsSync(short) ? short : target
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'narwhal tusk measurements', project: spelled })
    expect(e.projectKey).toBe(projectKeyOf(target))
    expect(ids(await memorySearch({ query: 'narwhal tusk', project: spelled, limit: 5 }))).toEqual([e.id])
    // WPA fix I5: the recent listing the host serves spells the folder out too.
    expect(ids(await memoryListLong({ project: spelled }))).toEqual([e.id])
  })

  it('memoryListLong: a folder with no short part, or none at all, is listed as memoryList lists it', async () => {
    drop([line('n1', 'beluga song notes', { project: 'repo', projectKey: sha('/srv/x/repo') })])
    initSwarmMemory(dir)
    expect(ids(await memoryListLong({ project: '/srv/x/repo' }))).toEqual(['n1'])
    expect(ids(await memoryListLong())).toEqual(['n1'])
  })
})

describe('strict label scope: legacy notes with no key never match by folder name', () => {
  it('a legacy note matches a normal search by slug, and is excluded with strictProject', async () => {
    drop([
      line('legacy', 'ocelot sighting report', { project: 'repo' }),
      line('keyed', 'ocelot sighting report two', { project: 'repo', projectKey: sha('/srv/x/repo') }),
    ])
    initSwarmMemory(dir)
    expect(ids(await memorySearch({ query: 'ocelot sighting', project: '/srv/x/repo', limit: 10 }))).toEqual(['keyed', 'legacy'])
    expect(ids(await memorySearch({ query: 'ocelot sighting', project: '/srv/x/repo', strictProject: true, limit: 10 }))).toEqual(['keyed'])
  })
})

describe('cancel checkpoints in memorySearch', () => {
  const unit = (): number[] => { const v = new Array(EMBED_DIM).fill(0); v[0] = 1; return v }

  it('an already-cancelled search throws AbortError before any work', async () => {
    initSwarmMemory(dir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'heron nest' })
    const ctl = new AbortController()
    ctl.abort()
    await expect(memorySearch({ query: 'heron', signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancelled during the query embed: stops after it, and the search is not cached', async () => {
    initSwarmMemory(dir)
    _setEmbedFnForTests(async () => null)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'heron nest count' })
    const ctl = new AbortController()
    let embeds = 0
    _setEmbedFnForTests(async () => { embeds++; ctl.abort(); return null })
    await expect(memorySearch({ query: 'heron nest', signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const again = await memorySearch({ query: 'heron nest' })
    expect(embeds).toBe(2) // it ran again: the cancelled one left nothing in the search cache
    expect(again).toHaveLength(1)
  })

  it('cancelled during the rerank: stops after it, never cached; rerank off skips it entirely', async () => {
    initSwarmMemory(dir)
    _setEmbedFnForTests(async () => unit())
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'pelican wing span one' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'pelican wing span two' })
    const ctl = new AbortController()
    let scored = 0
    setRerankBatchScorer(async (_q, docs) => { scored++; ctl.abort(); return docs.map(() => 0) })
    await expect(memorySearch({ query: 'pelican wing', rerank: true, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(scored).toBe(1)
    setRerankBatchScorer(async (_q, docs) => { scored++; return docs.map(() => 0) })
    expect(await memorySearch({ query: 'pelican wing', rerank: true })).toHaveLength(2)
    expect(scored).toBe(2)
    expect(await memorySearch({ query: 'pelican wing span', rerank: false })).toHaveLength(2)
    expect(scored).toBe(2) // rerank off: the cross-encoder is never asked
  })
})

describe('WP5: keys that keep the case on Linux, and short Git Bash spellings (review I6)', () => {
  it('a note keyed before WP5 (the path lowercased) still matches the folder however its case is spelled', async () => {
    drop([line('old', 'axolotl gill notes', { project: 'Repo', projectKey: sha('/srv/x/repo') })])
    initSwarmMemory(dir)
    expect(ids(await memorySearch({ query: 'axolotl gill', project: '/srv/X/Repo', limit: 5 }))).toEqual(['old'])
    expect(ids(memoryList({ project: '/srv/X/Repo' }))).toEqual(['old'])
  })

  it.runIf(process.platform === 'linux')('Linux: two folders that differ only in case keep their notes apart', async () => {
    initSwarmMemory(dir)
    const upper = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'tapir notes upper', project: '/srv/x/Repo' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'tapir notes lower', project: '/srv/x/repo' })
    expect(upper.projectKey).toBe(sha('/srv/x/Repo'))
    expect(ids(await memorySearch({ query: 'tapir notes', project: '/srv/x/Repo', strictProject: true, limit: 5 }))).toEqual([upper.id])
  })

  it.runIf(process.platform === 'win32')('Windows: a Git Bash short spelling is read as the long folder, and a note keyed by the short spelling keeps matching', async () => {
    const long = fs.realpathSync.native(dir)
    const target = path.join(long, 'Project Folder With Long Name')
    fs.mkdirSync(target)
    const short = target.replace('Project Folder With Long Name', 'PROJEC~1')
    const bash = `/${short[0].toLowerCase()}${short.slice(2).split(path.sep).join('/')}`
    drop([line('then', 'manatee feeding schedule', { project: 'PROJEC~1', projectKey: sha(bash.replace(/^\/(\w)/, '$1:').toLowerCase()) })])
    initSwarmMemory(dir)
    if (!fs.existsSync(short)) return // 8.3 names are off on this volume: nothing to spell out
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'manatee feeding new', project: bash })
    expect(e.projectKey).toBe(projectKeyOf(target))
    expect(ids(await memorySearch({ query: 'manatee feeding', project: bash, limit: 5 }))).toEqual([e.id, 'then'].sort())
    expect(ids(await memoryListLong({ project: bash }))).toEqual([e.id, 'then'].sort())
  })
})
