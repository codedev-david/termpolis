// One newline normalizer, shared by everything that CONTENT-HASHES text.
//
// The memory store and the code index are synced across machines (that is a shipped feature), and
// hashes are how they dedup and how the Safe-Import allowlist pins an artifact. But a file read on
// Windows arrives with CRLF and the same file on macOS/Linux arrives with LF, so any hash taken over
// the raw bytes DIFFERS across OSes for identical content:
//
//   * the same repo indexed on Windows and Linux dedups against nothing and stores a second copy;
//   * a skill hash-pinned as GREEN on one machine re-prompts as unknown on another (and, within one
//     machine, a directory import (CRLF) and its own .zip (LF) disagree).
//
// Normalizing to LF before hashing makes content the unit of identity, not its line-ending flavour.
// `\r\n?` collapses both Windows CRLF and bare-CR (classic Mac) to `\n`.

/** Convert CRLF and lone CR to LF. Use before any content hash that must be stable across OSes. */
export function normalizeNewlines(text: string): string {
  return (text || '').replace(/\r\n?/g, '\n')
}
