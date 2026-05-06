#!/usr/bin/env node
/**
 * verifyTosSnapshots
 *
 * Fetches the AI provider terms-of-service / data-controls pages that the
 * AI Security Center links to, normalizes the HTML to plain text, hashes
 * it, and compares the hash + content against snapshots committed under
 * docs/security-snapshots/. Surfaces drift so a human can review whether
 * the data-training language Termpolis advertises is still accurate.
 *
 * Modes:
 *   node scripts/verifyTosSnapshots.cjs            # check (CI default)
 *   node scripts/verifyTosSnapshots.cjs --update   # rewrite snapshots locally
 *   node scripts/verifyTosSnapshots.cjs --json     # machine-readable report
 *
 * Why this is a pragmatic approach:
 *   - Hashes are computed on a *normalized* DOM (script/style/nav stripped,
 *     whitespace collapsed) — drops most of the CSRF / cookie / build-id
 *     noise that would otherwise fire on every CDN deploy.
 *   - On drift, the workflow opens a GitHub issue with the diff URL pointing
 *     to the failing page, and the snapshot file in the repo. A human reads
 *     it, decides if Termpolis still tells the truth, then either updates
 *     AGENT_FACTS in src/main/aiSecurity.ts or refreshes the snapshot.
 *   - Robustness > completeness: the CSS selectors providers use change
 *     without notice, so the script intentionally avoids selector-based
 *     extraction. If a page becomes unfetchable (404, redirect chain, JS-
 *     only render) the script flags it as drift, not silently passes.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')

const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic / Claude',
    url: 'https://www.anthropic.com/legal/commercial-terms',
    expectKeywords: ['training', 'commercial', 'inputs', 'outputs'],
  },
  {
    id: 'openai',
    label: 'OpenAI / Codex',
    url: 'https://openai.com/enterprise-privacy',
    expectKeywords: ['training', 'data', 'API', 'retention'],
  },
  {
    id: 'google-gemini',
    label: 'Google / Gemini API',
    url: 'https://ai.google.dev/gemini-api/terms',
    expectKeywords: ['training', 'paid', 'free', 'gemini'],
  },
  {
    id: 'alibaba-qwen',
    label: 'Alibaba / Qwen Model Studio',
    url: 'https://www.alibabacloud.com/help/en/model-studio/legal-agreement',
    expectKeywords: ['training', 'service', 'data'],
  },
]

const SNAPSHOT_DIR = path.join(__dirname, '..', 'docs', 'security-snapshots')

const args = new Set(process.argv.slice(2))
const UPDATE = args.has('--update')
const JSON_OUT = args.has('--json')

// Normalize HTML to a stable plain-text representation.
//   1. Strip <script>, <style>, <noscript>, <svg>, <head>.
//   2. Drop HTML comments.
//   3. Replace tags with spaces.
//   4. Decode the handful of HTML entities we actually see in ToS pages.
//   5. Collapse runs of whitespace to single spaces.
// This is intentionally not a full DOM parser — providers change markup
// often enough that fancy extraction breaks more than it helps.
function normalizeHtml(html) {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function hash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'user-agent': 'TermpolisToSWatcher/1.0 (+https://github.com/codedev-david/termpolis)',
          accept: 'text/html,application/xhtml+xml',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
          const next = new URL(res.headers.location, url).toString()
          res.resume()
          return resolve(fetchUrl(next, redirectsLeft - 1))
        }
        if (!res.statusCode || res.statusCode >= 400) {
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('timeout fetching ' + url)))
    req.end()
  })
}

function snapshotPath(id, ext) {
  return path.join(SNAPSHOT_DIR, id + '.' + ext)
}

function readSnapshot(id) {
  try {
    return {
      hash: fs.readFileSync(snapshotPath(id, 'hash'), 'utf8').trim(),
      text: fs.readFileSync(snapshotPath(id, 'txt'), 'utf8'),
    }
  } catch {
    return null
  }
}

function writeSnapshot(id, text, hashHex) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  fs.writeFileSync(snapshotPath(id, 'hash'), hashHex + '\n', 'utf8')
  fs.writeFileSync(snapshotPath(id, 'txt'), text, 'utf8')
}

async function checkProvider(provider) {
  const result = {
    id: provider.id,
    label: provider.label,
    url: provider.url,
    status: 'ok',
    reason: '',
    newHash: '',
    oldHash: '',
    sizeBytes: 0,
    missingKeywords: [],
  }
  try {
    const { body } = await fetchUrl(provider.url)
    const text = normalizeHtml(body)
    result.sizeBytes = text.length
    if (text.length < 200) {
      result.status = 'drift'
      result.reason = 'fetched content too short (' + text.length + ' chars) — page may have moved or be JS-only'
      return result
    }
    const lower = text.toLowerCase()
    const missing = provider.expectKeywords.filter((k) => !lower.includes(k.toLowerCase()))
    result.missingKeywords = missing
    if (missing.length === provider.expectKeywords.length) {
      result.status = 'drift'
      result.reason = 'none of the expected keywords found — page content unrecognizable'
      return result
    }
    const newHash = hash(text)
    result.newHash = newHash
    const snap = readSnapshot(provider.id)
    if (UPDATE) {
      writeSnapshot(provider.id, text, newHash)
      result.status = 'updated'
      result.reason = 'snapshot rewritten by --update'
      return result
    }
    if (!snap) {
      result.status = 'drift'
      result.reason = 'no snapshot on disk yet — run with --update to seed'
      return result
    }
    result.oldHash = snap.hash
    if (snap.hash !== newHash) {
      result.status = 'drift'
      result.reason = 'hash differs from committed snapshot'
      return result
    }
  } catch (e) {
    result.status = 'error'
    result.reason = String(e && e.message ? e.message : e)
  }
  return result
}

async function main() {
  const results = []
  for (const p of PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop -- sequential fetch keeps the
    // user-agent rate-limit-friendly; 4 providers is small enough we don't
    // need parallelism.
    results.push(await checkProvider(p))
  }
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n')
  } else {
    for (const r of results) {
      const tag = r.status === 'ok'
        ? 'OK   '
        : r.status === 'updated'
          ? 'UPDT '
          : r.status === 'drift'
            ? 'DRIFT'
            : 'ERR  '
      process.stdout.write(`${tag} ${r.label}\n        ${r.url}\n`)
      if (r.status !== 'ok' && r.status !== 'updated') {
        process.stdout.write(`        reason: ${r.reason}\n`)
      }
      if (r.missingKeywords.length && r.status !== 'error') {
        process.stdout.write(`        missing keywords: ${r.missingKeywords.join(', ')}\n`)
      }
    }
  }
  const drifted = results.filter((r) => r.status === 'drift' || r.status === 'error')
  if (drifted.length && !UPDATE) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('verifyTosSnapshots fatal: ' + (e && e.stack ? e.stack : e) + '\n')
    process.exitCode = 2
  })
}

module.exports = { normalizeHtml, hash, PROVIDERS }
