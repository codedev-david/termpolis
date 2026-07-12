// Commit/Push Secret Shield — the git-boundary gate.
//
// The outbound PTY scanner only sees text the user types AT an AI; it never sees
// `git commit`, so a leaked key could still land in history and get pushed. These
// tests pin the behaviour of the git-boundary scan that closes that vector.
//
// NOTE: secret samples use repeated characters on purpose — they satisfy the rule
// regexes while failing entropy heuristics, so GitHub push protection won't block
// this test file (see reference_secret_scanner_test_gotcha).
import { describe, it, expect, vi } from 'vitest'
import { scanStagedDiff, scanPushRange, blockMessage } from '../../src/main/commitScan'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const AWS_KEY = 'AKIA' + 'A'.repeat(16)
const OPENAI_KEY = 'sk-' + 'a'.repeat(24)

/** A fake git that answers only the exact argv the scanner is expected to run. */
function fakeGit(map: Record<string, string>) {
  return (args: string[]): string => {
    const key = args.join(' ')
    if (key in map) return map[key]
    throw new Error('unexpected git call: ' + key)
  }
}

const STAGED = 'diff --cached --no-color --no-ext-diff'
const UNPUSHED = 'log -p --no-color --not --remotes'

describe('commitScan — staged diff (what `git commit` will capture)', () => {
  it('flags a secret in the staged diff and names the rule', () => {
    const diff = `diff --git a/.env b/.env\n+++ b/.env\n+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`
    const res = scanStagedDiff({ git: fakeGit({ [STAGED]: diff }) })
    expect(res.clean).toBe(false)
    expect(res.hitCount).toBe(1)
    expect(res.hits[0].rule).toBe('aws_access_key')
    expect(res.scannedBytes).toBe(diff.length)
  })

  it('passes a clean staged diff', () => {
    const res = scanStagedDiff({ git: fakeGit({ [STAGED]: '+const answer = 42\n' }) })
    expect(res.clean).toBe(true)
    expect(res.hitCount).toBe(0)
    expect(res.hits).toEqual([])
  })

  it('is clean when nothing is staged', () => {
    const res = scanStagedDiff({ git: fakeGit({ [STAGED]: '' }) })
    expect(res.clean).toBe(true)
    expect(res.scannedBytes).toBe(0)
  })
})

describe('commitScan — push range (what `git push` will send)', () => {
  it('scans the patch of every unpushed commit and flags a secret', () => {
    const patch = `commit abc123\n+++ b/config.ts\n+const key = "${OPENAI_KEY}"\n`
    const res = scanPushRange({ git: fakeGit({ [UNPUSHED]: patch }) })
    expect(res.clean).toBe(false)
    expect(res.hits.some((h) => h.rule === 'openai_key')).toBe(true)
  })

  it('is clean when there is nothing unpushed', () => {
    const res = scanPushRange({ git: fakeGit({ [UNPUSHED]: '' }) })
    expect(res.clean).toBe(true)
    expect(res.hitCount).toBe(0)
  })

  it('catches a secret that is already in history but not yet on a remote', () => {
    // The whole point of the push gate: the commit gate can be bypassed with
    // --no-verify or a commit made outside Termpolis. The push is the last line.
    const patch = `commit deadbeef\n+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`
    const res = scanPushRange({ git: fakeGit({ [UNPUSHED]: patch }) })
    expect(res.clean).toBe(false)
    expect(res.hitCount).toBe(1)
  })
})

describe('commitScan — block message', () => {
  it('names the offending rule labels and the operation', () => {
    const res = scanStagedDiff({ git: fakeGit({ [STAGED]: `+k=${AWS_KEY}\n` }) })
    const msg = blockMessage(res, 'commit')
    expect(msg).toContain('Blocked commit')
    expect(msg).toContain('AWS Access Key ID')
    expect(msg).toContain('1 secret')
  })

  it('pluralises and de-duplicates repeated rule labels', () => {
    const res = scanPushRange({ git: fakeGit({ [UNPUSHED]: `+a=${AWS_KEY}\n+b=${OPENAI_KEY}\n` }) })
    const msg = blockMessage(res, 'push')
    expect(msg).toContain('Blocked push')
    expect(msg).toContain('2 secrets')
  })
})
