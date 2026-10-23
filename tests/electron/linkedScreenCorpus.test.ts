// The Linked machines screen's false-removal bar, on real text: no key detector may take anything
// out of this repository's own files, out of listings of them as rg, rg on Windows, rg -C2 and
// cat -n print them, or out of 30 documents built like the ordinary text that carries the most
// base64 (images in markdown, a notebook, lockfiles, a minified bundle, certificate bundles, SVG,
// CSS and HTML). Each is screened whole, with only its last 200,000 or 3,999 characters kept, and
// as the asking side screens such an end: as one the other computer cut. The token rules are
// main's, unchanged, and not asserted here.
//
// Windows CI only, as the coverage gates are: it screens some 25 million characters. Listings are
// made in this process, so no search word goes on a command line. The full offline run, with git
// history, tool logs and node_modules, is the judge's (handoff-v1.54/linked-rework/judge/rerun2/
// p2-corpus-ff25.cjs), for a release check.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { generateKeyPairSync } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

import { screenText } from '../../src/main/aiSecurity'
import { MAX_ERROR_CHARS, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS } from '../../src/main/linkedJobs'

const ROOT = join(__dirname, '..', '..')

/** The ids a key detector names a removal by. No token rule has one of these in screenText. */
const KEY_IDS = new Set(['private_key', 'gpg_block', 'ssh_dsa_pubkey', 'ssh2_private_key', 'openvpn_static_key', 'private_key_b64', 'putty_private_key', 'jwk_private_key', 'xml_private_key'])

interface Doc {
  name: string
  text: string
}

/** The repository's tracked text files under 2 MB, read from disk. */
function repositoryFiles(): Doc[] {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean)
  const docs: Doc[] = []
  for (const name of names) {
    const path = join(ROOT, name)
    let size: number
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      size = st.size
    } catch {
      continue // deleted in the work tree
    }
    if (size > 2 * 1024 * 1024) continue
    const buf = readFileSync(path)
    if (buf.subarray(0, 8000).includes(0)) continue // binary
    docs.push({ name, text: buf.toString('utf8') })
  }
  return docs
}

/** The words a person greps for near keys, each opening a key detector's search. */
const NEEDLES = ['BEGIN', 'PRIVATE KEY', 'kty', 'RSAKeyValue', 'PuTTY', 'LS0t']

/** rg, rg on Windows, rg -C2 and cat -n listings of the files that hold each needle, in documents
 *  of 200,000 characters or so, as an agent pages its tool output. */
function listingsOf(files: Doc[]): Doc[] {
  const docs: Doc[] = []
  for (const needle of NEEDLES) {
    const rg: string[] = []
    const win: string[] = []
    const ctx: string[] = []
    const cat: string[] = []
    for (const f of files) {
      if (!f.text.includes(needle)) continue
      const lines = f.text.split(/\r?\n/)
      const winName = f.name.replace(/\//g, '\\')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(needle)) continue
        rg.push(`${f.name}:${i + 1}:${lines[i]}`)
        win.push(`${winName}:${i + 1}:${lines[i]}`)
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) ctx.push(`${f.name}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'}${lines[j]}`)
        ctx.push('--')
      }
      cat.push(lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'))
    }
    for (const [kind, lines] of [['rg', rg], ['rg on Windows', win], ['rg -C2', ctx], ['cat -n', cat]] as const) {
      let chunk = ''
      let part = 0
      for (const line of lines) {
        chunk += `${line}\n`
        if (chunk.length > 200_000) {
          docs.push({ name: `${kind} ${needle} (${part++})`, text: chunk })
          chunk = ''
        }
      }
      if (chunk) docs.push({ name: `${kind} ${needle} (${part})`, text: chunk })
    }
  }
  return docs
}

/** Bytes from a seed (mulberry32): random to any test of randomness, and the same every run, so a
 *  document that fails fails again. */
function bytesFrom(seed: number): (n: number) => Buffer {
  let a = seed >>> 0
  return (n) => {
    const out = Buffer.alloc(n)
    for (let i = 0; i < n; i++) {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      out[i] = (t ^ (t >>> 14)) & 255
    }
    return out
  }
}

const wrapAt = (s: string, w: number): string[] => s.match(new RegExp(`.{1,${w}}`, 'g')) ?? []

/** 30 documents of the ordinary text that carries the most base64, and names keys besides. */
function ordinaryDocs(): Doc[] {
  const bytes = bytesFrom(20261023)
  const b64 = (n: number): string => bytes(n).toString('base64')
  const hex = (n: number): string => bytes(n).toString('hex')
  const png = (n: number): string => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bytes(n)]).toString('base64')
  const der = (n: number): string => Buffer.concat([Buffer.from([0x30, 0x82, n >> 8, n & 255]), bytes(n)]).toString('base64')
  const spki = (): string => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }) as string
  const PACKAGES = ['pem', 'node-forge', 'jwk-to-pem', 'ssh2', 'openpgp', 'jsonwebtoken', 'asn1.js', 'keytar', 'putty-key', 'react', 'lodash', 'electron']
  const docs: Doc[] = []
  for (let i = 0; i < 5; i++) {
    const images = Array.from({ length: 1 + i }, (_, k) => `![figure ${k + 1}](data:image/png;base64,${png(4_000 + k * 20_000)})`)
    docs.push({
      name: `markdown with images ${i}`,
      text: [
        `# Deploy notes ${i}`,
        'Never commit a `-----BEGIN PRIVATE KEY-----` block: the key lives in the vault, and the',
        'service reads it from `/run/keys/deploy.pem`. A key file looks like this:',
        '```pem',
        '-----BEGIN PRIVATE KEY-----',
        '...',
        '-----END PRIVATE KEY-----',
        '```',
        ...images.flatMap((image, k) => [`## Step ${k + 1}`, 'The dashboard showed this:', '', image, '']),
      ].join('\n'),
    })
  }
  for (let i = 0; i < 5; i++) {
    const cells = Array.from({ length: 2 + i }, (_, k) => ({
      cell_type: 'code',
      execution_count: k + 1,
      metadata: {},
      source: [
        'from cryptography.hazmat.primitives import serialization\n',
        'pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())\n',
        "assert pem.startswith(b'-----BEGIN PRIVATE KEY-----')\n",
        `plot(results[${k}])`,
      ],
      outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': `${png(6_000 + k * 15_000)}\n`, 'text/plain': ['<Figure size 640x480 with 1 Axes>'] } }],
    }))
    docs.push({ name: `notebook ${i}`, text: JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3' } }, nbformat: 4, nbformat_minor: 5 }, null, 1) })
  }
  for (let i = 0; i < 5; i++) {
    const names = Array.from({ length: 300 + i * 250 }, (_, k) => `${PACKAGES[k % PACKAGES.length]}${k < PACKAGES.length ? '' : `-${k}`}`)
    const integrity = (): string => `sha512-${b64(64)}`
    const text =
      i % 3 === 0
        ? JSON.stringify({ name: 'app', lockfileVersion: 3, packages: Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: '1.2.3', resolved: `https://registry.npmjs.org/${n}/-/${n}-1.2.3.tgz`, integrity: integrity() }])) }, null, 2)
        : i % 3 === 1
          ? names.map((n) => `"${n}@^1.2.0":\n  version "1.2.3"\n  resolved "https://registry.yarnpkg.com/${n}/-/${n}-1.2.3.tgz#${hex(20)}"\n  integrity ${integrity()}\n`).join('\n')
          : `lockfileVersion: '9.0'\npackages:\n${names.map((n) => `  ${n}@1.2.3:\n    resolution: {integrity: ${integrity()}}\n`).join('')}`
    docs.push({ name: `lockfile ${i}`, text })
  }
  for (let i = 0; i < 5; i++) {
    const header = `var PEM_HEADER="-----BEGIN PRIVATE KEY-----",PEM_FOOTER="-----END PRIVATE KEY-----";function toPem(e){return PEM_HEADER+"\\n"+e.match(/.{1,64}/g).join("\\n")+"\\n"+PEM_FOOTER}`
    const fonts = Array.from({ length: 1 + i }, (_, k) => `var font${k}="data:font/woff2;base64,${b64(10_000 + k * 25_000)}";`).join('')
    const jwk = 'function toJwk(e){return{kty:"RSA",n:e.n,e:e.e,d:e.d,p:e.p,q:e.q}}'
    docs.push({ name: `minified bundle ${i}`, text: `!function(){"use strict";${header}${fonts}${jwk}var PUBLIC=${JSON.stringify(spki())};}();` })
  }
  for (let i = 0; i < 5; i++) {
    const certs = Array.from({ length: 20 + i * 30 }, (_, k) => [`# Issuer: CN=Example Root CA ${k}, O=Example`, `# Serial: ${hex(16)}`, '-----BEGIN CERTIFICATE-----', ...wrapAt(der(900 + (k % 9) * 37), 64), '-----END CERTIFICATE-----', ''].join('\n'))
    const extra = ['-----BEGIN EC PARAMETERS-----', 'BggqhkjOPQMBBw==', '-----END EC PARAMETERS-----', spki(), '# the matching -----END PRIVATE KEY----- block lives in key.pem, never here'].join('\n')
    docs.push({ name: `certificate bundle ${i}`, text: `${certs.join('\n')}\n${extra}\n` })
  }
  for (let i = 0; i < 5; i++) {
    const kind = i % 3
    const text =
      kind === 0
        ? `<svg xmlns="http://www.w3.org/2000/svg"><image width="64" height="64" href="data:image/png;base64,${png(8_000 + i * 30_000)}"/></svg>`
        : kind === 1
          ? Array.from({ length: 2 + i }, (_, k) => `@font-face{font-family:"Icons${k}";src:url(data:font/woff2;base64,${b64(12_000 + k * 20_000)}) format("woff2")}`).join('\n')
          : [
              '<h2>Key files</h2>',
              '<p>A private key file starts and ends like this; never paste one here.</p>',
              '<pre>-----BEGIN RSA PRIVATE KEY-----',
              '...',
              '-----END RSA PRIVATE KEY-----</pre>',
              `<img alt="screenshot" src="data:image/jpeg;base64,${wrapAt(b64(30_000 + i * 20_000), 76).join('\n')}">`,
            ].join('\n')
    docs.push({ name: `svg, css or html ${i}`, text })
  }
  return docs
}

describe.runIf(process.platform === 'win32')('the Linked screen takes no key out of ordinary text', () => {
  /** What a screen took out by a key detector's id, as `name (how): ids`. */
  const keyRemovals = (name: string, how: string, removed: Record<string, number>): string[] => {
    const ids = Object.keys(removed).filter((id) => KEY_IDS.has(id))
    return ids.length ? [`${name} (${how}): ${ids.join(', ')}`] : []
  }

  /** Every way a document is screened: whole, its last 200,000 and 3,999 characters as the
   *  computer that ran a job keeps them, and each such end as the asking side screens it. Only a
   *  key's tail under its END line is decided by where what is screened starts; every other find
   *  is decided by its own text, looked for from its opener, so a document with no END line is
   *  screened whole only. */
  let endsScreened = 0
  function screenEveryWay(doc: Doc): string[] {
    const found = keyRemovals(doc.name, 'whole', screenText(doc.text).removed)
    if (!doc.text.includes('-----END ') && !doc.text.includes('---- END ')) return found
    for (const keep of [MAX_OUTPUT_CHARS, MAX_ERROR_CHARS - 1]) {
      if (doc.text.length <= keep) continue
      endsScreened++
      const end = screenText(doc.text, keep, SCREEN_LOOKBACK_CHARS)
      found.push(...keyRemovals(doc.name, `last ${keep}`, end.removed))
      const output = keep === MAX_OUTPUT_CHARS
      const arrived = screenText(output ? end.text : `…${end.text}`, output ? MAX_OUTPUT_CHARS : MAX_ERROR_CHARS, SCREEN_LOOKBACK_CHARS, true)
      found.push(...keyRemovals(doc.name, `last ${keep}, arrived`, arrived.removed))
    }
    return found
  }

  /** Each private-key END marker, which a key's tail would end at. */
  const END_RE = /-----END ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY(?: BLOCK)?-----|---- END SSH2 ENCRYPTED PRIVATE KEY ----/g

  /** Cuts just above each private-key END line of `doc`, where an END line named in a sentence or
   *  code once ended a "key's tail" (the round-0 review's FR-1 and FR-2): at every line start in the
   *  4 KB above it as the asking side gets an end an older computer cut, the answer and its error,
   *  and at 12 of them as the doing side keeps such an end. The answer ends 2 KB below the END line,
   *  at a line's end, so the error's end holds it too. An END line with the same 4 KB above it is
   *  swept once. `older`: as such an end arrives too (false for what is a key's tail to that cut). */
  let cutsSwept = 0
  const swept = new Set<string>()
  function sweepAboveEnds(doc: Doc, older = true): string[] {
    const found: string[] = []
    const re = new RegExp(END_RE.source, 'g')
    for (let m = re.exec(doc.text); m !== null; m = re.exec(doc.text)) {
      const at = m.index
      const context = doc.text.slice(Math.max(0, at - 4096), at + m[0].length)
      if (swept.has(context)) continue
      swept.add(context)
      const nl = doc.text.indexOf('\n', at + 2048)
      const answer = doc.text.slice(0, nl === -1 ? doc.text.length : nl + 1)
      // line starts, after a line break or a `\n` escape (a test's text written on one line)
      const starts: number[] = []
      for (let i = Math.max(0, at - 4096); i < at; i++) {
        const c = doc.text.charCodeAt(i - 1)
        if (i === 0 || c === 10 || (c === 110 && doc.text.charCodeAt(i - 2) === 92)) starts.push(i)
      }
      const step = Math.max(1, Math.ceil(starts.length / 12))
      starts.forEach((cut, k) => {
        const kept = answer.slice(cut)
        const how = `cut at ${cut}, END line at ${at}`
        cutsSwept++
        if (k % step === 0) found.push(...keyRemovals(doc.name, `${how}, doing side`, screenText(answer, kept.length, SCREEN_LOOKBACK_CHARS).removed))
        if (!older) return
        found.push(...keyRemovals(doc.name, `${how}, arrived`, screenText(kept, MAX_OUTPUT_CHARS, SCREEN_LOOKBACK_CHARS, true).removed))
        const error = `…${kept.slice(-(MAX_ERROR_CHARS - 1))}`
        found.push(...keyRemovals(doc.name, `${how}, error arrived`, screenText(error, MAX_ERROR_CHARS, SCREEN_LOOKBACK_CHARS, true).removed))
      })
    }
    return found
  }

  /** Reports whose every line ends in a hash, an id or a digest, under a sentence that names an
   *  END line (judge 1's and the round-0 review's shapes); and lists and dumps above a bare END line
   *  in the middle of an answer (judge 1's C-shapes), which are a key's tail to no cut: `bare`. */
  function reportDocs(): Array<Doc & { bare: boolean }> {
    const bytes = bytesFrom(20261024)
    const b64 = (n: number): string => bytes(n).toString('base64')
    const hex = (n: number): string => bytes(n).toString('hex')
    const prose = (n: number): string => {
      let s = ''
      for (let i = 0; s.length < n; i++) s += `Step ${i}: the build copied the assets and wrote out/report-${i}.txt.\n`
      return s.slice(0, n)
    }
    const LINES: Array<(i: number) => string> = [
      (i) => `  ok ${i} - fixture tests/fixtures/sample-${i}.pem sha256=${hex(32)}`,
      (i) => `  commit ${i}: ${hex(20)}`,
      () => `  - sha384-${b64(48)}`,
      () => `      "integrity": "sha512-${b64(64)}",`,
      () => `  integrity sha512-${b64(64)}`,
      () => `  "${hex(32)}",`,
      () => `  pin-sha256="${b64(32)}";`,
      (i) => `app-${i}  latest  sha256:${hex(32)}`,
      (i) => `github.com/acme/mod${i} v1.${i}.0 h1:${b64(32)}`,
    ]
    const SUMMARIES = [
      'Summary: none of the fixtures ends with -----END PRIVATE KEY-----; all checks passed.',
      '  expected the file to end with "-----END RSA PRIVATE KEY-----"',
      'grep found -----END OPENSSH PRIVATE KEY----- in 0 files',
    ]
    const docs: Array<Doc & { bare: boolean }> = []
    LINES.forEach((line, k) => {
      const lines = Array.from({ length: 150 }, (_, i) => line(i + 1)).join('\n')
      docs.push({ name: `report ${k}`, text: `${prose(5_000)}Here is the report.\n${lines}\n${SUMMARIES[k % 3]}\nDone.\n${prose(3_000)}`, bare: false })
    })
    const wrapped = wrapAt(b64(6_000), 64).join('\n')
    const C = [
      `const PEM = [\n${Array.from({ length: 40 }, () => `  '${b64(48)}',`).join('\n')}\n  '-----END PRIVATE KEY-----',\n].join('\\n')\n`,
      `Screenshot:\n${wrapped}\n-----END PRIVATE KEY-----\n(the footer the parser expects)\n`,
      `cat <<EOF\n${Array.from({ length: 60 }, () => b64(48)).join('\n')}\n-----END PRIVATE KEY-----\nEOF\n`,
      `const DIGESTS = \`\n${Array.from({ length: 60 }, () => b64(32)).join('\n')}\n-----END PRIVATE KEY-----\`\n`,
    ]
    C.forEach((shape, k) => docs.push({ name: `C-shape ${k}`, text: `${prose(30_000)}${shape}${prose(20_000)}`, bare: true }))
    return docs
  }

  it('takes nothing out where a cut falls just above an END line in this repository, or in reports and dumps above one', () => {
    const files = repositoryFiles()
    expect(files.length).toBeGreaterThan(1_000)
    const found = files.flatMap((f) => sweepAboveEnds(f))
    const reports = reportDocs()
    expect(reports).toHaveLength(13)
    for (const doc of reports) {
      expect(screenText(doc.text).removed, doc.name).toEqual({})
      found.push(...sweepAboveEnds(doc, !doc.bare))
    }
    expect(found).toEqual([])
    // Not a pass by default: the repository has END lines named in its tests and docs, swept.
    expect(cutsSwept).toBeGreaterThan(1_000)
  }, 180_000)

  it('finds none in this repository, in listings of it, or in 30 documents dense with base64', () => {
    const files = repositoryFiles()
    // Not a pass by default: git listed the repository and the files were read.
    expect(files.length).toBeGreaterThan(1_000)
    expect(files.reduce((n, f) => n + f.text.length, 0)).toBeGreaterThan(15_000_000)
    const listings = listingsOf(files)
    expect(listings.length).toBeGreaterThan(20)
    const ordinary = ordinaryDocs()
    expect(ordinary).toHaveLength(30)
    expect(ordinary.filter((d) => d.text.length > MAX_OUTPUT_CHARS).length).toBeGreaterThan(5)
    const found = [...files, ...listings, ...ordinary].flatMap(screenEveryWay)
    expect(found).toEqual([])
    // ...and ends were screened, each as the doing side keeps it and as the asking side gets it.
    expect(endsScreened).toBeGreaterThan(40)
  }, 180_000)

  it('takes a real key out of the same kinds of document, the ways it screens them above', () => {
    // The screen above is not blind: a fresh key printed after a notebook's output, or after a
    // lockfile, is found whole, in the end kept, and in an end an older computer cut unscreened.
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const ordinary = ordinaryDocs()
    for (const doc of [
      { name: 'notebook with a key', text: `${ordinary[5].text}\n${JSON.stringify({ text: pem })}` },
      { name: 'lockfile then a key', text: `${ordinary[10].text}\n${pem}` },
    ]) {
      expect(screenText(doc.text).removed, doc.name).toEqual({ private_key: 1 })
      expect(screenText(doc.text, MAX_ERROR_CHARS - 1, SCREEN_LOOKBACK_CHARS).removed, doc.name).toEqual({ private_key: 1 })
      expect(screenText(`…${doc.text.slice(-(MAX_ERROR_CHARS - 1))}`, MAX_ERROR_CHARS, SCREEN_LOOKBACK_CHARS, true).removed, doc.name).toEqual({ private_key: 1 })
      expect(screenEveryWay(doc), doc.name).toEqual([`${doc.name} (whole): private_key`, `${doc.name} (last ${MAX_ERROR_CHARS - 1}): private_key`])
    }
  })
})
