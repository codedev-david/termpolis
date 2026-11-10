/**
 * v1.59.0: when to offer a terminal a fresh session BEFORE Claude compacts.
 *
 * The depth curve (sessionDepth.ts) measures what this user's own requests cost per turn at each
 * conversation length. Once a terminal's conversation is deep enough that a fresh session would
 * cost at least OFFER_MIN_SAVING_PCT less per turn, the pane offers the same Fresh session button
 * it shows after a compaction. Waiting for the compaction means paying the dearest turns first.
 *
 * One offer per band: the pane hears about a terminal once when it reaches a band worth offering,
 * and again only when it reaches a deeper one, so dismissing the offer quiets it until the saving
 * has grown. A message count that drops (a compaction, /clear, a new session in the same terminal)
 * starts the terminal over.
 */
import type { ProxyResultMsg } from '../headroomProxy/proxySupervisor'
import { bandFor, depthAdviceAt } from './sessionDepth'

/** Below this the saving is not worth interrupting someone for. */
export const OFFER_MIN_SAVING_PCT = 50
/** Terminals remembered; the oldest is forgotten past this. */
export const OFFER_TERMINAL_CAP = 200

export interface DepthOffer {
  terminalId: string
  messages: number
  savingPct: number
}

interface TerminalDepth {
  messages: number
  /** The band last offered, -1 for none yet. */
  offered: number
}

const seen = new Map<string, TerminalDepth>()

/**
 * The offer one proxy result earns, or null. Only a terminal's own main conversation counts: a
 * subagent's request, a failed one, or one with no terminal header says nothing about how long the
 * conversation the user is typing into has grown.
 */
export function depthOfferFor(r: ProxyResultMsg): DepthOffer | null {
  const terminalId = r.terminal
  const messages = r.stats?.msgCount ?? 0
  if (!terminalId || !r.main || r.agent || !(r.status >= 200 && r.status < 300) || !(messages > 0)) return null
  let t = seen.get(terminalId)
  if (!t || messages < t.messages) {
    seen.delete(terminalId)
    t = { messages, offered: -1 }
    seen.set(terminalId, t)
    if (seen.size > OFFER_TERMINAL_CAP) seen.delete(seen.keys().next().value as string)
  }
  t.messages = messages
  const band = bandFor(messages)
  if (band <= t.offered) return null
  const advice = depthAdviceAt(messages)
  if (!advice || advice.savingPct < OFFER_MIN_SAVING_PCT) return null
  t.offered = band
  return { terminalId, messages, savingPct: advice.savingPct }
}

export function resetDepthOffers(): void { seen.clear() }
