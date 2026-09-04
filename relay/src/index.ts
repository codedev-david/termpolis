import { PairingRoom } from './pairingRoom'

export interface Env {
  PAIRING_ROOM: DurableObjectNamespace
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

    const id = env.PAIRING_ROOM.idFromName(pairingId)
    return env.PAIRING_ROOM.get(id).fetch(request)
  },
}

export { PairingRoom }
