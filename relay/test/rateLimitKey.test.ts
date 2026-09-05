import { describe, it, expect } from 'vitest'
import { rateLimitKey } from '../src/rateLimitKey'

describe('rateLimitKey', () => {
  describe('IPv4', () => {
    it('keys an address on itself', () => {
      expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9')
    })

    it('keeps two addresses in the same /24 apart', () => {
      // Deliberately NOT aggregated. A v4 host is one address and buying a second
      // costs real money, so the address is already the unit of abuse; folding a
      // /24 together would put a small office and its neighbours on one counter
      // for no gain.
      expect(rateLimitKey('203.0.113.9')).not.toBe(rateLimitKey('203.0.113.10'))
    })
  })

  describe('IPv6', () => {
    it('counts an address under its /64', () => {
      expect(rateLimitKey('2001:db8:1234:5678:9abc:def0:1111:2222')).toBe(
        '2001:db8:1234:5678::/64',
      )
    })

    it('gives every address in one /64 the same key', () => {
      // The reason this module exists. An ISP hands out a /64 as a matter of
      // course, so keying on the address let one ordinary home connection open
      // unlimited pairing rooms by walking its own subnet -- while the IPv4
      // client next door was held to the limit.
      const a = rateLimitKey('2001:db8:1234:5678::1')
      const b = rateLimitKey('2001:db8:1234:5678:ffff:ffff:ffff:ffff')
      expect(a).toBe(b)
    })

    it('keeps neighbouring /64s apart', () => {
      // The other half of the trade: aggregating further than /64 would put
      // unrelated subscribers of the same ISP on one counter, and the limit's own
      // comment names that failure -- a shared key turns the defence into the
      // outage it exists to prevent.
      expect(rateLimitKey('2001:db8:1234:5678::1')).not.toBe(
        rateLimitKey('2001:db8:1234:5679::1'),
      )
    })

    it('expands a compressed run of zero groups', () => {
      expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    })

    it('handles a compression that starts the address', () => {
      expect(rateLimitKey('::1')).toBe('0:0:0:0::/64')
    })

    it('handles a compression that ends the address', () => {
      expect(rateLimitKey('2001:db8:1:2:3:4:5::')).toBe('2001:db8:1:2::/64')
    })

    it('is case-insensitive about hex digits', () => {
      // `CF-Connecting-IP` is text from another system. Two spellings of one
      // address must not buy two allowances.
      expect(rateLimitKey('2001:DB8:ABCD:1::1')).toBe(rateLimitKey('2001:db8:abcd:1::1'))
    })

    it('drops a zone id before keying', () => {
      // Scope, not address. It never reaches a public relay, but a fixture that
      // carries one should still key on the prefix rather than fall back.
      expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    })

    it('marks a subnet key so it cannot be read as an address', () => {
      // The `::/64` suffix is load-bearing. Without it the /64 would render as
      // `2001:db8:1:2`, which is also what an unparseable four-group string falls
      // back to -- and a counter that cannot say which population it counts is
      // not a counter.
      expect(rateLimitKey('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64')
      expect(rateLimitKey('2001:db8:1:2')).toBe('2001:db8:1:2')
    })
  })

  describe('IPv4-mapped IPv6', () => {
    it('keys on the embedded v4 address', () => {
      // A v4 client at a dual-stack edge can be reported either way. Both forms
      // must land on one counter, or the mapped form is a free second allowance.
      expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
    })

    it('agrees with the plain v4 form', () => {
      expect(rateLimitKey('::ffff:198.51.100.4')).toBe(rateLimitKey('198.51.100.4'))
    })

    it('reads the low and high byte of each group', () => {
      // 0.0.0.0 and 255.255.255.255 would both survive a shift/mask that dropped
      // half of each group; an asymmetric quad will not.
      expect(rateLimitKey('::ffff:1.2.3.4')).toBe('1.2.3.4')
    })

    it('handles the fully written mapped form', () => {
      expect(rateLimitKey('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9')
    })

    it('treats a dotted quad outside the mapped range as an ordinary address', () => {
      // ::203.0.113.9 is IPv4-COMPATIBLE, a deprecated form that is not the same
      // range. It gets the /64 treatment like any other v6 address.
      expect(rateLimitKey('::203.0.113.9')).toBe('0:0:0:0::/64')
    })
  })

  describe('input the edge should never send', () => {
    it('falls back to a single bucket when there is no address', () => {
      // Not a per-caller allowance. An absent CF-Connecting-IP means the
      // deployment is wrong, not that the caller is interesting, and in that state
      // the safe behaviour is to keep counting.
      expect(rateLimitKey(null)).toBe('unknown')
      expect(rateLimitKey(undefined)).toBe('unknown')
      expect(rateLimitKey('')).toBe('unknown')
      expect(rateLimitKey('   ')).toBe('unknown')
    })

    it('keys unparseable text on itself rather than dropping it', () => {
      // The old behaviour, exactly: count per string. An address this cannot parse
      // is never counted more loosely than it was before this function existed.
      expect(rateLimitKey('not:an:address:at:all:xyz')).toBe('not:an:address:at:all:xyz')
    })

    it('lowercases the fallback so one string is one key', () => {
      expect(rateLimitKey('NOT:AN:ADDRESS:XYZ')).toBe('not:an:address:xyz')
    })

    it('rejects two compressions', () => {
      expect(rateLimitKey('2001::db8::1')).toBe('2001::db8::1')
    })

    it('rejects an uncompressed address with too few groups', () => {
      expect(rateLimitKey('2001:db8:1:2:3:4:5')).toBe('2001:db8:1:2:3:4:5')
    })

    it('rejects an uncompressed address with too many groups', () => {
      expect(rateLimitKey('2001:db8:1:2:3:4:5:6:7')).toBe('2001:db8:1:2:3:4:5:6:7')
    })

    it('rejects a compression that stands for no groups at all', () => {
      // Eight groups plus a `::` is a form no stack emits, and accepting it would
      // let a ninth group ride along unnoticed.
      expect(rateLimitKey('1:2:3:4:5:6:7:8::9')).toBe('1:2:3:4:5:6:7:8::9')
    })

    it('rejects a hextet that is too long', () => {
      expect(rateLimitKey('2001:db8:12345::1')).toBe('2001:db8:12345::1')
    })

    it('rejects a hextet that is not hex', () => {
      expect(rateLimitKey('2001:db8:zzzz::1')).toBe('2001:db8:zzzz::1')
    })

    it('rejects an empty hextet that is not a compression', () => {
      expect(rateLimitKey('2001::db8:::1')).toBe('2001::db8:::1')
    })

    it('rejects a dotted quad with the wrong number of parts', () => {
      expect(rateLimitKey('::ffff:1.2.3')).toBe('::ffff:1.2.3')
      expect(rateLimitKey('::ffff:1.2.3.4.5')).toBe('::ffff:1.2.3.4.5')
    })

    it('rejects a dotted quad with a byte out of range', () => {
      expect(rateLimitKey('::ffff:1.2.3.256')).toBe('::ffff:1.2.3.256')
    })

    it('rejects a dotted quad part that is not digits', () => {
      expect(rateLimitKey('::ffff:1.2.3.0x4')).toBe('::ffff:1.2.3.0x4')
    })

    it('rejects a dotted quad with an empty part', () => {
      expect(rateLimitKey('::ffff:1.2..4')).toBe('::ffff:1.2..4')
    })

    it('rejects a bare dotted quad that reached the v6 path', () => {
      // Only reachable with a colon present, since an address without one is
      // returned before parsing. A trailing colon and a quad is the shape.
      expect(rateLimitKey(':1.2.3.4')).toBe(':1.2.3.4')
    })

    it('rejects a dotted quad that sits before the last colon', () => {
      // The quad is only ever the TAIL of an address. Text whose last colon comes
      // after its last dot leaves an empty slice, which is not four parts.
      expect(rateLimitKey('1.2.3.4:')).toBe('1.2.3.4:')
    })

    it('rejects a bad hextet after the compression', () => {
      // Head parses, tail does not -- the arm a malformed-head fixture skips.
      expect(rateLimitKey('2001:db8::zzzz')).toBe('2001:db8::zzzz')
    })

    it('trims surrounding whitespace before deciding', () => {
      expect(rateLimitKey('  2001:db8:1:2::1  ')).toBe('2001:db8:1:2::/64')
    })
  })
})
