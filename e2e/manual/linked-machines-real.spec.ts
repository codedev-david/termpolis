/**
 * Linked machines, for real: two Termpolis instances on this computer, linked
 * through the production relay, each asking the other's REAL agents for work
 * through the `linked_machines` MCP tool.
 *
 * Every hosted-CI layer stops short of this. The unit and in-process suites
 * use an in-memory relay and a fake `deliver`; e2e/linked-machines.spec.ts
 * drives one instance over a dead relay. Only this spec dials
 * wss://relay.termpolis.com from two bridges at once, compares safety words
 * that two separate processes derived, and gets answers back from headless
 * agents in both directions: Claude A -> B, Claude B -> A, and Codex B -> A.
 * So it is manual (see ./README.md): it needs the live relay plus the CLIs
 * installed and signed in, and each run spends a few tokens. The Codex leg is
 * skipped, with the reason, when OpenAI cannot be reached from this network.
 *
 *   npx playwright test -c playwright.manual.config.ts e2e/manual/linked-machines-real.spec.ts
 *
 * Pairing is driven through each window's `window.linked`, the same calls the
 * pane makes, because a click on a pending card is a weaker signal than the
 * statuses main returns. Each step is screenshotted from the real pane as
 * evidence. Screenshots and the MCP answers are written to $LINKED_REAL_OUT,
 * else to test-results/linked-real. TERMPOLIS_E2E_SKIP_BUILD=1 reuses `out/`.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import https from 'https'
import path from 'path'
import { e2eLaunchArgs, e2eUserDataDir, dismissOnboarding } from '../helpers/launch'

const PRODUCTION_RELAY = 'wss://relay.termpolis.com'
const PROMPT = 'Reply with exactly the single word PONG and nothing else.'
const NAME_OF_A = 'box-a'
const NAME_OF_B = 'box-b'
const OUT = process.env.LINKED_REAL_OUT || path.resolve('test-results', 'linked-real')

interface Grants {
  run: boolean
  write: boolean
}
interface MachineView {
  ref: string
  name: string
  online: boolean
  confirmed: boolean
  phrase?: string
  grants: Grants
}
interface ActivityView {
  id: string
  direction: 'in' | 'out'
  machine: string
  agent: string
  status: string
  durationMs?: number
}
interface StatusView {
  enabled: boolean
  running: boolean
  relayUrl: string
  thisMachine: string
  code: { code: string; expiresAt: number } | null
  joining: boolean
  machines: MachineView[]
  activity: ActivityView[]
}
type IpcResult<T> = { success: true; data: T } | { success: false; error: string }
type ToolAnswer = Record<string, unknown>

interface Instance {
  name: string
  app: ElectronApplication
  page: Page
  userData: string
}

let a: Instance
let b: Instance
let rpcId = 0
/** The id both sides know this link by: the host's device id for the joiner. */
let linkId = ''

/** Everything worth keeping from a run, flushed after each step so a failure
 *  still leaves what happened before it. */
const evidence: Record<string, unknown> = {}

function flushEvidence(): void {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'mcp-results.json'), JSON.stringify(evidence, null, 2))
}

/**
 * The environment of a Termpolis started from the Start menu. This harness
 * usually runs inside an agent's terminal, often a Termpolis one, and the
 * instances would otherwise hand that session's markers to every agent they
 * start: CLAUDECODE and the CLAUDE_CODE_* set, and the other Termpolis's
 * Headroom proxy as ANTHROPIC_BASE_URL. A real launch inherits none of them.
 * A user's own ANTHROPIC_BASE_URL is kept: only the copy that is the proxy
 * marker goes, which is the rule the app itself applies (proxySupervisor.ts).
 * No test shims and no TERMPOLIS_TEST_AGENTS: the agents here are the real ones.
 */
function desktopLaunchEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') delete env[k]
  }
  if (env.TERMPOLIS_HEADROOM_PROXY && env.ANTHROPIC_BASE_URL === env.TERMPOLIS_HEADROOM_PROXY) delete env.ANTHROPIC_BASE_URL
  for (const k of [
    'TERMPOLIS_HEADROOM_PROXY',
    'TERMPOLIS_SHELL_INTEGRATION',
    'TERMPOLIS_RELAY_URL',
    'TERMPOLIS_TEST_AGENTS',
    'TERMPOLIS_TEST_SHIM_DIR',
    'TERMPOLIS_TEST_USER_DATA_DIR',
    'TERMPOLIS_LINKED_JOB',
  ]) {
    delete env[k]
  }
  return { ...env, NODE_ENV: 'test' }
}

async function launch(name: string, label: string): Promise<Instance> {
  const app = await electron.launch({ args: e2eLaunchArgs(label), env: desktopLaunchEnv() })
  // Main's console, per instance: the only record of a bridge or main fault.
  fs.mkdirSync(OUT, { recursive: true })
  const log = fs.createWriteStream(path.join(OUT, `${name.toLowerCase()}-main.log`))
  app.process().stdout?.on('data', (d: Buffer) => log.write(d))
  app.process().stderr?.on('data', (d: Buffer) => log.write(d))
  app.process().on('exit', (code, signal) => log.write(`\n[process exited: code=${code} signal=${signal}]\n`))
  const page = await app.firstWindow()
  page.on('crash', () => log.write('\n[renderer crashed]\n'))
  page.on('close', () => log.write('\n[window closed]\n'))
  await dismissOnboarding(page)
  await page.waitForLoadState('domcontentloaded')
  return { name, app, page, userData: e2eUserDataDir(label) }
}

/** One `window.linked` method, as the pane calls it. Throws main's refusal. */
async function linked(inst: Instance, method: string, ...args: unknown[]): Promise<StatusView> {
  const res = (await inst.page.evaluate(
    ({ method, args }) => {
      const api = (window as unknown as { linked: Record<string, (...a: unknown[]) => Promise<unknown>> }).linked
      return api[method](...args)
    },
    { method, args },
  )) as IpcResult<StatusView>
  if (!res.success) throw new Error(`${inst.name}: linked.${method} refused: ${res.error}`)
  return res.data
}

const status = (inst: Instance): Promise<StatusView> => linked(inst, 'status')

/** Keep every `linked:event` a window receives, for the assertions and for
 *  the failure message when a wait runs out. */
async function recordEvents(inst: Instance): Promise<void> {
  await inst.page.evaluate(() => {
    const w = window as unknown as {
      __linkedEvents?: unknown[]
      linked: { onEvent(cb: (e: unknown) => void): () => void }
    }
    if (w.__linkedEvents) return
    const seen: unknown[] = []
    w.__linkedEvents = seen
    w.linked.onEvent((e) => seen.push(e))
  })
}

async function events(inst: Instance): Promise<Array<Record<string, unknown>>> {
  return inst.page.evaluate(
    () => ((window as unknown as { __linkedEvents?: Array<Record<string, unknown>> }).__linkedEvents ?? []).slice(),
  )
}

/** Both sides' statuses and events, for a failure message. */
async function snapshot(): Promise<string> {
  const side = async (inst: Instance) => ({
    status: await status(inst).catch((e: unknown) => String(e)),
    events: await events(inst).catch((e: unknown) => String(e)),
  })
  return JSON.stringify({ a: await side(a), b: await side(b) }, null, 2)
}

/** Poll until `probe` returns something truthy, and return it. */
async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const why = lastError ? ` (last error: ${String(lastError)})` : ''
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${why}\n${await snapshot()}`)
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

/** One `linked_machines` call through this instance's own MCP server: the
 *  path an agent's MCP client takes (POST /mcp, bearer token from userData). */
async function tool(inst: Instance, args: Record<string, unknown>): Promise<ToolAnswer> {
  const port = await waitFor(`${inst.name}'s mcp-port`, async () => readTrimmed(path.join(inst.userData, 'mcp-port')), 30_000)
  const token = readTrimmed(path.join(inst.userData, 'mcp-token'))
  expect(token, `${inst.name} wrote no mcp-token`).toBeTruthy()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name: 'linked_machines', arguments: args },
    }),
  })
  expect(res.status, `${inst.name} MCP HTTP status`).toBe(200)
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }
  expect(body.error, `${inst.name} JSON-RPC error`).toBeUndefined()
  expect(body.result?.isError, `${inst.name} tool error: ${body.result?.content?.[0]?.text}`).toBeFalsy()
  return JSON.parse(body.result?.content?.[0]?.text ?? 'null') as ToolAnswer
}

/** `run`, then `result` until the job is no longer running: start, then
 *  check, as an agent does under its MCP client's 60 s limit. Bounded. */
async function runToEnd(
  inst: Instance,
  args: { machine: string; agent: string },
): Promise<{ final: ToolAnswer; calls: ToolAnswer[]; ms: number }> {
  const t0 = Date.now()
  const calls: ToolAnswer[] = []
  let reply = await tool(inst, { action: 'run', ...args, prompt: PROMPT, waitSec: 50 })
  calls.push(reply)
  for (let i = 0; i < 8 && reply.status === 'running' && typeof reply.jobId === 'string'; i++) {
    reply = await tool(inst, { action: 'result', jobId: reply.jobId, waitSec: 50 })
    calls.push(reply)
  }
  return { final: reply, calls, ms: Date.now() - t0 }
}

/**
 * Why OpenAI cannot be reached from here, or null when it answers at all (any
 * HTTP status will do). Codex needs it, and some networks refuse its TLS
 * handshake outright: `codex exec` then logs "Reconnecting... waiting for
 * network" and sits there until the job's own timeout, which from this side
 * looks exactly like a Linked machines job that hung.
 */
function openAiUnreachable(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get('https://api.openai.com/v1/models', { timeout: 8_000 }, (res) => {
      res.resume()
      resolve(null)
    })
    req.on('timeout', () => req.destroy(new Error('no answer in 8 s')))
    req.on('error', (e: NodeJS.ErrnoException) => resolve(`${e.code ?? 'error'}: ${e.message}`))
  })
}

/** Assert a PONG run, after recording it. */
function expectPong(final: ToolAnswer, machine: string, agent: string): void {
  expect(final.error, `run failed: ${JSON.stringify(final)}`).toBeUndefined()
  expect(final).toMatchObject({ machine, agent, status: 'done' })
  expect(final.jobId).toMatch(new RegExp(`^${linkId}-[0-9a-f]{12}$`))
  expect(String(final.output)).toMatch(/\bPONG\b/)
}

/** The pane as the user sees it, saved as evidence. */
async function shoot(inst: Instance, file: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const pane = inst.page.locator('[data-testid="linked-settings"]')
  await pane.screenshot({ path: path.join(OUT, file) }).catch(() => inst.page.screenshot({ path: path.join(OUT, file) }))
}

async function openLinkedPane(inst: Instance): Promise<void> {
  await inst.page.locator('button[title="Settings"]').click()
  await inst.page.locator('[data-testid="settings-tab-linked"]').click()
  await expect(inst.page.locator('[data-testid="linked-enable"]')).toBeVisible({ timeout: 30_000 })
}

/** The one machine an instance lists, once `ok` says it is in the state wanted. */
async function onlyMachine(inst: Instance, what: string, ok: (m: MachineView) => boolean, timeoutMs: number): Promise<MachineView> {
  return waitFor(
    `${inst.name} to list one machine ${what}`,
    async () => {
      const s = await status(inst)
      return s.machines.length === 1 && ok(s.machines[0]) ? s.machines[0] : null
    },
    timeoutMs,
  )
}

const hexId = (ref: string): string => ref.slice(ref.indexOf(':') + 1)

test.beforeAll(async () => {
  test.setTimeout(300_000)
  if (process.env.TERMPOLIS_E2E_SKIP_BUILD !== '1') {
    const { execSync } = await import('child_process')
    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })
  }
  // Separate profiles, so separate single-instance locks, identities and MCP
  // tokens: as far as either instance can tell, the other is another computer.
  a = await launch('A', 'linked-real-a')
  b = await launch('B', 'linked-real-b')
  for (const inst of [a, b]) {
    await recordEvents(inst)
    await openLinkedPane(inst)
  }
  evidence.startedAt = new Date().toISOString()
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  // Off first, on both: a bridge still holding a relay socket is what turns
  // app.close() into a hang.
  for (const inst of [a, b]) {
    if (inst) await linked(inst, 'setEnabled', false).catch(() => {})
  }
  for (const inst of [a, b]) {
    if (inst) await inst.app.close().catch(() => {})
  }
  flushEvidence()
})

test.describe.serial('Linked machines, two real instances', () => {
  test('1. both come up on the production relay', async () => {
    for (const inst of [a, b]) {
      const s = await linked(inst, 'setEnabled', true)
      expect(s.enabled).toBe(true)
      // No override anywhere: this is the relay a shipped build dials.
      expect(s.relayUrl).toBe(PRODUCTION_RELAY)
      expect(s.machines).toEqual([])
    }
    for (const inst of [a, b]) {
      await waitFor(`${inst.name}'s bridge to run`, async () => (await status(inst)).running, 30_000)
    }
    evidence.thisMachine = (await status(a)).thisMachine
  })

  test('2. A makes a code, B enters it, and both show the same safety words', async () => {
    test.setTimeout(180_000)
    await linked(a, 'createCode', { run: true, write: false })
    const code = await waitFor('A to show a code', async () => (await status(a)).code?.code, 30_000)
    expect(code).toMatch(/^termpolis-link:[A-Za-z0-9_-]+$/)

    const t0 = Date.now()
    await linked(b, 'join', code, { run: true, write: false })
    // Unconfirmed, each with its words: the join reached A through the relay,
    // A accepted it, and B kept the link A acknowledged.
    const onB = await onlyMachine(b, 'with safety words', (m) => !!m.phrase, 90_000)
    const onA = await onlyMachine(a, 'with safety words', (m) => !!m.phrase, 90_000)
    evidence.pairingMs = Date.now() - t0

    expect(onA.ref).toMatch(/^device:[0-9a-f]{16}$/)
    expect(onB.ref).toMatch(/^link:[0-9a-f]{16}$/)
    // One link, known to both ends by the same id.
    expect(hexId(onA.ref)).toBe(hexId(onB.ref))
    linkId = hexId(onA.ref)
    expect(onA.confirmed).toBe(false)
    expect(onB.confirmed).toBe(false)

    // The whole point of the check: two processes, two key pairs, one phrase.
    evidence.phrases = { a: onA.phrase, b: onB.phrase, identical: onA.phrase === onB.phrase }
    expect(onA.phrase).toBe(onB.phrase)
    expect((onA.phrase ?? '').split(' ')).toHaveLength(8)

    // And each pane shows those words to its user, in large type.
    for (const inst of [a, b]) {
      await expect(inst.page.locator('[data-testid="linked-phrase"]')).toHaveText(onA.phrase as string, {
        timeout: 15_000,
      })
    }
    await shoot(a, 'a-1-pending.png')
    await shoot(b, 'b-1-pending.png')
    flushEvidence()
  })

  test('3. confirming on both sides brings the link up, under the names given', async () => {
    test.setTimeout(120_000)
    await linked(a, 'confirm', `device:${linkId}`, NAME_OF_B)
    await linked(b, 'confirm', `link:${linkId}`, NAME_OF_A)

    const t0 = Date.now()
    const onA = await onlyMachine(a, `"${NAME_OF_B}" online and confirmed`, (m) => m.online && m.confirmed, 60_000)
    const onB = await onlyMachine(b, `"${NAME_OF_A}" online and confirmed`, (m) => m.online && m.confirmed, 60_000)
    evidence.onlineAfterConfirmMs = Date.now() - t0
    expect(onA.name).toBe(NAME_OF_B)
    expect(onB.name).toBe(NAME_OF_A)
    // What the pairing grants said: run, not write, both ways.
    expect(onA.grants).toEqual({ run: true, write: false })
    expect(onB.grants).toEqual({ run: true, write: false })
    // A confirmed link keeps no phrase: it is only for the check.
    expect(onA.phrase).toBeUndefined()
    expect(onB.phrase).toBeUndefined()

    for (const inst of [a, b]) await expect(inst.page.locator('[data-testid="linked-phrase"]')).toHaveCount(0)
    await expect(a.page.locator(`[data-testid="linked-machine-device:${linkId}"]`)).toBeVisible()
    await expect(b.page.locator(`[data-testid="linked-machine-link:${linkId}"]`)).toBeVisible()
    await shoot(a, 'a-2-confirmed.png')
    await shoot(b, 'b-2-confirmed.png')
    flushEvidence()
  })

  test('4. each side lists the other over MCP, online, confirmed, with its agents', async () => {
    test.setTimeout(120_000)
    const fromA = await tool(a, { action: 'list' })
    const fromB = await tool(b, { action: 'list' })
    evidence.listFromA = fromA
    evidence.listFromB = fromB
    flushEvidence()

    const bSeenFromA = (fromA.machines as ToolAnswer[])[0]
    expect(fromA.machines).toHaveLength(1)
    expect(bSeenFromA).toMatchObject({ name: NAME_OF_B, online: true, confirmed: true, canRun: true, canWrite: false })
    expect(bSeenFromA.agents).toContain('claude')

    const aSeenFromB = (fromB.machines as ToolAnswer[])[0]
    expect(fromB.machines).toHaveLength(1)
    expect(aSeenFromB).toMatchObject({ name: NAME_OF_A, online: true, confirmed: true, canRun: true, canWrite: false })
  })

  test("5. A's agent runs Claude on B and gets PONG back", async () => {
    test.setTimeout(8 * 60_000)
    const { final, calls, ms } = await runToEnd(a, { machine: NAME_OF_B, agent: 'claude' })
    evidence.claudeOnB = { final, calls: calls.length, wallMs: ms }
    flushEvidence()
    expectPong(final, NAME_OF_B, 'claude')
  })

  test("6. the other way: B's agent runs Claude on A and gets PONG back", async () => {
    // The joiner asking the host: the same link, carrying a request the other
    // way, answered by the side that made the code.
    test.setTimeout(8 * 60_000)
    const { final, calls, ms } = await runToEnd(b, { machine: NAME_OF_A, agent: 'claude' })
    evidence.claudeOnA = { final, calls: calls.length, wallMs: ms }
    flushEvidence()
    expectPong(final, NAME_OF_A, 'claude')
  })

  test("7. B's agent runs Codex on A and gets PONG back", async () => {
    test.setTimeout(8 * 60_000)
    const aSeenFromB = ((evidence.listFromB as ToolAnswer).machines as ToolAnswer[])[0]
    test.skip(!(aSeenFromB.agents as string[]).includes('codex'), 'codex is not installed on this computer')
    const unreachable = await openAiUnreachable()
    if (unreachable) {
      evidence.codexOnA = { skipped: `OpenAI is unreachable from this network: ${unreachable}` }
      flushEvidence()
    }
    test.skip(unreachable !== null, `OpenAI is unreachable from this network, so codex cannot answer (${unreachable})`)
    const { final, calls, ms } = await runToEnd(b, { machine: NAME_OF_A, agent: 'codex' })
    evidence.codexOnA = { final, calls: calls.length, wallMs: ms }
    flushEvidence()
    expectPong(final, NAME_OF_A, 'codex')
  })

  test('8. both machines show every job, in and out', async () => {
    // Spec §4.6: every job appears on both machines.
    const want = (s: StatusView, direction: 'in' | 'out', agent: string): boolean =>
      s.activity.some((x) => x.direction === direction && x.agent === agent && x.status === 'done')
    const sa = await status(a)
    const sb = await status(b)
    evidence.activity = { a: sa.activity, b: sb.activity }
    flushEvidence()
    // A -> B, then B -> A.
    expect(want(sa, 'out', 'claude')).toBe(true)
    expect(want(sb, 'in', 'claude')).toBe(true)
    expect(want(sb, 'out', 'claude')).toBe(true)
    expect(want(sa, 'in', 'claude')).toBe(true)
    if ((evidence.codexOnA as { final?: unknown } | undefined)?.final) {
      expect(want(sb, 'out', 'codex')).toBe(true)
      expect(want(sa, 'in', 'codex')).toBe(true)
    }
    // And the pane draws them: one row per job on each side.
    for (const [inst, s] of [
      [a, sa],
      [b, sb],
    ] as const) {
      for (const row of s.activity) {
        await expect(inst.page.locator(`[data-testid="linked-activity-${row.id}"]`)).toBeVisible()
      }
    }
    await shoot(a, 'a-3-activity.png')
    await shoot(b, 'b-3-activity.png')
  })

  test('9. unlinking on A removes the link on B too', async () => {
    test.setTimeout(120_000)
    const afterA = await linked(a, 'unlink', `device:${linkId}`)
    expect(afterA.machines).toEqual([])
    // The goodbye crossed the relay, and B forgot the link on its own.
    await waitFor('B to drop the link', async () => (await status(b)).machines.length === 0, 30_000)
    const told = await waitFor(
      'B to say A unlinked it',
      async () => (await events(b)).find((e) => e.kind === 'error' && String(e.message).includes('unlinked this computer')),
      15_000,
    )
    expect(String(told.message)).toBe(`"${NAME_OF_A}" unlinked this computer.`)

    const fromB = await tool(b, { action: 'list' })
    evidence.listFromBAfterUnlink = fromB
    flushEvidence()
    expect(fromB.machines).toEqual([])
    await shoot(b, 'b-4-unlinked.png')
  })

  test('10. switching both off is the teardown', async () => {
    for (const inst of [a, b]) {
      const s = await linked(inst, 'setEnabled', false)
      expect(s.enabled).toBe(false)
      expect(s.running).toBe(false)
    }
  })
})
