// isoTime.ts
//
// Pure epoch-ms → ISO-8601 formatting, deliberately OUTSIDE `src/main/headroom/`.
//
// tests/electron/noNondeterministicCompression.test.ts bans the literal `new Date(` from
// the compression directories, because a clock READ anywhere on the transform path would
// make identical input produce different bytes and bust Anthropic's prompt cache on every
// request. Formatting a timestamp that was *passed in* is pure — same input, same output —
// but a textual guard cannot tell a read from a format. So the pure formatter lives here
// and the ban over `headroom/` stays absolute, with no exemptions to erode.
//
// Nothing in this file may read a clock. It takes the instant as an argument, always.

/** `1750000000000` → `'2025-06-15T14:26:40.000Z'`. Pure: no clock, no locale, no TZ. */
export function isoFromEpochMs(ms: number): string {
  return new Date(ms).toISOString()
}
