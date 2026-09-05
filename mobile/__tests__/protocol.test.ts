import { utf8Encode } from '../src/wire/bytes'
import {
  NO_CAPABILITIES,
  parseRemoteMessage,
  RELAY_MAX_FRAME_BYTES,
  type RemoteMessage,
} from '../src/wire/protocol'

function parse(text: string): RemoteMessage | null {
  return parseRemoteMessage(utf8Encode(text))
}

function parseJson(value: unknown): RemoteMessage | null {
  return parse(JSON.stringify(value))
}

describe('parseRemoteMessage: the four desktop shapes', () => {
  it('reads an ok response and passes its data through untouched', () => {
    // `data` is deliberately unknown: it is whatever MCP tool answered, and this
    // layer is not the one that knows the shape.
    const msg = parseJson({ kind: 'ok', id: 7, data: { terminals: [{ id: 't1' }] } })
    expect(msg).toEqual({ kind: 'ok', id: 7, data: { terminals: [{ id: 't1' }] } })
  })

  it('reads an ok response whose data is null', () => {
    expect(parseJson({ kind: 'ok', id: 1, data: null })).toEqual({
      kind: 'ok',
      id: 1,
      data: null,
    })
  })

  it('reads an error response', () => {
    expect(parseJson({ kind: 'error', id: 2, message: 'capability not granted' })).toEqual({
      kind: 'error',
      id: 2,
      message: 'capability not granted',
    })
  })

  it('reads a batched output payload', () => {
    const chunks = [
      { terminalId: 't1', chunk: 'hello', missed: 0, marker: null },
      { terminalId: 't1', chunk: 'world', missed: 12, marker: '[12 chars lost]' },
    ]
    expect(parseJson({ kind: 'output', chunks })).toEqual({ kind: 'output', chunks })
  })

  it('reads an output payload with no chunks at all', () => {
    expect(parseJson({ kind: 'output', chunks: [] })).toEqual({ kind: 'output', chunks: [] })
  })

  it('reads a status push with its summary intact', () => {
    expect(
      parseJson({
        kind: 'status',
        terminalId: 't2',
        status: 'waiting_for_input',
        summary: 'Claude is asking to run npm test',
      }),
    ).toEqual({
      kind: 'status',
      terminalId: 't2',
      status: 'waiting_for_input',
      summary: 'Claude is asking to run npm test',
    })
  })
})

describe('parseRemoteMessage: refusals', () => {
  it('refuses malformed JSON', () => {
    expect(parse('{')).toBeNull()
    expect(parse('')).toBeNull()
    expect(parse('kind=ok')).toBeNull()
  })

  it('refuses valid JSON that is not an object', () => {
    for (const text of ['null', '[]', '42', '"ok"', 'true']) {
      expect(parse(text)).toBeNull()
    }
  })

  it('refuses an unknown kind', () => {
    expect(parseJson({ kind: 'shutdown', id: 1 })).toBeNull()
    expect(parseJson({ kind: 'pairingCode', qrPayload: '{}' })).toBeNull()
    expect(parseJson({ id: 1, data: null })).toBeNull()
  })

  it('refuses a response with no correlation id', () => {
    // A response the caller cannot match to a request would resolve nothing and
    // sit in the pending map until it timed out.
    expect(parseJson({ kind: 'ok', data: null })).toBeNull()
    expect(parseJson({ kind: 'ok', id: '1', data: null })).toBeNull()
    expect(parseJson({ kind: 'ok', id: 1.5, data: null })).toBeNull()
    expect(parseJson({ kind: 'error', message: 'no' })).toBeNull()
    expect(parseJson({ kind: 'error', id: 1 })).toBeNull()
  })

  it('refuses an output payload whose chunks are not an array', () => {
    // The bug this whole module exists to prevent: an earlier desktop union
    // declared `output` with a `chunk` field nothing constructed. A phone reading
    // `.chunk` got undefined for every field with no error anywhere.
    expect(parseJson({ kind: 'output', chunk: 'hello' })).toBeNull()
    expect(parseJson({ kind: 'output', chunks: 'hello' })).toBeNull()
    expect(parseJson({ kind: 'output' })).toBeNull()
    expect(parseJson({ kind: 'output', chunks: null })).toBeNull()
  })

  it('refuses an output chunk missing terminalId', () => {
    expect(parseJson({ kind: 'output', chunks: [{ chunk: 'x', missed: 0, marker: null }] })).toBeNull()
  })

  it('refuses an output chunk with any field of the wrong type', () => {
    const good = { terminalId: 't1', chunk: 'x', missed: 0, marker: null }
    for (const bad of [
      { ...good, chunk: 42 },
      { ...good, missed: '0' },
      { ...good, marker: 42 },
      { ...good, terminalId: null },
    ]) {
      expect(parseJson({ kind: 'output', chunks: [bad] })).toBeNull()
    }
  })

  it('refuses the whole batch when one chunk is bad', () => {
    // Partial delivery would paint a terminal that is missing a span it never
    // marks as missing -- worse than showing nothing.
    const good = { terminalId: 't1', chunk: 'x', missed: 0, marker: null }
    expect(parseJson({ kind: 'output', chunks: [good, { chunk: 'y' }] })).toBeNull()
  })

  it('refuses a status push with a status outside the union', () => {
    expect(parseJson({ kind: 'status', terminalId: 't1', status: 'busy', summary: '' })).toBeNull()
    expect(parseJson({ kind: 'status', terminalId: 't1', status: 42, summary: '' })).toBeNull()
  })

  it('refuses a status push missing a field', () => {
    expect(parseJson({ kind: 'status', terminalId: 't1', status: 'idle' })).toBeNull()
    expect(parseJson({ kind: 'status', status: 'idle', summary: '' })).toBeNull()
  })

  it('refuses a plaintext that is not valid UTF-8', () => {
    expect(parseRemoteMessage(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBeNull()
  })
})

describe('parseRemoteMessage: never throws', () => {
  it('survives a table of hostile inputs', () => {
    // Nothing here may throw. An exception out of the message handler is an
    // unhandled rejection that tears down the connection -- which a hostile peer
    // could then trigger at will.
    const hostile = [
      '',
      'null',
      '[]',
      '{}',
      '{"kind":"ok"}',
      '{"kind":"output","chunks":[[]]}',
      '{"kind":"output","chunks":[null]}',
      '{"kind":"status"}',
      '{"kind":null}',
      '\u0000',
      '{"kind":"ok","id":1,"data":{"__proto__":{"polluted":true}}}',
      `{"kind":"ok","id":1,"data":"${'a'.repeat(1024)}"}`,
      'a'.repeat(1024 * 1024),
    ]
    for (const text of hostile) {
      expect(() => parse(text)).not.toThrow()
    }
  })

  it('does not let a __proto__ key in data reach Object.prototype', () => {
    parse('{"kind":"ok","id":1,"data":{"__proto__":{"polluted":true}}}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('parses a payload at the relay frame ceiling without throwing', () => {
    // 1 MiB is what the relay allows; a message that size is a legitimate first
    // drain of a busy terminal, not an attack.
    const chunk = 'x'.repeat(RELAY_MAX_FRAME_BYTES - 2048)
    const msg = parseJson({
      kind: 'output',
      chunks: [{ terminalId: 't1', chunk, missed: 0, marker: null }],
    })
    expect(msg?.kind).toBe('output')
  })
})

describe('NO_CAPABILITIES', () => {
  it('grants nothing', () => {
    expect(NO_CAPABILITIES).toEqual({
      read: false,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    })
  })

  it('is not shared by reference between devices', () => {
    // Spreading it is the caller's job, but a frozen object makes a missed spread
    // fail loudly here instead of silently granting one phone another's rights.
    expect(Object.isFrozen(NO_CAPABILITIES)).toBe(true)
  })
})

describe('RELAY_MAX_FRAME_BYTES', () => {
  it('matches the relay ceiling', () => {
    expect(RELAY_MAX_FRAME_BYTES).toBe(1_048_576)
  })
})
