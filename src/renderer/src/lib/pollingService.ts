type PollCallback = () => void

interface Subscriber {
  callback: PollCallback
  interval: number
  lastRun: number
}

const subscribers = new Map<string, Subscriber>()
let timer: ReturnType<typeof setInterval> | null = null

export function subscribe(id: string, callback: PollCallback, intervalMs: number): void {
  subscribers.set(id, { callback, interval: intervalMs, lastRun: 0 })
  if (!timer) {
    timer = setInterval(tick, 1000) // single 1-second base tick
  }
}

export function unsubscribe(id: string): void {
  subscribers.delete(id)
  if (subscribers.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

function tick(): void {
  const now = Date.now()
  for (const [, sub] of subscribers) {
    if (now - sub.lastRun >= sub.interval) {
      sub.lastRun = now
      try { sub.callback() } catch {}
    }
  }
}
