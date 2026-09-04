import { PairingRoom } from './pairingRoom'

export interface Env {
  PAIRING_ROOM: DurableObjectNamespace
  /** Edge rate limit on ROOM CREATION, keyed by source address. */
  REGISTRATIONS: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Optional per-connection byte budget override, as a decimal string. Absent in
   *  production, where the compiled-in default applies. */
  CONNECTION_BYTE_BUDGET?: string
}

/** Pairing ids are 16 random bytes rendered lowercase hex -- see `createPairingOffer`
 *  in the desktop bridge. Validated here rather than trusted, because this string
 *  names a Durable Object: a permissive parse lets a stranger address any name they
 *  can spell, including ones this Worker may use for something else later. */
const PAIRING_ID = /^[0-9a-f]{32}$/

/** Bodies are deliberately terse. An error that names the runtime, the binding or a
 *  stack frame tells a prober how the relay is built; it tells a legitimate client
 *  nothing it can act on, because every refusal here means "your request was
 *  malformed", not "something went wrong on our side". */
function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const match = /^\/v1\/pair\/([^/]*)$/.exec(url.pathname)
    if (!match) return refuse(404, 'not found')

    const pairingId = match[1]
    if (!PAIRING_ID.test(pairingId)) return refuse(400, 'bad pairing id')

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return refuse(426, 'expected a websocket upgrade')
    }

    // Checked LAST, after shape and upgrade. Spending limiter budget on requests
    // that are refused anyway would let unparseable junk from a shared NAT exhaust
    // an honest client's allowance -- the limit would become the attack.
    //
    // Keyed by source rather than globally: on a multi-tenant relay a global key
    // would let one abuser lock out every other user, turning the defence into the
    // outage it exists to prevent. The key is the caller's address and nothing
    // else -- notably NOT the pairing id, which would tie a rate-limit record to a
    // specific conversation the relay has no business distinguishing.
    const source = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (!(await env.REGISTRATIONS.limit({ key: source })).success) {
      return refuse(429, 'too many pairing rooms opened; slow down')
    }

    const id = env.PAIRING_ROOM.idFromName(pairingId)
    return env.PAIRING_ROOM.get(id).fetch(request)
  },
}

export { PairingRoom }
