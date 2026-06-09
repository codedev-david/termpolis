// Grand end-to-end: drive the WHOLE memory pipeline composed together, not each
// layer in isolation — disk transcript ingest → packed Float32 store → HNSW graph
// (+ persistence) → MCP cross-agent recall → cross-machine sync → at-rest
// encryption with the OS-keychain key. If the layers compose, this passes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryHasHash,
  getSyncStatus,
  setSyncDir,
  setSyncPassphrase,
  _resetForTests,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
} from '../../src/main/swarmMemory'
import { runConversationIngest } from '../../src/main/conversationIngest'
import { setSafeStorage } from '../../src/main/secureKeyStore'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))
const { executeTool } = await import('../../src/main/mcpServer')

// A deterministic "semantic" embedder: content on the same topic maps to the same
// 384-dim unit vector (cosine 1), different topics are orthogonal (cosine 0) — so
// a paraphrased query recalls same-topic memories through the packed/HNSW path.
function topicVec(topic: number): number[] {
  const v = new Array(384).fill(0)
  v[((topic % 384) + 384) % 384] = 1
  return v
}
function embedFor(text: string): number[] {
  const t = text.toLowerCase()
  if (/auth|jwt|login|token|credential/.test(t)) return topicVec(1)
  if (/rate|limit|throttle|hammer/.test(t)) return topicVec(2)
  if (/deploy|release|pipeline|ship/.test(t)) return topicVec(3)
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0
  return topicVec(100 + (Math.abs(h) % 200)) // distinct "other" topic
}

const handlers = (): McpToolHandlers => ({ memoryWrite, memorySearch, memoryList } as unknown as McpToolHandlers)
const xorKeychain = (k = 0x5a) => ({
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ k)),
  decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ k)).toString('utf8'),
})

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-e2e-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-e2e-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async (t: string) => embedFor(t))
  _setHnswThresholdForTests(5) // small so the HNSW graph engages in the test
})
afterEach(() => {
  _resetForTests()
  setSafeStorage(null)
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('memory brain — grand end-to-end', () => {
  it('ingest → pack → HNSW(+persist) → MCP cross-agent semantic recall → survives reload', async () => {
    initSwarmMemory(userDir)
    // 1) Ingest a Claude transcript from disk (the auto-feed path).
    const proj = path.join(userDir, '.claude', 'projects', 'p')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(
      path.join(proj, 's.jsonl'),
      '{"type":"user","message":{"role":"user","content":"please add login + token auth to the API"}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"done — JWT auth middleware added"}]}}',
    )
    const stats = await runConversationIngest({ hasHash: memoryHasHash, write: memoryWrite }, { roots: { claude: proj }, sources: ['claude'] })
    expect(stats.chunksWritten).toBeGreaterThan(0)

    // 2) Two agents write decisions through the real MCP dispatch path.
    await executeTool('memory_write', { agentId: 'claude', kind: 'decision', content: 'We throttle the public API with a token bucket.' }, handlers())
    await executeTool('memory_write', { agentId: 'codex', kind: 'decision', content: 'Deploys use blue-green releases.' }, handlers())
    // pad past the HNSW threshold so the graph engages
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'x', kind: 'note', content: `misc note number ${i}` })

    // 3) A different agent recalls the AUTH topic from a paraphrase (semantic).
    const hits = await executeTool('memory_search', { query: 'how do users sign in with credentials?', limit: 5 }, handlers())
    const text = hits.map((h: { content: string }) => h.content).join(' | ')
    expect(text).toMatch(/JWT|token auth|login/i) // recalled the ingested auth content
    expect(text).not.toMatch(/blue-green/) // unrelated topic not surfaced

    // 4) The HNSW graph was built (> threshold) and persisted to disk.
    expect(fs.existsSync(path.join(userDir, 'memory-hnsw.json'))).toBe(true)

    // 5) Reload the whole store from disk → still recalls (persistence + repack).
    _resetForTests(); _setEmbedFnForTests(async (t: string) => embedFor(t)); _setHnswThresholdForTests(5)
    initSwarmMemory(userDir)
    const again = await executeTool('memory_search', { query: 'authentication and login tokens', limit: 5 }, handlers())
    expect(again.map((h: { content: string }) => h.content).join(' ')).toMatch(/JWT|token auth|login/i)
  })

  it('cross-machine sync + at-rest encryption (OS-keychain) → a second device recalls it', async () => {
    setSafeStorage(xorKeychain())
    // Device A: write + ingest under sync, then encrypt with a passphrase.
    initSwarmMemory(userDir, { syncDir })
    await executeTool('memory_write', { agentId: 'claude', kind: 'decision', content: 'API login uses JWT bearer tokens.' }, handlers())
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'x', kind: 'note', content: `filler ${i}` })
    setSyncPassphrase('correct horse battery staple')

    // The synced shard on disk is ciphertext; the cached key is OS-keychain-encrypted.
    const shard = fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl'))!
    expect(fs.readFileSync(path.join(syncDir, shard), 'utf8')).toContain('enc:v1:')
    expect(fs.readFileSync(path.join(userDir, 'memory-sync.key'), 'utf8').startsWith('osk:v1:')).toBe(true)

    // Device B: fresh machine, SAME synced folder + SAME OS keychain + passphrase.
    const userDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-e2e-userB-'))
    try {
      _resetForTests(); _setEmbedFnForTests(async (t: string) => embedFor(t)); _setHnswThresholdForTests(5)
      setSafeStorage(xorKeychain())
      initSwarmMemory(userDirB, { syncDir })
      expect(getSyncStatus().locked).toBe(true) // encrypted, no key yet
      setSyncPassphrase('correct horse battery staple') // unlock
      expect(getSyncStatus().locked).toBe(false)
      // …and Device B semantically recalls Device A's encrypted memory.
      const hits = await executeTool('memory_search', { query: 'how does sign-in auth work?', limit: 5 }, handlers())
      expect(hits.map((h: { content: string }) => h.content).join(' ')).toMatch(/JWT|bearer tokens|login/i)
    } finally {
      fs.rmSync(userDirB, { recursive: true, force: true })
    }
  })
})
