// Self-contained BERT WordPiece tokenizer (bert-base-uncased vocab, as used by
// bge-small-en-v1.5). Pure TypeScript — zero native deps — so the local
// embedder ships no native binaries and stays ABI-agnostic (the whole reason
// we run embeddings on WASM, not onnxruntime-node).
//
// It reproduces HuggingFace's BertNormalizer + BertPreTokenizer + WordPiece
// exactly enough to match transformers.js token-for-token on real text; the
// test suite validates byte-exact against AutoTokenizer on a diverse corpus.

export interface BertTokenizerConfig {
  vocab: Record<string, number>
  unkToken: string
  clsToken: string
  sepToken: string
  padToken: string
  doLowerCase: boolean
  stripAccents: boolean
  tokenizeChineseChars: boolean
  maxInputCharsPerWord: number
  continuingSubwordPrefix: string
  modelMaxLength: number
}

export interface BertEncoding {
  inputIds: number[][]
  attentionMask: number[][]
  tokenTypeIds: number[][]
}

// Minimal shapes of the HuggingFace tokenizer.json / tokenizer_config.json we read.
interface RawWordPieceModel {
  vocab?: Record<string, number>
  unk_token?: string
  max_input_chars_per_word?: number
  continuing_subword_prefix?: string
}
interface RawNormalizer {
  lowercase?: boolean
  strip_accents?: boolean | null
  handle_chinese_chars?: boolean
}
export interface RawTokenizerJson {
  model?: RawWordPieceModel
  normalizer?: RawNormalizer
}
export interface RawTokenizerConfig {
  do_lower_case?: boolean
  strip_accents?: boolean | null
  unk_token?: string
  cls_token?: string
  sep_token?: string
  pad_token?: string
  tokenize_chinese_chars?: boolean
  model_max_length?: number
}

function isWhitespace(ch: string): boolean {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return true
  return /\p{Zs}/u.test(ch)
}

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false
  return /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u.test(ch)
}

// BERT punctuation: ASCII punctuation ranges + any Unicode P* category.
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }
  return /\p{P}/u.test(ch)
}

// CJK ranges that BERT isolates with surrounding spaces.
function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

function cleanText(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue
    out += isWhitespace(ch) ? ' ' : ch
  }
  return out
}

function insertChineseCharSpaces(text: string): string {
  let out = ''
  for (const ch of text) {
    if (isChineseChar(ch.codePointAt(0)!)) out += ' ' + ch + ' '
    else out += ch
  }
  return out
}

function stripAccentsFrom(text: string): string {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '')
}

export class BertTokenizer {
  private cfg: BertTokenizerConfig

  constructor(cfg: BertTokenizerConfig) {
    this.cfg = cfg
  }

  static fromJSON(tokenizerJson: RawTokenizerJson, tokenizerConfig: RawTokenizerConfig): BertTokenizer {
    const model = tokenizerJson?.model ?? {}
    const norm = tokenizerJson?.normalizer ?? {}
    const lower = tokenizerConfig?.do_lower_case ?? norm.lowercase ?? true
    // HuggingFace: strip_accents defaults to the lowercase flag when unset.
    const rawStrip = tokenizerConfig?.strip_accents ?? norm.strip_accents ?? null
    const stripAccents = rawStrip === null || rawStrip === undefined ? !!lower : !!rawStrip
    return new BertTokenizer({
      vocab: model.vocab ?? {},
      unkToken: tokenizerConfig?.unk_token ?? model.unk_token ?? '[UNK]',
      clsToken: tokenizerConfig?.cls_token ?? '[CLS]',
      sepToken: tokenizerConfig?.sep_token ?? '[SEP]',
      padToken: tokenizerConfig?.pad_token ?? '[PAD]',
      doLowerCase: !!lower,
      stripAccents,
      tokenizeChineseChars: tokenizerConfig?.tokenize_chinese_chars ?? norm.handle_chinese_chars ?? true,
      maxInputCharsPerWord: model.max_input_chars_per_word ?? 100,
      continuingSubwordPrefix: model.continuing_subword_prefix ?? '##',
      modelMaxLength: tokenizerConfig?.model_max_length ?? 512,
    })
  }

  private normalize(text: string): string {
    let t = cleanText(text)
    if (this.cfg.tokenizeChineseChars) t = insertChineseCharSpaces(t)
    if (this.cfg.stripAccents) t = stripAccentsFrom(t)
    if (this.cfg.doLowerCase) t = t.toLowerCase()
    return t
  }

  // Whitespace split + isolate each punctuation char (BertPreTokenizer).
  private basicTokenize(text: string): string[] {
    const tokens: string[] = []
    for (const word of text.split(/\s+/)) {
      if (!word) continue
      let cur = ''
      for (const ch of word) {
        if (isPunctuation(ch)) {
          if (cur) {
            tokens.push(cur)
            cur = ''
          }
          tokens.push(ch)
        } else {
          cur += ch
        }
      }
      if (cur) tokens.push(cur)
    }
    return tokens
  }

  // Greedy longest-match WordPiece; whole word → [UNK] if any piece is OOV.
  private wordpiece(token: string): string[] {
    const chars = [...token]
    if (chars.length > this.cfg.maxInputCharsPerWord) return [this.cfg.unkToken]
    const sub: string[] = []
    let start = 0
    while (start < chars.length) {
      let end = chars.length
      let match: string | null = null
      while (start < end) {
        let piece = chars.slice(start, end).join('')
        if (start > 0) piece = this.cfg.continuingSubwordPrefix + piece
        if (this.cfg.vocab[piece] !== undefined) {
          match = piece
          break
        }
        end--
      }
      if (match === null) return [this.cfg.unkToken]
      sub.push(match)
      start = end
    }
    return sub
  }

  /** Token id sequence including [CLS] … [SEP], truncated to modelMaxLength. */
  encode(text: string): number[] {
    const normalized = this.normalize(text)
    const pieces: string[] = []
    for (const bt of this.basicTokenize(normalized)) pieces.push(...this.wordpiece(bt))
    const maxBody = Math.max(0, this.cfg.modelMaxLength - 2)
    const body = pieces.slice(0, maxBody)
    const { vocab, unkToken, clsToken, sepToken } = this.cfg
    const ids = [vocab[clsToken]]
    for (const p of body) ids.push(vocab[p] ?? vocab[unkToken])
    ids.push(vocab[sepToken])
    return ids
  }

  /** Encode a batch, right-padded to the longest sequence. */
  encodeBatch(texts: string[]): BertEncoding {
    const rows = texts.map((t) => this.encode(t))
    const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0)
    const pad = this.cfg.vocab[this.cfg.padToken] ?? 0
    const inputIds: number[][] = []
    const attentionMask: number[][] = []
    const tokenTypeIds: number[][] = []
    for (const r of rows) {
      const padCount = maxLen - r.length
      inputIds.push([...r, ...new Array(padCount).fill(pad)])
      attentionMask.push([...new Array(r.length).fill(1), ...new Array(padCount).fill(0)])
      tokenTypeIds.push(new Array(maxLen).fill(0))
    }
    return { inputIds, attentionMask, tokenTypeIds }
  }
}
