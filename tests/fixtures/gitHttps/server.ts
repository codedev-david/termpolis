// A local git server that wants a sign-in, for proving Lumopolis's private-repository flows with the
// real git: a Node https server on 127.0.0.1 that checks Basic auth itself, then hands the request to
// `git http-backend` (CGI) for a bare repository it makes in `dir`.
//
// - The certificate is self-signed for 127.0.0.1 and made at start, in a fresh temporary folder, with
//   openssl. The key is read into memory and its file deleted at once; the folder (with the certificate,
//   which git trusts through GIT_SSL_CAINFO) is deleted on stop(). No key is ever committed.
// - The user and reply are the caller's (random per run). They live in memory: the check happens here,
//   in Node, and http-backend learns only the user, through REMOTE_USER in its environment. Neither is
//   ever on a command line, in a file or in a log line. Like GitHub, the reply also opens the repository
//   beside the user `x-access-token`, the one a token run gives.
// - Every git this fixture starts has GIT_CONFIG_NOSYSTEM=1 and its own empty GIT_CONFIG_GLOBAL, so no
//   login helper of the computer it runs on is ever involved.
//
// tests/fixtures/gitHttps/fake-helper.sh is the login helper the tests name in their own temporary git
// config (fakeHelperConfig). Paths resolve from the repository root, where vitest and Playwright run.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as https from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface GitHttps {
  /** https://127.0.0.1:<port>/private.git */
  url: string
  /** The server's self-signed certificate, for GIT_SSL_CAINFO. */
  caFile: string
  /** Commits a change in the server's repository (pushed locally, never over the network). */
  pushCommit(msg: string): Promise<void>
  /** Stops the server and deletes the certificate folder. */
  stop(): Promise<void>
}

/** The fake login helper, a POSIX sh script. */
export const FAKE_HELPER_PATH = resolve('tests', 'fixtures', 'gitHttps', 'fake-helper.sh')

/** The git config text that names the fake helper as the login helper (git runs a `!` helper through sh). */
export function fakeHelperConfig(): string {
  return `[credential]\n\thelper = "!sh '${FAKE_HELPER_PATH.replace(/\\/g, '/')}'"\n`
}

/** The user a token run gives git (gitLogin.ts TOKEN_USER); the server takes the reply beside it too. */
const TOKEN_RUN_USER = 'x-access-token'
const REPO = 'private.git'
const isWindows = process.platform === 'win32'

/** openssl: Git for Windows ships one; elsewhere the one on PATH. */
export function opensslBin(): string {
  const gitOpenssl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
  return isWindows && fs.existsSync(gitOpenssl) ? gitOpenssl : 'openssl'
}

/** Why this fixture cannot run here (no openssl, no git, or a git without http-backend), else null. */
export function fixtureToolsMissing(): string | null {
  const ssl = spawnSync(opensslBin(), ['version'], { encoding: 'utf8', windowsHide: true })
  if (ssl.error || ssl.status !== 0) return 'openssl was not found, so the local https git server cannot make its certificate'
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, env: baseEnv(join(tmpdir(), 'no-such.gitconfig')) })
  if (exec.error || exec.status !== 0) return 'git was not found'
  const backend = join(exec.stdout.trim(), isWindows ? 'git-http-backend.exe' : 'git-http-backend')
  if (!fs.existsSync(backend)) return `this git has no http-backend (${backend}), so the local https git server cannot serve`
  return null
}

/** This process's environment without any git or fake-helper variable, plus a config that reads no
 *  system file and the given global file. */
function baseEnv(globalConfig: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !/^(GIT_|FAKE_HELPER_|GCM_)/i.test(k)) env[k] = v
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = globalConfig
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function run(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string> }): Promise<void> {
  return new Promise((done, fail) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, timeout: 60_000 }, (err, _out, stderr) => {
      if (err) fail(new Error(`${cmd} ${args[0]} failed: ${String(stderr).trim() || err.message}`))
      else done()
    })
  })
}

/** Makes the self-signed certificate and key in `folder` with the brief's openssl line; an openssl that
 *  does not know -addext (an old LibreSSL) gets the same certificate from a config file instead. */
async function makeCertificate(folder: string): Promise<{ keyFile: string; caFile: string }> {
  const keyFile = join(folder, 'key.pem')
  const caFile = join(folder, 'cert.pem')
  const env = { ...process.env } as Record<string, string>
  const common = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1']
  const out = ['-keyout', keyFile, '-out', caFile]
  try {
    await run(opensslBin(), [...common, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', ...out], { env })
  } catch {
    const cnf = join(folder, 'req.cnf')
    await fsp.writeFile(
      cnf,
      '[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = 127.0.0.1\n[ext]\nsubjectAltName = IP:127.0.0.1\nbasicConstraints = critical,CA:TRUE\n'
    )
    await run(opensslBin(), [...common, '-config', cnf, ...out], { env })
  }
  return { keyFile, caFile }
}

/** Equal without leaking where it differs. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The user of a Basic auth header whose reply and user are right, else null. */
function signedInUser(header: string | undefined, user: string, reply: string): string | null {
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '')
  if (!m) return null
  const decoded = Buffer.from(m[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  const who = decoded.slice(0, colon)
  if (!same(decoded.slice(colon + 1), reply)) return null
  return who === user || who === TOKEN_RUN_USER ? who : null
}

export async function startGitHttps(opts: { user: string; reply: string; dir: string }): Promise<GitHttps> {
  const tlsDir = await fsp.mkdtemp(join(tmpdir(), 'lumopolis-fixture-tls-'))
  let key: Buffer
  let cert: Buffer
  let caFile: string
  try {
    const made = await makeCertificate(tlsDir)
    caFile = made.caFile
    key = await fsp.readFile(made.keyFile)
    cert = await fsp.readFile(caFile)
    await fsp.rm(made.keyFile, { force: true })
  } catch (e) {
    await fsp.rm(tlsDir, { recursive: true, force: true })
    throw e
  }

  // The repository: a working copy with a few files, pushed (locally) into the bare one the server serves.
  await fsp.mkdir(opts.dir, { recursive: true })
  const fixtureConfig = join(opts.dir, 'fixture.gitconfig')
  await fsp.writeFile(fixtureConfig, '')
  const gitEnv: Record<string, string> = {
    ...baseEnv(fixtureConfig),
    GIT_AUTHOR_NAME: 'Lumopolis Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Lumopolis Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
  }
  const git = (args: string[], cwd?: string): Promise<void> => run('git', args, { cwd, env: gitEnv })
  const bare = join(opts.dir, REPO)
  const work = join(opts.dir, 'work')
  await git(['init', '--bare', '-q', '-b', 'main', bare])
  await git(['--git-dir', bare, 'config', 'uploadpack.allowFilter', 'true'])
  await git(['init', '-q', '-b', 'main', work])
  await fsp.mkdir(join(work, 'src'), { recursive: true })
  await fsp.writeFile(join(work, 'package.json'), JSON.stringify({ name: 'private-fixture', version: '1.0.0', main: 'src/index.ts' }, null, 2) + '\n')
  await fsp.writeFile(join(work, 'src', 'index.ts'), "import { greet } from './greet'\n\nexport const hello = greet('world')\n")
  await fsp.writeFile(join(work, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `hello ${name}`\n}\n')
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'First commit'], work)
  await git(['push', '-q', bare, 'HEAD:refs/heads/main'], work)
  let commits = 1

  const sockets = new Set<Socket>()
  const server = https.createServer({ key, cert }, (req, res) => {
    const who = signedInUser(req.headers.authorization, opts.user, opts.reply)
    if (who === null) {
      req.resume()
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lumopolis fixture"', 'Content-Type': 'text/plain' })
      res.end('Sign in first.\n')
      return
    }
    const u = new URL(req.url ?? '/', 'https://127.0.0.1')
    const env: Record<string, string> = {
      ...baseEnv(fixtureConfig),
      GIT_PROJECT_ROOT: opts.dir,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: decodeURIComponent(u.pathname),
      QUERY_STRING: u.search.replace(/^\?/, ''),
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      REMOTE_USER: who,
      REMOTE_ADDR: '127.0.0.1'
    }
    if (req.headers['content-length'] !== undefined) env.CONTENT_LENGTH = String(req.headers['content-length'])
    if (req.headers['content-encoding'] !== undefined) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding'])
    if (req.headers['git-protocol'] !== undefined) env.GIT_PROTOCOL = String(req.headers['git-protocol'])
    const child = spawn('git', ['http-backend'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => undefined)
    child.stderr.resume()
    req.pipe(child.stdin)
    // The CGI header block comes first: Status and the response headers, then a blank line, then the body.
    let head: Buffer | null = Buffer.alloc(0)
    const fail = (): void => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end()
    }
    child.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (head === null) {
        res.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const text = head.toString('latin1')
      const crlf = text.indexOf('\r\n\r\n')
      const lf = text.indexOf('\n\n')
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1
      if (end < 0) return
      let status = 200
      for (const line of text.slice(0, end).split(/\r?\n/)) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (/^status$/i.test(name)) status = Number.parseInt(value, 10) || 200
        else res.setHeader(name, value)
      }
      res.writeHead(status)
      const body = head.subarray(end)
      head = null
      if (body.length > 0) res.write(body)
    })
    child.stdout.on('end', () => {
      if (head !== null) fail()
      else res.end()
    })
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  const port = (server.address() as AddressInfo).port

  let stopped = false
  return {
    url: `https://127.0.0.1:${port}/${REPO}`,
    caFile,
    async pushCommit(msg: string) {
      commits++
      await fsp.writeFile(join(work, 'src', `change${commits}.ts`), `export const change${commits} = ${commits}\n`)
      await git(['add', '-A'], work)
      await git(['commit', '-q', '-m', msg], work)
      await git(['push', '-q', bare, 'HEAD:refs/heads/main'], work)
    },
    async stop() {
      if (stopped) return
      stopped = true
      await new Promise<void>((done) => {
        server.close(() => done())
        for (const s of sockets) s.destroy()
      })
      await fsp.rm(tlsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
