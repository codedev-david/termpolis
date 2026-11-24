// THROWAWAY PROBE (t24/resp diagnosis, never to land): timestamped lines appended to TERMPOLIS_PROBE_DIR/probe.log.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const dir = process.env.TERMPOLIS_PROBE_DIR
let ready: Promise<unknown> | null = null
let chain: Promise<unknown> = Promise.resolve()
export const probeOn = (): boolean => !!dir
export function probe(line: string): void {
  if (!dir) return
  if (!ready) ready = mkdir(dir, { recursive: true }).catch(() => undefined)
  const s = `${new Date().toISOString()} ${process.pid} ${line}\n`
  chain = chain.then(() => ready).then(() => appendFile(join(dir, 'probe.log'), s)).catch(() => undefined)
}
