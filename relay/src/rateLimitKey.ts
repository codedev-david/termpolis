// What the registration rate limit counts against.
//
// The limiter used to key on the caller's address verbatim, which is correct for
// IPv4 and close to useless for IPv6. An IPv4 client has one address and has to
// buy more; an IPv6 client is handed a /64 as a matter of course -- eighteen
// quintillion addresses, every one of them a fresh key. Keying on the address
// meant a single ordinary home connection could open unlimited pairing rooms by
// walking its own subnet, while the IPv4 client next door was held to the limit.
// The defence was not weak on IPv6; it was absent.
//
// So: v4 keys on the address, v6 keys on the /64 the address sits in.

/** The prefix an IPv6 address is counted under: the first four hextets.
 *
 *  /64 and not /128 for the reason above, and not /48 or /56 either. Wider
 *  aggregation catches an attacker who holds more than one subnet, but it also
 *  merges unrelated customers of the same ISP into one bucket -- and the limit's
 *  own comment already names that failure: a key shared by strangers turns the
 *  defence into the outage it exists to prevent. /64 is the smallest block an
 *  end site is architecturally guaranteed, so it is the widest key that cannot
 *  put two unrelated subscribers behind one counter. */
const IPV6_PREFIX_HEXTETS = 4

/** Marks a key as a subnet rather than a host.
 *
 *  Without it, the /64 of `2001:db8:1:2::` would render as `2001:db8:1:2`, which
 *  is also how a (malformed, but not impossible) address could arrive. Two
 *  different things must never produce one key: the whole point is that the
 *  counter says which population it is counting. */
const SUBNET_SUFFIX = '::/64'

/** Where an address is counted when the edge did not give us one.
 *
 *  A single shared bucket, deliberately. `CF-Connecting-IP` is set by Cloudflare
 *  on every request that reaches a Worker, so an absent header means something
 *  is wrong with the deployment rather than something interesting about the
 *  caller -- and in that state the safe behaviour is to keep counting, not to
 *  hand out an unlimited allowance per unknown caller. */
const UNKNOWN = 'unknown'

/** Expand an IPv6 text form into its eight hextets, or null if it is not one.
 *
 *  Handles the two compressions the wire actually carries: `::` for a run of
 *  zero groups, and a trailing dotted quad (`::ffff:192.0.2.1`). Anything else
 *  -- too many groups, two `::`, a hextet that is not hex -- returns null, and
 *  the caller falls back to keying on the raw string. That fallback is the OLD
 *  behaviour, so an address this cannot parse is never counted more loosely than
 *  it was before this function existed.
 *
 *  Called only with text that contains at least one colon -- `rateLimitKey`
 *  returns before this for anything else -- which is what lets the dotted-quad
 *  branch below assume a colon precedes the quad. */
function hextets(address: string): number[] | null {
  let text = address
  // A zone id (`fe80::1%eth0`) is scope, not address, and never survives to a
  // public relay. Dropped rather than rejected so a link-local caller in a test
  // fixture still keys on its prefix.
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A trailing IPv4 quad occupies the last two hextets. Rewriting it here keeps
  // the group parser below dealing with one syntax instead of two.
  const dot = text.lastIndexOf('.')
  if (dot !== -1) {
    const cut = text.lastIndexOf(':')
    const quad = text.slice(cut + 1).split('.')
    if (quad.length !== 4) return null
    const bytes: number[] = []
    for (const part of quad) {
      if (!/^\d{1,3}$/.test(part)) return null
      const value = Number(part)
      if (value > 255) return null
      bytes.push(value)
    }
    const high = ((bytes[0] << 8) | bytes[1]).toString(16)
    const low = ((bytes[2] << 8) | bytes[3]).toString(16)
    text = `${text.slice(0, cut + 1)}${high}:${low}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }

  const head = parse(halves[0])
  if (head === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null

  const tail = parse(halves[1])
  if (tail === null) return null
  const gap = 8 - head.length - tail.length
  // `::` must stand for at least one group. Zero would mean the address had all
  // eight already and did not need the compression -- a form no stack emits and
  // one that would let `1:2:3:4:5:6:7:8::9` through as if it were eight groups.
  if (gap < 1) return null
  return [...head, ...new Array<number>(gap).fill(0), ...tail]
}

/** Is this the IPv4-mapped range, `::ffff:0:0/96`?
 *
 *  A v4 client reaching a dual-stack edge can be reported either way. Both forms
 *  must land on the same counter, or the mapped form is a free second allowance
 *  for anyone who can provoke it. */
function isIpv4Mapped(groups: number[]): boolean {
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  )
}

/** The key the registration limiter counts one caller under.
 *
 *  IPv4 addresses key on themselves. IPv6 addresses key on their /64. Anything
 *  unrecognised keys on itself, lowercased -- no worse than counting per address,
 *  which is all the limiter ever did. */
export function rateLimitKey(address: string | null | undefined): string {
  if (!address) return UNKNOWN
  const text = address.trim()
  if (text === '') return UNKNOWN
  // No colon at all is IPv4 (or something the edge invented). Either way there is
  // no subnet to fold it into, so the address is the key.
  if (!text.includes(':')) return text

  const groups = hextets(text)
  if (groups === null) return text.toLowerCase()

  if (isIpv4Mapped(groups)) {
    const a = groups[6] >> 8
    const b = groups[6] & 0xff
    const c = groups[7] >> 8
    const d = groups[7] & 0xff
    return `${a}.${b}.${c}.${d}`
  }

  const prefix = groups
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((g) => g.toString(16))
    .join(':')
  return `${prefix}${SUBNET_SUFFIX}`
}
