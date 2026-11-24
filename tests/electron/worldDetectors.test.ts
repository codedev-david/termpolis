import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fill, linear } from './_linearTime'
import { MAX_GRAPH_FILE_CHARS } from '../../src/main/codeGraph'
import {
  DEFAULT_DETECTORS,
  MAX_DETECT_FILE_CHARS,
  detectBoundaries,
  stripComments,
  type Boundary,
  type Detector
} from '../../src/main/world/detectors'

const F = 'src/main/x.ts'

function run(text: string): Boundary[] {
  return detectBoundaries(F, text)
}

function b(kind: Boundary['kind'], key: string, side: Boundary['side'], line = 1): Boundary {
  return { kind, key, side, file: F, line }
}

describe('constants', () => {
  it('mirrors the code graph file-size cap', () => {
    expect(MAX_DETECT_FILE_CHARS).toBe(MAX_GRAPH_FILE_CHARS)
  })
  it('exposes the default detector list', () => {
    expect(DEFAULT_DETECTORS).toHaveLength(6)
  })
})

describe('ipc', () => {
  it('provides on ipcMain and consumes on ipcRenderer', () => {
    expect(run(`ipcMain.handle('memory:count', () => 1)`)).toEqual([b('ipc', 'memory:count', 'provide')])
    expect(run(`ipcMain.on("a:b", f)`)).toEqual([b('ipc', 'a:b', 'provide')])
    expect(run(`ipcRenderer.invoke('memory:count')`)).toEqual([b('ipc', 'memory:count', 'consume')])
    expect(run('ipcRenderer.send(`x:y`)')).toEqual([b('ipc', 'x:y', 'consume')])
  })
  it('provides a preload bridge and consumes its window reads once per name', () => {
    expect(run(`contextBridge.exposeInMainWorld('api', api)`)).toEqual([b('ipc', 'window.api', 'provide')])
    expect(run(`contextBridge.exposeInMainWorld(name, api)`)).toEqual([])
    expect(run(`window.api.a()
const x = window.api.b
window.other.c()`)).toEqual([
      b('ipc', 'window.api', 'consume'),
      b('ipc', 'window.other', 'consume', 3)
    ])
    // Only the bare window global: a property or a longer identifier is not it.
    expect(run(`self.window.api.a(); mywindow.api.b(); $window.c`)).toEqual([])
  })
})

describe('processes', () => {
  it('detects utilityProcess.fork with new URL', () => {
    expect(run(`utilityProcess.fork(new URL('./memoryHost.js', import.meta.url))`)).toEqual([
      b('fork', 'memoryHost', 'consume')
    ])
  })
  it('detects fork with path.join and a bare string', () => {
    expect(run(`utilityProcess.fork(path.join(__dirname, 'memoryHost.js'))`)).toEqual([
      b('fork', 'memoryHost', 'consume')
    ])
    expect(run(`utilityProcess.fork('a/b/host')`)).toEqual([b('fork', 'host', 'consume')])
  })
  it('keys a multi-segment path.join by its last literal', () => {
    expect(run(`utilityProcess.fork(join(__dirname, 'workers', 'host.js'))`)).toEqual([b('fork', 'host', 'consume')])
    expect(run(`new Worker(path.join(__dirname, '..', 'x.js'))`)).toEqual([b('worker', 'x', 'consume')])
    expect(run(`utilityProcess.fork(join(__dirname, 'a', file))`)).toEqual([])
  })
  it('detects new Worker', () => {
    expect(run(`const w = new Worker(new URL('./embedWorker.js', import.meta.url))`)).toEqual([
      b('worker', 'embedWorker', 'consume')
    ])
  })
  it('detects spawn and execFile', () => {
    expect(run(`spawn('claude', ['-p'])`)).toEqual([b('spawn', 'claude', 'consume')])
    expect(run(`await execFile('git', ['status'])`)).toEqual([b('spawn', 'git', 'consume')])
    expect(run(`execFileSync("node")`)).toEqual([b('spawn', 'node', 'consume')])
  })
  it('ignores non-literal arguments', () => {
    expect(run(`spawn(cmd, [])`)).toEqual([])
    expect(run(`new Worker(file)`)).toEqual([])
  })
  it('takes a sibling script URL as the target of a fork through a variable', () => {
    const url = (name: string): string => `new URL('./${name}', import.meta.url)`
    expect(run(`const p = ${url('host.js')}
utilityProcess.fork(p)`)).toEqual([b('fork', 'host', 'consume')])
    // Even when another file does the forking (createTransport(p)), and for .cjs/.mjs scripts.
    expect(run(`start(${url('a.cjs')}, ${url('b.mjs')})`)).toEqual([b('fork', 'a', 'consume'), b('fork', 'b', 'consume')])
    // A file that creates a Worker starts its sibling scripts as workers.
    expect(run(`const p = ${url('w.js')}
new Worker(p)`)).toEqual([b('worker', 'w', 'consume')])
    // One boundary per target: the literal call is not repeated, nor a second URL of it.
    expect(run(`new Worker(
  ${url('w.js')})
const again = ${url('w.js')}`)).toEqual([b('worker', 'w', 'consume')])
    expect(run(`spawn('host')
${url('host.js')}`)).toEqual([b('spawn', 'host', 'consume'), b('fork', 'host', 'consume', 2)])
    // Not a script, not a sibling, or not module-relative.
    expect(run(`${url('icon.png')}; new URL('../x.js', import.meta.url); new URL('./x.js', base)`)).toEqual([])
  })
})

describe('message ports and child_process', () => {
  it('detectProcesses finds MessageChannel ports, exec, execSync and child_process.fork', () => {
    expect(run(`const ch = new MessageChannel()
const { port1 } = ch
port1.postMessage(1)
workerPort.postMessage(2)
mainPort2.postMessage(3)`)).toEqual([
      b('port', 'ch', 'provide'),
      b('port', 'port1', 'consume', 3),
      b('port', 'workerPort', 'consume', 4),
      b('port', 'mainPort2', 'consume', 5)
    ])
    // Not a port: a name that merely ends in "port", or a member of something else.
    expect(run(`report.postMessage(1); a.port.postMessage(3)`)).toEqual([])
    expect(run(`import { exec, execSync as sh, fork, spawn as sp } from 'node:child_process'
exec('git status')
sh("ls")
fork('./w.js')
sp('x')`)).toEqual([
      b('spawn', 'git status', 'consume', 2),
      b('spawn', 'ls', 'consume', 3),
      b('spawn', './w.js', 'consume', 4)
    ])
    expect(run(`const { exec: run, $q: q, fork } = require('child_process')
run('a')
q('no')
fork(\`b\`)`).map((x) => x.key)).toEqual(['a', 'b'])
    expect(run(`import * as cp from 'child_process'
cp.exec('x')
cp.execSync('y')
cp.fork('z')`).map((x) => x.key)).toEqual(['x', 'y', 'z'])
    expect(run(`import cp from 'child_process'
cp.exec('d')`).map((x) => x.key)).toEqual(['d'])
    expect(run(`const $cp = require('child_process')
$cp.exec('e')`).map((x) => x.key)).toEqual(['e'])
    expect(run(`const cp = require('node:child_process')
child_process.fork('./f.js')`).map((x) => x.key)).toEqual(['./f.js'])
  })
  it('does not count exec or fork that does not come from child_process', () => {
    expect(run(`const m = /a(b)/.exec('abc'); db.exec('create table x'); exec('ls'); fork('./w.js')`)).toEqual([])
    // child_process is imported, but these are not its functions or are member calls or variable arguments.
    expect(run(`import { spawn } from 'child_process'
db.exec('x'); re.exec('y'); exec('z'); other.fork('w'); cp.exec('v')`)).toEqual([])
    expect(run(`import { exec } from 'child_process'
exec(cmd); exec()`)).toEqual([])
  })
  it('reads a destructured require or import with spaces, tabs or a line break around the name', () => {
    expect(run(`const { exec: go } = require(  'child_process'  )
go('a')`).map((x) => x.key)).toEqual(['a'])
    expect(run(`const {\n  execSync,\n  fork\n} = require(\n\t"node:child_process")
execSync('b'); fork('c')`).map((x) => x.key)).toEqual(['b', 'c'])
    expect(run(`import {\n  exec\n}\nfrom\n  'child_process'
exec('d')`).map((x) => x.key)).toEqual(['d'])
  })
  // A require( with no module after a long run of spaces: the two `\s*` in a row split the run every way (3 s on main
  // at 50k). Reading 8 times the run takes under 24 times as long (see _linearTime). The file names child_process in
  // code (a comment is blanked first), so the rule runs. n is 32K so that 8n stays under MAX_DETECT_FILE_CHARS, over
  // which detectBoundaries returns [] at once; the call after the run must be found, on the file's last line, which
  // proves both sizes were read to the end. One test per input, so each stays well inside the test timeout under load.
  const N = 32 * 1024
  const after = "\nchild_process.exec('end')"
  const atEnd = (found: Boundary[], src: string): void => {
    expect(src.length).toBeLessThan(MAX_DETECT_FILE_CHARS)
    expect(found).toEqual([b('spawn', 'end', 'consume', src.split('\n').length)])
  }
  const hostile: [string, (pad: string) => (n: number) => string][] = [
    ['require', (pad) => (n) => `child_process.x = 1\nconst {}=require(${fill(pad, n)}${after}`],
    ['import', (pad) => (n) => `child_process.x = 1\nimport {}from${fill(pad, n)}${after}`]
  ]
  it.each(hostile.flatMap(([form, make]) => [' ', '\n', '\r\n'].map((pad) => [form, JSON.stringify(pad), make(pad)] as const)))(
    'reads a destructured %s with no module after a long run of %s in time linear in the run',
    (form, pad, make) => linear(make, run, N, `${form} ${pad}`, atEnd)
  )
})

describe('http', () => {
  it('detects outbound hosts only', () => {
    expect(run(`fetch('https://api.example.com/x')`)).toEqual([b('http-out', 'api.example.com', 'consume')])
    expect(run(`axios.post("http://localhost:8080/y", d)`)).toEqual([b('http-out', 'localhost', 'consume')])
    expect(run(`https.get('https://h.io?q=1')`)).toEqual([b('http-out', 'h.io', 'consume')])
  })
  it('skips a non-literal host', () => {
    expect(run('fetch(`https://${host}/x`)')).toEqual([])
    expect(run('fetch(`https://api.${zone}.com/x`)')).toEqual([])
    expect(run(`fetch('https://h.io')`)).toEqual([b('http-out', 'h.io', 'consume')])
  })
  it('detects listen ports', () => {
    expect(run(`server.listen(9315, '127.0.0.1')`)).toEqual([b('http-listen', '9315', 'provide')])
  })
  it('ignores a non-numeric listen', () => {
    expect(run(`server.listen(port)`)).toEqual([])
  })
})

describe('env', () => {
  it('provides keys assigned in an env object', () => {
    expect(run(`spawnIt({ env: { ...process.env, ANTHROPIC_BASE_URL: url, 'FOO_BAR': 1, lower: 2 } })`)).toEqual([
      b('env', 'ANTHROPIC_BASE_URL', 'provide'),
      b('env', 'FOO_BAR', 'provide')
    ])
  })
  it('provides keys assigned on process.env, consumes reads', () => {
    expect(run(`process.env.ANTHROPIC_BASE_URL = x`)).toEqual([b('env', 'ANTHROPIC_BASE_URL', 'provide')])
    expect(run(`process.env['A_B'] = x`)).toEqual([b('env', 'A_B', 'provide')])
    expect(run(`const a = process.env.ANTHROPIC_BASE_URL`)).toEqual([b('env', 'ANTHROPIC_BASE_URL', 'consume')])
    expect(run(`if (process.env["A_B"] === 'x') {}`)).toEqual([b('env', 'A_B', 'consume')])
  })
  it('keeps top-level keys when a value is a template literal with braces', () => {
    expect(run('x({ env: { URL: `http://${host}`, API_KEY: k } })')).toEqual([
      b('env', 'URL', 'provide'),
      b('env', 'API_KEY', 'provide')
    ])
  })
  it('keeps top-level keys around a nested object and ignores nested keys', () => {
    expect(run(`x({ env: { A_B: 1, NESTED: { INNER: 2, 'Q}': 3 }, C_D: "}", E_F: 'it\\'s {' } })`)).toEqual([
      b('env', 'A_B', 'provide'),
      b('env', 'NESTED', 'provide'),
      b('env', 'C_D', 'provide'),
      b('env', 'E_F', 'provide')
    ])
    expect(run(`x({ env: {
  A_B: 1,
  N: {
    INNER: 2,
  },
  C_D: 3,
} })`)).toEqual([
      b('env', 'A_B', 'provide', 2),
      b('env', 'N', 'provide', 3),
      b('env', 'C_D', 'provide', 6)
    ])
  })
  it('survives an unterminated env object or string', () => {
    expect(run(`env: { A_B: 1, C_D: 'oops`)).toEqual([b('env', 'A_B', 'provide'), b('env', 'C_D', 'provide')])
  })
  it('reports env-object keys on their own line', () => {
    expect(run(`x({\n  env: {\n    A_B: 1,\n  },\n})`)).toEqual([b('env', 'A_B', 'provide', 3)])
  })
})

describe('mcp', () => {
  it('detects a server with a name', () => {
    expect(run(`const s = new McpServer({ name: 'termpolis', version: '1' })`)).toEqual([
      b('mcp', 'termpolis', 'provide')
    ])
  })
  it('falls back to "server" without a name', () => {
    expect(run(`new McpServer(opts)`)).toEqual([b('mcp', 'server', 'provide')])
    expect(run(`new McpServer({ version: '1' })`)).toEqual([b('mcp', 'server', 'provide')])
  })
  it('detects mcpServers config', () => {
    expect(run(`const c = { mcpServers: { termpolis: { command: 'x' } } }`)).toEqual([
      b('mcp', 'termpolis', 'consume')
    ])
    expect(run(`mcpServers = { "my-srv": {} }`)).toEqual([b('mcp', 'my-srv', 'consume')])
    expect(run(`mcpServers: {}`)).toEqual([b('mcp', 'server', 'consume')])
  })
})

describe('watch', () => {
  it('uses the literal path as key', () => {
    expect(run(`fs.watch('/tmp/a.json', cb)`)).toEqual([b('watch', '/tmp/a.json', 'consume')])
    expect(run(`chokidar.watch("src")`)).toEqual([b('watch', 'src', 'consume')])
    expect(run(`fs.watchFile('x.log', cb)`)).toEqual([b('watch', 'x.log', 'consume')])
  })
  it('uses "*" for a non-literal path', () => {
    expect(run(`fs.watch(dir, cb)`)).toEqual([b('watch', '*', 'consume')])
  })
})

describe('comments, strings and lines', () => {
  it('ignores matches in line and block comments, even with strings inside', () => {
    expect(run(`// ipcMain.handle('a:b', f)\n/* spawn('git') */ /* "fetch('https://x.io')" */`)).toEqual([])
  })
  it('keeps // inside string literals', () => {
    expect(run(`fetch('https://api.example.com/x') // trailing`)).toEqual([
      b('http-out', 'api.example.com', 'consume')
    ])
    expect(run('fetch(`https://t.example.com/${a}`)')).toEqual([b('http-out', 't.example.com', 'consume')])
    expect(run(`const s = "it\\"s // not a comment"; spawn('git')`)).toEqual([b('spawn', 'git', 'consume')])
  })
  it('survives an unterminated string and an unterminated block comment', () => {
    expect(run(`const s = 'oops\nspawn('git')`)).toEqual([b('spawn', 'git', 'consume', 2)])
    expect(run(`spawn('a')\n/* never closed\nspawn('b')`)).toEqual([b('spawn', 'a', 'consume')])
  })
  it('mis-stripping a regex literal only misses things, never throws', () => {
    expect(run(String.raw`const r = /\/\//;` + `\nspawn('git')`)).toEqual([b('spawn', 'git', 'consume', 2)])
  })
  it('keeps line numbers right across a multi-line block comment', () => {
    const text = `/*\n one\n two\n*/\nspawn('git')\n`
    expect(run(text)).toEqual([b('spawn', 'git', 'consume', 5)])
  })
  it('stripComments preserves length and newlines', () => {
    const text = `a // c\n/* x\ny */ b`
    const out = stripComments(text)
    expect(out).toHaveLength(text.length)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toBe('a     \n    \n     b')
  })
  it('passes the file argument through unchanged', () => {
    expect(detectBoundaries('C:\\weird\\path.ts', `spawn('git')`)[0].file).toBe('C:\\weird\\path.ts')
  })
})

describe('detectBoundaries', () => {
  it('returns [] over the size cap and honours an override', () => {
    const big = `spawn('git')\n` + ' '.repeat(600 * 1024)
    expect(detectBoundaries(F, big)).toEqual([])
    expect(detectBoundaries(F, `spawn('git')`, undefined, 5)).toEqual([])
    expect(detectBoundaries(F, `spawn('git')`, undefined, 100)).toHaveLength(1)
  })
  it('runs custom detectors on comment-stripped text', () => {
    const custom: Detector = (file, text) => [{ kind: 'port', key: text.trim(), side: 'provide', file, line: 1 }]
    expect(detectBoundaries(F, 'a // gone', [custom])).toEqual([b('port', 'a', 'provide')])
  })
  it('scans a fixture file end to end', () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'world', 'main-sample.fixture.txt'), 'utf8')
    expect(
      detectBoundaries(F, text)
        .map((x) => `${x.kind}:${x.key}:${x.side}:${x.line}`)
        .sort()
    ).toEqual([
      'env:ANTHROPIC_BASE_URL:consume:9',
      'env:ANTHROPIC_BASE_URL:provide:6',
      'fork:memoryHost:consume:4',
      'ipc:memory:count:provide:3'
    ])
  })
})
