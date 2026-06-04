import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { BertTokenizer, type BertTokenizerConfig } from '../../src/main/bertTokenizer'

// ---- Deterministic logic tests (tiny hand-made vocab; always run) ----
const fixtureVocab: Record<string, number> = {
  '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3,
  hello: 4, world: 5, '!': 6, play: 7, '##ing': 8, test: 9, cafe: 10,
  '中': 11, ',': 12,
}
function makeTok(over: Partial<BertTokenizerConfig> = {}): BertTokenizer {
  return new BertTokenizer({
    vocab: fixtureVocab,
    unkToken: '[UNK]', clsToken: '[CLS]', sepToken: '[SEP]', padToken: '[PAD]',
    doLowerCase: true, stripAccents: true, tokenizeChineseChars: true,
    maxInputCharsPerWord: 100, continuingSubwordPrefix: '##', modelMaxLength: 512,
    ...over,
  })
}

describe('BertTokenizer (deterministic)', () => {
  it('wraps with [CLS] … [SEP]', () => {
    expect(makeTok().encode('hello world')).toEqual([2, 4, 5, 3])
  })

  it('does greedy WordPiece with ## continuation', () => {
    expect(makeTok().encode('playing')).toEqual([2, 7, 8, 3])
  })

  it('isolates punctuation', () => {
    expect(makeTok().encode('hello!')).toEqual([2, 4, 6, 3])
  })

  it('falls back to [UNK] for OOV words', () => {
    expect(makeTok().encode('zzzz')).toEqual([2, 1, 3])
  })

  it('returns [UNK] for words longer than maxInputCharsPerWord', () => {
    expect(makeTok({ maxInputCharsPerWord: 5 }).encode('hellohello')).toEqual([2, 1, 3])
  })

  it('handles empty and whitespace-only input', () => {
    expect(makeTok().encode('')).toEqual([2, 3])
    expect(makeTok().encode('   \t\n  ')).toEqual([2, 3])
  })

  it('lowercases', () => {
    expect(makeTok().encode('HELLO')).toEqual([2, 4, 3])
  })

  it('strips accents (café → cafe)', () => {
    expect(makeTok().encode('café')).toEqual([2, 10, 3])
  })

  it('isolates CJK characters with surrounding spaces', () => {
    expect(makeTok().encode('中')).toEqual([2, 11, 3])
  })

  it('splits non-ASCII punctuation via the Unicode P category', () => {
    // '¡' (U+00A1) is outside the ASCII punctuation ranges → matched by \p{P}
    expect(makeTok().encode('hello¡')).toEqual([2, 4, 1, 3])
  })

  it('drops control characters during text cleaning', () => {
    expect(makeTok().encode('hel\x07lo')).toEqual([2, 4, 3])
  })

  it('truncates the body to modelMaxLength - 2', () => {
    const tok = makeTok({ modelMaxLength: 4 }) // body cap = 2
    expect(tok.encode('hello world test')).toEqual([2, 4, 5, 3])
  })

  it('falls back to pad id 0 when padToken is missing from vocab', () => {
    const tok = makeTok({ padToken: '[NOPAD]' }) // fixtureVocab has no '[NOPAD]'
    expect(tok.encodeBatch(['hello', 'hello world']).inputIds[0]).toEqual([2, 4, 3, 0])
  })

  it('encodeBatch right-pads and builds masks', () => {
    const enc = makeTok().encodeBatch(['hello', 'hello world'])
    expect(enc.inputIds[0]).toEqual([2, 4, 3, 0])
    expect(enc.inputIds[1]).toEqual([2, 4, 5, 3])
    expect(enc.attentionMask[0]).toEqual([1, 1, 1, 0])
    expect(enc.attentionMask[1]).toEqual([1, 1, 1, 1])
    expect(enc.tokenTypeIds[0]).toEqual([0, 0, 0, 0])
  })
})

describe('BertTokenizer.fromJSON (CI-runnable, no model needed)', () => {
  const rawJson = {
    model: { vocab: fixtureVocab, max_input_chars_per_word: 100, continuing_subword_prefix: '##' },
    normalizer: { lowercase: true, strip_accents: null, handle_chinese_chars: true },
  }

  it('builds a working tokenizer from a full config', () => {
    const tok = BertTokenizer.fromJSON(rawJson, {
      do_lower_case: true,
      unk_token: '[UNK]',
      cls_token: '[CLS]',
      sep_token: '[SEP]',
      pad_token: '[PAD]',
      tokenize_chinese_chars: true,
      model_max_length: 512,
    })
    expect(tok.encode('hello world')).toEqual([2, 4, 5, 3])
  })

  it('falls back to normalizer/defaults when the config omits fields', () => {
    // empty config → do_lower_case falls back to normalizer.lowercase, and
    // strip_accents (null) defaults to the lowercase flag (true) → café → cafe
    const tok = BertTokenizer.fromJSON(rawJson, {})
    expect(tok.encode('CAFÉ')).toEqual([2, 10, 3])
  })

  it('honors an explicit strip_accents=false', () => {
    const vocab = { ...fixtureVocab, 'café': 20 }
    const tok = BertTokenizer.fromJSON({ model: { vocab }, normalizer: { lowercase: true } }, { strip_accents: false })
    expect(tok.encode('CAFÉ')).toEqual([2, 20, 3])
  })
})

// ---- Byte-exact validation against transformers.js (runs where the model
// cache exists; skipped in environments without it, e.g. offline CI). ----
function findCache(): { dir: string; root: string } | null {
  const root = path.join(
    process.cwd(),
    'node_modules', '@huggingface', 'transformers', '.cache',
  )
  const dir = path.join(root, 'Xenova', 'bge-small-en-v1.5')
  return fs.existsSync(path.join(dir, 'tokenizer.json')) ? { dir, root } : null
}
const cache = findCache()

describe.skipIf(!cache)('BertTokenizer matches transformers.js (real vocab)', () => {
  it('produces byte-exact input_ids across a diverse corpus', async () => {
    const tokJson = JSON.parse(fs.readFileSync(path.join(cache!.dir, 'tokenizer.json'), 'utf8'))
    const tokCfg = JSON.parse(fs.readFileSync(path.join(cache!.dir, 'tokenizer_config.json'), 'utf8'))
    const mine = BertTokenizer.fromJSON(tokJson, tokCfg)

    const mod = '@huggingface/transformers'
    const tf: any = await import(/* @vite-ignore */ mod)
    tf.env.allowRemoteModels = false
    tf.env.allowLocalModels = true
    tf.env.localModelPath = cache!.root
    const ref = await tf.AutoTokenizer.from_pretrained('Xenova/bge-small-en-v1.5')

    const corpus = [
      'The authentication middleware validates JWT tokens before each request.',
      'electron-builder packages the app; node-pty spawns the shell.',
      "Don't forget: rate-limit at 100 req/s — see PR #42 (urgent!).",
      'CamelCaseIdentifiers and snake_case_names and kebab-case-too',
      'Café naïve résumé jalapeño façade',
      'Unicode: 中文 こんにちは 한국어 mixed with English',
      'numbers 1234 5.67 0xDEADBEEF and v1.11.60',
      'emoji test 🚀 and symbols © ® ™ § ¶',
      '   leading and   multiple    spaces\tand\ttabs\n',
      'A supercalifragilisticexpialidocious antidisestablishmentarianism word',
      '',
      'a',
      'MEMORY.md path/to/file.ts:42 https://example.com/x?y=1',
    ]
    for (const s of corpus) {
      const out = await ref([s])
      const refIds = Array.from(out.input_ids.data as BigInt64Array, (x) => Number(x))
      expect(mine.encode(s), `mismatch on: ${JSON.stringify(s)}`).toEqual(refIds)
    }
  }, 60_000)
})
