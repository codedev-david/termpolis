// The real memory process, with one switch an e2e spec can flip: a memory that says it is locked (WPA fix M8,
// e2e/world-responsive.spec.ts). The app runs this as its memory process through TERMPOLIS_TEST_MEMORY_HOST_PATH; it loads
// the built host (TERMPOLIS_TEST_MEMORY_REAL_HOST, out/main/memoryHost.js) unchanged, so every memory call is the real one.
// While the file TERMPOLIS_TEST_MEMORY_LOCK_FILE holds the word `locked`, the store's status answers that its own key cannot
// open it (getSyncStatus ownLocked), which is what main asks before it says an answer was made without the project memory.
// While it holds the word `empty` (WPA2 M8), the memory answers every search and listing with no notes, as a healthy store with
// nothing saved for the question does.
// Nothing else is changed, and with the file absent or saying anything else this is the real memory process.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const port = process.parentPort
const lockFile = process.env.TERMPOLIS_TEST_MEMORY_LOCK_FILE
const switchSays = () => {
  try { return lockFile ? readFileSync(lockFile, 'utf8').trim() : '' } catch { return '' }
}
const EMPTIED = new Set(['memorySearch', 'memoryList'])
// The calls asked for, by id, so a result can be told apart. Recorded inside the real host's own message listener: a listener
// of ours, added before the host has loaded, would start the port early and the init message would reach only us (the host
// then never says it is ready, and main falls back to an in-process store this switch cannot touch).
const asked = new Map()
const on = port.on.bind(port)
port.on = (event, listener) => {
  if (event !== 'message') return on(event, listener)
  return on(event, (e) => {
    const m = e && e.data
    if (m && m.kind === 'call' && (m.fn === 'getSyncStatus' || EMPTIED.has(m.fn))) asked.set(m.id, m.fn)
    listener(e)
  })
}
const post = port.postMessage.bind(port)
port.postMessage = (msg) => {
  const fn = msg && msg.kind === 'result' ? asked.get(msg.id) : undefined
  if (fn !== undefined) asked.delete(msg.id)
  if (fn === 'getSyncStatus' && msg.ok && msg.result && typeof msg.result === 'object' && switchSays() === 'locked') {
    msg = { ...msg, result: { ...msg.result, ownLocked: true } }
  } else if (EMPTIED.has(fn) && msg.ok && Array.isArray(msg.result) && switchSays() === 'empty') {
    msg = { ...msg, result: [] }
  }
  post(msg)
}
await import(pathToFileURL(process.env.TERMPOLIS_TEST_MEMORY_REAL_HOST).href)
