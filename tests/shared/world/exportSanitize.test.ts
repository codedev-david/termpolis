import { describe, expect, it } from 'vitest'
import { cardText } from '../../../src/main/world/cardText'
import { edgeCard } from '../../../src/renderer/src/world/engine/cards'
import { OUTSIDE, isRevealingPath, relativePath, revealingPaths, sanitizeText, sanitizeWorld, type SanitizeContext } from '../../../src/shared/world/exportSanitize'
import type { Building, Claim, WorldDoc, WorldEdge } from '../../../src/shared/world/types'
import { minimal } from '../../renderer/world/helpers'

const win: SanitizeContext = { root: 'C:\\Users\\dev\\repo', home: 'C:\\Users\\dev', userData: 'C:\\Users\\dev\\AppData\\Roaming\\Termpolis' }
const posix: SanitizeContext = { root: '/home/dev/repo', home: '/home/dev', userData: '/home/dev/.config/Termpolis' }
const design: SanitizeContext = { root: null, home: '/home/dev', userData: '/home/dev/.config/Termpolis' }
const GH = 'ghp_' + 'a'.repeat(36)

describe('relativePath', () => {
  it('turns a Windows path inside the project into a project-relative one', () => {
    expect(relativePath('C:\\Users\\dev\\repo\\src\\a.ts', win)).toBe('src/a.ts')
  })

  it('matches a Windows root case-insensitively and in either slash form', () => {
    expect(relativePath('C:\\Users\\dev\\repo\\src\\a.ts', { ...win, root: 'c:/users/dev/repo' })).toBe('src/a.ts')
  })

  it('matches a UNC root, whatever the case of the server name', () => {
    expect(relativePath('\\\\SRV\\share\\repo\\lib\\b.ts', { ...win, root: '\\\\srv\\share\\repo' })).toBe('lib/b.ts')
  })

  it('matches a root holding spaces, brackets and a plus sign', () => {
    expect(relativePath('/home/dev/repo (copy)+/src/a.ts', { ...posix, root: '/home/dev/repo (copy)+' })).toBe('src/a.ts')
  })

  it('matches a POSIX root case-sensitively', () => {
    expect(relativePath('/home/dev/repo/src/a.ts', posix)).toBe('src/a.ts')
    expect(relativePath('/home/dev/Repo/src/a.ts', posix)).toBe(`${OUTSIDE}/a.ts`)
  })

  it('expands ~ with the home folder before comparing', () => {
    expect(relativePath('~/repo/x.ts', posix)).toBe('x.ts')
    expect(relativePath('~\\notes\\y.md', posix)).toBe(`${OUTSIDE}/y.md`)
  })

  it('treats a ~ path as outside when no home is known', () => {
    expect(relativePath('~/repo/x.ts', { ...posix, home: '' })).toBe(`${OUTSIDE}/x.ts`)
  })

  it('names a path outside the project by its basename only', () => {
    expect(relativePath('D:\\other\\secret.ts', win)).toBe('<outside the project>/secret.ts')
  })

  it('gives every absolute path of a design world (no root) as outside the project', () => {
    expect(relativePath('/home/dev/repo/src/a.ts', design)).toBe(`${OUTSIDE}/a.ts`)
  })

  it('never gives the home or userData folder name itself', () => {
    expect(relativePath('C:\\Users\\dev', win)).toBe(OUTSIDE)
    expect(relativePath('c:/users/dev/appdata/roaming/termpolis/', win)).toBe(OUTSIDE)
    expect(relativePath('/home/dev', design)).toBe(OUTSIDE)
    expect(relativePath('C:\\', win)).toBe(OUTSIDE)
  })

  it('gives the root itself as "."', () => {
    expect(relativePath('C:\\Users\\dev\\repo\\', win)).toBe('.')
  })

  it('keeps a relative path, with forward slashes and no dot segments', () => {
    expect(relativePath('src\\main\\.\\a.ts', win)).toBe('src/main/a.ts')
    expect(relativePath('src/x/../a.ts', win)).toBe('src/a.ts')
    expect(relativePath('', win)).toBe('')
    expect(relativePath('./', win)).toBe('.')
    expect(relativePath('b1', win)).toBe('b1')
  })

  it('gives a path that climbs out of the project as outside', () => {
    expect(relativePath('../other/x.ts', win)).toBe(`${OUTSIDE}/x.ts`)
    expect(relativePath('C:\\Users\\dev\\repo\\..\\other\\y.ts', win)).toBe(`${OUTSIDE}/y.ts`)
    expect(relativePath('..', win)).toBe(OUTSIDE)
  })
})

describe('sanitizeText', () => {
  it('replaces a secret with [redacted]', () => {
    expect(sanitizeText(GH, win)).toBe('[redacted]')
    expect(sanitizeText(`uses ${GH} to clone`, win)).toBe('uses [redacted] to clone')
  })

  it('rewrites every absolute path in free text', () => {
    expect(sanitizeText('Reads C:\\Users\\dev\\repo\\src\\a.ts and D:\\x\\b.ts.', win)).toBe(`Reads src/a.ts and ${OUTSIDE}/b.ts.`)
    expect(sanitizeText('see (c:/users/dev/repo/lib/c.ts), then \\\\srv\\share\\d.ts', win)).toBe(`see (lib/c.ts), then ${OUTSIDE}/d.ts`)
    expect(sanitizeText('stored under ~/notes/e.md and /Users/ann/f.md', posix)).toBe(`stored under ${OUTSIDE}/e.md and ${OUTSIDE}/f.md`)
    expect(sanitizeText('logs in /home/dev/.config/Termpolis/logs/g.log', posix)).toBe(`logs in ${OUTSIDE}/g.log`)
  })

  it('finds a root holding spaces and regex characters in free text', () => {
    const ctx = { ...posix, root: '/home/dev/repo (copy)+' }
    expect(sanitizeText('built from /home/dev/repo (copy)+/src/a.ts today', ctx)).toBe('built from src/a.ts today')
    expect(sanitizeText('the project at /home/dev/repo (copy)+, built', ctx)).toBe('the project at ., built')
  })

  it('finds a POSIX root outside the usual home folders', () => {
    const ctx = { ...posix, root: '/code/repo' }
    expect(sanitizeText('cloned to /code/repo/app.ts', ctx)).toBe('cloned to app.ts')
    expect(sanitizeText('cloned to /code/repo.', ctx)).toBe('cloned to ..')
    expect(sanitizeText('see /code/repo.old/x', ctx)).toBe('see /code/repo.old/x')
    expect(sanitizeText('see /srv/code/repo.old/x', { ...posix, root: '/srv/code/repo' })).toBe(`see ${OUTSIDE}/x`)
  })

  it('finds the home folder in any case and slash form, and only as a whole folder name', () => {
    expect(sanitizeText('C:/USERS/DEV/notes.txt', win)).toBe(`${OUTSIDE}/notes.txt`)
    expect(sanitizeText("C:\\Users\\dev's files", win)).toBe(`${OUTSIDE}'s files`)
    expect(sanitizeText('/home/dev2/x.ts', posix)).toBe(`${OUTSIDE}/x.ts`)
  })

  it('leaves routes, URLs, relative paths and plain words alone', () => {
    const plain = 'Serves /api/users over https://example.com/a/b, reads src/a.ts; input/output; a~/b'
    expect(sanitizeText(plain, win)).toBe(plain)
  })

  it('works with no root and no home', () => {
    expect(sanitizeText('at E:\\work\\h.ts', { root: null, home: '', userData: '' })).toBe(`at ${OUTSIDE}/h.ts`)
  })
})

/** Every string in a JSON value, keys included, passed through `f`. */
function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)]))
  return v
}

const claimOf =(text: string, ...evidence: Claim['evidence']): Claim => ({ text, state: 'observed', evidence })

function fullDoc(): WorldDoc {
  const doc = minimal()
  doc.projectKey = '3f9a1c0e7b2d4a68'
  const b = doc.buildings[0]
  b.name = 'App at C:\\Users\\dev\\repo\\src'
  b.techLabel = `Electron ${GH}`
  b.members = ['C:\\Users\\dev\\repo\\src\\main\\index.ts', 'src\\main\\other.ts']
  b.floors[0].members = ['C:\\Users\\dev\\repo\\src\\main\\index.ts']
  b.floors[0].name = 'Shell in C:\\Users\\dev\\repo\\src\\main'
  b.how = [claimOf('Opens the window', { kind: 'file', ref: 'C:\\Users\\dev\\repo\\src\\main\\index.ts', excerpt: 'const win = new BrowserWindow()' })]
  b.why = [claimOf('Remembered from a note', { kind: 'memory', ref: 'project_memory_brain', excerpt: 'C:\\Users\\dev\\notes' })]
  b.claims = [
    claimOf('Seen by an agent', { kind: 'transcriptStep', ref: 'C:\\Users\\dev\\.claude\\projects\\x.jsonl' }, { kind: 'test', ref: 'tests\\a.test.ts' }),
    claimOf('A person said so', { kind: 'person', ref: 'confirmed in Lumopolis from C:\\Users\\dev\\repo\\README.md' }),
    claimOf(`Token ${GH}`, { kind: 'commit', ref: '9281177c' }),
  ]
  b.growth = { start: 'family', seed: 'store', folder: 'C:\\Users\\dev\\repo\\src\\memory', merged: 1, mergedFiles: 2, reached: 3, inFolder: 4, folded: 5, cap: 60 }
  const b2 = doc.buildings[1]
  b2.growth = { start: 'file', seed: 'C:\\Users\\dev\\repo\\src\\memory\\store.ts', merged: 0, mergedFiles: 0, folded: 0, cap: 60 }
  doc.districts[0].name = 'Core of C:\\Users\\dev\\repo'
  doc.districts[0].subtitle = 'Holds C:\\Users\\dev\\AppData\\Roaming\\Termpolis\\worlds'
  doc.districts[0].members = ['b1', 'b2']
  const e = doc.edges[0]
  e.label = 'Calls C:\\Users\\dev\\repo\\src\\memory\\client.ts'
  e.rate = 'often'
  e.twoWayStated = true
  e.claims = [claimOf('Seen in code', { kind: 'symbol', ref: 'C:\\Users\\dev\\repo\\src\\memory\\client.ts#call' })]
  doc.externals = [{ id: 'x1', name: 'Files in C:\\Users\\dev\\Documents', kind: 'files', fog: true }]
  doc.glossary = { 'C:\\Users\\dev\\repo': 'the project folder C:\\Users\\dev\\repo' }
  doc.cargo = { memory: { shape: 'cube', color: '#fff', label: 'Notes from C:\\Users\\dev\\notes' } }
  doc.processes = { main: { label: 'Main at C:\\Users\\dev\\repo', color: '#000' } }
  doc.tours = [{ id: 't1', title: 'Tour of C:\\Users\\dev\\repo', steps: [{ ids: ['b1', 'b2'], caption: 'Start in C:\\Users\\dev\\repo\\src\\main\\index.ts' }] }]
  doc.layout = { seed: 7, positions: { b1: [1, 2, 3] }, round: 2 }
  doc.runtimeNames = { b1: ['svc at C:\\Users\\dev\\repo'] }
  doc.runtimeHandSet = ['b1']
  doc.labelTokens = 1234
  const pb: Building = { ...b, id: 'pb', growth: undefined, members: ['C:\\Users\\dev\\repo\\src\\new.ts'] }
  delete pb.growth
  const pe: WorldEdge = { ...e, id: 'pe', from: 'pb', to: 'b1' }
  delete pe.twoWayStated
  doc.layers = {
    plan: [
      { id: 'p1', title: 'Plan for C:\\Users\\dev\\repo', summary: [claimOf('Summary', { kind: 'memory', ref: 'm' })], buildings: [pb], edges: [pe], reconcile: { matched: { pb: 'b1' }, missing: ['pb'], extra: ['b2'], changed: ['b1'], planAt: 99 }, removes: ['b2'] },
      { id: 'p2', title: 'Bare', summary: [], buildings: [], edges: [] },
    ],
    live: { traces: ['C:\\Users\\dev\\repo'] },
  }
  Object.assign(doc, { conversation: ['hello'], sessionId: 'abc' })
  return doc
}

describe('sanitizeWorld', () => {
  it('removes every excerpt and every memory and transcriptStep evidence', () => {
    const out = sanitizeWorld(fullDoc(), win)
    const all = JSON.stringify(out)
    expect(all).not.toContain('excerpt')
    expect(all).not.toMatch(/"kind":"(memory|transcriptStep)"/)
    expect(out.buildings[0].how[0].evidence).toEqual([{ kind: 'file', ref: 'src/main/index.ts' }])
    expect(out.buildings[0].claims[0].evidence).toEqual([{ kind: 'test', ref: 'tests/a.test.ts' }])
  })

  it('keeps the text of a claim whose only evidence was a memory note, with no evidence', () => {
    const out = sanitizeWorld(fullDoc(), win)
    expect(out.buildings[0].why).toEqual([{ text: 'Remembered from a note', state: 'observed', evidence: [] }])
    expect(out.layers.plan[0].summary).toEqual([{ text: 'Summary', state: 'observed', evidence: [] }])
  })

  it('relativises evidence refs, members, growth folders and tour captions', () => {
    const out = sanitizeWorld(fullDoc(), win)
    const b = out.buildings[0]
    expect(b.members).toEqual(['src/main/index.ts', 'src/main/other.ts'])
    expect(b.floors[0].members).toEqual(['src/main/index.ts'])
    expect(b.floors[0].name).toBe('Shell in src/main')
    expect(b.claims[1].evidence[0].ref).toBe('confirmed in Lumopolis from README.md')
    expect(b.growth).toEqual({ start: 'family', seed: 'store', folder: 'src/memory', merged: 1, mergedFiles: 2, reached: 3, inFolder: 4, folded: 5, cap: 60 })
    expect(out.buildings[1].growth).toEqual({ start: 'file', seed: 'src/memory/store.ts', merged: 0, mergedFiles: 0, folded: 0, cap: 60 })
    expect(out.districts[0]).toEqual({ id: 'd1', name: 'Core of .', subtitle: `Holds ${OUTSIDE}/worlds`, hue: 210, members: ['b1', 'b2'], nameState: 'observed' })
    expect(out.edges[0].claims[0].evidence[0].ref).toBe('src/memory/client.ts#call')
    expect(out.edges[0].label).toBe('Calls src/memory/client.ts')
    expect(out.tours).toEqual([{ id: 't1', title: 'Tour of .', steps: [{ ids: ['b1', 'b2'], caption: 'Start in src/main/index.ts' }] }])
    expect(out.layers.plan[0].buildings[0].members).toEqual(['src/new.ts'])
    expect(out.externals).toEqual([{ id: 'x1', name: `Files in ${OUTSIDE}/Documents`, kind: 'files', fog: true }])
    expect(out.glossary).toEqual({ '.': 'the project folder .' })
    expect(out.cargo).toEqual({ memory: { shape: 'cube', color: '#fff', label: `Notes from ${OUTSIDE}/notes` } })
    expect(out.processes).toEqual({ main: { label: 'Main at .', color: '#000' } })
    expect(out.runtimeNames).toEqual({ b1: ['svc at .'] })
  })

  it("gives a code world's projectKey as the root's basename", () => {
    expect(sanitizeWorld(fullDoc(), win).projectKey).toBe('repo')
    expect(sanitizeWorld(fullDoc(), { ...win, root: 'C:\\Users\\dev\\repo\\' }).projectKey).toBe('repo')
  })

  it("keeps a design world's design:<id> key, and rewrites any other key when there is no root", () => {
    const doc = fullDoc()
    doc.projectKey = 'design:my-plan.v2'
    expect(sanitizeWorld(doc, design).projectKey).toBe('design:my-plan.v2')
    doc.projectKey = 'design:/home/dev/x'
    expect(sanitizeWorld(doc, design).projectKey).toBe(`design:${OUTSIDE}/x`)
    doc.projectKey = 'design:../x'
    expect(sanitizeWorld(doc, win).projectKey).toBe('repo')
  })

  it('a sanitised design world still reads its lines as planned', () => {
    const doc = minimal()
    doc.projectKey = 'design:p'
    doc.edges[0].twoWay = false
    Object.assign(doc.edges[0], { how: [], why: [], label: 'ipc world:get', tech: ['ipc'] })
    const out = sanitizeWorld(doc, design)
    const id = out.edges[0].id
    for (const card of [cardText(out, id), edgeCard(out, id)]) {
      expect(card).toContain('One way (planned)')
      expect(card).toContain('Not described yet.')
      expect(card).not.toContain('From the code')
    }
  })

  it('copies only the known WorldDoc fields', () => {
    const out = sanitizeWorld(fullDoc(), win) as unknown as Record<string, unknown>
    expect(out).not.toHaveProperty('conversation')
    expect(out).not.toHaveProperty('sessionId')
    expect(out.layers).toEqual({ plan: expect.any(Array) })
    expect(Object.keys(out).sort()).toEqual([
      'buildings', 'cargo', 'districts', 'edges', 'externals', 'generatedAt', 'glossary', 'labelTokens', 'layers', 'layout',
      'processes', 'projectKey', 'runtimeHandSet', 'runtimeNames', 'sourceRevision', 'tours', 'version',
    ])
  })

  it('keeps the structure: ids, layout, revision, plan reconcile and the optional fields', () => {
    const src = fullDoc()
    const out = sanitizeWorld(src, win)
    expect(out.version).toBe(1)
    expect(out.generatedAt).toBe(src.generatedAt)
    expect(out.sourceRevision).toEqual(src.sourceRevision)
    expect(out.layout).toEqual({ seed: 7, positions: { b1: [1, 2, 3] }, round: 2 })
    expect(out.runtimeHandSet).toEqual(['b1'])
    expect(out.labelTokens).toBe(1234)
    expect(out.edges[0]).toMatchObject({ id: 'e1', from: 'b1', to: 'b2', cargo: 'memory', tech: ['ipc'], rate: 'often', twoWay: true, twoWayStated: true })
    expect(out.layers.plan[0]).toMatchObject({ id: 'p1', title: 'Plan for .', reconcile: { matched: { pb: 'b1' }, missing: ['pb'], extra: ['b2'], changed: ['b1'], planAt: 99 }, removes: ['b2'] })
    expect(out.layers.plan[0].edges[0]).not.toHaveProperty('twoWayStated')
    expect(out.layers.plan[0].buildings[0]).not.toHaveProperty('growth')
    expect(out.layers.plan[1]).toEqual({ id: 'p2', title: 'Bare', summary: [], buildings: [], edges: [] })
    expect(out.buildings[0]).toMatchObject({ id: 'b1', districtId: 'd1', process: 'main', status: 'built', nameState: 'observed', stack: ['electron', 'react'] })
  })

  it('leaves out the optional fields an older world does not carry', () => {
    const doc = minimal()
    const out = sanitizeWorld(doc, win)
    expect(out).not.toHaveProperty('runtimeHandSet')
    expect(out).not.toHaveProperty('labelTokens')
    expect(out.layout).not.toHaveProperty('round')
  })

  it('does not change the doc it was given', () => {
    const src = fullDoc()
    const before = JSON.stringify(src)
    sanitizeWorld(src, win)
    expect(JSON.stringify(src)).toBe(before)
  })

  it('redacts a secret in a claim text', () => {
    const out = sanitizeWorld(fullDoc(), win)
    expect(out.buildings[0].claims[2].text).toBe('Token [redacted]')
    expect(out.buildings[0].techLabel).toBe('Electron [redacted]')
    expect(JSON.stringify(out)).not.toContain(GH)
  })

  it('never lets the home or userData folder through, in either slash form or any case', () => {
    const toPosix = (s: string): string => s.split('C:\\Users\\dev').join('/home/dev').replace(/\\/g, '/')
    const posixData: SanitizeContext = { root: '/home/dev/repo', home: '/home/dev', userData: '/home/dev/AppData/Roaming/Termpolis' }
    const cases: [WorldDoc, SanitizeContext][] = [[fullDoc(), win], [mapStrings(fullDoc(), toPosix) as WorldDoc, posixData]]
    for (const [doc, ctx] of cases) {
      expect(JSON.stringify(doc)).toContain(ctx.home.replace(/\\/g, '\\\\'))
      const json = JSON.stringify(sanitizeWorld(doc, ctx)).toLowerCase()
      for (const p of [ctx.home, ctx.userData]) {
        const fwd = p.replace(/\\/g, '/').toLowerCase()
        expect(json).not.toContain(fwd)
        expect(json).not.toContain(fwd.replace(/\//g, '\\\\'))
        expect(json).not.toContain(fwd.replace(/\//g, '\\'))
      }
    }
  })
})

describe('fix round 1', () => {
  const john: SanitizeContext = {
    root: 'C:\\Users\\John Smith\\repo', home: 'C:\\Users\\John Smith', userData: 'C:\\Users\\John Smith\\AppData\\Roaming\\Termpolis',
  }

  describe('path fields also get the free-text scan', () => {
    const forms: [string, string][] = [
      ['file:///C:/Users/dev/notes.md', `${OUTSIDE}/notes.md`],
      [' C:\\Users\\dev\\notes.md', ` ${OUTSIDE}/notes.md`],
      ['"C:\\Users\\dev\\notes.md"', `"${OUTSIDE}/notes.md"`],
      ['src/a.ts (from C:\\Users\\dev\\x)', `src/a.ts (from ${OUTSIDE}/x)`],
    ]
    for (const [form, want] of forms) {
      it(`cleans ${JSON.stringify(form)} as an evidence ref, a member and a growth seed`, () => {
        const doc = minimal()
        const b = doc.buildings[0]
        b.how = [claimOf('x', { kind: 'file', ref: form }, { kind: 'symbol', ref: form }, { kind: 'test', ref: form })]
        b.members = [form]
        b.floors[0].members = [form]
        doc.districts[0].members = [form]
        b.growth = { start: 'file', seed: form, folder: form, merged: 0, mergedFiles: 0, folded: 0, cap: 60 }
        const out = sanitizeWorld(doc, win)
        const ob = out.buildings[0]
        expect(ob.how[0].evidence.map((e) => e.ref)).toEqual([want, want, want])
        expect(ob.members).toEqual([want])
        expect(ob.floors[0].members).toEqual([want])
        expect(out.districts[0].members).toEqual([want])
        expect(ob.growth).toMatchObject({ seed: want, folder: want })
        expect(JSON.stringify(out).toLowerCase()).not.toMatch(/users[\\/]+dev/)
      })
    }
  })

  describe('a home folder with a space never leaks its user name', () => {
    const probes: [string, string][] = [
      ['\\\\?\\C:\\Users\\John Smith\\x.ts', `${OUTSIDE}/x.ts`],
      ['\\\\localhost\\C$\\Users\\John Smith\\x', `${OUTSIDE}/x`],
      ['C:\\\\Users\\\\John Smith\\\\x.ts', `${OUTSIDE}/x.ts`],
      ['\\\\?\\C:\\Users\\John Smith\\repo\\src\\a.ts', 'src/a.ts'],
      ['\\\\.\\c:\\users\\john smith', OUTSIDE],
    ]
    for (const [probe, want] of probes) {
      it(`rewrites ${JSON.stringify(probe)}`, () => {
        expect(sanitizeText(`at ${probe} now`, john)).toBe(`at ${want} now`)
        expect(relativePath(probe, john)).toBe(want)
      })
    }

    it('keeps the name out of a whole sanitised world', () => {
      const doc = minimal()
      const all = probes.map(([p]) => p)
      doc.buildings[0].name = all.join(' and ')
      doc.buildings[0].members = all
      doc.buildings[0].how = [claimOf(all.join(', '), ...all.map((ref): Claim['evidence'][number] => ({ kind: 'file', ref })))]
      const json = JSON.stringify(sanitizeWorld(doc, john))
      expect(json).not.toContain('John Smith')
      expect(json.toLowerCase()).not.toContain('john')
    })

    it('matches a UNC root given in long form', () => {
      const ctx = { ...john, root: '\\\\srv\\share\\repo' }
      expect(sanitizeText('in \\\\?\\UNC\\srv\\share\\repo\\b.ts', ctx)).toBe('in b.ts')
      expect(sanitizeText('in \\\\srv\\share\\repo\\c.ts', ctx)).toBe('in c.ts')
    })
  })

  it('keeps only file, symbol, test, commit and person evidence', () => {
    const doc = minimal()
    const kinds = ['file', 'symbol', 'test', 'commit', 'person', 'memory', 'transcriptStep', 'trace', 'metric', 'log', 'deploy'] as const
    doc.buildings[0].how = [claimOf('x', ...kinds.map((kind) => ({ kind, ref: 'r' })))]
    expect(sanitizeWorld(doc, win).buildings[0].how[0].evidence.map((e) => e.kind)).toEqual(['file', 'symbol', 'test', 'commit', 'person'])
  })

  describe('the revealing-path definition', () => {
    const revealing = [
      'C:\\Users\\a\\b.ts', 'D:/w/x.ts', 'x_C:\\Users\\a', '\\\\?\\C:\\a', '\\\\srv\\share\\a', 'file://host/x', 'FILE:///C:/x',
      '~/a', '~ann/a', '/home/a', '/USERS/ann', '/root/x', '/mnt/c', '/media/x', '/Volumes/x', '/tmp/x', '/private/x',
      '/var/log/x', '/opt/x', '/srv/x', '/workspace/x', '/workspaces/x', '(/home/a)', 'HOME=/home/a',
    ]
    const safe = ['/api/users', '/etc/hosts', 'https://example.com/a/b', 'src/a.ts', `${OUTSIDE}/home`, `${OUTSIDE}/x.ts`, 'a~/b', 'x/home/a', '/homework/x', '[redacted]']
    for (const t of revealing) {
      it(`counts ${t} as revealing`, () => {
        expect(isRevealingPath(`see ${t}`)).toBe(true)
        expect(isRevealingPath(sanitizeText(`see ${t}`, win))).toBe(false)
      })
    }
    for (const t of safe) {
      it(`leaves ${t} alone`, () => {
        expect(isRevealingPath(t)).toBe(false)
        expect(sanitizeText(t, win)).toBe(t)
      })
    }

    it('lists every revealing path in a text', () => {
      expect(revealingPaths('a C:\\x.ts and /opt/y, and /api/z')).toEqual(['C:\\x.ts', '/opt/y,'])
      expect(revealingPaths('nothing here')).toEqual([])
    })

    it('rewrites the widened forms', () => {
      expect(sanitizeText('x_C:\\Users\\a\\b.ts', win)).toBe(`x_${OUTSIDE}/b.ts`)
      expect(sanitizeText('at /USERS/ann/f.md', win)).toBe(`at ${OUTSIDE}/f.md`)
      expect(sanitizeText('at ~ann/notes/x.md and ~ann', win)).toBe(`at ${OUTSIDE}/x.md and ~ann`)
      expect(sanitizeText('at file://srv/share/y.md', win)).toBe(`at ${OUTSIDE}/y.md`)
      expect(sanitizeText('at file:///home/dev/repo/src/a.ts', posix)).toBe('at src/a.ts')
      expect(sanitizeText('at file:/home/dev/repo/src/b.ts', posix)).toBe('at src/b.ts')
      expect(sanitizeText('at file:///C:/Users/John Smith/repo/c.ts', john)).toBe('at c.ts')
      expect(sanitizeText('at file:///C:/Users/John%20Smith/x.ts', john)).toBe(`at ${OUTSIDE}/x.ts`)
      expect(sanitizeText('at file:///C:/a%zz/b.ts', win)).toBe(`at ${OUTSIDE}/b.ts`)
      expect(relativePath('~ann', win)).toBe(OUTSIDE)
    })
  })

  it('merges glossary terms that sanitise to the same text instead of dropping one', () => {
    const doc = minimal()
    doc.glossary = { 'C:\\Users\\dev\\repo': 'the project', 'c:/users/dev/repo': 'the folder', constructor: 'builds' }
    expect(sanitizeWorld(doc, win).glossary).toEqual({ '.': 'the project; the folder', constructor: 'builds' })
  })

  it('gives a drive-root or filesystem-root project the key "project"', () => {
    expect(sanitizeWorld(minimal(), { ...win, root: 'C:\\' }).projectKey).toBe('project')
    expect(sanitizeWorld(minimal(), { ...posix, root: '/' }).projectKey).toBe('project')
  })
})

describe('fix round 2: a drive letter glued to a word', () => {
  const prose = [
    'route:/users', 'see:/docs', 'type:/path', 'ns:/x', 'route:/users/:id',
    'http://localhost:3000/api', '12:30', 'a:b', 'git@github.com:org/repo.git',
  ]
  for (const t of prose) {
    it(`leaves ${t} alone`, () => {
      expect(isRevealingPath(`go ${t} now`)).toBe(false)
      expect(sanitizeText(`go ${t} now`, win)).toBe(`go ${t} now`)
    })
  }

  const glued: [string, string][] = [
    ['x_C:\\Users\\a\\b.ts', `x_${OUTSIDE}/b.ts`],
    ['x_C:/Users/a/b.ts', `x_${OUTSIDE}/b.ts`],
    ['x2C:/w/b.ts', `x2${OUTSIDE}/b.ts`],
    ['xC:\\a', `x${OUTSIDE}/a`],
    ['(C:/x)', `(${OUTSIDE}/x)`],
    ['x=C:\\x', `x=${OUTSIDE}/x`],
  ]
  for (const [t, want] of glued) {
    it(`still rewrites ${t}`, () => {
      expect(isRevealingPath(t)).toBe(true)
      expect(sanitizeText(t, win)).toBe(want)
    })
  }

  it('still rewrites a letter-glued home path through the known-folder pass', () => {
    expect(isRevealingPath('xC:/Users/dev/a.ts')).toBe(false)
    expect(sanitizeText('xC:/Users/dev/a.ts', win)).toBe(`x${OUTSIDE}/a.ts`)
    expect(sanitizeText('xC:/Users/dev/repo/src/a.ts', win)).toBe('xsrc/a.ts')
  })
})
